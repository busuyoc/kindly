// INTEGRITY gates. Strict-mode gates that verify the bytes being imported
// match what their catalog-provided metadata claims. Both fire only when
// --strict-imports is passed — they're CI-preflight teeth, not user-ack
// warnings (the consumer-facing equivalents are handled by the W32
// hash-verdict renderer and W36/W37 scan-findings preview in the
// import result).

import type { GateDefinition } from "../types.ts";
import type { PluginHashReport } from "../../catalog/verify.ts";
import type { ScanReport } from "../../types/results.ts";

/**
 * STRICT_PLUGIN_HASH_CHECK — W34e.
 *
 * Under --strict-imports, any plugin file whose byte hash fails to MATCH
 * the catalog blocks the import. Non-MATCH verdicts include UNVERIFIED
 * (catalog has no hashes for this plugin), UNCATALOGUED (plugin not in
 * catalog at all), MISMATCH (hash differs), and MALFORMED_STRUCTURE
 * (archive entries outside <name>.koplugin/).
 *
 * UNVERIFIED blocks too — an attacker could otherwise impersonate any
 * catalogued-but-unhashed plugin folder name to slip S2-style
 * lexically-obfuscated payloads past the strict gate. (See 89 §4.4.)
 */
export const STRICT_PLUGIN_HASH_CHECK: GateDefinition = {
    id: "STRICT_PLUGIN_HASH_CHECK",
    category: "INTEGRITY",
    appliesAt: ["import"],
    requires: ["pluginHashReport"],
    firesIn: "strict-imports-only",
    bypassFlags: [],
    errorCode: "STRICT_IMPORT_BLOCKED",
    remediation: [
        { text: "Regenerate the catalog against the device's KOReader version, or drop --strict-imports if the findings are expected." },
    ],
    check: (ctx) => {
        const report = ctx.producers.pluginHashReport as PluginHashReport | null;
        if (!report) return { kind: "pass" };
        const bad = report.verdicts.filter((v) => v.status !== "MATCH");
        if (bad.length === 0) return { kind: "pass" };
        const list = bad
            .map((v) => v.status === "MALFORMED_STRUCTURE"
                ? `  [MALFORMED_STRUCTURE] ${v.paths.length} path(s) outside <name>.koplugin/`
                : `  [${v.status}] ${v.name}`)
            .join("\n");
        return {
            kind: "block",
            message:
                `--strict-imports: ${bad.length} plugin integrity finding(s):\n${list}`,
        };
    },
};

/**
 * STRICT_SCANNER_FINDINGS — W36/W37.
 *
 * Under --strict-imports, any unsuppressed finding from the Lua static
 * scanner (os.execute, io.popen, require("socket"), loadstring, etc.)
 * blocks the import. Catalog-MATCH findings are already suppressed upstream
 * (docs/93 §5.2); what reaches this gate is by definition "code we
 * couldn't vouch for via the catalog."
 */
export const STRICT_SCANNER_FINDINGS: GateDefinition = {
    id: "STRICT_SCANNER_FINDINGS",
    category: "INTEGRITY",
    appliesAt: ["import"],
    requires: ["scanReport"],
    firesIn: "strict-imports-only",
    bypassFlags: [],
    errorCode: "STRICT_IMPORT_BLOCKED",
    remediation: [
        { text: "Review the findings.", command: "kindly setup inspect <file>" },
        { text: "If the shipped plugin is bundled and curated, the hash should match the catalog; regenerate the catalog if it drifted." },
        { text: "Drop --strict-imports if the findings are expected." },
    ],
    check: (ctx) => {
        const report = ctx.producers.scanReport as ScanReport | null;
        if (!report || report.findings.length === 0) return { kind: "pass" };
        const preview = report.findings.slice(0, 5).map(
            (f) => `  [${f.category}] ${f.plugin}/${f.file}:${f.line}`,
        ).join("\n");
        const more = report.findings.length > 5
            ? `\n  … and ${report.findings.length - 5} more`
            : "";
        return {
            kind: "block",
            message:
                `--strict-imports: ${report.findings.length} Lua scanner finding(s) in shipped code:\n${preview}${more}`,
        };
    },
};
