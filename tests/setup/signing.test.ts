// W39 signing primitive tests. The crypto layer doesn't make trust
// decisions — those live above it (TOFU, key registry, doctor). What we
// test here:
//   - sign-then-verify round-trips on a real .kset
//   - tampered archive (post-sign) → MANIFEST_HASH_MISMATCH at verify
//   - tampered signature bytes → SIGNATURE_INVALID
//   - swapped public key (sig made by A, sidecar claims B) → INVALID_SIDECAR
//   - wrong filter_version → UNSUPPORTED_FILTER_VERSION
//   - cross-file signature substitution (lift sidecar from archive A,
//     drop next to archive B) → MANIFEST_HASH_MISMATCH
//
// These are crypto-layer guarantees. They DO NOT establish that the
// signer is trustworthy — that's what TOFU / key registry above this
// layer does.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { packSetup } from "../../src/setup/pack.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import {
    signSetupArchive, verifySetupArchive, SigningError,
    KINDLY_FILTER_VERSION, buildSigningInput, keyIdFromPublicKey,
    type SidecarSignature,
} from "../../src/setup/signing.ts";

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kindly-signtest-"));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

function mkKeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
        publicKeyPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    };
}

function fatManifest(): SetupManifest {
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "Sig Test", created_at: "2026-04-25T00:00:00Z" },
        apply_mode: "additive",
        plugins: {
            files: [{
                path: "SSH.koplugin/main.lua",
                hash: hashBytes(ssh),
                bytes: ssh.length,
            }],
        },
    });
}

function packedArchive(): { archivePath: string; manifest: SetupManifest } {
    const m = fatManifest();
    const files = new Map<string, Buffer>([
        ["SSH.koplugin/main.lua", Buffer.from("-- SSH stub\n", "utf8")],
    ]);
    const out = join(workDir, "test.kset");
    packSetup({ manifest: m, files }, out);
    return { archivePath: out, manifest: m };
}

