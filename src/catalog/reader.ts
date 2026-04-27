// Plugin catalog runtime (v0.9 W19→W24).
//
// Loads `data/catalog/plugins.bundled.v1.json` — the hand-curated descriptor
// for KOReader's bundled plugins, produced by regenerating the draft from a
// KOReader source tree (W19) and curating into the committed v1 file (W20).
//
// Why a runtime loader: W21 (`kindly plugin list`), W22 (`plugin describe`),
// W23 (`debloat-bundled` template), and W24 (`plugins_bundled` category
// unification in diff/inspect) all consume the catalog. Centralizing the
// load + Zod validation means the GUI and CLI go through the same path.
//
// Schema is strict on the required fields (curation contract). Unknown
// keys are silently dropped (Zod v4 default — `.strip`). Round-5 S2082
// closure: previously `.passthrough()` × 3 let attacker-injected fields
// in a swapped catalog (with S2081's cwd hatch) round-trip into the
// `plugin:list` / `plugin:describe` JSON envelope. Strip protects the
// envelope without forcing the schema to enumerate every future field.

import { exists, readText } from "../fs/safeRead.ts";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import type { LuaValue } from "../lua/writer.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

// Round-5 S2083 (partial): size cap before parse, mirroring
// `src/setup/builtinKeyring.ts` MAX_KEYRING_BYTES discipline. The
// production catalog ships at ~50-150 KiB; 1 MiB is generous for any
// realistic curation set. A packager swapping the file for a multi-MiB
// crafted JSON now hits this short-circuit before `JSON.parse` runs.
// Full hash-binding (mirroring BUILTIN_KEYRING_HASH) is the v0.14
// follow-up; size cap closes the most-DoS-amplifying half of the gap.
export const MAX_CATALOG_BYTES = 1024 * 1024;

export const CurationOpinionSchema = z.enum(["recommended", "debloat", "niche"]);
export type CurationOpinion = z.infer<typeof CurationOpinionSchema>;

export const ShipDefaultSchema = z.enum(["always", "hardware_gated", "never"]);
export type ShipDefault = z.infer<typeof ShipDefaultSchema>;

export const DeprecatedSchema = z.object({
    kind: z.string(),
    detail: z.string(),
});

/** W32 (89 §2): per-file SHA256 of a plugin's known-good files, keyed by
 *  path relative to the plugin folder (e.g. `"main.lua"`). Used by the
 *  import-time hash verifier and the doctor to flag tampered or
 *  uncatalogued plugin bytes. */
export const KnownHashesSchema = z.record(
    z.string(),
    z.string().regex(/^sha256:[a-f0-9]{64}$/),
);
export type KnownHashes = z.infer<typeof KnownHashesSchema>;

export const PluginEntrySchema = z.object({
    /** Folder basename without `.koplugin`. Matches the key used in
     *  KOReader's `plugins_disabled` settings dict. */
    name: z.string(),
    /** Human-facing full name from `_meta.lua`. */
    fullname: z.string(),
    /** Filesystem folder under `<koreader>/plugins/`, e.g. "SSH.koplugin". */
    folder: z.string(),
    /** Top-level taxonomy bucket: reading | ui | sync | dev | accessibility | system. */
    category: z.string(),
    /** Upstream default: is this plugin enabled by KOReader itself? */
    ship_default_on: ShipDefaultSchema,
    /** One-line rationale for ship_default_on. */
    ship_default_rationale: z.string(),
    /** MIT-safe paraphrase (NOT the AGPL _meta.lua text). */
    description: z.string(),
    /** kindly's recommendation for a typical Kindle user. */
    curation_opinion: CurationOpinionSchema,
    /** Forum/wiki/issues digest. */
    community_sentiment: z.string(),
    /** Kindle-specific caveats; empty string if none. */
    kindle_notes: z.string(),
    /** 1-3 links out for `plugin describe` + the future GUI. */
    references: z.array(z.string()),
    /** Extractor carry-over: `{kind, detail}` for the rare deprecated plugin. */
    deprecated: DeprecatedSchema.nullable(),
    /** Extractor carry-over: true when the source used `require()`/`and`/`or`. */
    computed: z.boolean(),
    /** Extractor carry-over: non-fatal extraction warnings. */
    warnings: z.array(z.string()),
    /** W32 (89 §2): per-file SHA256 of the plugin's known-good bytes.
     *  `null` when the extractor couldn't hash (predates W32 or failed to
     *  walk the directory). Omitted on entries that predate the field. */
    known_hashes: KnownHashesSchema.nullable().optional(),
});

