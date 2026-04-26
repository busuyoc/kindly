// Step 10 — curated templates.
//
// Templates bundle a pre-authored settings + plugins.disabled set for a
// named use case. On `setup export --template <id>` the manifest is built
// from the template, no device settings are read. CLI flags layer on top.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest } from "../../src/setup/schema.ts";
import { unpackSetup } from "../../src/setup/unpack.ts";
import { listTemplates, getTemplate } from "../../src/setup/templates.ts";

// ---- scaffolding -----------------------------------------------------------

function makeFakeKindle(): {
    root: string; settingsPath: string; pluginsDir: string; patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-tmpl-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
}
`);
    const pluginsDir = join(kor, "plugins");
    const patchesDir = join(kor, "patches");
    mkdirSync(pluginsDir);
    mkdirSync(patchesDir);
    return { root, settingsPath, pluginsDir, patchesDir };
}

function makeEnv(cwd: string, mountOverride: string | undefined, setupsDir: string) {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride: mountOverride ?? "/tmp/no-kindle-here",
            now: () => new Date("2026-04-21T12:00:00Z"),
            setupsDir,
        } as CliEnv,
        out,
        err,
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
    workdir = mkdtempSync(join(tmpdir(), "kindly-tmpl-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-tmpl-s-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
});

// ---- registry --------------------------------------------------------------

describe("templates registry", () => {
    test("exposes the v0.3 templates + v0.9 debloat-bundled", () => {
        const ids = listTemplates().map((t) => t.id).sort();
        expect(ids).toEqual([
            "debloat-bundled",
            "distraction-free",
            "minimal-ui",
            "night-reading",
        ]);
    });

    test("every template has an id, display_name, description, apply_mode", () => {
        for (const t of listTemplates()) {
            expect(t.id).toMatch(/^[a-z0-9-]+$/);
            expect(t.display_name.length).toBeGreaterThan(0);
            expect(t.description.length).toBeGreaterThan(10);
            expect(["additive", "replace"]).toContain(t.apply_mode);
        }
    });

    test("all shipped templates are apply_mode: additive in v0.3", () => {
        // See design discussion: replace-mode templates would factory-reset
        // everything not declared. Additive is the only safe default.
        for (const t of listTemplates()) {
            expect(t.apply_mode).toBe("additive");
        }
    });

    test("getTemplate returns undefined for an unknown id", () => {
        expect(getTemplate("nope")).toBeUndefined();
    });
});

// ---- debloat-bundled (W23) ------------------------------------------------

describe("debloat-bundled template", () => {
    test("plugins.disabled is derived from the catalog (all debloat entries)", async () => {
        const { loadPluginCatalog, reloadPluginCatalog } = await import(
            "../../src/catalog/reader.ts"
        );
        reloadPluginCatalog();
        const catalog = loadPluginCatalog();
        const expected = catalog.plugins
            .filter((p) => p.curation_opinion === "debloat")
            .map((p) => p.name)
            .sort();

        const t = getTemplate("debloat-bundled")!;
        expect(t).toBeDefined();
        expect(t.apply_mode).toBe("additive");
        expect(t.settings).toBeUndefined();
        expect(t.plugins?.disabled).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
    });

    test("description mentions the concrete debloat count and catalog version", async () => {
        const { loadPluginCatalog, reloadPluginCatalog } = await import(
            "../../src/catalog/reader.ts"
        );
        reloadPluginCatalog();
        const catalog = loadPluginCatalog();
        const expectedCount = catalog.plugins
            .filter((p) => p.curation_opinion === "debloat").length;

        const t = getTemplate("debloat-bundled")!;
        expect(t.description).toContain(String(expectedCount));
        expect(t.description).toContain(catalog.catalog_version);
    });

    test("setup export --template debloat-bundled yields a manifest with plugins.disabled populated", async () => {
        const outputPath = join(workdir, "debloat.kset.yaml");
        const code = await main(
            ["setup", "export", "my-debloat", "--template", "debloat-bundled", "--output", outputPath],
            env,
        );
        expect(code).toBe(0);
        expect(existsSync(outputPath)).toBe(true);

        const raw = readFileSync(outputPath, "utf8");
        const manifest = parseManifest(yamlParse(raw));
        expect(manifest.apply_mode).toBe("additive");

        const disabled = (manifest.plugins?.disabled ?? []).slice().sort();
        const { loadPluginCatalog } = await import("../../src/catalog/reader.ts");
        const expected = loadPluginCatalog().plugins
            .filter((p) => p.curation_opinion === "debloat")
            .map((p) => p.name).sort();
        expect(disabled).toEqual(expected);
    });
});

// ---- `setup templates` subcommand ------------------------------------------

describe("setup templates", () => {
    test("lists all shipped templates with metadata", async () => {
        const code = await main(["setup", "templates"], env);
        expect(code).toBe(0);
        const out = stdout.value;
        expect(out).toContain("minimal-ui");
        expect(out).toContain("night-reading");
        expect(out).toContain("distraction-free");
        // Headers present.
        expect(out).toMatch(/ID/);
        expect(out).toMatch(/MODE/);
        // Description lines render under the table.
        expect(out).toMatch(/immersive reading|chrome/i);
    });

    test("rejects extra positional arguments", async () => {
        const code = await main(["setup", "templates", "oops"], env);
        expect(code).toBe(2);
        expect(stderr.value).toMatch(/unexpected argument/);
    });
});

// ---- `setup export --template` --------------------------------------------

describe("setup export — --template", () => {
    test("unknown template id → exit 2 with available list", async () => {
        const code = await main([
            "setup", "export", "mine", "--template", "nope",
        ], env);
        expect(code).toBe(2);
        expect(stderr.value).toMatch(/unknown template/);
        expect(stderr.value).toMatch(/minimal-ui/);
    });

    test("minimal-ui → manifest has expected settings + plugins.disabled", async () => {
        const out = join(workdir, "mu.kset.yaml");
        const code = await main([
            "setup", "export", "my-minimal",
            "--template", "minimal-ui",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.apply_mode).toBe("additive");
        expect(m.settings?.avoid_flashing_ui).toBe(true);
        expect(m.settings?.reader_footer_mode).toBe(0);
        const disabled = m.plugins?.disabled ?? [];
        expect(disabled).toContain("coverbrowser");
        expect(disabled).toContain("calendar");
        expect(disabled).toContain("newsdownloader");
    });

    test("night-reading → five autowarmth/autodim keys, no plugin toggles", async () => {
        const out = join(workdir, "nr.kset.yaml");
        const code = await main([
            "setup", "export", "my-night",
            "--template", "night-reading",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.settings?.autowarmth_activate).toBe(1);
        expect(m.settings?.autowarmth_easy_mode).toBe(true);
        expect(m.settings?.autodim_fraction).toBe(20);
        expect(m.plugins?.disabled ?? []).toEqual([]);
    });

    test("works without a mount (templates skip device read)", async () => {
        // Point mountOverride at a path that isn't a Kindle mount. If the
        // code tried to resolve a mount, this would fail.
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, "/tmp/definitely-no-kindle", setupsDir));
        const out = join(workdir, "no-mount.kset.yaml");
        const code = await main([
            "setup", "export", "offline",
            "--template", "minimal-ui",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        expect(existsSync(out)).toBe(true);
    });

    test("template description lands in meta.description by default", async () => {
        const out = join(workdir, "desc.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.meta.description).toBeDefined();
        expect(m.meta.description).toMatch(/chrome|immersive/i);
    });

    test("--description overrides the template's description", async () => {
        const out = join(workdir, "desc2.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--description", "bespoke version",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.meta.description).toBe("bespoke version");
    });

    test("--apply-mode replace overrides the template's additive default", async () => {
        const out = join(workdir, "replace.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--apply-mode", "replace",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.apply_mode).toBe("replace");
    });

    test("--keys narrows template settings to the intersection", async () => {
        const out = join(workdir, "narrow.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--keys", "avoid_flashing_ui,not_in_template",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        // Only avoid_flashing_ui survives. plugins_disabled was lifted out
        // of the settings dict into plugins.disabled before --keys filtered.
        expect(Object.keys(m.settings ?? {})).toEqual(["avoid_flashing_ui"]);
        expect(m.settings?.avoid_flashing_ui).toBe(true);
    });

    test("--tags and --author layer onto a template-built manifest", async () => {
        const out = join(workdir, "meta.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--author", "me",
            "--tags", "cozy,evening",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.meta.author).toBe("me");
        expect(m.meta.tags).toEqual(["cozy", "evening"]);
    });

    test("--compat-* flags work with templates", async () => {
        const out = join(workdir, "compat.kset.yaml");
        await main([
            "setup", "export", "mine",
            "--template", "night-reading",
            "--compat-koreader-min", "2024.03",
            "--compat-device", "kindle-pw5",
            "--output", out,
        ], env);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat?.koreader_version_min).toBe("2024.03");
        expect(m.compat?.device).toEqual(["kindle-pw5"]);
    });

    test("--include-plugin-files with a template augments from the live device", async () => {
        // Seed the fake Kindle with a plugin dir so the fat augment has
        // something to pack.
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "-- ssh\n");
        const out = join(workdir, "tmpl-fat.kset");
        const code = await main([
            "setup", "export", "mine",
            "--template", "minimal-ui",
            "--include-plugin-files",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const unpacked = unpackSetup(out);
        // Settings come from the template.
        expect(unpacked.manifest.settings?.avoid_flashing_ui).toBe(true);
        // Plugin files come from the device.
        const paths = (unpacked.manifest.plugins?.files ?? []).map((f) => f.path);
        expect(paths).toContain("SSH.koplugin/main.lua");
    });

    test("distraction-free template round-trips through import onto a fake Kindle", async () => {
        // 1. Export using the template.
        const ksetPath = join(workdir, "df.kset.yaml");
        const exportCode = await main([
            "setup", "export", "my-df",
            "--template", "distraction-free",
            "--output", ksetPath,
        ], env);
        expect(exportCode).toBe(0);

        // 2. Import onto the fake Kindle. The distraction-free template
        // sets plugins_disabled (sensitive-service per S960) — accept it.
        const importCode = await main(
            ["setup", "import", ksetPath, "--accept-sensitive"],
            env,
        );
        expect(importCode).toBe(4);

        // 3. The device's settings now carry the template's keys.
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain(`["autoturn_enabled"] = false`);
        expect(after).toContain(`["end_document_action"] = "next_file"`);
        // plugins_disabled is a nested table; at least one expected entry lands.
        expect(after).toContain(`["coverbrowser"] = true`);
    });
});
