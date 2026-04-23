// Plugin hash verification against the curated catalog (W32).
//
// Contract: docs/89-plugin-hash-verification-spec.md §4, §8.
//
// Pure comparison — takes (pluginName, files, catalog) and returns a
// PluginVerdict. Called from two paths:
//   - import (W32): files come from a fat Setup archive's `files` map.
//   - doctor (W34): files come from the on-device `plugins/` directory.
// Same inputs → same verdict. The property test in W32's test suite
// verifies this — the function is the single source of truth for
// "does this plugin match the catalog?"
//
// Verdict ordering (highest severity first in ranked displays):
//   MISMATCH > UNCATALOGUED > UNVERIFIED > MALFORMED_STRUCTURE > MATCH
// Callers may rank differently (e.g. doctor escalates MODIFIED .lua
// higher than MODIFIED assets — see fileRole below).

import { hashBytes } from "../setup/canonical.ts";
import type { PluginCatalog, PluginEntry } from "./reader.ts";

export type PluginFileVerdict =
    | { status: "modified"; file: string; expected: string; actual: string }
    | { status: "extra";    file: string; actual: string }
    | { status: "missing";  file: string; expected: string };

export type PluginVerdict =
    | { status: "MATCH"; name: string }
    | { status: "MISMATCH"; name: string; files: PluginFileVerdict[] }
    | { status: "UNCATALOGUED"; name: string }
    | { status: "UNVERIFIED"; name: string }
    | { status: "MALFORMED_STRUCTURE"; paths: string[] };

export interface PluginHashReport {
    verdicts: PluginVerdict[];
    /** `koreader_hash_version` from the catalog entries (first non-null);
     *  null when no catalogued plugin was compared. */
    catalogVersion: string | null;
    /** KOReader version on the mounted device, null when unknown. */
    deviceVersion: string | null;
    /** True iff catalogVersion === deviceVersion (exact string match). */
    versionMatch: boolean;
}

// 89 §3 "File role derivation": Lua = executable, everything else = asset.
// Doctor (W34) escalates MODIFIED .lua verdicts to error severity; assets
// stay at warning. Extension-only — no content sniffing.
export function fileRole(path: string): "code" | "asset" {
    return path.endsWith(".lua") ? "code" : "asset";
}

// Per-plugin verification. `files` is keyed by path RELATIVE to the
// plugin folder (e.g. "main.lua"), NOT the archive-absolute form
// ("SSH.koplugin/main.lua"). Callers are responsible for stripping
// the folder prefix — keeps this function agnostic about where the
// bytes came from.
//
// `subsetMode` controls the missing-files rule (89 §5.4): in "subset"
// mode, catalog-only files are NOT reported as missing (a fat Setup
// may legitimately ship a subset of the plugin). In "full" mode
// (doctor checking an on-device install), catalog-only files ARE
// reported as missing — a partial install is broken.
export function verifyPluginAgainstCatalog(
    pluginName: string,
    files: Map<string, Uint8Array>,
    catalog: PluginCatalog,
    subsetMode: "subset" | "full" = "full",
): PluginVerdict {
    const entry: PluginEntry | undefined = catalog.plugins.find(
        (p) => p.name === pluginName,
    );
    if (!entry) return { status: "UNCATALOGUED", name: pluginName };
    if (entry.known_hashes == null) return { status: "UNVERIFIED", name: pluginName };

    const known = entry.known_hashes;
    const fileVerdicts: PluginFileVerdict[] = [];

    // Files in archive: match / modified / extra.
    for (const [path, bytes] of files) {
        const expected = known[path];
        const actual = hashBytes(bytes);
        if (expected === undefined) {
            fileVerdicts.push({ status: "extra", file: path, actual });
        } else if (expected !== actual) {
            fileVerdicts.push({ status: "modified", file: path, expected, actual });
        }
        // match → silent
    }

    // Files in catalog but not in archive: missing (only in full mode).
    if (subsetMode === "full") {
        for (const path of Object.keys(known)) {
            if (!files.has(path)) {
                fileVerdicts.push({
                    status: "missing", file: path, expected: known[path]!,
                });
            }
        }
    }

    if (fileVerdicts.length === 0) return { status: "MATCH", name: pluginName };
    return { status: "MISMATCH", name: pluginName, files: fileVerdicts };
}

// Group a fat Setup's archive files by top-level `.koplugin` directory.
// Files whose first segment does not end in `.koplugin` are collected
// under a synthetic `__malformed__` key so the caller can surface a
// single `MALFORMED_STRUCTURE` verdict (89 §4.2 prerequisite). Returns
// a map from plugin name (without the `.koplugin` suffix) to
// { files: Map<relPath, bytes> }. The malformed bucket uses key
// `__malformed__` with { files } that is empty and paths[] populated.
export interface GroupedPluginFiles {
    /** plugin name (no ".koplugin") → file bytes keyed by relative path. */
    plugins: Map<string, Map<string, Uint8Array>>;
    /** Archive paths that did not follow `<name>.koplugin/<file>`. */
    malformed: string[];
}

export function groupArchivePluginFiles(
    archiveFiles: readonly { path: string }[],
    fileBytes: Map<string, Uint8Array>,
): GroupedPluginFiles {
    const plugins = new Map<string, Map<string, Uint8Array>>();
    const malformed: string[] = [];

    for (const f of archiveFiles) {
        const segments = f.path.split("/");
        const head = segments[0];
        if (!head || !head.endsWith(".koplugin") || segments.length < 2) {
            malformed.push(f.path);
            continue;
        }
        const name = head.slice(0, -".koplugin".length);
        const rel = segments.slice(1).join("/");
        const bytes = fileBytes.get(f.path);
        if (bytes === undefined) {
            // unpackSetup's contract: every declared file has bytes.
            // Silently dropping here would hide a pipeline bug — surface it
            // as malformed so the verdict alerts the caller.
            malformed.push(f.path);
            continue;
        }
        let bucket = plugins.get(name);
        if (!bucket) { bucket = new Map(); plugins.set(name, bucket); }
        bucket.set(rel, bytes);
    }

    return { plugins, malformed };
}
