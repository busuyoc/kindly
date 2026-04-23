// W36/W37: wire scanLuaSource over a fat Setup's shipped plugin and
// patch files, with catalog-hash suppression.
//
// Spec: docs/93-lua-static-scanner-spec.md §5.2, §7.
//
// The load-bearing decision (docs/93 §5.2): findings on a file whose
// sha256 matches a MATCH verdict in the PluginHashReport are *suppressed*
// — counted in `suppressedByCatalog` but not emitted. The catalog is
// the whitelist; curators already reviewed that exact byte sequence.
// Novelty is the threat. MISMATCH / UNCATALOGUED / MALFORMED_STRUCTURE
// all leave findings visible; only MATCH silences them.
//
// Pure function on byte maps. Callers (src/lib/importSetup.ts +
// src/lib/setupInspect.ts) assemble the inputs; this module does the
// walking, hashing, scanning, and suppression math.

import { hashBytes } from "../setup/canonical.ts";
import { scanLuaSource } from "../setup/luaScan.ts";
import type { EmbeddedFile } from "../setup/schema.ts";
import type { ScanFinding, ScanReport } from "../types/results.ts";
import type { PluginHashReport, PluginVerdict } from "./verify.ts";

// Sentinel used as the `plugin` field on patch findings. Patches live
// flat under `patches/` and have no containing plugin; the sentinel
// keeps the renderer and JSON shape uniform.
export const PATCH_SENTINEL = "(patch)";

export interface ScanInputs {
    /** EmbeddedFile entries from manifest.plugins.files. Paths are
     *  archive-absolute (`statistics.koplugin/main.lua`). */
    shippedPlugins: readonly EmbeddedFile[];
    /** EmbeddedFile entries from manifest.patches. Paths are
     *  archive-absolute (`patches/01-foo.lua`). */
    shippedPatches: readonly EmbeddedFile[];
    /** Per-file bytes keyed by the archive-absolute path. */
    files: Map<string, Buffer>;
    /** Optional hash report for catalog suppression. When null, nothing
     *  is suppressed. */
    hashReport: PluginHashReport | null;
}

// Build a set of "plugin names with MATCH verdict". Per docs/93 §5.2,
// only MATCH triggers suppression — everything else leaves findings
// visible.
function matchedPluginNames(report: PluginHashReport | null): Set<string> {
    const set = new Set<string>();
    if (!report) return set;
    for (const v of report.verdicts as readonly PluginVerdict[]) {
        if (v.status === "MATCH") set.add(v.name);
    }
    return set;
}

export function scanShippedLuaFiles(inputs: ScanInputs): ScanReport {
    const findings: ScanFinding[] = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    let suppressedByCatalog = 0;

    const matched = matchedPluginNames(inputs.hashReport);

    // Plugins: `<name>.koplugin/<rest>`. Scan every `.lua`, suppress when
    // the plugin's verdict is MATCH (all file hashes matched the catalog,
    // so the whole plugin is known-good and we don't re-scold).
    for (const entry of inputs.shippedPlugins) {
        if (!entry.path.endsWith(".lua")) continue;
        const segments = entry.path.split("/");
        const head = segments[0];
        if (!head || !head.endsWith(".koplugin") || segments.length < 2) continue;
        const pluginName = head.slice(0, -".koplugin".length);
        const relPath = segments.slice(1).join("/");

        if (matched.has(pluginName)) {
            suppressedByCatalog++;
            continue;
        }

        const bytes = inputs.files.get(entry.path);
        if (!bytes) continue; // unpackSetup contract should prevent this

        const source = bytes.toString("utf8");
        filesScanned++;
        bytesScanned += bytes.length;

        for (const m of scanLuaSource(source)) {
            findings.push({
                plugin: pluginName,
                file: relPath,
                line: m.line,
                category: m.category,
                label: m.label,
                snippet: m.snippet,
            });
        }
    }

    // Patches: flat under `patches/`. No catalog coverage — patches are
    // ephemeral KOReader runtime tweaks, never catalogued. Every shipped
    // patch gets scanned.
    for (const entry of inputs.shippedPatches) {
        if (!entry.path.endsWith(".lua")) continue;
        const relPath = entry.path.startsWith("patches/")
            ? entry.path.slice("patches/".length)
            : entry.path;

        const bytes = inputs.files.get(entry.path);
        if (!bytes) continue;

        const source = bytes.toString("utf8");
        filesScanned++;
        bytesScanned += bytes.length;

        for (const m of scanLuaSource(source)) {
            findings.push({
                plugin: PATCH_SENTINEL,
                file: relPath,
                line: m.line,
                category: m.category,
                label: m.label,
                snippet: m.snippet,
            });
        }
    }

    findings.sort((a, b) => {
        if (a.plugin !== b.plugin) return a.plugin.localeCompare(b.plugin);
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.line - b.line;
    });

    return { findings, filesScanned, bytesScanned, suppressedByCatalog };
}

// Convenience used by setupInspect.ts, which loads the archive but
// doesn't know about catalog verdicts. The verify hash (for suppression)
// is optional — when the pipeline has no hash report (lean inspect flow),
// we still scan everything; findings just aren't suppressible.
export function hashesForShippedPlugins(
    files: Map<string, Buffer>,
): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, bytes] of files) {
        out.set(path, hashBytes(bytes as unknown as Uint8Array));
    }
    return out;
}
