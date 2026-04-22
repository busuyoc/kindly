// Unit tests for the W9 taxonomy mapper (src/taxonomy/mapper.ts).
//
// The mapper is what diff/inspect/GUI will call to:
//   - resolve category + label + control_hint for a key
//   - turn (prev, next) into {severity, hint?} for rendering a diff row

import { describe, test, expect } from "bun:test";

import {
    categoryOf,
    controlHintOf,
    descriptionOf,
    impactOf,
    labelOf,
    loadTaxonomy,
    type Taxonomy,
} from "../../src/taxonomy/mapper.ts";

function tax(keys: Record<string, Partial<Taxonomy["keys"][string]>>): Taxonomy {
    const out: Taxonomy["keys"] = {};
    for (const [k, v] of Object.entries(keys)) {
        out[k] = {
            category: v.category ?? "reading",
            label: v.label ?? k,
            control_hint: v.control_hint ?? "text",
            ...(v.description !== undefined ? { description: v.description } : {}),
        };
    }
    return {
        $schema_version: 1,
        generated_at: "2026-04-22T00:00:00.000Z",
        source: { schema: "x", categories: "y" },
        stats: { total_keys: Object.keys(out).length, uncategorized_count: 0, by_category: {}, by_control_hint: {} },
        categories: [],
        keys: out,
    };
}

describe("mapper — accessors", () => {
    const t = tax({
        font_size: { category: "fonts", label: "Font size", control_hint: "number" },
        home_dir: { category: "reading", description: "Where the file manager starts." },
    });

    test("categoryOf returns curated category", () => {
        expect(categoryOf(t, "font_size")).toBe("fonts");
        expect(categoryOf(t, "home_dir")).toBe("reading");
    });

    test("categoryOf falls back to uncategorized for unknown key", () => {
        expect(categoryOf(t, "brand_new_flag")).toBe("uncategorized");
    });

    test("labelOf returns curated label or humanized key", () => {
        expect(labelOf(t, "font_size")).toBe("Font size");
        expect(labelOf(t, "home_dir")).toBe("home_dir"); // fixture didn't override
        expect(labelOf(t, "font_menu_use_font_face")).toBe("Font menu use font face");
    });

    test("descriptionOf returns curated value or undefined", () => {
        expect(descriptionOf(t, "home_dir")).toBe("Where the file manager starts.");
        expect(descriptionOf(t, "font_size")).toBeUndefined();
        expect(descriptionOf(t, "unknown")).toBeUndefined();
    });

    test("controlHintOf returns curated hint or text fallback", () => {
        expect(controlHintOf(t, "font_size")).toBe("number");
        expect(controlHintOf(t, "unknown")).toBe("text");
    });
});

describe("mapper — impactOf severity", () => {
    const t = tax({
        lastfile:          { category: "ephemeral" },
        cre_font_size:     { category: "fonts" },
        reader_footer_all: { category: "status_bar" },
        screensaver_type:  { category: "screensaver" },
        inertial_scroll:   { category: "reading" },
        kosync:            { category: "plugins_bundled" },
    });

    test("ephemeral → trivial", () => {
        expect(impactOf(t, "lastfile", "/old", "/new").severity).toBe("trivial");
    });

    test("fonts/status_bar/screensaver → visual", () => {
        expect(impactOf(t, "cre_font_size", 18, 22).severity).toBe("visual");
        expect(impactOf(t, "reader_footer_all", false, true).severity).toBe("visual");
        expect(impactOf(t, "screensaver_type", "cover", "message").severity).toBe("visual");
    });

    test("reading + unknown → functional", () => {
        expect(impactOf(t, "inertial_scroll", false, true).severity).toBe("functional");
        expect(impactOf(t, "totally_new_key", undefined, true).severity).toBe("functional");
    });

    test("plugins_bundled → breaking", () => {
        expect(impactOf(t, "kosync", undefined, { user: "x" }).severity).toBe("breaking");
    });

    test("equal values → trivial regardless of category", () => {
        expect(impactOf(t, "kosync", { a: 1 }, { a: 1 }).severity).toBe("trivial");
        expect(impactOf(t, "cre_font_size", 18, 18).severity).toBe("trivial");
    });
});

describe("mapper — impactOf hints", () => {
    const t = tax({
        cre_font_size:    { category: "fonts" },
        night_mode:       { category: "display" },
        home_dir:         { category: "reading" },
        copt_line_spacing:{ category: "reading" },
        big_blob:         { category: "reading" },
        nested:           { category: "reading" },
    });

    test("added / removed for undefined sides", () => {
        expect(impactOf(t, "home_dir", undefined, "/books").hint).toBe("added");
        expect(impactOf(t, "home_dir", "/books", undefined).hint).toBe("removed");
    });

    test("boolean → enabled/disabled", () => {
        expect(impactOf(t, "night_mode", false, true).hint).toBe("enabled");
        expect(impactOf(t, "night_mode", true, false).hint).toBe("disabled");
    });

    test("numeric delta with percent", () => {
        const h = impactOf(t, "copt_line_spacing", 100, 120).hint;
        expect(h).toBe("100 → 120 (+20%)");
    });

    test("font_size keys get 'larger text'/'smaller text' annotation", () => {
        expect(impactOf(t, "cre_font_size", 18, 22).hint).toContain("larger text");
        expect(impactOf(t, "cre_font_size", 22, 18).hint).toContain("smaller text");
    });

    test("numeric delta handles zero previous", () => {
        expect(impactOf(t, "copt_line_spacing", 0, 5).hint).toBe("0 → 5");
    });

    test("short strings get quoted a → b, long strings omit hint", () => {
        expect(impactOf(t, "home_dir", "/a", "/b").hint).toBe('"/a" → "/b"');
        const longPrev = "x".repeat(80);
        const longNext = "y".repeat(80);
        expect(impactOf(t, "big_blob", longPrev, longNext).hint).toBeUndefined();
    });

    test("tables / mixed types leave hint absent", () => {
        const impact = impactOf(t, "nested", { a: 1 }, { a: 2 });
        expect(impact.severity).toBe("functional");
        expect(impact.hint).toBeUndefined();
    });
});

describe("mapper — loadTaxonomy", () => {
    test("loads the built artifact and exposes real keys", () => {
        const real = loadTaxonomy();
        expect(real.$schema_version).toBe(1);
        expect(real.stats.total_keys).toBeGreaterThan(500);
        // Spot check: curated categories from W8 round.
        expect(categoryOf(real, "cre_font")).toBe("fonts");
        expect(categoryOf(real, "lastfile")).toBe("ephemeral");
        expect(categoryOf(real, "reader_footer_mode")).toBe("status_bar");
    });
});
