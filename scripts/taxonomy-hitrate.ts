#!/usr/bin/env bun
// One-shot: cross-reference a real device's top-level settings keys against
// the taxonomy to see how many get categorized vs land in "uncategorized".
// Not a recurring check — just a sanity pass during W7 curation.
//
// Usage:  bun run scripts/taxonomy-hitrate.ts [mount-root]
//   default mount-root: /Volumes/Kindle

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSettingsFile } from "../src/lua/reader.ts";

type TaxonomyEntry = { category: string; label: string; control_hint: string };
type TaxonomyFile = { keys: Record<string, TaxonomyEntry> };

function main(argv: readonly string[]): number {
    const mount = argv[0] ?? "/Volumes/Kindle";
    const settingsPath = resolve(mount, "koreader/settings.reader.lua");
    const taxonomyPath = resolve(
        import.meta.dir, "..", "data/taxonomy/settings.v1.json",
    );

    const tax = JSON.parse(readFileSync(taxonomyPath, "utf8")) as TaxonomyFile;
    const onDevice = parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;

    const deviceKeys = Object.keys(onDevice).sort();
    const byCategory: Record<string, string[]> = {};
    const unknownToSchema: string[] = [];

    for (const k of deviceKeys) {
        const entry = tax.keys[k];
        if (!entry) {
            unknownToSchema.push(k);
            continue;
        }
        (byCategory[entry.category] ??= []).push(k);
    }

    const total = deviceKeys.length;
    const uncat = byCategory.uncategorized?.length ?? 0;
    const missing = unknownToSchema.length;
    const categorized = total - uncat - missing;

    console.log(`device: ${settingsPath}`);
    console.log(`taxonomy: ${taxonomyPath}`);
    console.log();
    console.log(`top-level keys on device: ${total}`);
    console.log(`  categorized:   ${categorized} (${((categorized / total) * 100).toFixed(1)}%)`);
    console.log(`  uncategorized: ${uncat} (${((uncat / total) * 100).toFixed(1)}%)`);
    console.log(`  not in schema: ${missing} (${((missing / total) * 100).toFixed(1)}%)`);
    console.log();

    console.log("by category:");
    const orderedCats = Object.keys(byCategory).sort((a, b) =>
        (byCategory[b]!.length) - (byCategory[a]!.length));
    for (const c of orderedCats) {
        console.log(`  ${c.padEnd(16)} ${byCategory[c]!.length.toString().padStart(3)}`);
    }
    console.log();

    if (uncat > 0) {
        console.log("uncategorized keys present on device (W8 priorities):");
        for (const k of byCategory.uncategorized!.sort()) console.log(`  ${k}`);
        console.log();
    }

    if (missing > 0) {
        console.log("keys on device but NOT in schema extract (schema drift or plugin keys):");
        for (const k of unknownToSchema) console.log(`  ${k}`);
    }

    return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
