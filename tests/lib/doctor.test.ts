// Library-level tests for src/lib/doctor.ts. Locks DoctorResult shape and
// the "no printing" contract. Note: doctor's contract is "never throws" —
// mount failure becomes a failing check, not an exception.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeDoctor } from "../../src/lib/doctor.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import type { PluginCatalog } from "../../src/catalog/reader.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({
        avoid_flashing_ui: true,
        zlibrary_password: "hunter2",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-w-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeDoctor (library)", () => {
    test("happy path: all checks pass on a healthy fake kindle", () => {
        const r = executeDoctor(env);
        expect(r.ok).toBe(true);
        expect(r.checks.every((c) => c.ok)).toBe(true);
        expect(r.secretsPresent).toContain("zlibrary_password");
    });

    test("no printing — stdout and stderr stay empty", () => {
        executeDoctor(env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("mount failure becomes a failing check (no throw)", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        expect(() => executeDoctor(bad)).not.toThrow();
        const r = executeDoctor(bad);
        expect(r.ok).toBe(false);
        expect(r.checks[0]!.id).toBe("mount");
        expect(r.checks[0]!.ok).toBe(false);
        // 90 §2: mount-missing is fatal (kindly can't function).
        expect(r.checks[0]!.severity).toBe("fatal");
    });
});

describe("executeDoctor — 90 §2/§4 severity taxonomy + exit policy", () => {
    test("every check carries severity and category", () => {
        const r = executeDoctor(env);
        for (const c of r.checks) {
            expect(["fatal", "error", "warning", "info"]).toContain(c.severity);
            expect(typeof c.category).toBe("string");
            expect(c.category.length).toBeGreaterThan(0);
        }
    });

    test("legacy `ok` field is derived from severity (back-compat §4.1)", () => {
        const r = executeDoctor(env);
        for (const c of r.checks) {
            const expected = c.severity === "fatal" || c.severity === "error"
                ? false : true;
            expect(c.ok).toBe(expected);
        }
    });

    test("DoctorResult.ok = no fatal/error findings (§2 exit policy)", () => {
        // Healthy kindle: all info → ok.
        expect(executeDoctor(env).ok).toBe(true);

        // Mount missing: one fatal → !ok.
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        expect(executeDoctor(bad).ok).toBe(false);
    });

    test("checks are ordered (severity desc, category asc, id asc) §4.2", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        const r = executeDoctor(bad);
        // Fatal checks come first.
        const severities = r.checks.map((c) => c.severity);
        const firstNonFatal = severities.findIndex((s) => s !== "fatal");
        const afterFatal = firstNonFatal < 0
            ? []
            : severities.slice(firstNonFatal);
        expect(afterFatal.every((s) => s !== "fatal")).toBe(true);
    });

    test("mount category is 'mount'; settings checks are 'settings'", () => {
        const r = executeDoctor(env);
        const cats = Object.fromEntries(r.checks.map((c) => [c.id, c.category]));
        expect(cats.mount).toBe("mount");
        expect(cats.settings_present).toBe("settings");
        expect(cats.settings_parseable).toBe("settings");
        expect(cats.old_parseable).toBe("settings");
    });

    test("corrupt .old → warning (not fatal): KOReader fallback, kindly itself fine", () => {
        // Seed a corrupt .old next to the healthy settings file.
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        writeFileSync(settingsPath + ".old", "return { not valid lua");

        const r = executeDoctor(env);
        const oldCheck = r.checks.find((c) => c.id === "old_parseable")!;
        expect(oldCheck.severity).toBe("warning");
        // Overall result still ok — kindly keeps working.
        expect(r.ok).toBe(true);
    });
});

// ---- W34b plugins.* findings (90 §5.4, §5.5) -------------------------------

