// W39 signing primitive — Ed25519 over the canonical extracted tree.
//
// Trust contract (Q1 = canonical-tree, Q2 = verifier-independent re-filter,
// Q3 = canonical-hash-identical):
//
//   signing input = "kindly-sig:v1\n" + manifest_hash + "\n" + filter_version + "\n"
//   signature     = Ed25519(signing input, signer_private_key)
//
// Filter-invariance (Q2 Option B): both sign and verify call
// assertManifestFilterInvariant() on the canonical manifest. Sign refuses
// non-invariant input (Q2b: forces publisher pipelines to canonicalize
// before any signed bytes leave their machine); verify refuses on the
// receiver side, so a compromised publisher cannot escape the membership
// test. The filter rules live in filterCheck.ts and are versioned by
// KINDLY_FILTER_VERSION.
//
// What's deliberately NOT here yet:
//   - Key distribution (TOFU vs publisher registry). Sidecar embeds the
//     full public key so verify() is self-contained crypto-wise — trust
//     decisions live above this module.
//
// Sidecar format (JSON, written next to <archive>.kset as <archive>.kset.sig):
//   {
//     "kindly_sig": "v1",
//     "alg": "ed25519",
//     "filter_version": "v0.12.0",
//     "manifest_hash": "sha256:<hex>",
//     "signer_public_key": "<base64 32B raw Ed25519 pubkey>",
//     "signer_key_id": "sha256:<hex 64 chars of pubkey bytes>",
//     "signature": "<base64 64B Ed25519 sig>"
//   }
//
// The sidecar is OUT-OF-BAND from the .kset itself: signing the canonical
// manifest hash means the archive can be re-tarred / re-compressed across
// builders without invalidating the signature, as long as canonical-tree
// equality holds (W46 invariant).

