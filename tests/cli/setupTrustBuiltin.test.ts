// W39 upstream key distribution — integration tests.
//
// The local-roster lifecycle is covered by setupTrustE2E.test.ts. This
// file exercises the *built-in* registry path:
//
//   - `setup verify --json` reports `trust_source: "builtin"` when the
//     signer key_id matches a curated publisher
//   - `setup trust list --json` returns `{builtin, local}` and lists
//     curated publishers under the `builtin` group
//   - `setup trust add <pub>` for a key that already lives in the
//     built-in registry is rejected with BUILTIN_KEY_ALREADY_TRUSTED
//   - `setup trust remove <prefix>` for a built-in key_id is rejected
//     with BUILTIN_KEY_NOT_REMOVABLE
//   - `setup import` succeeds against a built-in publisher without
//     `--accept-untrusted-signature`
//
// The committed v0.13 keyring ships with `publishers: []`. To exercise
// the "matches a built-in publisher" path without polluting the source
// tree, we use the test-only injection seam
// (`_overrideBuiltinKeyringForTests`) to install a synthetic curated
// entry whose key_id matches an Ed25519 keypair generated in-test.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { packSetup } from "../../src/setup/pack.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import {
    keyIdFromPublicKey,
    signSetupArchive,
} from "../../src/setup/signing.ts";
import {
    _overrideBuiltinKeyringForTests,
    _resetBuiltinKeyringCacheForTests,
    BuiltinKeyringSchema,
    type BuiltinKeyring,
} from "../../src/setup/builtinKeyring.ts";

function makeFakeKindle(): { root: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-builtin-k-"));
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

function mkKeyPair(): {
    privatePem: string;
    publicPem: string;
    keyId: string;
    pubB64: string;
} {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
    // Mirror keyring.ts:rawEd25519PublicKey — last 32 bytes of SPKI DER
    // are the raw Ed25519 pubkey.
    const der = createPublicKey(publicPem).export({ format: "der", type: "spki" });
    const raw = Buffer.from(der.subarray(12));
    const keyId = keyIdFromPublicKey(raw);
    const pubB64 = raw.toString("base64");
    return { privatePem, publicPem, keyId, pubB64 };
}

function buildSignedArchive(
    home: string, keys: { privatePem: string; publicPem: string },
): string {
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    const manifest: SetupManifest = parseManifest({
        kindly_setup: "v1",
        meta: { name: "Builtin Trust", created_at: "2026-04-26T00:00:00Z" },
        apply_mode: "additive",
        plugins: {
            files: [{
                path: "SSH.koplugin/main.lua",
                hash: hashBytes(ssh),
                bytes: ssh.length,
            }],
        },
    });
    const archive = join(home, "kindly-curated.kset");
    packSetup({ manifest, files: new Map([["SSH.koplugin/main.lua", ssh]]) }, archive);
    signSetupArchive({
        archivePath: archive,
        privateKeyPem: keys.privatePem,
        publicKeyPem: keys.publicPem,
    });
    return archive;
}

function installBuiltinPublisher(keyId: string, pubB64: string, label: string): void {
    const k: BuiltinKeyring = BuiltinKeyringSchema.parse({
        kindly_builtin_keyring: "v1",
        curated_at: "2026-04-26",
        publishers: [{
            key_id: keyId,
            public_key_b64: pubB64,
            label,
            description: "test fixture publisher",
            since: "v0.13.0",
        }],
    });
    _overrideBuiltinKeyringForTests(k);
}

let home: string;
let kindle: ReturnType<typeof makeFakeKindle>;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-builtin-h-"));
    kindle = makeFakeKindle();
});

afterEach(() => {
    // Drop the synthetic built-in keyring so other suites see the real
    // committed empty list.
    _resetBuiltinKeyringCacheForTests();
});

