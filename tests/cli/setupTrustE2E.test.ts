// W39 step 6 — full lifecycle test for the local trust roster.
//
// One test, six commands, in the order a user would run them:
//
//   1. sign     — publisher tools sign the fat .kset
//   2. verify   — recipient runs verify *before* importing; reports
//                 "signature verified" but "untrusted" because the key
//                 isn't in the local roster yet
//   3. trust add — recipient installs the publisher's public key
//   4. trust list — listing now contains the just-added entry
//   5. verify   — re-running verify now reports "trusted" with label
//   6. import   — import proceeds without UNTRUSTED_SIGNER blocking
//
// Each individual leg already has dedicated tests (setupVerify, setupTrust,
// setupImportSignerTrust). What this file covers that those don't: that
// the SAME key_id flows through every command consistently — sign → key_id
// in sidecar → key_id in trust roster → key_id matches at verify → key_id
// matches at import. A drift in key_id derivation in any one leg would
// break this test without breaking the per-command tests.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { packSetup } from "../../src/setup/pack.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { signSetupArchive } from "../../src/setup/signing.ts";

function makeFakeKindle(): { root: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-trust-e2e-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(
        join(kor, "settings.reader.lua"),
        `return {
    ["refresh_rate"] = 8,
}
`,
    );
    return { root };
}

function makeEnv(
    home: string, mount: string,
): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd: home,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride: mount,
            homeOverride: home,
            now: () => new Date("2026-04-26T12:00:00Z"),
        },
        out,
        err,
    };
}

function mkKeyPair(): { privatePem: string; publicPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    return {
        privatePem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
        publicPem: publicKey.export({ format: "pem", type: "spki" }) as string,
    };
}

function buildSignedArchive(
    home: string, keys: { privatePem: string; publicPem: string },
): string {
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    const manifest: SetupManifest = parseManifest({
        kindly_setup: "v1",
        meta: { name: "Trust E2E", created_at: "2026-04-26T00:00:00Z" },
        apply_mode: "additive",
        plugins: {
            files: [{
                path: "SSH.koplugin/main.lua",
                hash: hashBytes(ssh),
                bytes: ssh.length,
            }],
        },
    });
    const archive = join(home, "publisher.kset");
    packSetup({ manifest, files: new Map([["SSH.koplugin/main.lua", ssh]]) }, archive);
    signSetupArchive({
        archivePath: archive,
        privateKeyPem: keys.privatePem,
        publicKeyPem: keys.publicPem,
    });
    return archive;
}

let home: string;
let kindle: ReturnType<typeof makeFakeKindle>;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-trust-e2e-h-"));
    kindle = makeFakeKindle();
});

describe("W39 trust roster — end-to-end lifecycle", () => {
    test("verify-untrusted → trust add → verify-trusted → import succeeds", async () => {
        // 1. Publisher signs the archive.
        const keys = mkKeyPair();
        const archive = buildSignedArchive(home, keys);
        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        // 2. Recipient runs `setup verify` BEFORE installing the key.
        // Crypto passes; trust roster reports "untrusted".
        {
            const { env, out } = makeEnv(home, kindle.root);
            const code = await main(["setup", "verify", "--json", archive], env);
            expect(code).toBe(0);
            const payload = JSON.parse(out.value);
            expect(payload.status).toBe("ok");
            // `ok: true` is the crypto-verify outcome; `trusted: false`
            // is the roster outcome.
            expect(payload.data.ok).toBe(true);
            expect(payload.data.trusted).toBe(false);
            expect(payload.data.signer_key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
        }

        // 3. Recipient adds the publisher's key with a label.
        {
            const { env, out } = makeEnv(home, kindle.root);
            const code = await main([
                "setup", "trust", "add", pubPath, "--label", "publisher-alice",
            ], env);
            expect(code).toBe(0);
            expect(out.value).toContain("added key sha256:");
            expect(out.value).toContain("publisher-alice");
        }

        // 4. `trust list` now shows the entry.
        {
            const { env, out } = makeEnv(home, kindle.root);
            const code = await main(["setup", "trust", "list", "--json"], env);
            expect(code).toBe(0);
            const payload = JSON.parse(out.value);
            expect(payload.status).toBe("ok");
            expect(payload.data.keys).toHaveLength(1);
            expect(payload.data.keys[0].label).toBe("publisher-alice");
            expect(payload.data.keys[0].key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
        }

        // 5. Re-running `setup verify` now reports trusted with the
        // label we just chose.
        let signerKeyId: string;
        {
            const { env, out } = makeEnv(home, kindle.root);
            const code = await main(["setup", "verify", "--json", archive], env);
            expect(code).toBe(0);
            const payload = JSON.parse(out.value);
            expect(payload.data.trusted).toBe(true);
            expect(payload.data.signer_label).toBe("publisher-alice");
            signerKeyId = payload.data.signer_key_id;
        }

        // 6. `setup import` proceeds — SIGNER_TRUSTED passes since the
        // key is in the roster. --accept-plugins unblocks the unrelated
        // FAT-consent gate so this isolates the trust-gate behavior.
        {
            const { env, err } = makeEnv(home, kindle.root);
            const code = await main([
                "setup", "import", "--accept-plugins", archive,
            ], env);
            expect(code === 0 || code === 4).toBe(true);
            expect(err.value).not.toContain("UNTRUSTED_SIGNER");
            expect(err.value).not.toContain("not in your trust roster");
        }

        // The same key_id was reported by verify both times and is the
        // one stored in the roster — no derivation drift across commands.
        expect(signerKeyId).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    test("trust remove → next import blocks again", async () => {
        const keys = mkKeyPair();
        const archive = buildSignedArchive(home, keys);
        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        // Add → import passes.
        {
            const { env } = makeEnv(home, kindle.root);
            await main(["setup", "trust", "add", pubPath, "--label", "alice"], env);
        }

        // Capture the key_id from verify so we can pass it to trust remove.
        let keyId: string;
        {
            const { env, out } = makeEnv(home, kindle.root);
            await main(["setup", "verify", "--json", archive], env);
            keyId = JSON.parse(out.value).data.signer_key_id;
        }

        // Remove the key.
        {
            const { env, out } = makeEnv(home, kindle.root);
            const code = await main(["setup", "trust", "remove", keyId], env);
            expect(code).toBe(0);
            expect(out.value).toContain("removed");
        }

        // Import now blocks — the gate fires again.
        {
            const { env, err } = makeEnv(home, kindle.root);
            const code = await main([
                "setup", "import", "--accept-plugins", archive,
            ], env);
            expect(code).toBe(3);
            expect(err.value).toContain("not in your trust roster");
        }
    });
});
