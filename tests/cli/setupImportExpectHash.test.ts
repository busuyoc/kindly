// Integration tests for `kindly setup import --expect-hash`.
//
// Contract: docs/92-expect-hash-spec.md (W34a).
// The flag gates import on a user-supplied content-hash assertion —
// matches go through, mismatches fail with MANIFEST_HASH_MISMATCH and
// exit 1, malformed hashes fail with ArgError and exit 2 (the flag
// itself didn't parse).

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupImport } from "../../src/commands/setup.ts";
import { canonicalizeManifest, hashBytes } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
}
`;

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-eh-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "eh-test", created_at: "2026-04-23T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

// Write a manifest in canonical form and return { path, hash }. The hash
// is what `--expect-hash` should be given for a successful assertion.
function writeManifestFile(path: string, m: SetupManifest): { hash: string } {
    const bytes = canonicalizeManifest(m);
    writeFileSync(path, bytes);
    return { hash: hashBytes(bytes) };
}

let kindle: { root: string; settingsPath: string };
let workdir: string;
let manifestPath: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-eh-w-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-23T12:00:00Z"),
    };
});

describe("setup import --expect-hash — match", () => {
    test("matching hash (lean) → import proceeds, exit 4", async () => {
        const { hash } = writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", hash],
            env,
        );
        expect(code).toBe(4);
        expect(stderr.value).not.toContain("MANIFEST_HASH_MISMATCH");
    });

    test("sha256: prefix accepted → normalized, import proceeds", async () => {
        const { hash } = writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        // hash already starts with "sha256:" — pass as-is
        expect(hash.startsWith("sha256:")).toBe(true);
        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", hash],
            env,
        );
        expect(code).toBe(4);
    });

    test("bare hex accepted → normalized to sha256:, import proceeds", async () => {
        const { hash } = writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const bare = hash.slice("sha256:".length);
        expect(bare).toMatch(/^[a-f0-9]{64}$/);
        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", bare],
            env,
        );
        expect(code).toBe(4);
    });
});

describe("setup import --expect-hash — mismatch", () => {
    test("mismatched hash → MANIFEST_HASH_MISMATCH, exit 3, no writes", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const wrong = "sha256:" + "0".repeat(64);

        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", wrong],
            env,
        );
        expect(code).toBe(3);
        expect(stderr.value).toContain("expected " + wrong);
        // Settings file untouched.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
        // No pre-import snapshot dir.
        expect(existsSync(join(workdir, ".kindly", "pre-import"))).toBe(false);
    });

    test("--dry-run with mismatched hash → still fails (hash gate is before dry-run)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const wrong = "sha256:" + "f".repeat(64);

        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--expect-hash", wrong],
            env,
        );
        // Hash assertion fires before dry-run short-circuit.
        expect(code).toBe(3);
        expect(stderr.value).toContain("expected " + wrong);
    });

    test("--force does NOT bypass --expect-hash", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const wrong = "sha256:" + "a".repeat(64);

        const code = await main(
            ["setup", "import", manifestPath, "--force", "--expect-hash", wrong],
            env,
        );
        expect(code).toBe(3);
        expect(stderr.value).toContain("expected " + wrong);
    });

    test("--json mismatch → MANIFEST_HASH_MISMATCH envelope on stderr", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const wrong = "sha256:" + "b".repeat(64);

        const code = await main(
            ["setup", "import", manifestPath, "--json", "--expect-hash", wrong],
            env,
        );
        expect(code).toBe(3);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("MANIFEST_HASH_MISMATCH");
        expect(payload.error.message).toContain(wrong);
        // Success channel stays clean.
        expect(stdout.value).toBe("");
    });
});

describe("setup import --expect-hash — malformed values (ArgError / exit 2)", () => {
    test("wrong length (63 chars) → ArgError, exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({}));
        const bad = "a".repeat(63);

        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", bad],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--expect-hash");
    });

    test("invalid chars (uppercase) → ArgError, exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({}));
        const bad = "sha256:" + "Z".repeat(64);

        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", bad],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--expect-hash");
    });

    test("unknown prefix (md5:) → ArgError, exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({}));
        const bad = "md5:" + "a".repeat(32);

        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", bad],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--expect-hash");
    });

    test("--json malformed value → ArgError envelope, exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({}));

        const code = await main(
            ["setup", "import", manifestPath, "--json", "--expect-hash", "nope"],
            env,
        );
        expect(code).toBe(2);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("ARG_INVALID");
    });
});

describe("setup import --expect-hash — CLI / lib layer split", () => {
    // Spec 92 §3: format validation runs in the CLI layer. The lib's
    // executeSetupImport must never throw ArgError — it trusts opts.expectHash
    // is already a canonical `sha256:<64 hex>` string. Calling the lib with a
    // malformed value would be a contract violation by the caller; the lib
    // just does byte-compare and fails the assertion.
    test("lib receives pre-normalized string; never sees bare hex", async () => {
        const { hash } = writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        // Direct lib call with the canonical form — should succeed.
        const result = executeSetupImport(
            { file: manifestPath, expectHash: hash, dryRun: true },
            env,
        );
        expect(result.mode).toBe("dry-run");
    });

    test("lib with wrong-but-well-formed hash → KindlyError (not ArgError)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const wrong = "sha256:" + "c".repeat(64);
        expect(() => executeSetupImport(
            { file: manifestPath, expectHash: wrong },
            env,
        )).toThrow(/expected sha256:cccc/);
    });
});