describe("signing primitive — round-trip", () => {
    test("sign produces a sidecar that verify accepts", () => {
        const { archivePath } = packedArchive();
        const keys = mkKeyPair();

        const sidecar = signSetupArchive({ archivePath, ...keys });
        expect(sidecar.alg).toBe("ed25519");
        expect(sidecar.kindly_sig).toBe("v1");
        expect(sidecar.filter_version).toBe(KINDLY_FILTER_VERSION);
        expect(sidecar.manifest_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(sidecar.signer_key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(Buffer.from(sidecar.signature, "base64").length).toBe(64);
        expect(Buffer.from(sidecar.signer_public_key, "base64").length).toBe(32);
        expect(existsSync(`${archivePath}.sig`)).toBe(true);

        const result = verifySetupArchive(archivePath);
        expect(result.sidecar).toEqual(sidecar);
        expect(result.derivedManifestHash).toBe(sidecar.manifest_hash);
        expect(result.signerKeyId).toBe(sidecar.signer_key_id);
    });

    test("buildSigningInput is stable + domain-separated", () => {
        const a = buildSigningInput("sha256:" + "0".repeat(64), "v0.12.0");
        const b = buildSigningInput("sha256:" + "0".repeat(64), "v0.12.0");
        expect(a.equals(b)).toBe(true);
        expect(a.toString("utf8").startsWith("kindly-sig:v1\n")).toBe(true);
    });

    test("keyIdFromPublicKey rejects non-32-byte input", () => {
        expect(() => keyIdFromPublicKey(Buffer.alloc(31))).toThrow(SigningError);
        expect(() => keyIdFromPublicKey(Buffer.alloc(33))).toThrow(SigningError);
        const id = keyIdFromPublicKey(Buffer.alloc(32, 7));
        expect(id).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
});

describe("signing primitive — failure modes", () => {
    function loadSidecar(p: string): SidecarSignature {
        return JSON.parse(readFileSync(`${p}.sig`, "utf8")) as SidecarSignature;
    }
    function writeSidecar(p: string, s: SidecarSignature): void {
        writeFileSync(`${p}.sig`, JSON.stringify(s, null, 2) + "\n", "utf8");
    }

    test("tampered archive after sign → MANIFEST_HASH_MISMATCH", () => {
        // Sign archive A. Then re-pack a different archive at the same
        // path (different file bytes → different manifest hash). The
        // sidecar is now bound to a hash the new archive won't produce.
        const { archivePath } = packedArchive();
        const keys = mkKeyPair();
        signSetupArchive({ archivePath, ...keys });

        // Re-pack with different file contents.
        const ssh2 = Buffer.from("-- SSH v2\n", "utf8");
        const m2 = parseManifest({
            kindly_setup: "v1",
            meta: { name: "Sig Test", created_at: "2026-04-25T00:00:00Z" },
            apply_mode: "additive",
            plugins: { files: [{ path: "SSH.koplugin/main.lua", hash: hashBytes(ssh2), bytes: ssh2.length }] },
        });
        packSetup({ manifest: m2, files: new Map([["SSH.koplugin/main.lua", ssh2]]) }, archivePath);

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("MANIFEST_HASH_MISMATCH");
        }
    });

    test("flipped signature byte → SIGNATURE_INVALID", () => {
        const { archivePath } = packedArchive();
        const keys = mkKeyPair();
        signSetupArchive({ archivePath, ...keys });

        const sidecar = loadSidecar(archivePath);
        const sig = Buffer.from(sidecar.signature, "base64");
        sig[0] = sig[0]! ^ 0x01;
        sidecar.signature = sig.toString("base64");
        writeSidecar(archivePath, sidecar);

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("SIGNATURE_INVALID");
        }
    });

    test("attacker swaps public key but keeps signer_key_id → INVALID_SIDECAR", () => {
        // Real signature was made by A. Attacker overwrites
        // signer_public_key with B's pubkey but leaves signer_key_id
        // pointing at A's key-id (or vice versa). The pubkey-vs-key-id
        // check catches it before crypto.verify ever runs.
        const { archivePath } = packedArchive();
        const a = mkKeyPair();
        const b = mkKeyPair();
        signSetupArchive({ archivePath, ...a });

        const sidecar = loadSidecar(archivePath);
        // Replace pubkey with B's, leave A's key_id in place.
        // Extract B's raw 32B pubkey from its SPKI PEM.
        const bSpkiDer = (require("node:crypto") as typeof import("node:crypto"))
            .createPublicKey(b.publicKeyPem).export({ format: "der", type: "spki" });
        sidecar.signer_public_key = Buffer.from(bSpkiDer.subarray(12)).toString("base64");
        // signer_key_id intentionally NOT updated.
        writeSidecar(archivePath, sidecar);

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("INVALID_SIDECAR");
        }
    });

    test("attacker updates BOTH key fields → SIGNATURE_INVALID", () => {
        // The defense in depth: even if the attacker updates pubkey
        // AND key_id together (so they match each other), the signature
        // was made by A's private key — Ed25519 verify with B's pubkey
        // fails.
        const { archivePath } = packedArchive();
        const a = mkKeyPair();
        const b = mkKeyPair();
        signSetupArchive({ archivePath, ...a });

        const sidecar = loadSidecar(archivePath);
        const bSpkiDer = (require("node:crypto") as typeof import("node:crypto"))
            .createPublicKey(b.publicKeyPem).export({ format: "der", type: "spki" });
        const bRaw = Buffer.from(bSpkiDer.subarray(12));
        sidecar.signer_public_key = bRaw.toString("base64");
        sidecar.signer_key_id = keyIdFromPublicKey(bRaw);
        writeSidecar(archivePath, sidecar);

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("SIGNATURE_INVALID");
        }
    });

    test("filter_version drift → UNSUPPORTED_FILTER_VERSION", () => {
        const { archivePath } = packedArchive();
        const keys = mkKeyPair();
        // Sign at a future filter_version this build doesn't accept.
        signSetupArchive({ archivePath, ...keys, filterVersion: "v9.9.9" });

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("UNSUPPORTED_FILTER_VERSION");
        }
    });

    test("cross-file signature substitution → MANIFEST_HASH_MISMATCH", () => {
        // Sign archive A. Build a different archive B (different
        // contents → different manifest hash). Drop A's sidecar next to
        // B. Verify against B should reject.
        const a = packedArchive();
        const keys = mkKeyPair();
        signSetupArchive({ archivePath: a.archivePath, ...keys });
        const aSidecar = readFileSync(`${a.archivePath}.sig`, "utf8");

        // Build archive B at a different path with different contents.
        const sshB = Buffer.from("-- different SSH stub\n", "utf8");
        const mB = parseManifest({
            kindly_setup: "v1",
            meta: { name: "Sig Test B", created_at: "2026-04-25T00:00:00Z" },
            apply_mode: "additive",
            plugins: { files: [{ path: "SSH.koplugin/main.lua", hash: hashBytes(sshB), bytes: sshB.length }] },
        });
        const archiveB = join(workDir, "b.kset");
        packSetup({ manifest: mB, files: new Map([["SSH.koplugin/main.lua", sshB]]) }, archiveB);
        writeFileSync(`${archiveB}.sig`, aSidecar, "utf8");

        try {
            verifySetupArchive(archiveB);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("MANIFEST_HASH_MISMATCH");
        }
    });

    test("malformed sidecar JSON → INVALID_SIDECAR", () => {
        const { archivePath } = packedArchive();
        writeFileSync(`${archivePath}.sig`, "{not json", "utf8");

        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("INVALID_SIDECAR");
        }
    });

    test("missing sidecar → INVALID_SIDECAR", () => {
        const { archivePath } = packedArchive();
        // Don't write a sidecar at all.
        try {
            verifySetupArchive(archivePath);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(SigningError);
            expect((e as SigningError).code).toBe("INVALID_SIDECAR");
        }
    });
});

