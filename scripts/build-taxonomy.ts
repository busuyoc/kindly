#!/usr/bin/env bun
// Taxonomy builder for settings.reader.lua keys.
//
// Reads:
//   - data/schemas/settings.reader.lua.v1.json (type info per key)
//   - data/taxonomy/settings.v1.categories.yaml (key → category, hand-curated)
//
// Writes:
//   - data/taxonomy/settings.v1.json
//
// The output taxonomy is what the GUI sidebar consumes: every schema key gets
// a category (or "uncategorized"), a human label, an optional description,
// and a control_hint inferred from schema type.
//
// Design note (2026-04-22): the category map is key-indexed (one line per key)
// rather than pattern-indexed. Patterns are concise but introduce precedence
// conflicts and silent mis-categorization when the schema grows. 557 explicit
// lines is boring but auditable; `grep "^font_size:"` answers the question.
// Setting relevance/dependencies (which settings gate others) lives in a
// separate data file when it lands — kept orthogonal to the taxonomy schema
// so each concern can version independently.
//
// Usage:  bun run scripts/build-taxonomy.ts [schema-path] [categories-path] [output-path]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse as yamlParse } from "yaml";

type ControlHint = "toggle" | "number" | "text" | "enum" | "color" | "structured";

type SchemaKey = {
    type: "boolean" | "number" | "string" | "table" | "unknown";
    call_sites?: number;
};

type SchemaFile = {
    $schema_version: number;
    keys: Record<string, SchemaKey>;
};

// A category map entry is either the category name (string), or an object
// with overrides. String is the compact case for the 90% where the key speaks
// for itself; object for the cases where you want a better label or hint.
type CategoryEntry = string | {
    category: string;
    label?: string;
    description?: string;
    control_hint?: ControlHint;
};

type CategoriesFile = {
    categories: string[];          // valid category names, for validation
    keys: Record<string, CategoryEntry>;
};

type TaxonomyEntry = {
    category: string;
    label: string;
    description?: string;
    control_hint: ControlHint;
};

type TaxonomyFile = {
    $schema_version: 1;
    generated_at: string;
    source: {
        schema: string;
        categories: string;
    };
    stats: {
        total_keys: number;
        uncategorized_count: number;
        by_category: Record<string, number>;
        by_control_hint: Record<string, number>;
    };
    categories: string[];
    keys: Record<string, TaxonomyEntry>;
};

const UNCATEGORIZED = "uncategorized";

// Map a schema type to a control hint. Category overrides can refine this
// (e.g. a string-typed key that's actually an enum, or a color).
function defaultControlHint(t: SchemaKey["type"]): ControlHint {
    switch (t) {
        case "boolean": return "toggle";
        case "number":  return "number";
        case "string":  return "text";
        case "table":   return "structured";
        case "unknown": return "text"; // safe fallback
    }
}

// "font_face_size" → "Font face size". Boring but consistent; overrides in
// the categories YAML let curators write better labels where it matters.
function humanizeLabel(key: string): string {
    const spaced = key.replace(/_/g, " ").trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function loadSchema(path: string): SchemaFile {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SchemaFile;
    if (!parsed.keys || typeof parsed.keys !== "object") {
        throw new Error(`schema ${path} missing "keys" object`);
    }
    return parsed;
}

function loadCategories(path: string): CategoriesFile {
    const raw = readFileSync(path, "utf8");
    const parsed = yamlParse(raw) as CategoriesFile;
    if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
        throw new Error(`${path} must declare a non-empty "categories" array`);
    }
    if (!parsed.keys || typeof parsed.keys !== "object") {
        throw new Error(`${path} must declare a "keys" map`);
    }
    return parsed;
}

function normalizeEntry(entry: CategoryEntry): {
    category: string;
    label?: string;
    description?: string;
    controlHintOverride?: ControlHint;
} {
    if (typeof entry === "string") return { category: entry };
    return {
        category: entry.category,
        label: entry.label,
        description: entry.description,
        controlHintOverride: entry.control_hint,
    };
}

