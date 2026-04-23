// W38: structured exit codes beyond 0/1/2.
//
// Contract: docs/80 §v0.11.2 W38.
//   0 = success
//   1 = runtime error
//   2 = argument validation error
//   3 = blocked by policy (user can pass a flag to override)
//   4 = success with warnings

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["night_mode"] = false,
}
`;

function makeFakeKindle(initial?: string): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-w38-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, initial ?? DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "w38-test", created_at: "2026-04-23T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

function writeManifestFile(path: string, m: SetupManifest): void {
    writeFileSync(path, canonicalizeManifest(m));
}

let kindle: { root: string; settingsPath: string };
let workdir: string;
let manifestPath: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-w38-w-"));
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

// ---- exit 0: clean success ------------------------------------------------

describe("exit 0 — clean success", () => {
    test("setup import with no warnings → exit 0", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { night_mode: true },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
    });

    test("--version → exit 0", async () => {
        const code = await main(["--version"], env);
        expect(code).toBe(0);
    });
});

// ---- exit 2: arg validation -----------------------------------------------

describe("exit 2 — arg validation", () => {
    test("unknown flag → exit 2", async () => {
        const code = await main(["doctor", "--nonexistent"], env);
        expect(code).toBe(2);
    });

    test("--expect-hash with bad format → exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({}));
        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", "nope"],
            env,
        );
        expect(code).toBe(2);
    });
});

// ---- exit 3: policy block -------------------------------------------------

describe("exit 3 — policy block", () => {
    test("SENSITIVE_REQUIRES_ACK → exit 3", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(3);
    });

    test("SENSITIVE_REQUIRES_ACK JSON mode → exit 3", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--json"],
            env,
        );
        expect(code).toBe(3);
    });

    test("MANIFEST_HASH_MISMATCH → exit 3", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { night_mode: true },
        }));
        const wrong = "sha256:" + "0".repeat(64);
        const code = await main(
            ["setup", "import", manifestPath, "--expect-hash", wrong],
            env,
        );
        expect(code).toBe(3);
    });

    test("COMPAT_INCOMPATIBLE → exit 3", async () => {
        // Device must identify as "kindle" so compat blocks on "kobo-libra".
        const sysDir = join(kindle.root, "system");
        mkdirSync(sysDir, { recursive: true });
        writeFileSync(join(sysDir, "version.txt"), "Kindle 5.16.2.1.1");
        writeManifestFile(manifestPath, makeManifest({
            compat: { device: ["kobo-libra"] },
            settings: { night_mode: true },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(3);
    });
});

// ---- exit 4: success with warnings ----------------------------------------

describe("exit 4 — success with warnings", () => {
    test("import with accepted SENSITIVE hits → exit 4", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-sensitive"],
            env,
        );
        expect(code).toBe(4);
    });

    test("import with schema findings (non-strict) → exit 4", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { totally_unknown_key_xyz: true },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(4);
    });
});

// ---- exit 1: runtime error -------------------------------------------------

describe("exit 1 — runtime error", () => {
    test("missing YAML file → exit 1", async () => {
        const code = await main(["apply", "--file", "/nonexistent.yaml"], env);
        expect(code).toBe(1);
    });
});
