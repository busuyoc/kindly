// SHAPE gates. Structural conformance checks on the data being imported
// or applied.
//
// Step 8 ships SCHEMA_VIOLATION (manifest settings vs KOReader schema).
// Step 11 adds YAML_SHAPE_NORMAL — the S89 fix — for the input-shape
// normalizer at the YAML→Lua boundary.

import type { GateDefinition } from "../types.ts";
import type { ValidationReport } from "../../schema/report.ts";
import { formatValidationReport } from "../../schema/report.ts";

/**
 * SCHEMA_VIOLATION — v0.5 W schema-validation + --strict.
 *
 * The schema validator always runs (its output feeds the import result's
 * schemaFindings field whether or not the import blocks). This gate
 * blocks import only under `--strict`, and only when the finding class
 * isn't explicitly waived by `--allow-unknown-keys`. Concretely:
 *
 *   unknown keys + --strict + !allow-unknown-keys  → block
 *   type mismatches + --strict                     → block
 *   either finding + !strict                       → pass (warn only)
 *
 * `--allow-unknown-keys` is a targeted waiver: it suppresses the
 * unknown-key finding class under strict, but does NOT suppress type
 * mismatches. That asymmetry comes from the spec — unknowns are
 * typically plugin-scoped custom keys (benign), mismatches are almost
 * always typos (actionable).
 */
export const SCHEMA_VIOLATION: GateDefinition = {
    id: "SCHEMA_VIOLATION",
    category: "SHAPE",
    appliesAt: ["import"],
    requires: ["schemaFindings"],
    firesIn: "always",  // gate's own check() filters on strict
    bypassFlags: [],    // --strict triggers, it doesn't bypass
    errorCode: "SCHEMA_VIOLATION",
    remediation: [
        { text: "Review the listed keys — likely typos or plugin-scoped unknowns." },
        { text: "Re-run without --strict, or pass --allow-unknown-keys if you're sure." },
    ],
    check: (ctx) => {
        const report = ctx.producers.schemaFindings as ValidationReport | null;
        if (!report) return { kind: "pass" };
        const strict = ctx.opts.strict as boolean | undefined;
        if (!strict) return { kind: "pass" };

        const hasUnknowns = report.unknownKeys.length > 0;
        const hasMismatches = report.typeMismatches.length > 0;
        const allowUnknownKeys = ctx.opts.allowUnknownKeys as boolean | undefined;
        const showUnknowns = !allowUnknownKeys;
        const schemaBlocks = (showUnknowns && hasUnknowns) || hasMismatches;
        if (!schemaBlocks) return { kind: "pass" };

        const msg = formatValidationReport(report);
        return {
            kind: "block",
            message: `${msg}\n--strict: aborting due to schema findings.`,
        };
    },
};
