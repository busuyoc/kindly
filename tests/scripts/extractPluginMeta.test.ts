// Regex-based extractor for plugin `_meta.lua` files (W19).
//
// Coverage:
//   - canonical shape: fullname + description with _("...")
//   - bracket-string description: _([[...]])
//   - multi-line bracket string with blank lines (japanese)
//   - deprecated = { "kind", "detail" } (exporter)
//   - computed: conditional with require(...) and two _() calls (autowarmth)
//   - computed: bare word "and" inside a literal is NOT computed (regression
//     — earlier version flagged "Keeps and displays..." as computed)
//   - missing fields produce warnings, not crashes
//   - malformed file (no `return {`) yields warnings with null values
//   - extractAllPlugins walks a synthetic plugins/ directory and skips
//     non-.koplugin entries
//
// These tests use synthetic fixtures rather than a real KOReader tree so
// they run hermetically in CI.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractAllPlugins, extractPluginMeta } from "../../scripts/extract-plugin-meta.ts";

describe("extractPluginMeta — canonical shape", () => {
    test("_(\"...\") fields", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Hello"),
    description = _("This is a debugging plugin."),
}
`;
        const r = extractPluginMeta(src, "hello");
        expect(r.fullname).toBe("Hello");
        expect(r.description).toBe("This is a debugging plugin.");
        expect(r.deprecated).toBeNull();
        expect(r.computed).toBe(false);
        expect(r.warnings).toEqual([]);
    });

    test("_([[...]]) bracket string", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Cover browser"),
    description = _([[Alternative display modes for file browser and history.]]),
}
`;
        const r = extractPluginMeta(src, "coverbrowser");
        expect(r.description).toBe(
            "Alternative display modes for file browser and history.",
        );
        // "and" inside a literal must NOT trigger computed.
        expect(r.computed).toBe(false);
    });

    test("multi-line bracket string preserves content", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Japanese support"),
    description = _([[
Japanese language support for KOReader.

This plugin extends KOReader's selection system.]]),
}
`;
        const r = extractPluginMeta(src, "japanese");
        // Leading newline inside [[...]] is stripped by Lua; we match.
        expect(r.description?.startsWith("Japanese language support")).toBe(true);
        expect(r.description?.includes("\n\n")).toBe(true);
        expect(r.computed).toBe(false);
    });
});

describe("extractPluginMeta — deprecated", () => {
    test("deprecated = { kind, detail }", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Export highlights"),
    description = _("Exports highlights and notes."),
    deprecated = { "feature", "Joplin " },
}
`;
        const r = extractPluginMeta(src, "exporter");
        expect(r.deprecated).toEqual({ kind: "feature", detail: "Joplin " });
        expect(r.computed).toBe(false);
    });

    test("missing deprecated is null (no warning)", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("X"),
    description = _("Y"),
}
`;
        const r = extractPluginMeta(src, "x");
        expect(r.deprecated).toBeNull();
        expect(r.warnings).toEqual([]);
    });
});

describe("extractPluginMeta — computed (autowarmth)", () => {
    test("conditional with require() and two _() calls flags computed", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = require("device"):hasNaturalLight() and _("Auto warmth and night mode") or _("Auto night mode"),
    description = require("device"):hasNaturalLight() and _([[This plugin allows to set the frontlight warmth and night mode automagically.]]) or _([[This plugin allows to enable night mode automagically.]]),
}
`;
        const r = extractPluginMeta(src, "autowarmth");
        // First branch wins — the one a device WITH natural light sees.
        expect(r.fullname).toBe("Auto warmth and night mode");
        expect(r.description?.startsWith("This plugin allows to set")).toBe(true);
        expect(r.computed).toBe(true);
        expect(r.warnings).toEqual([]);
    });

    test("single _() with no require/and/or is NOT computed", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Gestures"),
    description = _("Configure gestures and actions."),
}
`;
        const r = extractPluginMeta(src, "gestures");
        expect(r.computed).toBe(false);
    });
});

describe("extractPluginMeta — robustness", () => {
    test("missing fullname / description → warnings, null values", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("Only fullname"),
}
`;
        const r = extractPluginMeta(src, "partial");
        expect(r.fullname).toBe("Only fullname");
        expect(r.description).toBeNull();
        expect(r.warnings).toContain("no `description` field");
    });

    test("no return block → warning, all nulls", () => {
        const src = `
-- not a _meta.lua at all
print("hi")
`;
        const r = extractPluginMeta(src, "broken");
        expect(r.fullname).toBeNull();
        expect(r.description).toBeNull();
        expect(r.warnings).toContain("could not find \`return { ... }\` block");
    });

    test("deprecated with unexpected shape → warning", () => {
        const src = `
local _ = require("gettext")
return {
    fullname = _("X"),
    description = _("Y"),
    deprecated = true,
}
`;
        const r = extractPluginMeta(src, "x");
        expect(r.deprecated).toBeNull();
        expect(r.warnings).toContain("could not parse `deprecated` table");
    });
});

describe("extractAllPlugins — directory walk", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "kindly-extplugin-"));
        mkdirSync(join(root, "plugins"));
    });

    function seed(folder: string, content: string): void {
        mkdirSync(join(root, "plugins", folder));
        writeFileSync(join(root, "plugins", folder, "_meta.lua"), content);
    }

    test("extracts every .koplugin folder, sorted by name, skips others", () => {
        seed("bbb.koplugin", `local _ = require("gettext")
return { fullname = _("Bee"), description = _("b desc") }
`);
        seed("aaa.koplugin", `local _ = require("gettext")
return { fullname = _("Aye"), description = _("a desc") }
`);
        // Non-koplugin folder under plugins/ — should be ignored.
        mkdirSync(join(root, "plugins", "README"));
        writeFileSync(join(root, "plugins", "README", "notes.md"), "hi");

        const result = extractAllPlugins(root);
        expect(result.plugin_count).toBe(2);
        expect(result.plugins.map((p) => p.name)).toEqual(["aaa", "bbb"]);
        // koreader_source is the folder basename, not the absolute path
        // (keeps committed drafts portable across machines).
        expect(result.koreader_source).not.toContain("/");
        expect(result.extracted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("missing _meta.lua inside a .koplugin folder → entry with warning", () => {
        mkdirSync(join(root, "plugins", "empty.koplugin"));
        const result = extractAllPlugins(root);
        expect(result.plugins).toEqual([{
            name: "empty",
            fullname: null,
            description: null,
            deprecated: null,
            computed: false,
            warnings: ["no _meta.lua"],
            known_hashes: {},   // empty dir — walk returns {}
        }]);
    });

    test("throws when <root>/plugins is not a directory", () => {
        const bad = mkdtempSync(join(tmpdir(), "kindly-extplugin-bad-"));
        expect(() => extractAllPlugins(bad)).toThrow(/no plugins\//);
    });
});
