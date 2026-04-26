// W39 step 5 — `kindly setup import` consults the local trust roster
// when the .kset carries a signature sidecar. Untrusted (or unknown-trust)
// signers block the import; --accept-untrusted-signature unlocks the case
// where the user trusts the publisher out-of-band and just hasn't installed
// their key on this machine.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
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
    const root = mkdtempSync(join(tmpdir(), "kindly-import-sigtrust-k-"));
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
    cwd: string, mount: string,
): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride: mount,
            homeOverride: cwd,
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

function fatManifest(): { manifest: SetupManifest; files: Map<string, Buffer> } {
    // Minimal fat Setup — one shipped plugin file (packSetup refuses
    // to pack a lean Setup). The plugin is uncatalogued so it sits in
    // SHIPPED but won't trip the strict-imports / hash gates as long
    // as we don't pass --strict-imports.
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    return {
        manifest: parseManifest({
            kindly_setup: "v1",
            meta: { name: "Sig Trust Test", created_at: "2026-04-26T00:00:00Z" },
            apply_mode: "additive",
            plugins: {
                files: [{
                    path: "SSH.koplugin/main.lua",
                    hash: hashBytes(ssh),
                    bytes: ssh.length,
                }],
            },
        }),
        files: new Map([["SSH.koplugin/main.lua", ssh]]),
    };
}

function packSigned(
    home: string, keys: { privatePem: string; publicPem: string },
): string {
    const archivePath = join(home, "test.kset");
    const { manifest, files } = fatManifest();
    packSetup({ manifest, files }, archivePath);
    signSetupArchive({
        archivePath,
        privateKeyPem: keys.privatePem,
        publicKeyPem: keys.publicPem,
    });
    return archivePath;
}

function packUnsigned(home: string): string {
    const archivePath = join(home, "unsigned.kset");
    const { manifest, files } = fatManifest();
    packSetup({ manifest, files }, archivePath);
    return archivePath;
}

let home: string;
let kindle: ReturnType<typeof makeFakeKindle>;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-import-sigtrust-h-"));
    kindle = makeFakeKindle();
});

// ---- Untrusted signer → blocked ------------------------------------------

describe("setup import — signed by untrusted key", () => {
    test("untrusted signer → blocks with UNTRUSTED_SIGNER", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "import", archive], env);
        expect(code).toBe(3); // POLICY_BLOCK_CODES → exit 3
        expect(err.value).toContain("not in your trust roster");
        expect(err.value).toContain("kindly setup trust add");
    });

    test("untrusted signer in --json mode → KindlyError envelope with code", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        // emitJsonError writes the error envelope to stderr (not stdout) so
        // tools that pipe stdout to a JSON parser don't choke on a half-empty
        // stream when the command fails.
        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "import", "--json", archive], env);
        expect(code).toBe(3);
        const payload = JSON.parse(err.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("UNTRUSTED_SIGNER");
        expect(payload.error.message).toContain("not in your trust roster");
    });

    test("untrusted signer + --dry-run → still blocks", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "import", "--dry-run", archive], env);
        expect(code).toBe(3);
        expect(err.value).toContain("not in your trust roster");
    });
});

// ---- Trusted signer → success ---------------------------------------------

describe("setup import — signed by trusted key", () => {
    test("after `trust add` → import proceeds (no UNTRUSTED_SIGNER block)", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const pubPath = join(home, "publisher.pub");
        writeFileSync(pubPath, keys.publicPem);

        const { env: addEnv } = makeEnv(home, kindle.root);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], addEnv);

        // Pass --accept-plugins to unblock the FAT-consent gate that fires
        // after SIGNER_TRUSTED — we're isolating the trust-gate behavior,
        // and other policy gates have their own tests.
        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-plugins", archive,
        ], env);
        // Either 0 (clean) or 4 (warnings) is fine; what we forbid is 3
        // (policy block) — the trust gate must not fire when the signer
        // is in the roster.
        expect(code === 0 || code === 4).toBe(true);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");
        expect(err.value).not.toContain("not in your trust roster");
    });
});

// ---- --accept-untrusted-signature bypass ---------------------------------