describe("setup verify — built-in registry", () => {
    test("verify --json reports trust_source: 'builtin' when key matches a curated publisher", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");
        const archive = buildSignedArchive(home, keys);

        const { env, out } = makeEnv(home, kindle.root);
        const code = await main(["setup", "verify", "--json", archive], env);
        expect(code).toBe(0);
        const payload = JSON.parse(out.value);
        expect(payload.data.ok).toBe(true);
        expect(payload.data.trusted).toBe(true);
        expect(payload.data.trust_source).toBe("builtin");
        expect(payload.data.signer_label).toBe("kindly-builtin: kindly-team");
    });

    test("verify pretty output shows '(built-in)' tag when matched via registry", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");
        const archive = buildSignedArchive(home, keys);

        const { env, out } = makeEnv(home, kindle.root);
        const code = await main(["setup", "verify", archive], env);
        expect(code).toBe(0);
        expect(out.value).toContain("trusted");
        expect(out.value).toContain("(built-in)");
        expect(out.value).toContain("kindly-builtin: kindly-team");
    });

    test("local roster wins when same key ends up in both rosters", async () => {
        // Models the real upgrade scenario: a user adds bob's key with
        // `setup trust add`, then a later kindly release ships with
        // bob in the built-in registry. The CLI guard rejects new
        // duplicate adds (BUILTIN_KEY_ALREADY_TRUSTED) but the
        // pre-existing local entry remains. Verify must still report
        // "local" so the audit trail is preserved.
        //
        // We write the local roster directly (bypassing the CLI guard
        // that prevents this state from being created post-upgrade).
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "from-builtin");

        const { mkdirSync: mkdir, chmodSync: chmod, writeFileSync: write } = await import("node:fs");
        const dotKindly = join(home, ".kindly");
        mkdir(dotKindly, { recursive: true });
        if (process.platform !== "win32") chmod(dotKindly, 0o700);
        write(join(dotKindly, "trusted-keys.json"), JSON.stringify({
            kindly_trust: "v1",
            keys: [{
                key_id: keys.keyId,
                public_key_b64: keys.pubB64,
                label: "from-local",
                added_at: "2026-04-26T12:00:00.000Z",
            }],
        }));

        const archive = buildSignedArchive(home, keys);
        const { env, out } = makeEnv(home, kindle.root);
        const code = await main(["setup", "verify", "--json", archive], env);
        expect(code).toBe(0);
        const payload = JSON.parse(out.value);
        expect(payload.data.trust_source).toBe("local");
        expect(payload.data.signer_label).toBe("from-local");
    });
});

describe("setup trust list — grouping by source", () => {
    test("--json envelope returns {builtin, local} groups", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const { env, out } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "list", "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(out.value);
        expect(payload.data.builtin).toHaveLength(1);
        expect(payload.data.builtin[0].label).toBe("kindly-team");
        expect(payload.data.builtin[0].key_id).toBe(keys.keyId);
        expect(payload.data.local).toEqual([]);
    });

    test("pretty output groups built-in and local under separate headers", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        // Add a separate local key to populate both sections.
        const userKeys = mkKeyPair();
        const pubPath = join(home, "user.pub");
        writeFileSync(pubPath, userKeys.publicPem);
        const { env: addEnv } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "add", pubPath, "--label", "user-key"], addEnv);

        const { env, out } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "list"], env);
        expect(out.value).toContain("built-in (kindly-curated) — 1");
        expect(out.value).toContain("kindly-team");
        expect(out.value).toContain("local — 1");
        expect(out.value).toContain("user-key");
    });
});

describe("setup trust add — duplicate-with-builtin guard", () => {
    test("adding a key that's already in the built-in registry → BUILTIN_KEY_ALREADY_TRUSTED", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const pubPath = join(home, "kindly-team.pub");
        writeFileSync(pubPath, keys.publicPem);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "add", pubPath], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("already trusted via the built-in registry");
    });

    test("--json mode emits BUILTIN_KEY_ALREADY_TRUSTED code", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const pubPath = join(home, "kindly-team.pub");
        writeFileSync(pubPath, keys.publicPem);

        // emitJsonError writes the error envelope to stderr — same shape
        // as setupImportSignerTrust.test.ts:130.
        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "add", "--json", pubPath], env);
        expect(code).not.toBe(0);
        const payload = JSON.parse(err.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("BUILTIN_KEY_ALREADY_TRUSTED");
    });
});

