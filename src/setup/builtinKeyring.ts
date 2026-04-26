// Built-in publisher keyring — the "upstream" half of W39 trust.
//
// The local roster (keyring.ts) answers "do I trust this signer?" by
// looking at keys the user typed `setup trust add` for. That works
// once a key is in front of the user — but it does not solve the
// first-encounter problem: how does a fresh install know to trust
// the maintainer who signed the starter Setup the user is about to
// import? keyring.ts:13-17 is explicit that we will not TOFU the
// answer ("the first encounter with an unknown signer is exactly when
// impersonation is most likely to succeed"); the alternative this
// module provides is a curated registry committed in source.
//
// What this module does:
//   - Loads `data/keyring/publishers.v1.json` from a hard-resolved
//     path under the kindly install (no cwd-override hatch — closes
//     Batch N S300 by not having the surface).
//   - Validates the file under a strict Zod schema (closes S301
//     passthrough hazard by refusing extra keys).
//   - Caps file size before parse (closes S305).
//   - Hash-binds the file's bytes to a constant in source
//     (`builtinKeyringHash.ts`); a tampered or swapped JSON fails
//     load (closes S306).
//
// What this module does NOT do:
//   - Distribute keys at runtime. There is no fetch-from-URL, no
//     auto-update — the registry is whatever was in source when the
//     binary was built/installed.
//   - Override the local roster. The local-vs-builtin precedence is
//     decided by the producer (signerTrust.ts), not here.
//   - Render anything. Display strings flow through the renderer's
//     `sanitizeForTerminal` chokepoint (Batch M); load returns raw
//     validated bytes.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { hashBytes } from "./canonical.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { BUILTIN_KEYRING_HASH } from "./builtinKeyringHash.ts";

// SHA256_HEX matches keyring.ts:48 — same shape that flows through
// the local roster + sidecars + producer. Re-stated locally rather
// than imported so this module does not bind the local-roster
// implementation as a transitive dependency.
const KEY_ID_RE = /^sha256:[a-f0-9]{64}$/;
// PUBKEY_B64_RE matches keyring.ts:50 — raw 32B Ed25519 in base64.
const PUBKEY_B64_RE = /^[A-Za-z0-9+/]{43}=$/;

// S961 scheme allowlist. References are URLs the user might click
// through from a future GUI ("see this maintainer's other work"); the
// same `javascript:` / `data:` / `file:` / `vbscript:` schemes that
// schema.ts rejects on `source_url` are rejected here.
const URL_SCHEME_RE = /^(https?:|mailto:|git\+https:)/i;
const ReferenceUrlSchema = z.string().url().refine(
    (v) => URL_SCHEME_RE.test(v),
    { message: "reference URL scheme must be http, https, mailto, or git+https" },
);

// A built-in publisher entry. Distinct from `TrustedKey` (local
// roster):
//   - `label` is REQUIRED — no anonymous entries in the curated
//     registry; the user can read it in `setup trust list` and tell
//     "kindly-builtin: alice" apart from a randomly-named local key.
//   - `description`, `since`, `references` are optional curation
//     metadata that have no analogue in the local roster.
//   - `added_at` (local) → `since` (builtin); semantics differ: local
//     records WHEN the user added the key, builtin records WHICH
//     RELEASE first shipped it.
const BuiltinPublisherSchema = z.object({
    key_id: z.string().regex(
        KEY_ID_RE,
        "key_id must be 'sha256:' + 64 lowercase hex chars",
    ),
    public_key_b64: z.string().regex(
        PUBKEY_B64_RE,
        "public_key_b64 must be 44-char base64 of raw 32B Ed25519 pubkey",
    ),
    label: z.string().min(1, "label is required for built-in entries").max(120),
    description: z.string().max(500).optional(),
    since: z.string().max(40).optional(),
    references: z.array(ReferenceUrlSchema).max(10).optional(),
}).strict();

export type BuiltinPublisher = z.infer<typeof BuiltinPublisherSchema>;

// File envelope. `kindly_builtin_keyring: "v1"` mirrors the
// `kindly_trust: "v1"` marker on the local roster — same single-byte
// version axis, same "refuse unknown majors" policy when v2 lands.
export const BuiltinKeyringSchema = z.object({
    kindly_builtin_keyring: z.literal("v1"),
    curated_at: z.iso.datetime({ offset: false }).or(
        // The curation date is the maintainer-controlled
        // committed-in-source timestamp; allow plain `YYYY-MM-DD` so
        // the JSON stays human-skimmable in a PR diff.
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "curated_at must be ISO 8601 datetime or YYYY-MM-DD"),
    ),
    publishers: z.array(BuiltinPublisherSchema),
}).strict();

export type BuiltinKeyring = z.infer<typeof BuiltinKeyringSchema>;

// ---- Path resolution ------------------------------------------------------
//
// Hard-resolved against this module's location. No cwd-override hatch
// (closes Batch N S300; src/catalog/reader.ts has one and it's been
// flagged). The keyring is part of the install — it MUST come from
// the bundle, not from wherever the user happens to invoke kindly.
const BUILTIN_KEYRING_PATH = resolve(
    import.meta.dir, "..", "..",
    "data/keyring/publishers.v1.json",
);

// 64 KiB is generous for a curated publisher list (a few dozen entries,
// each ~250 bytes). Closes Batch N S305: the catalog had no size cap,
// so a packager could swap a multi-megabyte file and force a long
// JSON.parse before any validation ran.
export const MAX_KEYRING_BYTES = 64 * 1024;

