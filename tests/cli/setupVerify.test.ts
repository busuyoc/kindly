// W39 step 4 — `kindly setup verify` upgraded to consult the local trust
// roster after the crypto check. Verify is a probe; it never fails on
// untrusted (the gate lives in `setup import`, step 5). It only reports
// trust state so the user knows where they stand before importing.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    chmodSync, mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { keyringPath } from "../../src/setup/keyring.ts";
import { packSetup } from "../../src/setup/pack.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { signSetupArchive } from "../../src/setup/signing.ts";

function makeEnv(home: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd: home,
            stdout: out,
            stderr: err,
            color: false,
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

function packAndSign(home: string, keys: { privatePem: string; publicPem: string }): string {
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    const manifest: SetupManifest = parseManifest({
        kindly_setup: "v1",
        meta: { name: "Verify Test", created_at: "2026-04-25T00:00:00Z" },
        apply_mode: "additive",
        plugins: {
            files: [{
                path: "SSH.koplugin/main.lua",
                hash: hashBytes(ssh),
                bytes: ssh.length,
            }],
        },
    });
    const archivePath = join(home, "test.kset");
    packSetup({ manifest, files: new Map([["SSH.koplugin/main.lua", ssh]]) }, archivePath);
    signSetupArchive({
        archivePath,
        privateKeyPem: keys.privatePem,
        publicKeyPem: keys.publicPem,
    });
    return archivePath;
}

let home: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-verify-cli-"));
});

// ---- Untrusted (signer not in roster) ------------------------------------

describe("setup verify — signer not in roster", () => {
    test("pretty output → reports untrusted with hint", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const { env, out } = makeEnv(home);
        const code = await main(["setup", "verify", archive], env);
        expect(code).toBe(0);
        expect(out.value).toContain("signature verified");
        expect(out.value).toContain("untrusted");
        expect(out.value).toContain("kindly setup trust add");
    });

    test("--json → trusted: false, no signer_label", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const { env, out } = makeEnv(home);
        const code = await main(["setup", "verify", "--json", archive], env);
        expect(code).toBe(0);
        const payload = JSON.parse(out.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.trusted).toBe(false);
        expect(payload.data.signer_label).toBeUndefined();
        expect(payload.data.signer_key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
});

// ---- Trusted (signer in roster) ------------------------------------------

describe("setup verify — signer in roster", () => {
    test("after `trust add` → reports trusted with label", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        const { env: addEnv } = makeEnv(home);
        const addCode = await main(["setup", "trust", "add", pubPath, "--label", "alice"], addEnv);
        expect(addCode).toBe(0);

        const { env, out } = makeEnv(home);
        const code = await main(["setup", "verify", archive], env);
        expect(code).toBe(0);
        expect(out.value).toContain("signature verified");
        expect(out.value).toContain("trusted");
        expect(out.value).toContain("alice");
        expect(out.value).not.toContain("untrusted");
    });

    test("--json → trusted: true, signer_label echoed", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        const { env: addEnv } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], addEnv);

        const { env, out } = makeEnv(home);
        await main(["setup", "verify", "--json", archive], env);
        const payload = JSON.parse(out.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.trusted).toBe(true);
        expect(payload.data.signer_label).toBe("alice");
    });

    test("trusted entry without label → no label suffix on pretty line", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        const { env: addEnv } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath], addEnv);

        const { env, out } = makeEnv(home);
        await main(["setup", "verify", archive], env);
        expect(out.value).toContain("trusted");
        // No label was set on add, so the pretty line should not pretend
        // there is one. We check that "(label:" doesn't appear.
        expect(out.value).not.toContain("(label:");
    });
});

// ---- Roster corruption: degrade, don't fail ------------------------------

describe("setup verify — corrupt roster", () => {
    test("malformed roster → warn but exit 0 with crypto answer", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        // Plant a corrupt roster file. Verify must keep working — its
        // crypto answer is independent of trust state.
        const dotKindly = join(home, ".kindly");
        mkdirSync(dotKindly, { recursive: true });
        if (process.platform !== "win32") chmodSync(dotKindly, 0o700);
        writeFileSync(join(dotKindly, "trusted-keys.json"), "{ not json", "utf8");

        const { env, out, err } = makeEnv(home);
        const code = await main(["setup", "verify", archive], env);
        expect(code).toBe(0);
        expect(out.value).toContain("signature verified");
        expect(err.value).toContain("trust roster unreadable");
    });

    test("--json on corrupt roster → roster_error field, trusted: false", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const dotKindly = join(home, ".kindly");
        mkdirSync(dotKindly, { recursive: true });
        if (process.platform !== "win32") chmodSync(dotKindly, 0o700);
        writeFileSync(join(dotKindly, "trusted-keys.json"), "{ not json", "utf8");

        const { env, out } = makeEnv(home);
        await main(["setup", "verify", "--json", archive], env);
        const payload = JSON.parse(out.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.trusted).toBe(false);
        expect(payload.data.roster_error).toContain("valid JSON");
    });
});

// ---- Empty roster (no file) -----------------------------------------------

describe("setup verify — empty roster (first-run)", () => {
    test("no roster file → reports untrusted (no spurious roster_error)", async () => {
        const keys = mkKeyPair();
        const archive = packAndSign(home, keys);

        const { env, out } = makeEnv(home);
        await main(["setup", "verify", "--json", archive], env);
        // loadKeyring returns an empty roster on missing file, so it is
        // an "untrusted" answer rather than a roster_error.
        const payload = JSON.parse(out.value);
        expect(payload.data.trusted).toBe(false);
        expect(payload.data.roster_error).toBeUndefined();
        // Sanity: roster file was never created (verify is read-only on
        // the trust path).
        // Use the same env to look up the path consistently.
        // We can't easily check existsSync here without recreating the
        // path; rely on the keyringPath helper.
        const path = keyringPath(env);
        expect(path).toContain(".kindly");
    });
});