function writeSyntheticCatalog(dir: string, plugins: unknown[]): string {
    const body: PluginCatalog = {
        catalog_version: "v1" as const,
        license: "MIT",
        curated_at: "2026-04-23",
        koreader_source: "test-src",
        plugin_count: plugins.length,
        plugins: plugins as PluginCatalog["plugins"],
    };
    const path = join(dir, `catalog-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(body));
    return path;
}

function entry(overrides: Record<string, unknown> & { name: string }): Record<string, unknown> {
    return {
        fullname: overrides.name, folder: `${overrides.name}.koplugin`,
        category: "dev", ship_default_on: "always", ship_default_rationale: "",
        description: "", curation_opinion: "niche", community_sentiment: "",
        kindle_notes: "", references: [], deprecated: null,
        computed: false, warnings: [], ...overrides,
    };
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

describe("executeDoctor — W34b plugins.* findings (90 §5.4, §5.5)", () => {
    let pluginsDir: string;
    beforeEach(() => {
        pluginsDir = join(fakeKindle, "koreader", "plugins");
        mkdirSync(pluginsDir, { recursive: true });
    });

    test("no plugins installed → summary 0/0/0, info severity", () => {
        const catalogPath = writeSyntheticCatalog(workdir, []);
        const r = executeDoctor(env, { catalogPath });
        const summary = r.checks.find((c) => c.id === "plugins.hashes_verified")!;
        expect(summary.severity).toBe("info");
        expect(summary.data).toEqual({ verified: 0, tampered: 0, uncatalogued: 0 });
        expect(r.ok).toBe(true);
    });

    test("catalogued matching plugin → verified:1, summary info", () => {
        const mainSrc = "-- ssh\nreturn {}\n";
        seedPlugin(pluginsDir, "SSH.koplugin", { "main.lua": mainSrc });
        const catalogPath = writeSyntheticCatalog(workdir, [entry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(Buffer.from(mainSrc)) },
        })]);

        const r = executeDoctor(env, { catalogPath });
        const summary = r.checks.find((c) => c.id === "plugins.hashes_verified")!;
        expect(summary.severity).toBe("info");
        expect(summary.data).toMatchObject({ verified: 1, tampered: 0, uncatalogued: 0 });
        expect(r.checks.find((c) => c.id === "plugins.tampered")).toBeUndefined();
    });

    test("tampered .lua → plugins.tampered at error severity (code role)", () => {
        const origSrc = "-- original\n";
        const tamperedSrc = "-- evil\n";
        seedPlugin(pluginsDir, "SSH.koplugin", { "main.lua": tamperedSrc });
        const catalogPath = writeSyntheticCatalog(workdir, [entry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(Buffer.from(origSrc)) },
        })]);

        const r = executeDoctor(env, { catalogPath });
        const t = r.checks.filter((c) => c.id === "plugins.tampered");
        expect(t.length).toBe(1);
        expect(t[0]!.severity).toBe("error");
        expect(t[0]!.data).toMatchObject({ plugin: "SSH", file: "main.lua" });
        // error bumps DoctorResult.ok to false.
        expect(r.ok).toBe(false);
    });

    test("tampered asset (.png) → plugins.tampered at warning severity (asset role)", () => {
        const origPng = "PNG-original";
        const evilPng = "PNG-evil";
        seedPlugin(pluginsDir, "icons.koplugin", { "icon.png": evilPng });
        const catalogPath = writeSyntheticCatalog(workdir, [entry({
            name: "icons",
            known_hashes: { "icon.png": hashBytes(Buffer.from(origPng)) },
        })]);

        const r = executeDoctor(env, { catalogPath });
        const t = r.checks.find((c) => c.id === "plugins.tampered")!;
        expect(t.severity).toBe("warning");
        // Warning alone keeps ok = true.
        expect(r.ok).toBe(true);
    });

    test("uncatalogued plugin → plugin name listed at info severity (§1 scope)", () => {
        seedPlugin(pluginsDir, "thirdparty.koplugin", { "main.lua": "-- x\n" });
        const catalogPath = writeSyntheticCatalog(workdir, []);

        const r = executeDoctor(env, { catalogPath });
        const uc = r.checks.find((c) => c.id === "plugins.uncatalogued")!;
        expect(uc.severity).toBe("info");
        expect(uc.data).toEqual({ plugins: ["thirdparty"] });
        // Summary goes to warning because uncatalogued > 0.
        const summary = r.checks.find((c) => c.id === "plugins.hashes_verified")!;
        expect(summary.severity).toBe("warning");
        expect(r.ok).toBe(true);
    });

    test("catalog unavailable (bad path) → no plugins.* findings, doctor continues", () => {
        seedPlugin(pluginsDir, "SSH.koplugin", { "main.lua": "x\n" });
        const r = executeDoctor(env, { catalogPath: "/nonexistent/catalog.json" });
        expect(r.checks.find((c) => c.category === "plugins")).toBeUndefined();
        // Other checks still fire.
        expect(r.checks.some((c) => c.id === "mount")).toBe(true);
    });
});
