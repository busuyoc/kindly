// W39 signing primitive — Ed25519 over the canonical extracted tree.
//
// Trust contract (Q1 = canonical-tree, Q2 = verifier-independent re-filter,
// Q3 = canonical-hash-identical):
//
//   signing input = "kindly-sig:v1\n" + manifest_hash + "\n" + filter_version + "\n"
//   signature     = Ed25519(signing input, signer_private_key)
//
// What's deliberately NOT here yet:
//   - Q2 Option B re-filter check (verifier asserts filter(input) == input).
//     The filter is currently spread across producers (apply.ts, restore.ts,
//     importSetup.ts) and not packaged as a single deterministic function.
//     Today the filter_version field rides in the signing payload but no
//     re-filter is run. Once filter is consolidated, verify() must reject
//     inputs whose filter_version isn't supported AND whose canonical bytes
//     don't survive the re-filter unchanged.
//   - Q2b mandatory `prepare` step. Today sign() accepts any valid .kset.
//     Once the filter is packaged, sign() should refuse if the input isn't
//     filter-invariant under its declared filter_version.
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

import { readFileSync, writeFileSync } from "node:fs";
import {
    createPrivateKey, createPublicKey, createHash,
    sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";
import { unpackSetup } from "./unpack.ts";
import { manifestHash as computeManifestHash } from "./canonical.ts";

/** The filter version this build of kindly speaks. Bound into every
 *  signature so v0.13's tightened filter doesn't silently re-validate
 *  v0.12 packages under different rules.
 *
 *  Q2a: bumps when the filter's behavior changes in any
 *  observable way (new control-byte rejection, different NFC handling,
 *  added classify entries that affect filter_invariant). N=2 generation
 *  window: a verifier on v0.13 accepts filter_version "v0.13.0" and
 *  "v0.12.0"; rejects older. */
export const KINDLY_FILTER_VERSION = "v0.12.0";

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
    | "UNSUPPORTED_FORMAT";

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

    // TODO(Q2b): once C1 is consolidated, re-filter the canonical tree
    // and refuse if filter(tree) != tree. Today: accept anything that
    // unpackSetup accepted.

    const priv = createPrivateKey(opts.privateKeyPem);
    if (priv.asymmetricKeyType !== "ed25519") {
        throw new SigningError(
            `expected Ed25519 private key, got ${priv.asymmetricKeyType ?? "unknown"}`,
            "INVALID_KEY",
        );
    }
    const rawPub = rawEd25519PublicKey(opts.publicKeyPem);
    const keyId = keyIdFromPublicKey(rawPub);

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

    // Q2a generation window: today the only accepted filter_version is
    // KINDLY_FILTER_VERSION. When v0.13 lands, accept N=2 generations.
    if (sidecar.filter_version !== KINDLY_FILTER_VERSION) {
        throw new SigningError(
            `signature was made under filter_version=${sidecar.filter_version}, ` +
            `this build only verifies ${KINDLY_FILTER_VERSION}`,
            "UNSUPPORTED_FILTER_VERSION",
        );
    }

    const unpacked = unpackSetup(archivePath);
    const derivedHash = computeManifestHash(unpacked.manifest);
    if (derivedHash !== sidecar.manifest_hash) {
        throw new SigningError(
            `manifest hash mismatch: archive yields ${derivedHash}, sidecar declares ${sidecar.manifest_hash}`,
            "MANIFEST_HASH_MISMATCH",
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
    return {
        kindly_sig: o.kindly_sig as "v1",
        alg: o.alg as "ed25519",
        filter_version: o.filter_version as string,
        manifest_hash: o.manifest_hash as string,
        signer_public_key: o.signer_public_key as string,
        signer_key_id: o.signer_key_id as string,
        signature: o.signature as string,
    };
}