// ---- Pure validation -------------------------------------------------------
//
// All the failure-mode logic is pulled out of the IO path so tests can
// exercise it without monkey-patching `data/keyring/publishers.v1.json`
// in the live source tree (which would force every parallel test to
// own the file lock). The IO wrapper below trusts whatever this returns.
//
// Tests pass synthetic bytes + the hash they expect; production passes
// the real file bytes + the committed BUILTIN_KEYRING_HASH constant.
export function validateBuiltinKeyringBytes(
    bytes: Buffer,
    expectedHash: string,
    pathForErrorMessages: string,
): BuiltinKeyring {
    if (bytes.length > MAX_KEYRING_BYTES) {
        throw new KindlyError(
            ErrorCodes.BUILTIN_KEYRING_TOO_LARGE,
            `built-in keyring at ${pathForErrorMessages} is ${bytes.length} bytes (max ${MAX_KEYRING_BYTES}); install may be tampered`,
            [{ text: "reinstall kindly from a trusted source" }],
        );
    }

    const actualHash = hashBytes(bytes);
    if (actualHash !== expectedHash) {
        throw new KindlyError(
            ErrorCodes.BUILTIN_KEYRING_HASH_MISMATCH,
            `built-in keyring hash mismatch: expected ${expectedHash}, got ${actualHash}`,
            [
                { text: "the keyring file has been modified after install — reinstall kindly from a trusted source" },
                { text: "if you intended to edit data/keyring/publishers.v1.json, rebuild the hash", command: "bun run scripts/build-builtin-keyring.ts" },
            ],
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch (e) {
        throw new KindlyError(
            ErrorCodes.BUILTIN_KEYRING_INVALID,
            `built-in keyring is not valid JSON: ${(e as Error).message}`,
            [{ text: "reinstall kindly from a trusted source" }],
        );
    }

    const result = BuiltinKeyringSchema.safeParse(parsed);
    if (!result.success) {
        const summary = result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
            .join("; ");
        throw new KindlyError(
            ErrorCodes.BUILTIN_KEYRING_INVALID,
            `built-in keyring schema invalid: ${summary}`,
            [{ text: "reinstall kindly from a trusted source" }],
        );
    }

    return result.data;
}

// ---- Cache ----------------------------------------------------------------
//
// The file is committed-in-source bytes — it cannot legitimately change
// during the lifetime of a process. Cache the validated result so the
// per-`setup verify` and per-`setup import` calls don't re-hash + re-
// parse 64 KiB on every invocation. (The local roster is NOT cached —
// it can be edited by `setup trust add/remove` from another process.)
let cached: BuiltinKeyring | null = null;

/** Load and validate the built-in publisher keyring.
 *
 *  Fails closed on any of:
 *    - file missing (BUILTIN_KEYRING_INVALID — install bundle is broken)
 *    - file > 64 KiB (BUILTIN_KEYRING_TOO_LARGE — packager swap)
 *    - bytes don't hash to BUILTIN_KEYRING_HASH (HASH_MISMATCH —
 *      tampered post-install or auto-update served wrong bytes)
 *    - JSON / Zod validation fails (BUILTIN_KEYRING_INVALID)
 *
 *  Never returns "empty roster on missing file" the way `loadKeyring`
 *  does. Local roster missing = first-run user; built-in keyring
 *  missing = corrupt install.
 */
export function loadBuiltinKeyring(): BuiltinKeyring {
    if (cached !== null) return cached;

    let bytes: Buffer;
    try {
        // Stat-then-read to short-circuit a multi-MiB readFileSync if a
        // packager swapped the file with something huge — same protection
        // pattern as src/fs/yamlSafe.ts.
        const stat = statSync(BUILTIN_KEYRING_PATH);
        if (stat.size > MAX_KEYRING_BYTES) {
            throw new KindlyError(
                ErrorCodes.BUILTIN_KEYRING_TOO_LARGE,
                `built-in keyring at ${BUILTIN_KEYRING_PATH} is ${stat.size} bytes (max ${MAX_KEYRING_BYTES}); install may be tampered`,
                [{ text: "reinstall kindly from a trusted source" }],
            );
        }
        bytes = readFileSync(BUILTIN_KEYRING_PATH);
    } catch (e) {
        if (e instanceof KindlyError) throw e;
        throw new KindlyError(
            ErrorCodes.BUILTIN_KEYRING_INVALID,
            `cannot read built-in keyring at ${BUILTIN_KEYRING_PATH}: ${(e as Error).message}`,
            [{ text: "reinstall kindly from a trusted source" }],
        );
    }

    cached = validateBuiltinKeyringBytes(bytes, BUILTIN_KEYRING_HASH, BUILTIN_KEYRING_PATH);
    return cached;
}

/** Test-only: drop the cached load. Production paths should not call
 *  this — the keyring is committed-in-source and immutable per
 *  process. Tests need it because they monkey-patch the bundle in
 *  parallel suites. */
export function _resetBuiltinKeyringCacheForTests(): void {
    cached = null;
}

/** Test-only: install a synthetic keyring as the active load result.
 *  Production never has reason to call this — the curated keyring is
 *  whatever shipped in the install bundle. Tests need it to exercise
 *  the "signer matches a built-in publisher" code path against the
 *  empty-by-default v0.13 seed. Any subsequent `loadBuiltinKeyring()`
 *  in the same process returns this value verbatim until
 *  `_resetBuiltinKeyringCacheForTests()` clears it. */
export function _overrideBuiltinKeyringForTests(k: BuiltinKeyring): void {
    cached = k;
}

/** Exact-match lookup by full key_id. Mirrors keyring.ts:findKey. */
export function findBuiltinKey(
    keyring: BuiltinKeyring,
    keyId: string,
): BuiltinPublisher | null {
    return keyring.publishers.find((p) => p.key_id === keyId) ?? null;
}