describe("setup import — --accept-untrusted-signature bypass", () => {
    test("untrusted + bypass → proceeds, gate-event recorded", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-plugins",
            "--accept-untrusted-signature", archive,
        ], env);
        expect(code === 0 || code === 4).toBe(true);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");

        // Bypass is sticky: the gate orchestrator emits a gate-event so
        // it's auditable. gateLogPath(cwd) keeps these CLI-side under
        // <cwd>/.kindly/, separate from the on-device .kindly/ tree.
        const eventsPath = join(home, ".kindly", "gate-events.jsonl");
        expect(existsSync(eventsPath)).toBe(true);
        const events = readFileSync(eventsPath, "utf8")
            .split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const bypass = events.find((e) =>
            e.gate_id === "SIGNER_TRUSTED" && e.kind === "bypass",
        );
        expect(bypass).toBeDefined();
    });

    test("--dry-run + bypass → still bypasses the trust gate", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        // Dry-run + accept-plugins so the only gate at play here is
        // SIGNER_TRUSTED. Without the bypass this would be exit 3
        // (UNTRUSTED_SIGNER); with the bypass it should not be.
        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--dry-run", "--accept-plugins",
            "--accept-untrusted-signature", archive,
        ], env);
        expect(code).not.toBe(3);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");
    });
});

// ---- Corrupt roster → fail closed ----------------------------------------

describe("setup import — corrupt roster", () => {
    test("corrupt roster → blocks (fail closed)", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const dotKindly = join(home, ".kindly");
        mkdirSync(dotKindly, { recursive: true });
        writeFileSync(join(dotKindly, "trusted-keys.json"), "{ not json", "utf8");

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "import", archive], env);
        expect(code).toBe(3);
        expect(err.value).toContain("trust state is unknown");
    });

    test("corrupt roster + --accept-untrusted-signature → trust gate bypasses", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const dotKindly = join(home, ".kindly");
        mkdirSync(dotKindly, { recursive: true });
        writeFileSync(join(dotKindly, "trusted-keys.json"), "{ not json", "utf8");

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-plugins",
            "--accept-untrusted-signature", archive,
        ], env);
        expect(code).not.toBe(3);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");
    });
});

// ---- Crypto-broken sidecar → SETUP_SIGNATURE_INVALID ---------------------

describe("setup import — broken sidecar", () => {
    test("tampered sidecar bytes → SETUP_SIGNATURE_INVALID (not UNTRUSTED_SIGNER)", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        // Flip a byte in the sidecar's signature.
        const sidecarPath = `${archive}.sig`;
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
        const sigBuf = Buffer.from(sidecar.signature, "base64");
        sigBuf[0] ^= 0xff;
        sidecar.signature = sigBuf.toString("base64");
        writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main(["setup", "import", "--json", archive], env);
        expect(code).not.toBe(0);
        // JSON-mode error envelope lands on stderr; broken-crypto
        // surfaces as SETUP_SIGNATURE_INVALID, not UNTRUSTED_SIGNER —
        // the bypass flag deliberately does not cover crypto failure.
        const payload = JSON.parse(err.value);
        expect(payload.error.code).toBe("SETUP_SIGNATURE_INVALID");
    });

    test("--accept-untrusted-signature does NOT bypass broken sidecar", async () => {
        const keys = mkKeyPair();
        const archive = packSigned(home, keys);

        const sidecarPath = `${archive}.sig`;
        const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
        const sigBuf = Buffer.from(sidecar.signature, "base64");
        sigBuf[0] ^= 0xff;
        sidecar.signature = sigBuf.toString("base64");
        writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

        const { env } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-untrusted-signature", archive,
        ], env);
        expect(code).not.toBe(0);
    });
});

// ---- Unsigned Setup → no gate fires --------------------------------------

describe("setup import — unsigned Setup", () => {
    test("no sidecar → SIGNER_TRUSTED passes, no trust-related error", async () => {
        const archive = packUnsigned(home);

        const { env, err } = makeEnv(home, kindle.root);
        const code = await main([
            "setup", "import", "--accept-plugins", archive,
        ], env);
        // Unsigned is the v0.13 default; the gate is opt-in based on
        // sidecar presence. Trust gate must not fire here.
        expect(code === 0 || code === 4).toBe(true);
        expect(err.value).not.toContain("UNTRUSTED_SIGNER");
        expect(err.value).not.toContain("not in your trust roster");
    });
});
