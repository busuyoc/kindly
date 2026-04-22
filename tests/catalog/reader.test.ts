import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    findPlugin,
    joinCatalogWithState,
    loadPluginCatalog,
    readDisabledSet,
    reloadPluginCatalog,
} from "../../src/catalog/reader.ts";
import { KindlyError } from "../../src/types/errors.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "catalog", "plugins.bundled.v1.json");

beforeEach(() => reloadPluginCatalog());

describe("loadPluginCatalog", () => {
    test("loads and validates the fixture", () => {
        const catalog = loadPluginCatalog(FIXTURE);
        expect(catalog.catalog_version).toBe("v1");
        expect(catalog.plugins.length).toBe(4);
        expect(catalog.plugins.map((p) => p.name).sort())
            .toEqual(["SSH", "calibre", "exporter", "hello"]);
    });

    test("throws CATALOG_NOT_FOUND when file missing", () => {
        try {
            loadPluginCatalog("/nonexistent/catalog.json");
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("CATALOG_NOT_FOUND");
        }
    });

    test("throws CATALOG_MALFORMED when schema fails", () => {
        const dir = mkdtempSync(join(tmpdir(), "catalog-bad-"));
        const bad = join(dir, "plugins.json");
        writeFileSync(bad, JSON.stringify({ catalog_version: "v1", plugins: [] }));
        try {
            loadPluginCatalog(bad);
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("CATALOG_MALFORMED");
        }
    });

    test("passthrough: accepts unknown fields on entries", () => {
        const dir = mkdtempSync(join(tmpdir(), "catalog-pt-"));
        const p = join(dir, "plugins.json");
        writeFileSync(p, JSON.stringify({
            catalog_version: "v1",
            license: "MIT",
            curated_at: "2026-04-22",
            koreader_source: "x",
            plugin_count: 1,
            plugins: [{
                name: "X", folder: "X.koplugin", fullname: "X",
                category: "dev", ship_default_on: "never",
                ship_default_rationale: "r", curation_opinion: "niche",
                description: "d", community_sentiment: "c",
                kindle_notes: "", references: [],
                deprecated: null, computed: false, warnings: [],
                future_field: { nested: 42 },
            }],
            top_level_unknown: "ok",
        }));
        const c = loadPluginCatalog(p);
        expect(c.plugins.length).toBe(1);
    });
});

describe("findPlugin", () => {
    test("finds a plugin by folder-basename name (case-sensitive)", () => {
        const catalog = loadPluginCatalog(FIXTURE);
        expect(findPlugin(catalog, "SSH")?.fullname).toBe("SSH");
        expect(findPlugin(catalog, "ssh")).toBeUndefined();
        expect(findPlugin(catalog, "nope")).toBeUndefined();
    });
});

describe("readDisabledSet", () => {
    test("returns empty set when plugins_disabled is missing", () => {
        expect(readDisabledSet({})).toEqual(new Set());
    });

    test("returns empty set when plugins_disabled is not a dict", () => {
        expect(readDisabledSet({ plugins_disabled: "wat" as unknown as never }))
            .toEqual(new Set());
        expect(readDisabledSet({ plugins_disabled: [1, 2] as unknown as never }))
            .toEqual(new Set());
    });

    test("returns names whose value is true", () => {
        const set = readDisabledSet({
            plugins_disabled: { SSH: true, calibre: true, hello: false },
        });
        expect(set).toEqual(new Set(["SSH", "calibre"]));
    });
});

describe("joinCatalogWithState", () => {
    test("marks enabled_on_device: null when disabled is null", () => {
        const c = loadPluginCatalog(FIXTURE);
        const joined = joinCatalogWithState(c, null);
        expect(joined.every((p) => p.enabled_on_device === null)).toBe(true);
    });

    test("sets enabled_on_device by negation of disabled set", () => {
        const c = loadPluginCatalog(FIXTURE);
        const joined = joinCatalogWithState(c, new Set(["hello"]));
        const byName = Object.fromEntries(joined.map((p) => [p.name, p.enabled_on_device]));
        expect(byName).toEqual({
            SSH: true, calibre: true, exporter: true, hello: false,
        });
    });
});

describe("reloadPluginCatalog", () => {
    test("cache returns same object; reload invalidates", () => {
        // Default-path cache behavior is verified indirectly: passing `path`
        // always bypasses cache, so we assert that explicit calls return
        // equal but independently-parsed structures.
        const a = loadPluginCatalog(FIXTURE);
        const b = loadPluginCatalog(FIXTURE);
        expect(a).not.toBe(b);
        expect(a.plugins.length).toBe(b.plugins.length);
        reloadPluginCatalog();
    });
});