export function buildTaxonomy(
    schema: SchemaFile,
    categories: CategoriesFile,
    sourcePaths: { schema: string; categories: string },
    now: Date = new Date(),
): TaxonomyFile {
    const validCategories = new Set(categories.categories);
    validCategories.add(UNCATEGORIZED);

    // Validate that every mapped key actually exists in the schema — catches
    // typos and stale entries left over from removed KOReader features.
    const stale: string[] = [];
    for (const k of Object.keys(categories.keys)) {
        if (!(k in schema.keys)) stale.push(k);
    }
    if (stale.length > 0) {
        throw new Error(
            `categories file references ${stale.length} key(s) not in schema: ` +
            stale.slice(0, 5).join(", ") + (stale.length > 5 ? ", ..." : ""),
        );
    }

    // Validate that every category referenced is declared up top.
    const undeclared = new Set<string>();
    for (const [k, entry] of Object.entries(categories.keys)) {
        const { category } = normalizeEntry(entry);
        if (!validCategories.has(category)) undeclared.add(`${k} → ${category}`);
    }
    if (undeclared.size > 0) {
        throw new Error(
            `categories file uses undeclared category names: ${[...undeclared].slice(0, 5).join(", ")}`,
        );
    }

    const outKeys: Record<string, TaxonomyEntry> = {};
    const byCategory: Record<string, number> = {};
    const byHint: Record<string, number> = {};
    let uncategorizedCount = 0;

    // Iterate schema keys (not categories keys) so every schema key gets
    // an entry — unmapped keys fall into `uncategorized`.
    const sortedKeys = Object.keys(schema.keys).sort();
    for (const key of sortedKeys) {
        const schemaKey = schema.keys[key]!;
        const mapped = categories.keys[key];
        const norm = mapped ? normalizeEntry(mapped) : undefined;

        const category = norm?.category ?? UNCATEGORIZED;
        const hint = norm?.controlHintOverride ?? defaultControlHint(schemaKey.type);
        const entry: TaxonomyEntry = {
            category,
            label: norm?.label ?? humanizeLabel(key),
            control_hint: hint,
        };
        if (norm?.description) entry.description = norm.description;

        outKeys[key] = entry;
        byCategory[category] = (byCategory[category] ?? 0) + 1;
        byHint[hint] = (byHint[hint] ?? 0) + 1;
        if (category === UNCATEGORIZED) uncategorizedCount++;
    }

    // Deterministic category list: declared order, then uncategorized at the
    // end if any key landed there. GUI can render in this order.
    const categoriesOut = [...categories.categories];
    if (uncategorizedCount > 0 && !categoriesOut.includes(UNCATEGORIZED)) {
        categoriesOut.push(UNCATEGORIZED);
    }

    return {
        $schema_version: 1,
        generated_at: now.toISOString(),
        source: sourcePaths,
        stats: {
            total_keys: sortedKeys.length,
            uncategorized_count: uncategorizedCount,
            by_category: byCategory,
            by_control_hint: byHint,
        },
        categories: categoriesOut,
        keys: outKeys,
    };
}

function main(argv: readonly string[]): number {
    const repoRoot = resolve(import.meta.dir, "..");
    const schemaPath     = argv[0] ?? resolve(repoRoot, "data/schemas/settings.reader.lua.v1.json");
    const categoriesPath = argv[1] ?? resolve(repoRoot, "data/taxonomy/settings.v1.categories.yaml");
    const outputPath     = argv[2] ?? resolve(repoRoot, "data/taxonomy/settings.v1.json");

    const schema = loadSchema(schemaPath);
    const categories = loadCategories(categoriesPath);

    // Record paths relative to the repo root so the committed taxonomy file
    // doesn't carry absolute home-dir paths (noise on every checkout).
    const out = buildTaxonomy(schema, categories, {
        schema: relative(repoRoot, schemaPath),
        categories: relative(repoRoot, categoriesPath),
    });

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(out, null, 2) + "\n", "utf8");

    console.log(
        `wrote ${outputPath}\n` +
        `  total_keys: ${out.stats.total_keys}\n` +
        `  uncategorized: ${out.stats.uncategorized_count}\n` +
        `  categories: ${out.categories.length}`,
    );
    return 0;
}

if (import.meta.main) {
    process.exit(main(process.argv.slice(2)));
}
