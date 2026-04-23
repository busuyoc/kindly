// Integration tests for `kindly setup import` W31a — `extra_plugin_paths`
// dual gate.
//
// Contract: docs/88-sensitive-keys-spec.md §4.3 + roadmap W31a.
// `extra_plugin_paths` redirects KOReader's plugin loader. Even with
// --accept-sensitive (or --accept-key=extra_plugin_paths), the import must
// also require --accept-plugins — same trust boundary as shipped Lua files.
// FAT_REQUIRES_ACK fires after the SENSITIVE gate clears.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupImport } from "../../src/commands/setup.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
}
`;

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-w31a-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "w31a-test", created_at: "2026-04-23T12:00:00Z" },
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
    workdir = mkdtempSync(join(tmpdir(), "kindly-w31a-w-"));
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

describe("setup import — W31a extra_plugin_paths dual gate", () => {
    test("--accept-sensitive alone is NOT enough — FAT_REQUIRES_ACK fires", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-sensitive"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("extra_plugin_paths");
        expect(stderr.value).toContain("Lua plugins");
        expect(stderr.value).toContain("--accept-plugins");
        // No write.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(DEFAULT_LUA);
    });

    test("--accept-key=extra_plugin_paths alone is NOT enough", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/sd/scripts" },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-key=extra_plugin_paths"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("extra_plugin_paths");
        expect(stderr.value).toContain("--accept-plugins");
    });

    test("--accept-plugins alone is NOT enough — SENSITIVE still fires first", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-plugins"],
            env,
        );
        expect(code).toBe(1);
        // SENSITIVE message, not the W31a one.
        expect(stderr.value).toContain("security-sensitive");
        expect(stderr.value).toContain("[code-exec]");
    });

    test("BOTH flags → import succeeds", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-sensitive", "--accept-plugins"],
            env,
        );
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8"))
            .toContain("extra_plugin_paths");
    });

    test("--accept-key=extra_plugin_paths + --accept-plugins → succeeds", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/sd/scripts" },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-key=extra_plugin_paths", "--accept-plugins"],
            env,
        );
        expect(code).toBe(0);
    });

    test("--dry-run skips W31a (content gate per 88 §3.5)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run"],
            env,
        );
        expect(code).toBe(0);
        expect(stdout.value).toContain("[SENSITIVE]");
        expect(stdout.value).toContain("extra_plugin_paths");
        // No FAT_REQUIRES_ACK message in dry-run.
        expect(stderr.value).not.toContain("Lua plugins");
    });

    test("Setup without extra_plugin_paths → no W31a fire", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },  // SENSITIVE but not extra_plugin_paths
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-sensitive"],
            env,
        );
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("Lua plugins");
    });

    test("error code is FAT_REQUIRES_ACK in JSON envelope", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-sensitive", "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("FAT_REQUIRES_ACK");
        expect(payload.error.message).toContain("extra_plugin_paths");
    });

    test("lib layer: opts.acceptSensitive without acceptPlugins throws", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: "/mnt/us/documents/themes" },
        }));
        expect(() => executeSetupImport(
            { file: manifestPath, acceptSensitive: true },
            env,
        )).toThrow(/extra_plugin_paths/);
    });

    test("same-value extra_plugin_paths → no change → no W31a", async () => {
        const sharedValue = ["/mnt/us/documents/themes"];
        // Pre-populate device with the same value the manifest will set.
        writeFileSync(kindle.settingsPath, `return {
    ["extra_plugin_paths"] = {
        [1] = "/mnt/us/documents/themes",
    },
}
`);
        writeManifestFile(manifestPath, makeManifest({
            settings: { extra_plugin_paths: sharedValue },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
        // Neither the SENSITIVE nor the W31a message fires.
        expect(stderr.value).not.toContain("security-sensitive");
        expect(stderr.value).not.toContain("Lua plugins");
    });
});