import { readFileSync, writeFileSync, statSync } from "node:fs";
import {
    createPrivateKey, createPublicKey, createHash,
    sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";
import { unpackSetup } from "./unpack.ts";
import { manifestHash as computeManifestHash } from "./canonical.ts";
import { assertManifestFilterInvariant, FilterInvariantError } from "./filterCheck.ts";

/** The filter version this build of kindly signs under. Bound into every
 *  signature so a future tightened filter doesn't silently re-validate
 *  older packages under different rules.
 *
 *  Bumps when filterCheck.ts changes behavior observably: new control-byte
 *  rejections, different NFC handling, anything that flips a previously-
 *  passing manifest to failing or vice versa. Pure classify changes
 *  (e.g. S960 plugins_disabled) do NOT bump — filterCheck walks every
 *  string uniformly and is independent of classify.
 *
 *  v0.12.0 -> v0.13.0 bump (round 3 filter-parity HIGH): filterCheck now
 *  also rejects Cf/Cc codepoints (ZWSP/ZWNJ/ZWJ/BOM/RLO/C1-controls/...)
 *  to match what `parseYamlSafe` rejects on the verify side (Lead 19).
 *  Without parity, v0.12.0-signed bytes containing those codepoints
 *  passed sign-time filterCheck but failed parse-time YAML check on the
 *  receiver — signed-but-unusable bytes. */
export const KINDLY_FILTER_VERSION = "v0.13.0";

/** Q2a generation window. Verifier accepts any sidecar whose
 *  filter_version is in this list. The build's `KINDLY_FILTER_VERSION`
 *  (current) is always element 0; the previous generation, if any, is
 *  element 1.
 *
 *  Bump procedure when filterCheck.ts changes behavior:
 *    1. Bump KINDLY_FILTER_VERSION to the new tag (e.g. "v0.14.0").
 *    2. Prepend it here; drop the tail if length would exceed 2.
 *  Concretely: ["v0.14.0", "v0.13.0"] keeps the previous generation as
 *  a one-release grace window for honest publishers. Three or more
 *  generations are explicitly out of scope — old filter bugs expire on
 *  a schedule (see docs/security/99-v0.12-implementation-plan.md §Q2a).
 *
 *  Note: even within the grace window the verifier still re-runs
 *  filterCheck.ts at the *current* generation (Q2 Option B is "trust
 *  the verifier's filter, not the publisher's"). A v0.12.0-signed
 *  archive whose bytes already satisfy v0.13.0 rules verifies fine; one
 *  whose bytes only passed v0.12.0 rules will FILTER_NOT_INVARIANT.
 *  The grace window therefore widens *acceptance of the version label*,
 *  not the rule set itself. */
export const ACCEPTED_FILTER_VERSIONS = ["v0.13.0", "v0.12.0"] as const;

/** Domain-separation prefix in the signing input. Prevents an Ed25519
 *  key reused for kindly from also producing valid signatures under
 *  some other protocol that happens to sign similar-shaped strings. */
const SIGNING_DOMAIN = "kindly-sig:v1";

export type SidecarSignature = {
    kindly_sig: "v1";
    alg: "ed25519";
    filter_version: string;
    manifest_hash: string;
    signer_public_key: string;   // base64 raw 32B
    signer_key_id: string;       // "sha256:<hex>"
    signature: string;           // base64 raw 64B
};

export class SigningError extends Error {
    constructor(message: string, public readonly code: SigningErrorCode) {
        super(message);
        this.name = "SigningError";
    }
}

export type SigningErrorCode =
    | "INVALID_KEY"
    | "INVALID_SIDECAR"
    | "MANIFEST_HASH_MISMATCH"
    | "SIGNATURE_INVALID"
    | "UNSUPPORTED_FILTER_VERSION"
    | "UNSUPPORTED_FORMAT"
    | "FILTER_NOT_INVARIANT"
    | "AUTHOR_KEY_ID_MISMATCH";

/** True iff `v` is in the N=2 generation window. Pure membership check;
 *  no version comparison. */
export function isAcceptedFilterVersion(v: string): boolean {
    return (ACCEPTED_FILTER_VERSIONS as readonly string[]).includes(v);
}

/** Numeric `vX.Y.Z` comparator: returns negative / 0 / positive like
 *  `Array.sort`. Used solely to pick the right error-message hint
 *  (older-than-window vs. newer-than-build). Unparseable versions sort
 *  as "older" — a malformed filter_version is already a publisher bug,
 *  and the older hint ("re-sign with current tools") is the right next
 *  step regardless. */
export function compareFilterVersions(a: string, b: string): number {
    const pa = parseFilterVersion(a);
    const pb = parseFilterVersion(b);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

function parseFilterVersion(v: string): [number, number, number] {
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (!m) return [0, 0, 0];
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Bytes that get fed to Ed25519. Must match exactly between sign and
 *  verify. UTF-8 encoded, newline-terminated, length-implicit-via-prefix
 *  (no separator that could confuse a manifest hash containing newlines —
 *  manifest hashes are sha256:<64 hex> by construction). */
export function buildSigningInput(manifestHash: string, filterVersion: string): Buffer {
    return Buffer.from(
        `${SIGNING_DOMAIN}\n${manifestHash}\n${filterVersion}\n`,
        "utf8",
    );
}

/** Hash of the raw 32-byte Ed25519 public key, displayed as the signer's
 *  identity in the sidecar and CLI output. Stable as long as the key is. */
export function keyIdFromPublicKey(rawPubKey: Buffer): string {
    if (rawPubKey.length !== 32) {
        throw new SigningError(
            `expected 32-byte Ed25519 public key, got ${rawPubKey.length}`,
            "INVALID_KEY",
        );
    }
    const h = createHash("sha256").update(rawPubKey).digest("hex");
    return `sha256:${h}`;
}

/** Extract the raw 32-byte Ed25519 public key from a Node KeyObject. */
function rawEd25519PublicKey(keyPem: string): Buffer {
    const k = createPublicKey(keyPem);
    if (k.asymmetricKeyType !== "ed25519") {
        throw new SigningError(
            `expected Ed25519 public key, got ${k.asymmetricKeyType ?? "unknown"}`,
            "INVALID_KEY",
        );
    }
    // SPKI-DER for Ed25519 is a fixed 44-byte prefix-free encoding;
    // raw key is the trailing 32 bytes.
    const der = k.export({ format: "der", type: "spki" });
    if (der.length !== 44) {
        throw new SigningError(
            `unexpected SPKI length for Ed25519: ${der.length}`,
            "INVALID_KEY",
        );
    }
    return Buffer.from(der.subarray(12));
}

/** Sign a `.kset` archive and write the sidecar `<archive>.sig`. The
 *  archive must already pass unpackSetup validation (manifest hash + per-
 *  file hashes); we re-derive the canonical hash here rather than trust
 *  any caller-supplied value.
 *
 *  Returns the sidecar object that was written. */
export function signSetupArchive(opts: {
    archivePath: string;
    privateKeyPem: string;
    publicKeyPem: string;
    filterVersion?: string;
}): SidecarSignature {
    const filterVersion = opts.filterVersion ?? KINDLY_FILTER_VERSION;

    // Unpack & re-derive the canonical hash. unpackSetup verifies all
    // internal hashes; if any tampering occurred between pack and sign
    // it'll throw before we sign.
    const unpacked = unpackSetup(opts.archivePath);
    const derivedHash = computeManifestHash(unpacked.manifest);

    // Q2b: refuse to sign a non-filter-invariant manifest. Forces the
    // publisher to fix their pipeline (re-canonicalize, NFC-normalize,
    // strip control bytes) before any signed bytes leave their machine.
    try {
        assertManifestFilterInvariant(unpacked.manifest);
    } catch (e) {
        if (e instanceof FilterInvariantError) {
            throw new SigningError(e.message, "FILTER_NOT_INVARIANT");
        }
        throw e;
    }

    const priv = createPrivateKey(opts.privateKeyPem);
    if (priv.asymmetricKeyType !== "ed25519") {
        throw new SigningError(
            `expected Ed25519 private key, got ${priv.asymmetricKeyType ?? "unknown"}`,
            "INVALID_KEY",
        );
    }
    const rawPub = rawEd25519PublicKey(opts.publicKeyPem);
    const keyId = keyIdFromPublicKey(rawPub);

    // Defensive check (red-team H1): refuse to sign a manifest that
    // claims someone else as author. Catches publisher-pipeline mistakes
    // (cross-tenant key swap, copy-pasted manifest with stale claim) at
    // the publisher boundary instead of letting them propagate to
    // verifiers as AUTHOR_KEY_ID_MISMATCH.
    if (
        unpacked.manifest.meta.author_key_id
        && unpacked.manifest.meta.author_key_id !== keyId
    ) {
        throw new SigningError(
            `refusing to sign: manifest claims author_key_id=${unpacked.manifest.meta.author_key_id} ` +
            `but signing key is ${keyId}`,
            "AUTHOR_KEY_ID_MISMATCH",
        );
    }

    const input = buildSigningInput(derivedHash, filterVersion);
    // For Ed25519, node:crypto wants algorithm = null (the curve carries
    // its own hash internally — Ed25519ph is NOT what we use here).
    const sig = cryptoSign(null, input, priv);

    const sidecar: SidecarSignature = {
        kindly_sig: "v1",
        alg: "ed25519",
        filter_version: filterVersion,
        manifest_hash: derivedHash,
        signer_public_key: rawPub.toString("base64"),
        signer_key_id: keyId,
        signature: sig.toString("base64"),
    };
    writeFileSync(`${opts.archivePath}.sig`, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    return sidecar;
}

export type VerifyResult = {
    /** Sidecar after schema-validation. */
    sidecar: SidecarSignature;
    /** The canonical hash we re-derived from the archive (== sidecar.manifest_hash). */
    derivedManifestHash: string;
    /** Echo of sidecar.signer_key_id for caller convenience. */
    signerKeyId: string;
};

/** Verify a `.kset.sig` sidecar against its archive. Throws SigningError
 *  with a stable code on any failure. Returns sidecar + signer identity
 *  so callers (kindly setup verify, future doctor checks) can render
 *  trust decisions consistently.
 *
 *  Verification does NOT trust the sidecar's manifest_hash. We re-derive
 *  it from the archive contents and compare — that's how Q1=canonical-
 *  tree achieves robustness against archive-framing attacks. */
export function verifySetupArchive(archivePath: string): VerifyResult {
    const sidecarPath = `${archivePath}.sig`;
    let sidecar: SidecarSignature;
    try {
        const st = statSync(sidecarPath);
        if (st.size > SIDECAR_MAX_BYTES) {
            throw new SigningError(
                `sidecar at ${sidecarPath} is ${st.size} bytes, exceeds ${SIDECAR_MAX_BYTES} cap`,
                "INVALID_SIDECAR",
            );
        }
        const raw = readFileSync(sidecarPath, "utf8");
        sidecar = parseSidecar(raw);
    } catch (e) {
        if (e instanceof SigningError) throw e;
        throw new SigningError(
            `cannot read signature sidecar at ${sidecarPath}: ${(e as Error).message}`,
            "INVALID_SIDECAR",
        );
    }

    if (sidecar.kindly_sig !== "v1") {
        throw new SigningError(
            `unsupported sidecar version: ${sidecar.kindly_sig}`,
            "UNSUPPORTED_FORMAT",
        );
    }
    if (sidecar.alg !== "ed25519") {
        throw new SigningError(
            `unsupported signature algorithm: ${sidecar.alg}`,
            "UNSUPPORTED_FORMAT",
        );
    }

    // Q2a generation window. Membership check against ACCEPTED_FILTER_VERSIONS
    // (current + at most one previous, see definition). The error message
    // distinguishes older-than-window (publisher should re-sign with current
    // tools) from newer-than-build (user should upgrade kindly) — same
    // error code, different remediation.
    if (!isAcceptedFilterVersion(sidecar.filter_version)) {
        const accepted = ACCEPTED_FILTER_VERSIONS.join(", ");
        const newer = compareFilterVersions(sidecar.filter_version, KINDLY_FILTER_VERSION) > 0;
        const hint = newer
            ? "upgrade kindly — this build is older than the signature's filter generation."
            : "ask the publisher to re-sign with current kindly tooling — this filter generation has expired.";
        throw new SigningError(
            `signature was made under filter_version=${sidecar.filter_version}, ` +
            `this build accepts ${accepted}; ${hint}`,
            "UNSUPPORTED_FILTER_VERSION",
        );
    }

    const unpacked = unpackSetup(archivePath);
    const derivedHash = computeManifestHash(unpacked.manifest);

    // Q2 Option B: verifier re-runs the filter and rejects any .kset
    // whose canonical content isn't filter-invariant. The publisher's
    // signature is irrelevant if the bytes themselves don't pass our
    // membership test.
    try {
        assertManifestFilterInvariant(unpacked.manifest);
    } catch (e) {
        if (e instanceof FilterInvariantError) {
            throw new SigningError(e.message, "FILTER_NOT_INVARIANT");
        }
        throw e;
    }

    if (derivedHash !== sidecar.manifest_hash) {
        throw new SigningError(
            `manifest hash mismatch: archive yields ${derivedHash}, sidecar declares ${sidecar.manifest_hash}`,
            "MANIFEST_HASH_MISMATCH",
        );
    }

    // Authority confusion (red-team H1, 2026-04-26): manifest.meta.author_key_id
    // is a free-form publisher claim ("this setup was authored by key X").
    // Without this check, an attacker who holds a trusted key K_eve can
    // re-sign a manifest claiming author_key_id = K_alice; the trust gate
    // fires on K_eve, but downstream surfaces (verify --json, history,
    // future social-trust UI) report the lie. Bind the claim to the actual
    // signer at the same boundary that already binds manifest_hash to
    // signer_key_id.
    if (
        unpacked.manifest.meta.author_key_id
        && unpacked.manifest.meta.author_key_id !== sidecar.signer_key_id
    ) {
        throw new SigningError(
            `manifest claims author_key_id=${unpacked.manifest.meta.author_key_id} ` +
            `but signature was made by ${sidecar.signer_key_id}`,
            "AUTHOR_KEY_ID_MISMATCH",
        );
    }

    // Reconstitute the public key and check the signer_key_id.
    const rawPub = Buffer.from(sidecar.signer_public_key, "base64");
    const claimedKeyId = keyIdFromPublicKey(rawPub);
    if (claimedKeyId !== sidecar.signer_key_id) {
        throw new SigningError(
            `signer_key_id (${sidecar.signer_key_id}) does not match hash of signer_public_key (${claimedKeyId})`,
            "INVALID_SIDECAR",
        );
    }

    // Build a Node KeyObject from the raw 32-byte pubkey via SPKI prefix.
    const spkiPrefix = Buffer.from([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ]);
    const spkiDer = Buffer.concat([spkiPrefix, rawPub]);
    const pubKey = createPublicKey({ key: spkiDer, format: "der", type: "spki" });

    const sig = Buffer.from(sidecar.signature, "base64");
    if (sig.length !== 64) {
        throw new SigningError(
            `expected 64-byte Ed25519 signature, got ${sig.length}`,
            "INVALID_SIDECAR",
        );
    }
    const input = buildSigningInput(derivedHash, sidecar.filter_version);
    const ok = cryptoVerify(null, input, pubKey, sig);
    if (!ok) {
        throw new SigningError(
            "signature did not verify against signer_public_key",
            "SIGNATURE_INVALID",
        );
    }

    return {
        sidecar,
        derivedManifestHash: derivedHash,
        signerKeyId: sidecar.signer_key_id,
    };
}

// Round-5 S2001/S2003 closure: filter_version is publisher-supplied
// and is echoed verbatim into UNSUPPORTED_FILTER_VERSION error
// messages. Pre-fix: any string was accepted (1 MiB payloads, embedded
// `\n`, control bytes) until the membership check rejected the value
// downstream. Sanitize-at-write is the last line of defence; this is
// the first. The shape regex matches `vX.Y.Z` plus an optional
// `-<pre>` segment (semver pre-release) — wider than today's
// ACCEPTED_FILTER_VERSIONS so future bumps don't have to update both.
const FILTER_VERSION_MAX_LEN = 32;
const FILTER_VERSION_RE = /^v\d{1,5}\.\d{1,5}\.\d{1,5}(-[A-Za-z0-9.]+)?$/;

// R1 (review hardening): cap sidecar bytes before JSON.parse to defeat
// a multi-GiB buffer allocation from a hostile <archive>.kset.sig. Real
// sidecars are <1 KB; 1 MiB is generously above any legitimate growth.
// Mirrors the KEYRING_MAX_BYTES pattern in setup/keyring.ts.
const SIDECAR_MAX_BYTES = 1 * 1024 * 1024;

function parseSidecar(raw: string): SidecarSignature {
    let obj: unknown;
    try {
        obj = JSON.parse(raw);
    } catch (e) {
        throw new SigningError(
            `sidecar is not valid JSON: ${(e as Error).message}`,
            "INVALID_SIDECAR",
        );
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new SigningError("sidecar is not a JSON object", "INVALID_SIDECAR");
    }
    const o = obj as Record<string, unknown>;
    const fields = [
        "kindly_sig", "alg", "filter_version", "manifest_hash",
        "signer_public_key", "signer_key_id", "signature",
    ] as const;
    for (const k of fields) {
        if (typeof o[k] !== "string") {
            throw new SigningError(`sidecar missing string field: ${k}`, "INVALID_SIDECAR");
        }
    }
    const filterVersion = o.filter_version as string;
    if (filterVersion.length > FILTER_VERSION_MAX_LEN) {
        throw new SigningError(
            `sidecar filter_version is ${filterVersion.length} chars (max ${FILTER_VERSION_MAX_LEN})`,
            "INVALID_SIDECAR",
        );
    }
    if (!FILTER_VERSION_RE.test(filterVersion)) {
        throw new SigningError(
            "sidecar filter_version does not match vX.Y.Z[-<pre>] shape",
            "INVALID_SIDECAR",
        );
    }
    return {
        kindly_sig: o.kindly_sig as "v1",
        alg: o.alg as "ed25519",
        filter_version: filterVersion,
        manifest_hash: o.manifest_hash as string,
        signer_public_key: o.signer_public_key as string,
        signer_key_id: o.signer_key_id as string,
        signature: o.signature as string,
    };
}
