// Shared helper: turn a list of schema changes into a grouped-by-category
// shape (DiffGroupEntry[] per category) enriched via the W9 mapper.
//
// Used by `diff` (W10) and `setup inspect --vs-*` (W11). Kept out of
// commands/ so both call sites depend on it without circular imports.
//
// W24 — plugins_bundled unification: per-plugin entries in `plugins_disabled`
// (path `plugins_disabled.<name>`) get catalog-aware labels and severities.
// `fullname (opinion)` replaces the generic "Plugins disabled" label, and
// severity is derived from `curation_opinion` (recommended → breaking,
// niche → functional, debloat → trivial). A whole-dict `added` change on
// `plugins_disabled` is decomposed into per-plugin rows at render time so
// the same labeled view works for fresh-install diffs.

import type { LuaValue } from "../lua/writer.ts";
import type { Change } from "../schema/diff.ts";
import type { DiffGroupEntry } from "../types/results.ts";
import { categoryOf, impactOf, labelOf, loadTaxonomy, type Taxonomy, type Severity } from "./mapper.ts";
import { findPlugin, loadPluginCatalog, type PluginCatalog, type CurationOpinion } from "../catalog/reader.ts";

function severityForOpinion(opinion: CurationOpinion): Severity {
    switch (opinion) {
        case "recommended": return "breaking";
        case "niche":       return "functional";
        case "debloat":     return "trivial";
    }
}

/** Try to load the catalog without throwing. If the file is missing or
 *  malformed we fall back to the previous generic rendering — W24 is a
 *  nice-to-have, not a correctness gate. */
function tryLoadCatalog(): PluginCatalog | null {
    try { return loadPluginCatalog(); } catch { return null; }
}

function isPluginsDisabledDict(c: Change): boolean {
    return c.kind === "added"
        && c.path.length === 1
        && c.path[0] === "plugins_disabled"
        && typeof c.next === "object"
        && c.next !== null
        && !Array.isArray(c.next);
}

/** Expand a whole-dict add like `{kind:"added", path:["plugins_disabled"],
 *  next:{SSH:true, hello:true}}` into per-plugin add entries. Values that
 *  aren't `true` (unusual — KOReader only persists true here) are kept
 *  as-is so callers can see them. */
function decomposeAddedPluginsDisabled(c: Change): Change[] {
    if (!isPluginsDisabledDict(c)) return [c];
    const dict = (c as { next: LuaValue }).next as Record<string, LuaValue>;
    const out: Change[] = [];
    for (const name of Object.keys(dict).sort()) {
        out.push({ kind: "added", path: ["plugins_disabled", name], next: dict[name]! });
    }
    return out;
}

/** Build a plugin-toggle-aware DiffGroupEntry. `hint` becomes
 *  "enabled"/"disabled" based on the final value + kind. */
function pluginToggleEntry(
    c: Change,
    pluginName: string,
    catalog: PluginCatalog | null,
    tax: Taxonomy,
): DiffGroupEntry {
    const prev = c.kind === "added"   ? undefined : (c as { prev: LuaValue }).prev;
    const next = c.kind === "removed" ? undefined : (c as { next: LuaValue }).next;

    const p = catalog ? findPlugin(catalog, pluginName) : undefined;
    const label = p
        ? `${p.fullname} (${p.curation_opinion})`
        : `${pluginName} (unknown plugin)`;
    const severity: Severity = p
        ? severityForOpinion(p.curation_opinion)
        // Unknown plugin — be cautious. Could be a third-party install.
        : "breaking";

    // KOReader persists `disabled = true` only; a "removed" entry means the
    // plugin was re-enabled; an "added" entry means it was disabled.
    let hint: string;
    if (c.kind === "added")   hint = next === true ? "disabled" : `enabled → ${String(next)}`;
    else if (c.kind === "removed") hint = "enabled";
    else {
        // "changed" — rare (value flipped within the dict).
        const n = (c as { next: LuaValue }).next;
        hint = n === true ? "disabled" : "enabled";
    }

    const entry: DiffGroupEntry = {
        key: c.path.join("."),
        label,
        before: prev as DiffGroupEntry["before"],
        after: next as DiffGroupEntry["after"],
        severity,
        kind: c.kind,
        hint,
    };
    // Tax is unused for per-plugin entries but kept in scope so future
    // refinements (e.g. read a `category_override` from taxonomy) can
    // access it without another signature change.
    void tax;
    return entry;
}

export function groupChanges(
    changes: Change[],
    tax: Taxonomy = loadTaxonomy(),
    catalog: PluginCatalog | null = tryLoadCatalog(),
): Record<string, DiffGroupEntry[]> {
    // Expand whole-dict adds on plugins_disabled so the grouped view shows
    // one row per plugin even on fresh installs. The raw `changes` array
    // passed to callers is unchanged — this decomposition is a render-layer
    // concern.
    const expanded: Change[] = [];
    for (const c of changes) {
        for (const e of decomposeAddedPluginsDisabled(c)) expanded.push(e);
    }

    const byCategory = new Map<string, DiffGroupEntry[]>();

    for (const c of expanded) {
        const topKey = c.path[0]!;
        const isPluginToggle =
            topKey === "plugins_disabled" && c.path.length === 2;

        let entry: DiffGroupEntry;
        if (isPluginToggle) {
            entry = pluginToggleEntry(c, c.path[1]!, catalog, tax);
        } else {
            const prev = c.kind === "added" ? undefined : (c as { prev: unknown }).prev;
            const next = c.kind === "removed" ? undefined : (c as { next: unknown }).next;
            const impact = impactOf(tax, topKey, prev, next);
            entry = {
                key: c.path.join("."),
                label: labelOf(tax, topKey),
                before: prev as DiffGroupEntry["before"],
                after: next as DiffGroupEntry["after"],
                severity: impact.severity,
                kind: c.kind,
            };
            if (impact.hint) entry.hint = impact.hint;
        }

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