export type PluginEntry = z.infer<typeof PluginEntrySchema>;

export const PluginCatalogSchema = z.object({
    catalog_version: z.literal("v1"),
    license: z.string(),
    curated_at: z.string(),
    koreader_source: z.string(),
    /** W32 (89 §2): KOReader source version the hashes were computed
     *  from. One value per catalog — spec §5.3 "one hash set per catalog".
     *  Drives the version-skew advisory when the device runs a different
     *  version. Null/omitted on catalogs that predate W32. */
    koreader_hash_version: z.string().nullable().optional(),
    plugin_count: z.number().int().nonnegative(),
    plugins: z.array(PluginEntrySchema),
});

export type PluginCatalog = z.infer<typeof PluginCatalogSchema>;

let cached: PluginCatalog | undefined;

const DEFAULT_PATH = resolve(
    import.meta.dir,
    "..",
    "..",
    "data/catalog/plugins.bundled.v1.json",
);

/** Load + validate the catalog. Cached at module level; pass `path` to
 *  bypass the cache (tests). */
export function loadPluginCatalog(path?: string): PluginCatalog {
    if (cached && !path) return cached;
    const p = path ?? DEFAULT_PATH;
    if (!exists(p, "derived-from-cwd")) {
        throw new KindlyError(
            ErrorCodes.CATALOG_NOT_FOUND,
            `plugin catalog not found at ${p}`,
            [
                {
                    text: "The catalog is committed at data/catalog/plugins.bundled.v1.json. If you're working from a fresh clone, check that the file is present.",
                },
            ],
        );
    }
    const stat = statSync(p);
    if (stat.size > MAX_CATALOG_BYTES) {
        throw new KindlyError(
            ErrorCodes.CATALOG_MALFORMED,
            `plugin catalog at ${p} is ${stat.size} bytes (max ${MAX_CATALOG_BYTES}); install may be tampered`,
            [{ text: "Reinstall kindly from a trusted source." }],
        );
    }
    const raw = JSON.parse(readText(p, "derived-from-cwd"));
    const parsed = PluginCatalogSchema.safeParse(raw);
    if (!parsed.success) {
        throw new KindlyError(
            ErrorCodes.CATALOG_MALFORMED,
            `plugin catalog at ${p} does not match v1 schema: ${parsed.error.message}`,
            [{ text: "Re-run scripts/extract-plugin-meta.ts and re-curate, or pin to a known-good checkout." }],
        );
    }
    if (!path) cached = parsed.data;
    return parsed.data;
}

export function reloadPluginCatalog(): void {
    cached = undefined;
}

/** Look up one entry by name (case-sensitive, matches folder basename). */
export function findPlugin(catalog: PluginCatalog, name: string): PluginEntry | undefined {
    return catalog.plugins.find((p) => p.name === name);
}

/** Extract the `plugins_disabled` dict from a parsed settings.reader.lua.
 *  Returns a Set of plugin names (without `.koplugin`) that the device has
 *  explicitly disabled. Enabled plugins are those NOT in this set. */
export function readDisabledSet(parsedSettings: Record<string, LuaValue>): Set<string> {
    const raw = parsedSettings["plugins_disabled"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
    const out = new Set<string>();
    for (const [k, v] of Object.entries(raw)) {
        if (v === true) out.add(k);
    }
    return out;
}

export interface PluginWithState extends PluginEntry {
    /** True iff the plugin is NOT in `plugins_disabled` on the device. Null
     *  when no device state was available (offline `plugin list`). */
    enabled_on_device: boolean | null;
}

/** Cross-reference the catalog against device state. `disabled` is the set
 *  from `readDisabledSet`, or null when we couldn't read the device. */
export function joinCatalogWithState(
    catalog: PluginCatalog,
    disabled: Set<string> | null,
): PluginWithState[] {
    return catalog.plugins.map((p) => ({
        ...p,
        enabled_on_device: disabled === null ? null : !disabled.has(p.name),
    }));
}
