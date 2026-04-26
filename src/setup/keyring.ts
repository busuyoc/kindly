// Local trust roster for sidecar verification.
//
// W39 step 2: a publisher's signature only proves "the holder of key X
// signed this." Whether the user trusts key X is a separate question,
// answered by this module.
//
// Storage: <homeDir>/.kindly/trusted-keys.json. Cross-project (a key
// the user trusted once should keep working when they switch repos),
// per-user (no shared system roster — every user makes their own
// trust decisions). The file is JSON, Zod-validated on load, atomic-
// written via tmp+rename on save.
//
// What this module does NOT do:
//   - Decide trust automatically. Adding a key is always an explicit
//     `kindly setup trust add` action. No TOFU prompt; the first
//     encounter with an unknown signer is exactly when impersonation
//     is most likely to succeed.
//   - Distribute keys. There is no built-in maintainer roster, no
//     fetch-from-URL, no key-transparency log. v0.13 ships a local
//     roster only; richer distribution is a v1.x concern (see
//     docs/security/99-v0.12-implementation-plan.md §5).
//   - Revoke keys. Removal is local — `setup trust remove` deletes
//     the entry from this user's roster. There's no global revocation
//     list because there's no global roster.

import {
    closeSync, existsSync, fsyncSync, mkdirSync, openSync,
    readFileSync, renameSync, statSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { keyIdFromPublicKey } from "./signing.ts";
import { createPublicKey } from "node:crypto";

/** Minimal slice of CliEnv this module needs. Both the keyring loader and
 *  saver only read `homeOverride` (path resolution); decoupling lets the
 *  gates/producers/signerTrust producer call us without conjuring a full
 *  CliEnv with stub writers. */
export interface KeyringEnv {
    homeOverride?: string;
}

// ---- Schema ---------------------------------------------------------------

const KEY_ID_RE = /^sha256:[a-f0-9]{64}$/;
// Raw 32-byte Ed25519 pubkey base64-encoded → 44 chars including padding.
const PUBKEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

const TrustedKeySchema = z.object({
    key_id: z.string().regex(KEY_ID_RE, "key_id must be 'sha256:' + 64 lowercase hex chars"),
    public_key_b64: z.string().regex(PUBKEY_B64_RE, "public_key_b64 must be 44-char base64 of raw 32B Ed25519 pubkey"),
    label: z.string().max(120).optional(),
    added_at: z.iso.datetime({ offset: true }),
}).strict();

const TrustedKeysFileSchema = z.object({
    kindly_trust: z.literal("v1"),
    keys: z.array(TrustedKeySchema),
}).strict();

export type TrustedKey = z.infer<typeof TrustedKeySchema>;
export type TrustedKeysFile = z.infer<typeof TrustedKeysFileSchema>;

// ---- Errors ---------------------------------------------------------------

export class KeyringError extends Error {
    constructor(message: string, public readonly code: KeyringErrorCode) {
        super(message);
        this.name = "KeyringError";
    }
}

export type KeyringErrorCode =
    | "KEYRING_CORRUPT"
    | "KEYRING_KEY_AMBIGUOUS"
    | "KEYRING_KEY_NOT_FOUND"
    | "KEYRING_DUP_KEY"
    | "KEYRING_INVALID_KEY"
    | "KEYRING_TOO_LARGE";

/** Round 3 keyring MED: cap the on-disk roster before readFileSync.
 *  Each entry is <300 bytes (key_id + b64 pubkey + label + iso ts). A
 *  legitimate roster of even 10k keys fits in well under 4 MiB. The
 *  cap closes a memory-amplification path: an attacker who can write
 *  to ~/.kindly/trusted-keys.json can't force `setup trust list` (or
 *  any signerTrust-producer call path) to allocate a multi-GiB buffer
 *  before Zod rejects the contents. statSync is cheap; the early
 *  check fails closed before the JSON parse cost. */
const KEYRING_MAX_BYTES = 4 * 1024 * 1024;

// ---- Path resolution ------------------------------------------------------

/** Where the keyring lives. Honors CliEnv.homeOverride for tests. */
export function keyringPath(env: KeyringEnv): string {
    const home = env.homeOverride ?? homedir();
    return join(home, ".kindly", "trusted-keys.json");
}

/** Lockfile path that serializes load→mutate→save sequences against
 *  the user's roster. Lives next to the roster (per-user, not per-
 *  cwd) so two `kindly setup trust add` calls from different working
 *  directories still serialize against the same destination file. */
export function keyringLockPath(env: KeyringEnv): string {
    const home = env.homeOverride ?? homedir();
    return join(home, ".kindly", "keyring.lock");
}

// ---- Load / save ----------------------------------------------------------

/** Read and validate the keyring. Returns an empty roster if the file
 *  doesn't exist (the natural first-run state — we don't pre-create it). */
export function loadKeyring(env: KeyringEnv): TrustedKeysFile {
    const path = keyringPath(env);
    if (!existsSync(path)) {
        return { kindly_trust: "v1", keys: [] };
    }
    let raw: string;
    try {
        const st = statSync(path);
        if (st.size > KEYRING_MAX_BYTES) {
            throw new KeyringError(
                `keyring at ${path} is ${st.size} bytes, exceeds ${KEYRING_MAX_BYTES} cap`,
                "KEYRING_TOO_LARGE",
            );
        }
        raw = readFileSync(path, "utf8");
    } catch (e) {
        if (e instanceof KeyringError) throw e;
        throw new KeyringError(
            `cannot read keyring at ${path}: ${(e as Error).message}`,
            "KEYRING_CORRUPT",
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new KeyringError(
            `keyring is not valid JSON: ${(e as Error).message}`,
            "KEYRING_CORRUPT",
        );
    }
    const result = TrustedKeysFileSchema.safeParse(parsed);
    if (!result.success) {
        const summary = result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
            .join("; ");
        throw new KeyringError(
            `keyring schema invalid: ${summary}`,
            "KEYRING_CORRUPT",
        );
    }

    // Round 3 keyring MEDs (cluster):
    //
    //   (1) key_id <-> public_key_b64 cross-check. Zod validates each
    //       field's shape independently; nothing prevents an attacker
    //       (or a corrupt write) from pairing publisher A's pubkey
    //       with publisher B's key_id. Without this check, lookups
    //       happen by key_id while signature verification consumes
    //       public_key_b64 — the bytes that belong to a different
    //       publisher entirely. Bind them at load time so signerTrust
    //       can't surface "trusted: alice" while verifying with bob's
    //       key.
    //
    //   (2) duplicate key_id. addKey rejects dups going forward, but
    //       a malformed roster (concurrent-write artifact, hand-edit,
    //       merge by hand) could already contain duplicates today.
    //       Last-write-wins lookup hides whichever entry was added
    //       first; reject on load.
    //
    // Failing closed for both: any non-trivial corruption surfaces as
    // KEYRING_CORRUPT and the user re-runs `setup trust list` to see
    // their actual state.
    const seen = new Map<string, number>();
    for (let i = 0; i < result.data.keys.length; i++) {
        const k = result.data.keys[i]!;
        const prior = seen.get(k.key_id);
        if (prior !== undefined) {
            throw new KeyringError(
                `keyring contains duplicate key_id at indexes ${prior} and ${i}: ${k.key_id}`,
                "KEYRING_CORRUPT",
            );
        }
        seen.set(k.key_id, i);

        let derived: string;
        try {
            derived = keyIdFromPublicKey(Buffer.from(k.public_key_b64, "base64"));
        } catch (e) {
            throw new KeyringError(
                `keyring entry ${i} has unverifiable public_key_b64: ${(e as Error).message}`,
                "KEYRING_CORRUPT",
            );
        }
        if (derived !== k.key_id) {
            throw new KeyringError(
                `keyring entry ${i} key_id ${k.key_id} does not match the hash of public_key_b64 (got ${derived})`,
                "KEYRING_CORRUPT",
            );
        }
    }

    return result.data;
}

/** Write the keyring atomically. Creates ~/.kindly/ if missing. Tmp+rename
 *  prevents partial-write corruption — destination always sees a complete
 *  prior file or a complete new file, never a half-written one. */
export function saveKeyring(env: KeyringEnv, file: TrustedKeysFile): void {
    const path = keyringPath(env);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const content = JSON.stringify(file, null, 2) + "\n";

    const fd = openSync(tmp, "wx");
    try {
        const buf = Buffer.from(content, "utf8");
        let off = 0;
        while (off < buf.length) {
            off += writeSync(fd, buf, off, buf.length - off);
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
}

// ---- Mutations ------------------------------------------------------------

/** Add a key. Derives `key_id` from the pubkey PEM via keyIdFromPublicKey
 *  (same function the signing path uses, so claims align). Refuses dups
 *  by `key_id`. Returns the updated file; caller saves. */
export function addKey(file: TrustedKeysFile, opts: {
    publicKeyPem: string;
    label?: string;
    now: Date;
}): { file: TrustedKeysFile; added: TrustedKey } {
    const rawPub = rawEd25519PublicKey(opts.publicKeyPem);
    const keyId = keyIdFromPublicKey(rawPub);

    if (file.keys.some((k) => k.key_id === keyId)) {
        throw new KeyringError(
            `key ${keyId} is already in the roster`,
            "KEYRING_DUP_KEY",
        );
    }

    const entry: TrustedKey = {
        key_id: keyId,
        public_key_b64: rawPub.toString("base64"),
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        added_at: opts.now.toISOString(),
    };
    return {
        file: { ...file, keys: [...file.keys, entry] },
        added: entry,
    };
}

/** Remove the key whose `key_id` starts with `prefix`. Throws on
 *  ambiguous (multiple matches) or absent (zero matches) so the user
 *  knows their command targeted nothing concrete. */
export function removeKey(file: TrustedKeysFile, prefix: string): {
    file: TrustedKeysFile;
    removed: TrustedKey;
} {
    const matches = file.keys.filter((k) => k.key_id.startsWith(prefix));
    if (matches.length === 0) {
        throw new KeyringError(
            `no key in roster matches prefix "${prefix}"`,
            "KEYRING_KEY_NOT_FOUND",
        );
    }
    if (matches.length > 1) {
        const ids = matches.map((m) => m.key_id).join(", ");
        throw new KeyringError(
            `prefix "${prefix}" matches ${matches.length} keys: ${ids}`,
            "KEYRING_KEY_AMBIGUOUS",
        );
    }
    const removed = matches[0]!;
    return {
        file: { ...file, keys: file.keys.filter((k) => k.key_id !== removed.key_id) },
        removed,
    };
}

// ---- Lookup ---------------------------------------------------------------

/** Exact-match lookup by full key_id. Returns null if absent. */
export function findKey(file: TrustedKeysFile, keyId: string): TrustedKey | null {
    return file.keys.find((k) => k.key_id === keyId) ?? null;
}

// ---- Helpers --------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from a PEM. Throws
 *  KEYRING_INVALID_KEY for non-Ed25519 or malformed input. Mirrors the
 *  helper in signing.ts so an invalid PEM produces the same shape of
 *  error whether the user is signing or trusting.
 *
 *  Exported for use in `setup trust add` — the CLI needs to derive
 *  key_id BEFORE mutating the local roster (to check against the
 *  built-in registry first), so the SPKI-DER-length invariant lives
 *  here in one place. */
export function rawEd25519PublicKey(keyPem: string): Buffer {
    let k: ReturnType<typeof createPublicKey>;
    try {
        k = createPublicKey(keyPem);
    } catch (e) {
        throw new KeyringError(
            `invalid public key PEM: ${(e as Error).message}`,
            "KEYRING_INVALID_KEY",
        );
    }
    if (k.asymmetricKeyType !== "ed25519") {
        throw new KeyringError(
            `expected Ed25519 public key, got ${k.asymmetricKeyType ?? "unknown"}`,
            "KEYRING_INVALID_KEY",
        );
    }
    const der = k.export({ format: "der", type: "spki" });
    if (der.length !== 44) {
        throw new KeyringError(
            `unexpected SPKI length for Ed25519: ${der.length}`,
            "KEYRING_INVALID_KEY",
        );
    }
    return Buffer.from(der.subarray(12));
}