describe("setup trust remove — built-in non-removability", () => {
    test("remove with prefix matching a built-in key → BUILTIN_KEY_NOT_REMOVABLE", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const { env, err } = makeEnv(home, kindle.root);
        const prefix = keys.keyId.slice(0, 20);
        const code = await main(["setup", "trust", "remove", prefix], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("matches built-in publisher key");
        expect(err.value).toContain("Built-in keys are managed by kindly upgrades");
    });

    test("--json mode emits BUILTIN_KEY_NOT_REMOVABLE code", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "trust", "remove", "--json", keys.keyId,
        ], env);
        expect(code).not.toBe(0);
        const payload = JSON.parse(err.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("BUILTIN_KEY_NOT_REMOVABLE");
    });

    test("remove with full built-in key_id → matches built-in publisher key", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "remove", keys.keyId], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("matches built-in publisher key");
    });

    test("remove of a local-only key still works when built-in keyring is populated", async () => {
        // Make sure the built-in guard doesn't accidentally block all
        // remove operations.
        const builtinKeys = mkKeyPair();
        installBuiltinPublisher(builtinKeys.keyId, builtinKeys.pubB64, "kindly-team");

        const localKeys = mkKeyPair();
        const pubPath = join(home, "local.pub");
        writeFileSync(pubPath, localKeys.publicPem);
        const { env: addEnv } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "add", pubPath, "--label", "local-only"], addEnv);

        const { env, out } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "remove", localKeys.keyId], env);
        expect(code).toBe(0);
        expect(out.value).toContain("removed key");
        expect(out.value).toContain("was labeled: local-only");
    });

    // Round-3 trust-remove conflict (Angle 6): when a prefix matches BOTH
    // a built-in key and a local key, the user is entitled to remove
    // the local entry — but the prior implementation rejected with
    // BUILTIN_KEY_NOT_REMOVABLE without disclosing the local match,
    // leaving the user unable to recover. Surface the local match in
    // the remediation so the user can pass the full local key_id.
    test("cross-roster prefix collision discloses local match in remediation", async () => {
        // Engineer a prefix that matches both rosters by using the
        // "sha256:" header itself — every key_id starts with it, so
        // the prefix overlaps any local + any built-in entry.
        const builtinKeys = mkKeyPair();
        installBuiltinPublisher(builtinKeys.keyId, builtinKeys.pubB64, "kindly-team");

        const localKeys = mkKeyPair();
        const pubPath = join(home, "local.pub");
        writeFileSync(pubPath, localKeys.publicPem);
        const { env: addEnv } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "add", pubPath, "--label", "victim"], addEnv);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "trust", "remove", "sha256:"], env);
        expect(code).not.toBe(0);
        // Original built-in rejection message still appears.
        expect(err.value).toContain("matches built-in publisher key");
        // NEW: local match must be disclosed so the user can act.
        expect(err.value).toContain("Prefix also matches local key");
        expect(err.value).toContain(localKeys.keyId);
        expect(err.value).toContain("pass the full key_id");
    });

    test("--json mode includes local-collision remediation in the envelope", async () => {
        const builtinKeys = mkKeyPair();
        installBuiltinPublisher(builtinKeys.keyId, builtinKeys.pubB64, "kindly-team");

        const localKeys = mkKeyPair();
        const pubPath = join(home, "local.pub");
        writeFileSync(pubPath, localKeys.publicPem);
        const { env: addEnv } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "add", pubPath, "--label", "victim"], addEnv);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "trust", "remove", "--json", "sha256:",
        ], env);
        expect(code).not.toBe(0);
        const payload = JSON.parse(err.value);
        expect(payload.error.code).toBe("BUILTIN_KEY_NOT_REMOVABLE");
        const remediations = payload.error.remediation as Array<{ text: string }>;
        const localHint = remediations.find((r) =>
            r.text.includes("Prefix also matches local key"),
        );
        expect(localHint).toBeDefined();
        expect(localHint!.text).toContain(localKeys.keyId);
    });
});

describe("setup import — signed by built-in publisher", () => {
    test("import succeeds without --accept-untrusted-signature when signer is in built-in registry", async () => {
        const keys = mkKeyPair();
        installBuiltinPublisher(keys.keyId, keys.pubB64, "kindly-team");
        const archive = buildSignedArchive(home, keys);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-plugins", archive,
        ], env);
        // 0 = clean, 4 = warnings (fat-archive consent banner) — both
        // acceptable. UNTRUSTED_SIGNER would be exit 3.
        expect(code === 0 || code === 4).toBe(true);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");
        expect(err.value).not.toContain("not in your trust roster");
    });
});
