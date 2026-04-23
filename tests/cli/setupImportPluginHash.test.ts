// Integration tests for W32 plugin hash verification in the import
// pipeline (89 §4, §5, §9).
//
// Exercises the real `executeSetupImport` path: fat Setup → canonical
// import → pluginHashReport on the typed result. All verdict-shape
// assertions inject a per-test catalog via the `catalogPath` testability
// hook on SetupImportOptions — no mutation of the committed catalog file,
// no reload dance, no parallelism hazards. UNCATALOGUED falls through to
// the real catalog by picking a name not in it.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupImport, renderSetupImport } from "../../src/commands/setup.ts";
import type { PluginCatalog } from "../../src/catalog/reader.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { packSetup } from "../../src/setup/pack.ts";
import { parseManifest } from "../../src/setup/schema.ts";

// Write a synthetic catalog to a scratch path. Callers pass this path
// into executeSetupImport via `opts.catalogPath`. Bypasses file-mutation
// hazards on the committed catalog.
function writeSyntheticCatalog(
    dir: string,
    plugins: unknown[],
    hashVersion?: string,
): string {
    const body: PluginCatalog = {
        catalog_version: "v1" as const,
        license: "MIT",
        curated_at: "2026-04-23",
        koreader_source: "test-src",
        koreader_hash_version: hashVersion ?? null,
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

// ---- fake kindle -----------------------------------------------------------

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
    ["lastfile"] = "/mnt/us/documents/book.epub",
}
`;

function makeFakeKindle(): {
    root: string; settingsPath: string;
    pluginsDir: string; patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-w32-k-"));
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

function makeEnv(
    cwd: string, mountOverride: string, setupsDir: string,
): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd, stdout: out, stderr: err, color: false, mountOverride,
            now: () => new Date("2026-04-23T12:00:00Z"),
            setupsDir,
        },
        out, err,
    };
}

let kindle: ReturnType<typeof makeFakeKindle>;
let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-w32-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-w32-s-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
});

// Build a fat .kset using the export CLI, then wipe the device so the
// import side starts fresh. Returns the archive path.
async function exportFat(
    folder: string, files: Record<string, string>, name = "hash-fixture",
): Promise<string> {
    seedPlugin(kindle.pluginsDir, folder, files);
    const outPath = join(workdir, `${name}.kset`);
    const code = await main([
        "setup", "export", name,
        "--include-plugin-files", "--output", outPath,
    ], env);
    expect(code).toBe(0);
    // Fresh kindle so import doesn't see the seeded source files.
    kindle = makeFakeKindle();
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
    return outPath;
}

// ---- UNVERIFIED / UNCATALOGUED verdict paths -------------------------------

describe("pluginHashReport — UNVERIFIED / UNCATALOGUED verdicts", () => {
    test("catalog entry with null known_hashes → UNVERIFIED verdict", async () => {
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({ name: "SSH", known_hashes: null }),
        ]);
        const src = await exportFat("SSH.koplugin", {
            "main.lua": "-- ssh\n",
            "_meta.lua": "-- meta\n",
        });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath }, env,
        );
        expect(r.pluginHashReport).not.toBeNull();
        const v = r.pluginHashReport!.verdicts.find((x) => "name" in x && x.name === "SSH");
        expect(v?.status).toBe("UNVERIFIED");
    });

    test("unknown plugin → UNCATALOGUED verdict", async () => {
        const src = await exportFat("definitely-not-real.koplugin", {
            "main.lua": "-- not a real plugin\n",
        });
        const r = executeSetupImport({ file: src, acceptPlugins: true }, env);
        const v = r.pluginHashReport!.verdicts.find(
            (x) => "name" in x && x.name === "definitely-not-real",
        );
        expect(v?.status).toBe("UNCATALOGUED");
    });
});

// ---- no-verification paths -------------------------------------------------

describe("pluginHashReport — nulled when nothing to verify", () => {
    test("--skip-plugins → pluginHashReport is null (no install, no verify)", async () => {
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- ssh\n" });
        const r = executeSetupImport({ file: src, skipPlugins: true }, env);
        expect(r.pluginHashReport).toBeNull();
    });

    test("no plugins shipped → pluginHashReport is null", async () => {
        // Lean Setup with settings only.
        const outPath = join(workdir, "lean.kset.yaml");
        const code = await main([
            "setup", "export", "lean-only", "--output", outPath,
        ], env);
        expect(code).toBe(0);
        const r = executeSetupImport({ file: outPath }, env);
        expect(r.pluginHashReport).toBeNull();
    });
});

// ---- MATCH / MISMATCH with an injected catalog -----------------------------

describe("pluginHashReport — MATCH/MISMATCH against synthetic catalog", () => {
    test("MATCH: shipped bytes match catalog hashes", async () => {
        const mainSrc = "-- ssh main\nreturn {}\n";
        const metaSrc = "return { name = 'SSH' }\n";
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: {
                    "main.lua": hashBytes(Buffer.from(mainSrc)),
                    "_meta.lua": hashBytes(Buffer.from(metaSrc)),
                },
            }),
        ], "v2026.01");
        const src = await exportFat("SSH.koplugin", {
            "main.lua": mainSrc, "_meta.lua": metaSrc,
        });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath },
            env,
        );
        const v = r.pluginHashReport!.verdicts[0]!;
        expect(v.status).toBe("MATCH");
    });

    test("MATCH: subset mode — catalog-only files are NOT reported missing (89 §5.4)", async () => {
        const mainSrc = "-- main\n";
        const metaSrc = "-- meta\n";
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: {
                    "main.lua": hashBytes(Buffer.from(mainSrc)),
                    "_meta.lua": hashBytes(Buffer.from(metaSrc)),
                },
            }),
        ]);
        // Ship only main.lua — a legitimate subset of the catalogued plugin.
        const src = await exportFat("SSH.koplugin", { "main.lua": mainSrc });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath },
            env,
        );
        expect(r.pluginHashReport!.verdicts[0]!.status).toBe("MATCH");
    });

    test("MISMATCH: modified bytes → verdict with modified file entry", async () => {
        const mainSrc = "-- ssh main\n";
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from(mainSrc)) },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", {
            "main.lua": "-- evil tampered\n",
        });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath },
            env,
        );
        const v = r.pluginHashReport!.verdicts[0]!;
        if (v.status !== "MISMATCH") throw new Error(`expected MISMATCH, got ${v.status}`);
        expect(v.files.length).toBe(1);
        expect(v.files[0]!.status).toBe("modified");
    });

    test("MISMATCH: extra file in archive not in catalog", async () => {
        const mainSrc = "-- main\n";
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from(mainSrc)) },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", {
            "main.lua": mainSrc,
            "backdoor.lua": "-- pwn\n",
        });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath },
            env,
        );
        const v = r.pluginHashReport!.verdicts[0]!;
        if (v.status !== "MISMATCH") throw new Error(`expected MISMATCH, got ${v.status}`);
        const extras = v.files.filter((f) => f.status === "extra");
        expect(extras.map((e) => (e as { file: string }).file)).toEqual(["backdoor.lua"]);
    });
});

// ---- renderer output: §5.6 data-loss + version skew ------------------------

describe("setup import renderer — §5.6 data-loss + version-skew advisory", () => {
    test("MISMATCH + --no-safety-snapshot → data-loss warning emitted (89 §5.6)", async () => {
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from("-- original\n")) },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- tampered\n" });
        // Drive executeSetupImport + renderSetupImport directly so we can
        // pass catalogPath without mutating the committed catalog.
        const r = executeSetupImport(
            {
                file: src, acceptPlugins: true, catalogPath,
                dryRun: true, safetySnapshot: false,
            },
            env,
        );
        renderSetupImport(r, env, {
            allowUnknownKeys: false, strict: false, force: false,
            safetySnapshot: false,
        });
        expect(stderr.value).toMatch(/MISMATCH/);
        expect(stderr.value).toMatch(/NO rollback copy/i);
    });

    test("MISMATCH with safety snapshot ON → NO data-loss warning", async () => {
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from("-- original\n")) },
            }),
        ]);
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- tampered\n" });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath, dryRun: true },
            env,
        );
        renderSetupImport(r, env, {
            allowUnknownKeys: false, strict: false, force: false,
            safetySnapshot: true,
        });
        expect(stderr.value).not.toMatch(/NO rollback copy/i);
    });

    test("version-skew advisory: catalog version present + MISMATCH surfaces", async () => {
        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: { "main.lua": hashBytes(Buffer.from("-- orig\n")) },
            }),
        ], "v2025.01-pinned");
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- tampered\n" });
        const r = executeSetupImport(
            { file: src, acceptPlugins: true, catalogPath, dryRun: true },
            env,
        );
        renderSetupImport(r, env, {
            allowUnknownKeys: false, strict: false, force: false,
            safetySnapshot: true,
        });
        expect(stderr.value).toMatch(/MISMATCH|v2025\.01-pinned/);
    });
});

// ---- JSON envelope ---------------------------------------------------------

describe("setup import --json — pluginHashReport is present", () => {
    test("report is serialized as-is on the result", async () => {
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- ssh\n" });
        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--dry-run", "--json",
        ], env);
        expect(code).toBe(4);
        const { status, data } = JSON.parse(stdout.value);
        expect(status).toBe("ok");
        expect(data.pluginHashReport).toBeDefined();
        expect(data.pluginHashReport.verdicts).toBeInstanceOf(Array);
        const first = data.pluginHashReport.verdicts[0];
        expect(["MATCH", "MISMATCH", "UNCATALOGUED", "UNVERIFIED", "MALFORMED_STRUCTURE"])
            .toContain(first.status);
    });

    test("--skip-plugins → pluginHashReport is null in JSON", async () => {
        const src = await exportFat("SSH.koplugin", { "main.lua": "-- ssh\n" });
        const code = await main([
            "setup", "import", src,
            "--skip-plugins", "--dry-run", "--json",
        ], env);
        expect(code).toBe(4);
        const { data } = JSON.parse(stdout.value);
        expect(data.pluginHashReport).toBeNull();
    });
});

// ---- MALFORMED_STRUCTURE (89 §4.2 prerequisite) ---------------------------

describe("pluginHashReport — MALFORMED_STRUCTURE", () => {
    test("file path not under <name>.koplugin/ → MALFORMED_STRUCTURE verdict + renderer", async () => {
        // Craft a fat .kset manually with a path that doesn't follow the
        // <name>.koplugin/ convention. The manifest schema only blocks
        // `..` traversal, not the koplugin prefix — so packSetup will
        // accept it and the import pipeline sees it at verify time.
        const evilBytes = Buffer.from("-- pretending to be a plugin\n");
        const evilHash = hashBytes(evilBytes);
        const manifest = parseManifest({
            kindly_setup: "v1",
            meta: { name: "malformed-fixture", created_at: "2026-04-23T12:00:00Z" },
            apply_mode: "additive",
            plugins: {
                files: [{
                    path: "not_a_plugin/evil.lua",
                    hash: evilHash, bytes: evilBytes.length,
                }],
            },
        });
        const outPath = join(workdir, "malformed.kset");
        packSetup({
            manifest,
            files: new Map([["not_a_plugin/evil.lua", evilBytes]]),
        }, outPath);

        // Swap in a fresh kindle (no pre-existing plugins dir content).
        kindle = makeFakeKindle();
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));

        const r = executeSetupImport(
            { file: outPath, acceptPlugins: true, dryRun: true },
            env,
        );
        const v = r.pluginHashReport!.verdicts.find((x) => x.status === "MALFORMED_STRUCTURE");
        if (!v || v.status !== "MALFORMED_STRUCTURE") {
            throw new Error(`expected MALFORMED_STRUCTURE, got ${JSON.stringify(r.pluginHashReport!.verdicts)}`);
        }
        expect(v.paths).toContain("not_a_plugin/evil.lua");

        // Renderer also surfaces the malformed block.
        renderSetupImport(r, env, {
            allowUnknownKeys: false, strict: false, force: false,
            safetySnapshot: true,
        });
        expect(stderr.value).toMatch(/MALFORMED_STRUCTURE/);
        expect(stderr.value).toContain("not_a_plugin/evil.lua");
    });
});

// ---- catalog+extractor round-trip (89 §8 identity property) ----------------

describe("extractor + verifier round-trip", () => {
    test("hashPluginDir output matches verifier's hashBytes — MATCH", async () => {
        // Seed a plugin, have the extractor hash it, build a catalog
        // from those hashes, then import the same bytes and expect MATCH.
        const { hashPluginDir } = await import("../../scripts/extract-plugin-meta.ts");

        const src = kindle.pluginsDir;
        mkdirSync(join(src, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(src, "SSH.koplugin", "main.lua"), "-- roundtrip\n");
        writeFileSync(join(src, "SSH.koplugin", "_meta.lua"), "-- meta rt\n");
        const hashes = hashPluginDir(join(src, "SSH.koplugin"));

        const catalogPath = writeSyntheticCatalog(workdir, [
            stubCatalogEntry({
                name: "SSH",
                known_hashes: hashes,
            }),
        ], "rt-v1");
        // Export + re-import the very bytes the extractor just hashed.
        const outPath = join(workdir, "rt.kset");
        const code = await main([
            "setup", "export", "rt",
            "--include-plugin-files", "--output", outPath,
        ], env);
        expect(code).toBe(0);
        kindle = makeFakeKindle();
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));

        const r = executeSetupImport(
            { file: outPath, acceptPlugins: true, catalogPath },
            env,
        );
        expect(r.pluginHashReport!.verdicts[0]!.status).toBe("MATCH");
    });
});
