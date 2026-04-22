// Unit tests for the W7 taxonomy builder.
//
// Exercises buildTaxonomy() directly with fixture schema + category inputs.
// The script's file-I/O shell (main()) is a thin wrapper around this.

import { describe, test, expect } from "bun:test";

import { buildTaxonomy } from "../../scripts/build-taxonomy.ts";

type SchemaKey = { type: "boolean" | "number" | "string" | "table" | "unknown" };

function schema(keys: Record<string, SchemaKey["type"]>) {
    const out: Record<string, SchemaKey> = {};
    for (const [k, t] of Object.entries(keys)) out[k] = { type: t };
    return { $schema_version: 1, keys: out };
}

function cats(
    categories: string[],
    keys: Record<string, unknown>,
) {
    return { categories, keys } as Parameters<typeof buildTaxonomy>[1];
}

const SOURCE = { schema: "test-schema.json", categories: "test-cats.yaml" };
const NOW = new Date("2026-04-22T12:00:00Z");

describe("buildTaxonomy — happy path", () => {
    test("every schema key gets an entry", () => {
        const out = buildTaxonomy(
            schema({ font_size: "number", home_dir: "string" }),
            cats(["fonts", "reading"], {
                font_size: "fonts",
                home_dir: "reading",
            }),
            SOURCE, NOW,
        );
        expect(Object.keys(out.keys).sort()).toEqual(["font_size", "home_dir"]);
        expect(out.keys.font_size!.category).toBe("fonts");
        expect(out.keys.home_dir!.category).toBe("reading");
    });

    test("infers control_hint from schema type", () => {
        const out = buildTaxonomy(
            schema({
                flag: "boolean",
                count: "number",
                name: "string",
                blob: "table",
                mystery: "unknown",
            }),
            cats(["reading"], {
                flag: "reading", count: "reading", name: "reading",
                blob: "reading", mystery: "reading",
            }),
            SOURCE, NOW,
        );
        expect(out.keys.flag!.control_hint).toBe("toggle");
        expect(out.keys.count!.control_hint).toBe("number");
        expect(out.keys.name!.control_hint).toBe("text");
        expect(out.keys.blob!.control_hint).toBe("structured");
        expect(out.keys.mystery!.control_hint).toBe("text");
    });

    test("humanizes default label; explicit label overrides", () => {
        const out = buildTaxonomy(
            schema({ font_menu_use_font_face: "boolean", home_dir: "string" }),
            cats(["fonts", "reading"], {
                font_menu_use_font_face: "fonts",
                home_dir: { category: "reading", label: "Home directory" },
            }),
            SOURCE, NOW,
        );
        expect(out.keys.font_menu_use_font_face!.label).toBe("Font menu use font face");
        expect(out.keys.home_dir!.label).toBe("Home directory");
    });

    test("description is optional — omitted when not provided", () => {
        const out = buildTaxonomy(
            schema({ a: "boolean", b: "boolean" }),
            cats(["reading"], {
                a: "reading",
                b: { category: "reading", description: "why b matters" },
            }),
            SOURCE, NOW,
        );
        expect(out.keys.a!.description).toBeUndefined();
        expect(out.keys.b!.description).toBe("why b matters");
    });

    test("control_hint override wins over schema-inferred", () => {
        const out = buildTaxonomy(
            schema({ copt_css: "string" }),
            cats(["fonts"], {
                copt_css: { category: "fonts", control_hint: "text" },
            }),
            SOURCE, NOW,
        );
        expect(out.keys.copt_css!.control_hint).toBe("text");
    });
});

describe("buildTaxonomy — uncategorized fallback", () => {
    test("unmapped keys land in uncategorized", () => {
        const out = buildTaxonomy(
            schema({ font_size: "number", weird_thing: "unknown" }),
            cats(["fonts"], { font_size: "fonts" }),
            SOURCE, NOW,
        );
        expect(out.keys.weird_thing!.category).toBe("uncategorized");
        expect(out.stats.uncategorized_count).toBe(1);
        expect(out.categories).toContain("uncategorized");
    });

    test("uncategorized is absent from categories when empty", () => {
        const out = buildTaxonomy(
            schema({ font_size: "number" }),
            cats(["fonts"], { font_size: "fonts" }),
            SOURCE, NOW,
        );
        expect(out.stats.uncategorized_count).toBe(0);
        expect(out.categories).not.toContain("uncategorized");
    });
});

describe("buildTaxonomy — stats", () => {
    test("by_category and by_control_hint tally correctly", () => {
        const out = buildTaxonomy(
            schema({
                f1: "number", f2: "number", f3: "number",
                r1: "boolean", r2: "boolean",
                x: "unknown",
            }),
            cats(["fonts", "reading"], {
                f1: "fonts", f2: "fonts", f3: "fonts",
                r1: "reading", r2: "reading",
                // x unmapped → uncategorized
            }),
            SOURCE, NOW,
        );
        expect(out.stats.total_keys).toBe(6);
        expect(out.stats.uncategorized_count).toBe(1);
        expect(out.stats.by_category).toEqual({
            fonts: 3, reading: 2, uncategorized: 1,
        });
        expect(out.stats.by_control_hint.number).toBe(3);
        expect(out.stats.by_control_hint.toggle).toBe(2);
        expect(out.stats.by_control_hint.text).toBe(1); // unknown → text
    });
});

describe("buildTaxonomy — validation", () => {
    test("rejects category map entry pointing to undeclared category", () => {
        expect(() => buildTaxonomy(
            schema({ font_size: "number" }),
            cats(["fonts"], { font_size: "typography" }),
            SOURCE, NOW,
        )).toThrow(/undeclared category/);
    });

    test("rejects stale key not present in schema", () => {
        expect(() => buildTaxonomy(
            schema({ font_size: "number" }),
            cats(["fonts"], { font_size: "fonts", removed_key: "fonts" }),
            SOURCE, NOW,
        )).toThrow(/not in schema/);
    });
});

describe("buildTaxonomy — output shape", () => {
    test("deterministic key order (alphabetical)", () => {
        const out = buildTaxonomy(
            schema({ zebra: "string", apple: "string", mango: "string" }),
            cats(["reading"], { zebra: "reading", apple: "reading", mango: "reading" }),
            SOURCE, NOW,
        );
        expect(Object.keys(out.keys)).toEqual(["apple", "mango", "zebra"]);
    });

    test("carries source paths + generated_at for traceability", () => {
        const out = buildTaxonomy(
            schema({ a: "boolean" }),
            cats(["reading"], { a: "reading" }),
            SOURCE, NOW,
        );
        expect(out.source).toEqual(SOURCE);
        expect(out.generated_at).toBe("2026-04-22T12:00:00.000Z");
        expect(out.$schema_version).toBe(1);
    });
});
