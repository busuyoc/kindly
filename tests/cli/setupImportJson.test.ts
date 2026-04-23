// Typed result + --json envelope tests for `kindly setup import`.
// Covers executeSetupImport directly (data shape) plus the --json wire
// contract, no-op / dry-run / imported modes, and the COMPAT_INCOMPATIBLE,
// FAT_REQUIRES_ACK, SCHEMA_VIOLATION, SETTINGS_NOT_FOUND error codes.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync,
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
    ["avoid_flashing_ui"] = false,
}
`;

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-sij-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "test", created_at: "2026-04-22T12:00:00Z" },
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
    workdir = mkdtempSync(join(tmpdir(), "kindly-sij-w-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeSetupImport", () => {
    test("additive import returns populated typed result", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2, screen_warmth: 50 },
        }));
        const r = executeSetupImport({ file: manifestPath }, env);
        expect(r.mode).toBe("imported");
        expect(r.setupFile).toBe(manifestPath);
        expect(r.applyMode).toBe("additive");
        expect(r.name).toBe("test");
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
        expect(r.settingsPath).toBe(kindle.settingsPath);
        expect(r.changes.length).toBeGreaterThan(0);
        expect(r.backupPath).not.toBeNull();
        expect(r.installedPluginFiles).toBe(0);
        expect(r.installedPatches).toBe(0);
    });

    test("--dry-run sets mode + skips write", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const r = executeSetupImport({ file: manifestPath, dryRun: true }, env);
        expect(r.mode).toBe("dry-run");
        expect(r.backupPath).toBeNull();
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("identical manifest → no-op mode", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 8, avoid_flashing_ui: false },
        }));
        const r = executeSetupImport({ file: manifestPath }, env);
        expect(r.mode).toBe("no-op");
        expect(r.changes).toHaveLength(0);
        expect(r.backupPath).toBeNull();
    });

    test("un-acked fat plugins → FAT_REQUIRES_ACK", () => {
        writeManifestFile(manifestPath, makeManifest({
            plugins: {
                disabled: [],
                files: [{
                    path: "coverbrowser.koplugin/main.lua",
                    hash: "sha256:" + "0".repeat(64),
                    bytes: 100,
                }],
            },
            settings: { refresh_rate: 2 },
        }));
        expect(() => executeSetupImport({ file: manifestPath }, env))
            .toThrow(/--accept-plugins|--skip-plugins/);
    });

    test("--strict + unknown key → SCHEMA_VIOLATION", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { totally_made_up_key: 1 },
        }));
        expect(() => executeSetupImport(
            { file: manifestPath, strict: true },
            env,
        )).toThrow(/--strict/);
    });

    test("missing settings.reader.lua → SETTINGS_NOT_FOUND", () => {
        unlinkSync(kindle.settingsPath);
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        expect(() => executeSetupImport({ file: manifestPath }, env))
            .toThrow(/doesn't exist|KOReader installed/i);
    });
});

describe("setup import --json", () => {
    test("additive import emits envelope with import data", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2, screen_warmth: 50 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--json"],
            env,
        );
        expect(code).toBe(4);
        const { command, status, data } = JSON.parse(stdout.value);
        expect(command).toBe("setup import");
        expect(status).toBe("ok");
        expect(data.mode).toBe("imported");
        expect(data.setupFile).toBe(manifestPath);
        expect(data.name).toBe("test");
        expect(data.applyMode).toBe("additive");
        expect(Array.isArray(data.changes)).toBe(true);
        expect(data.changes.length).toBeGreaterThan(0);
        // Internal render-only fields shouldn't leak.
        expect(data.schemaFindings).toBeUndefined();
        expect(data.shippedPluginCount).toBeUndefined();
        expect(data.shippedPatchCount).toBeUndefined();
        // Pre-gate intro text must NOT appear in JSON mode.
        expect(stdout.value).not.toContain("importing setup");
        expect(stdout.value).not.toContain("ships executable code");
    });

    test("--dry-run --json emits dry-run mode, no write", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--json"],
            env,
        );
        expect(code).toBe(4);
        const { data } = JSON.parse(stdout.value);
        expect(data.mode).toBe("dry-run");
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("identical manifest → no-op envelope", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 8, avoid_flashing_ui: false },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--json"],
            env,
        );
        expect(code).toBe(4);
        const { data } = JSON.parse(stdout.value);
        expect(data.mode).toBe("no-op");
        expect(data.changes).toHaveLength(0);
    });

    test("un-acked fat → FAT_REQUIRES_ACK error envelope", async () => {
        writeManifestFile(manifestPath, makeManifest({
            plugins: {
                disabled: [],
                files: [{
                    path: "coverbrowser.koplugin/main.lua",
                    hash: "sha256:" + "0".repeat(64),
                    bytes: 100,
                }],
            },
            settings: { refresh_rate: 2 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--json"],
            env,
        );
        expect(code).toBe(3);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("FAT_REQUIRES_ACK");
        // Stdout stays clean in JSON mode — no fat disclosure on success channel.
        expect(stdout.value).toBe("");
    });

    test("--strict unknown key → SCHEMA_VIOLATION error envelope", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { totally_made_up_key: 1 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--strict", "--json"],
            env,
        );
        expect(code).toBe(3);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("SCHEMA_VIOLATION");
    });
});
