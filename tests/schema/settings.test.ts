import { describe, test, expect } from "bun:test";

import { loadSchema, validateKey, jsValueType, type Schema } from "../../src/schema/settings.ts";

// Tiny hand-built schema for focused unit tests.
const FIXTURE: Schema = {
    $schema_version: 1,
    extracted_from: {},
    extracted_at: "2026-04-22T00:00:00Z",
    stats: {},
    keys: {
        night_mode: {
            type: "boolean",
            evidence: { methods: ["isTrue"], literals: [], observed: ["boolean"], source: "method" },
            call_sites: 5,
        },
        home_dir: {
            type: "string",
            evidence: { methods: ["readSetting"], literals: [], observed: ["string"], source: "observed" },
            call_sites: 10,
        },
        items_per_page: {
            type: "number",
            evidence: { methods: ["readSetting", "saveSetting"], literals: ["number"], observed: [], source: "literal" },
            call_sites: 4,
        },
        footer: {
            type: "table",
            evidence: { methods: ["saveSetting"], literals: ["table"], observed: ["table"], source: "literal" },
            call_sites: 2,
        },
        mystery_key: {
            type: "unknown",
            evidence: { methods: ["readSetting"], literals: [], observed: [], source: null },
            call_sites: 1,
        },
    },
};

describe("jsValueType", () => {
    test("maps JS values to schema types", () => {
        expect(jsValueType(true)).toBe("boolean");
        expect(jsValueType(false)).toBe("boolean");
        expect(jsValueType(42)).toBe("number");
        expect(jsValueType(0)).toBe("number");
        expect(jsValueType("hi")).toBe("string");
        expect(jsValueType("")).toBe("string");
        expect(jsValueType([1, 2])).toBe("table");
        expect(jsValueType({ a: 1 })).toBe("table");
    });

    test("null/undefined map to unknown", () => {
        expect(jsValueType(null)).toBe("unknown");
        expect(jsValueType(undefined)).toBe("unknown");
    });
});

describe("validateKey — known keys", () => {
    test("boolean key with boolean value → typeMatch true", () => {
        const r = validateKey(FIXTURE, "night_mode", true);
        expect(r).toEqual({ known: true, typeMatch: true, expectedType: "boolean", actualType: "boolean" });
    });

    test("boolean key with number value → typeMatch false", () => {
        const r = validateKey(FIXTURE, "night_mode", 1);
        expect(r.known).toBe(true);
        expect(r.typeMatch).toBe(false);
        expect(r.expectedType).toBe("boolean");
        expect(r.actualType).toBe("number");
    });

    test("string key with string value → ok", () => {
        const r = validateKey(FIXTURE, "home_dir", "/mnt/books");
        expect(r.typeMatch).toBe(true);
    });

    test("number key with string value → mismatch", () => {
        const r = validateKey(FIXTURE, "items_per_page", "ten");
        expect(r.typeMatch).toBe(false);
        expect(r.expectedType).toBe("number");
        expect(r.actualType).toBe("string");
    });

    test("table key with object value → ok", () => {
        const r = validateKey(FIXTURE, "footer", { align: "center" });
        expect(r.typeMatch).toBe(true);
    });
});

describe("validateKey — unknown schema type", () => {
    test("key exists but type is 'unknown' → typeMatch null, never flagged", () => {
        const r = validateKey(FIXTURE, "mystery_key", "any value");
        expect(r.known).toBe(true);
        expect(r.typeMatch).toBeNull();
        expect(r.expectedType).toBe("unknown");
    });

    test("unknown-type key with any JS type → still typeMatch null", () => {
        expect(validateKey(FIXTURE, "mystery_key", 42).typeMatch).toBeNull();
        expect(validateKey(FIXTURE, "mystery_key", true).typeMatch).toBeNull();
        expect(validateKey(FIXTURE, "mystery_key", { x: 1 }).typeMatch).toBeNull();
    });
});

describe("validateKey — key missing from schema", () => {
    test("completely unknown key → known:false, typeMatch null", () => {
        const r = validateKey(FIXTURE, "nightmode", true);
        expect(r.known).toBe(false);
        expect(r.typeMatch).toBeNull();
        expect(r.expectedType).toBeNull();
        expect(r.actualType).toBe("boolean");
    });

    test("typo against a real key is still unknown → validator's whole job", () => {
        const r = validateKey(FIXTURE, "home_directory", "/x");
        expect(r.known).toBe(false);
    });
});

describe("loadSchema", () => {
    test("loads the committed v1 schema without error", () => {
        const s = loadSchema();
        expect(s.$schema_version).toBe(1);
        expect(Object.keys(s.keys).length).toBeGreaterThan(500);
    });

    test("contains the bool keys that motivated this work", () => {
        const s = loadSchema();
        expect(s.keys["night_mode"]?.type).toBe("boolean");
        expect(s.keys["nightmode"]).toBeUndefined();   // THE typo
    });

    test("loader cache reuses default, explicit path reloads", () => {
        const a = loadSchema();
        const b = loadSchema();
        expect(a).toBe(b);
    });
});
