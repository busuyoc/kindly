// Shared helper: turn a list of schema changes into a grouped-by-category
// shape (DiffGroupEntry[] per category) enriched via the W9 mapper.
//
// Used by `diff` (W10) and `setup inspect --vs-*` (W11). Kept out of
// commands/ so both call sites depend on it without circular imports.

import type { Change } from "../schema/diff.ts";
import type { DiffGroupEntry } from "../types/results.ts";
import { categoryOf, impactOf, labelOf, loadTaxonomy, type Taxonomy } from "./mapper.ts";

export function groupChanges(
    changes: Change[],
    tax: Taxonomy = loadTaxonomy(),
): Record<string, DiffGroupEntry[]> {
    const byCategory = new Map<string, DiffGroupEntry[]>();

    for (const c of changes) {
        const topKey = c.path[0]!;
        const prev = c.kind === "added" ? undefined : (c as { prev: unknown }).prev;
        const next = c.kind === "removed" ? undefined : (c as { next: unknown }).next;

        const impact = impactOf(tax, topKey, prev, next);
        const entry: DiffGroupEntry = {
            key: c.path.join("."),
            label: labelOf(tax, topKey),
            before: prev as DiffGroupEntry["before"],
            after: next as DiffGroupEntry["after"],
            severity: impact.severity,
            kind: c.kind,
        };
        if (impact.hint) entry.hint = impact.hint;

        const cat = categoryOf(tax, topKey);
        const bucket = byCategory.get(cat) ?? [];
        bucket.push(entry);
        byCategory.set(cat, bucket);
    }

    // Insertion order = taxonomy-declared category order, then any leftover
    // (e.g. "uncategorized") sorted alphabetically. Deterministic output so
    // JSON consumers + tests can rely on it.
    const out: Record<string, DiffGroupEntry[]> = {};
    for (const cat of tax.categories) {
        const bucket = byCategory.get(cat);
        if (bucket && bucket.length > 0) out[cat] = bucket;
    }
    for (const cat of [...byCategory.keys()].sort()) {
        if (!(cat in out)) out[cat] = byCategory.get(cat)!;
    }
    return out;
}
