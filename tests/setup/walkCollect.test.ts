// S901 / Angle C — walkCollect emits files in code-unit order, not
// localeCompare order. The intra-dir sort feeds the canonical manifest
// hash (via canonical.ts S905 sort) and was previously locale-dependent:
// Bun/JSC hardcodes en-US, Node honors LC_ALL → manifest hashes drifted
// across runtime/locale for byte-identical input trees.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPluginDirs } from "../../src/setup/files.ts";

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kindly-walk-"));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

describe("walkCollect — code-unit ordering (S901)", () => {
    test("intra-dir order is code-unit, accented names follow ASCII", () => {
        // Build a fake plugins root with one plugin containing a mixed
        // ASCII + accented filename set. Code-unit order: codepoints
        // < 0x80 (ASCII) sort before 0xc0-0xff (accented Latin) and
        // before > 0xffff (cyrillic, etc).
        const root = join(workDir, "plugins");
        mkdirSync(root, { recursive: true });
        const plugin = join(root, "Test.koplugin");
        mkdirSync(plugin);
        // Names chosen so localeCompare and code-unit DIFFER: under
        // localeCompare, "ä" sorts BETWEEN "a" and "b" (locale-aware
        // collation). Under code-unit, "ä" (U+00E4) sorts AFTER all
        // basic-Latin letters (last basic Latin = "z" at U+007A).
        writeFileSync(join(plugin, "main.lua"), "main\n");
        writeFileSync(join(plugin, "z.lua"), "z\n");
        writeFileSync(join(plugin, "a.lua"), "a\n");
        writeFileSync(join(plugin, "ä.lua"), "umlaut\n");

        const { declared } = collectPluginDirs(root);
        const paths = declared.map((d) => d.path);
        const expectedOrder = [
            "Test.koplugin/a.lua",
            "Test.koplugin/main.lua",
            "Test.koplugin/z.lua",
            "Test.koplugin/ä.lua",
        ];
        // Sort by codepoint to make the assertion explicit.
        expect(paths).toEqual(expectedOrder);
    });

    test("two writes of the same plugin tree yield identical declared order", () => {
        // Build the tree, collect, tear down, rebuild, collect again —
        // the order must match. Filesystem-creation-order shouldn't
        // affect the result.
        const build = (): readonly string[] => {
            const root = join(workDir, `p-${Math.random().toString(36).slice(2)}`);
            mkdirSync(root, { recursive: true });
            const plugin = join(root, "X.koplugin");
            mkdirSync(plugin);
            // Different write order each call.
            const order = ["b.lua", "a.lua", "c.lua", "ñ.lua", "0.lua"];
            for (const n of order) writeFileSync(join(plugin, n), n);
            const { declared } = collectPluginDirs(root);
            return declared.map((d) => d.path);
        };
        expect(build()).toEqual(build());
    });
});