describe("signing — Q2 Option B filter-invariance enforcement", () => {
    // The publisher pipeline must produce filter-invariant bytes before
    // signing. Q2b: sign() refuses unprepared input. Q2 Option B:
    // verify() also re-runs the filter, so a compromised pipeline can't
    // ship signed-but-malformed bytes — receiver catches it.
    test("sign refuses non-NFC manifest input", async () => {
        // Build an archive whose manifest carries an NFD string. We
        // bypass the canonical pack path by writing manifest bytes
        // directly so unpackSetup will accept it but filter check fails.
        const ssh = Buffer.from("-- SSH\n", "utf8");
        const sshHash = hashBytes(ssh);
        const nameNFD = "Café".normalize("NFD");
        // Self-check: NFD form has more codepoints than NFC.
        expect(nameNFD.length).toBeGreaterThan("Café".normalize("NFC").length);
        const yaml =
            "apply_mode: additive\n" +
            "kindly_setup: v1\n" +
            "meta:\n" +
            "  created_at: 2026-04-25T00:00:00Z\n" +
            `  name: ${nameNFD}\n` +
            "plugins:\n" +
            "  files:\n" +
            "    - bytes: " + ssh.length + "\n" +
            "      hash: " + sshHash + "\n" +
            "      path: SSH.koplugin/main.lua\n";

        const stage = mkdtempSync(join(tmpdir(), "kindly-filtertest-"));
        try {
            mkdirSync(join(stage, "plugins/SSH.koplugin"), { recursive: true });
            writeFileSync(join(stage, "manifest.yaml"), yaml, "utf8");
            writeFileSync(join(stage, "plugins/SSH.koplugin/main.lua"), ssh);
            const archive = join(workDir, "nfd.kset");
            const { spawnSync } = await import("node:child_process");
            const r = spawnSync("tar", ["-czf", archive, "-C", stage, "manifest.yaml", "plugins"]);
            expect(r.status).toBe(0);

            const keys = mkKeyPair();
            try {
                signSetupArchive({ archivePath: archive, ...keys });
                throw new Error("expected throw");
            } catch (e) {
                expect(e).toBeInstanceOf(SigningError);
                expect((e as SigningError).code).toBe("FILTER_NOT_INVARIANT");
            }
        } finally {
            rmSync(stage, { recursive: true, force: true });
        }
    });
});

describe("signing — canonical-tree binding (W46 invariant)", () => {
    // The whole point of Q1 = canonical-tree: a signature made over
    // archive A built on macOS must verify against archive B built on
    // Linux when the underlying tree is logically identical.
    //
    // We can't easily simulate Linux on macOS, but we CAN simulate the
    // canonical-equivalence: hand-build two archives whose canonical
    // manifests are byte-equal, sign one, verify the OTHER sidecar
    // against neither — what we test instead is that the signing input
    // depends only on canonical hash + filter_version, not on archive
    // bytes (rebuilding the same tar.gz a second time wouldn't change
    // the sig either).
    test("re-pack of identical input → same signing input → same sig under same key", () => {
        const a = packedArchive();
        const keys = mkKeyPair();
        const sigA = signSetupArchive({ archivePath: a.archivePath, ...keys });

        // Repack the same logical tree at a different path.
        const m = fatManifest();
        const files = new Map<string, Buffer>([
            ["SSH.koplugin/main.lua", Buffer.from("-- SSH stub\n", "utf8")],
        ]);
        const second = join(workDir, "again.kset");
        packSetup({ manifest: m, files }, second);
        const sigB = signSetupArchive({ archivePath: second, ...keys });

        // Ed25519 is deterministic — same key + same input → same sig
        // bytes. Both archives carry the same canonical manifest hash.
        expect(sigA.manifest_hash).toBe(sigB.manifest_hash);
        expect(sigA.signature).toBe(sigB.signature);
    });
});
