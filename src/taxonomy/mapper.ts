// Taxonomy runtime — lookups + change-impact hints.
//
// Consumers (diff, inspect, future GUI) want to answer:
//   - "Which category does this key live under?" → categoryOf
//   - "How should a human read this key's change?" → labelOf, impactOf
//
// impactOf turns a raw (prev, next) into a {severity, hint?} tuple so the UI
// can color a diff row and render a short summary ("18 → 22, +22%") without
// re-deriving taxonomy lookups at every render.
//
// Severity is a function of category — not of the value difference:
//   - ephemeral                                   → trivial
//   - fonts / status_bar / screensaver            → visual
//   - reading / menu / gestures / display /
//     progress / uncategorized                   → functional (safe default)
//   - plugins_bundled                            → breaking
// with the override that equal values are ALWAYS trivial (no-op change).
//
// plugins_bundled is "breaking" because plugin settings can gate whether a
// plugin runs at all; mis-pushing them can brick a plugin the user relies on.
// Once W19-W24 plugin catalog adds per-plugin severity, we'll refine this.

import { resolve } from "node:path";
import { readText } from "../fs/safeRead.ts";

export type ControlHint = "toggle" | "number" | "text" | "enum" | "color" | "structured";

export type TaxonomyEntry = {
    category: string;
    label: string;
    description?: string;
    control_hint: ControlHint;
};

export type Taxonomy = {
    $schema_version: 1;
    generated_at: string;
    source: { schema: string; categories: string };
    stats: {
        total_keys: number;
        uncategorized_count: number;
        by_category: Record<string, number>;
        by_control_hint: Record<string, number>;
    };
    categories: string[];
    keys: Record<string, TaxonomyEntry>;
};

export type Severity = "trivial" | "visual" | "functional" | "breaking";

export type Impact = {
    severity: Severity;
    // Short human-readable summary of the change, e.g. "enabled", "disabled",
    // "18 → 22 (+22%)", "added", "removed". Absent when the change is
    // structural (tables) and better rendered by the UI from raw values.
    hint?: string;
};

const UNCATEGORIZED = "uncategorized";

let cached: Taxonomy | undefined;

// Load the built taxonomy JSON. Default path points at the repo artifact.
// Cached module-level after first read; `reloadTaxonomy()` resets for tests.
export function loadTaxonomy(path?: string): Taxonomy {
    if (cached && !path) return cached;
    const p = path ?? resolve(import.meta.dir, "..", "..", "data/taxonomy/settings.v1.json");
    const parsed = JSON.parse(readText(p, "derived-from-cwd")) as Taxonomy;
    if (!path) cached = parsed;
    return parsed;
}

export function reloadTaxonomy(): void {
    cached = undefined;
}

// "font_face_size" → "Font face size". Matches build-taxonomy's humanizer so
// unknown-key fallback labels look consistent with curated ones.
function humanizeLabel(key: string): string {
    const spaced = key.replace(/_/g, " ").trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function categoryOf(tax: Taxonomy, key: string): string {
    return tax.keys[key]?.category ?? UNCATEGORIZED;
}

export function labelOf(tax: Taxonomy, key: string): string {
    return tax.keys[key]?.label ?? humanizeLabel(key);
}

export function descriptionOf(tax: Taxonomy, key: string): string | undefined {
    return tax.keys[key]?.description;
}

export function controlHintOf(tax: Taxonomy, key: string): ControlHint {
    return tax.keys[key]?.control_hint ?? "text";
}

function severityForCategory(category: string): Severity {
    switch (category) {
        case "ephemeral":                            return "trivial";
        case "fonts":
        case "status_bar":
        case "screensaver":                          return "visual";
        case "plugins_bundled":                      return "breaking";
        case "reading":
        case "menu":
        case "gestures":
        case "display":
        case "progress":
        case UNCATEGORIZED:                          return "functional";
        default:                                     return "functional";
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => deepEqual(x, b[i]));
    }
    if (typeof a === "object") {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        const ak = Object.keys(ao).sort();
        const bk = Object.keys(bo).sort();
        if (ak.length !== bk.length) return false;
        for (let i = 0; i < ak.length; i++) {
            if (ak[i] !== bk[i]) return false;
            if (!deepEqual(ao[ak[i]!], bo[bk[i]!])) return false;
        }
        return true;
    }
    return false;
}

// Small helper: does this key look like a font-size dimension? Used to tack
// a human-readable "larger text"/"smaller text" onto the % delta so the UI
// doesn't have to carry that semantic itself.
function isFontSizeKey(key: string): boolean {
    return /font_size$/.test(key) || key === "copt_font_size" || key === "font_size";
}

function formatNumericDelta(key: string, prev: number, next: number): string {
    if (prev === 0) {
        // Avoid div-by-zero; render as absolute.
        return `${prev} → ${next}`;
    }
    const pct = ((next - prev) / Math.abs(prev)) * 100;
    const sign = pct >= 0 ? "+" : "";
    const rounded = Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1);
    const base = `${prev} → ${next} (${sign}${rounded}%)`;
    if (isFontSizeKey(key)) {
        if (next > prev) return `${base} larger text`;
        if (next < prev) return `${base} smaller text`;
    }
    return base;
}

export function impactOf(
    tax: Taxonomy,
    key: string,
    prev: unknown,
    next: unknown,
): Impact {
    // No-op: always trivial regardless of category. Callers that pre-filter
    // equal values never reach this branch, but it keeps the function safe.
    if (deepEqual(prev, next)) return { severity: "trivial" };

    const severity = severityForCategory(categoryOf(tax, key));

    // Add / remove.
    if (prev === undefined) return { severity, hint: "added" };
    if (next === undefined) return { severity, hint: "removed" };

    // Boolean transitions.
    if (typeof prev === "boolean" && typeof next === "boolean") {
        return { severity, hint: next ? "enabled" : "disabled" };
    }

    // Numeric deltas — but only for keys the taxonomy marks as real numbers.
    // KOReader stores toggles and enums as ints (Lua config has no booleans),
    // so `cre_header_battery: 1 → 0` would otherwise render as "-100%" which
    // reads like catastrophic loss instead of "turned off". control_hint
    // curation in the taxonomy distinguishes the two.
    if (typeof prev === "number" && typeof next === "number") {
        const hint = controlHintOf(tax, key);
        if (hint === "toggle") {
            // Int-backed boolean: normalize 0/1 to enabled/disabled; anything
            // weirder falls back to plain "prev → next".
            if ((prev === 0 || prev === 1) && (next === 0 || next === 1)) {
                return { severity, hint: next === 1 ? "enabled" : "disabled" };
            }
            return { severity, hint: `${prev} → ${next}` };
        }
        if (hint === "enum") {
            return { severity, hint: `${prev} → ${next}` };
        }
        return { severity, hint: formatNumericDelta(key, prev, next) };
    }

    // Short strings: show "a → b"; long ones we skip so the UI renders its own.
    if (typeof prev === "string" && typeof next === "string") {
        if (prev.length <= 40 && next.length <= 40) {
            return { severity, hint: `"${prev}" → "${next}"` };
        }
        return { severity };
    }

    // Tables / mixed types — leave hint to the UI.
    return { severity };
}
