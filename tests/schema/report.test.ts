import { describe, test, expect } from "bun:test";

import { validateSettings, formatValidationReport, hasFindings } from "../../src/schema/report.ts";
import type { Schema } from "../../src/schema/settings.ts";

const FIXTURE: Schema = {
    $schema_version: 1,
    extracted_from: {}, extracted_at: "", stats: {},
    keys: {
        night_mode: { type: "boolean", evidence: { methods: [], literals: [], observed: [], source: null }, call_sites: 1 },
        home_dir:   { type: "string",  evidence: { methods: [], literals: [], observed: [], source: null }, call_sites: 1 },
        items_per_page: { type: "number", evidence: { methods: [], literals: [], observed: [], source: null }, call_sites: 1 },
        footer:     { type: "table",   evidence: { methods: [], literals: [], observed: [], source: null }, call_sites: 1 },
        mystery:    { type: "unknown", evidence: { methods: [], literals: [], observed: [], source: null }, call_sites: 1 },
    },
};

describe("validateSettings — clean", () => {
    test("all keys known and typed correctly → empty report", () => {
        const r = validateSettings({
            night_mode: true,
            home_dir: "/mnt",
            items_per_page: 10,
            footer: { align: "center" },
        }, FIXTURE);
        expect(r.totalKeys).toBe(4);
        expect(r.unknownKeys).toEqual([]);
        expect(r.typeMismatches).toEqual([]);
        expect(hasFindings(r)).toBe(false);
    });

    test("empty table is trivially valid", () => {
        const r = validateSettings({}, FIXTURE);
        expect(r.totalKeys).toBe(0);
        expect(hasFindings(r)).toBe(false);
    });
});

describe("validateSettings — unknown keys", () => {
    test("one typo → one unknown, no mismatches", () => {
        const r = validateSettings({ nightmode: true }, FIXTURE);
        expect(r.unknownKeys).toEqual([{ key: "nightmode", actualType: "boolean" }]);
        expect(r.typeMismatches).toEqual([]);
        expect(hasFindings(r)).toBe(true);
    });

    test("multiple unknowns are sorted and listed", () => {
        const r = validateSettings({
            zzz_custom: 1,
            aaa_custom: "x",
            night_mode: true,
        }, FIXTURE);
        expect(r.unknownKeys.map((u) => u.key)).toEqual(["aaa_custom", "zzz_custom"]);
    });
});

describe("validateSettings — type mismatches", () => {
    test("bool key assigned a string → one mismatch", () => {
        const r = validateSettings({ night_mode: "yes" }, FIXTURE);
        expect(r.typeMismatches).toEqual([
            { key: "night_mode", expectedType: "boolean", actualType: "string" },
        ]);
    });

    test("number key assigned a table → mismatch", () => {
        const r = validateSettings({ items_per_page: { x: 1 } }, FIXTURE);
        expect(r.typeMismatches[0]).toEqual({
            key: "items_per_page", expectedType: "number", actualType: "table",
        });
    });

    test("unknown-type schema entry never produces a mismatch", () => {
        const r = validateSettings({ mystery: "anything" }, FIXTURE);
        expect(r.typeMismatches).toEqual([]);
        expect(r.unknownKeys).toEqual([]);
    });
});

describe("validateSettings — combined", () => {
    test("typo + mismatch reported together", () => {
        const r = validateSettings({
            nightmode: true,          // typo
            items_per_page: "ten",    // mismatch
            home_dir: "/mnt",         // ok
        }, FIXTURE);
        expect(r.unknownKeys).toHaveLength(1);
        expect(r.typeMismatches).toHaveLength(1);
        expect(hasFindings(r)).toBe(true);
    });
});

describe("formatValidationReport", () => {
    test("empty report renders to empty string", () => {
        expect(formatValidationReport({ totalKeys: 0, unknownKeys: [], typeMismatches: [] })).toBe("");
    });

    test("unknowns and mismatches rendered with counts", () => {
        const s = formatValidationReport({
            totalKeys: 3,
            unknownKeys: [{ key: "nightmode", actualType: "boolean" }],
            typeMismatches: [{ key: "items_per_page", expectedType: "number", actualType: "string" }],
        });
        expect(s).toContain("unknown keys (1)");
        expect(s).toContain("nightmode");
        expect(s).toContain("type mismatches (1)");
        expect(s).toContain("items_per_page");
        expect(s).toContain("expected number");
        expect(s).toContain("got string");
    });
});
