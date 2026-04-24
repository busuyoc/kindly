// SHAPE gates. Structural conformance checks on the data being imported
// or applied.

import type { GateDefinition } from "../types.ts";
import type { ValidationReport } from "../../schema/report.ts";
import type { NormalizedYaml } from "../producers/normalizedYaml.ts";
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
    firesIn: "always",
    bypassFlags: [],
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

/**
 * YAML_SHAPE_NORMAL — S89 fix, Step 11.
 *
 * Structurally rejects YAML shapes that would wipe SECRETs on merge.
 * The normalizedYaml producer does the detection; this gate translates
 * any errors into a structured block.
 *
 * Fires on BOTH import and apply boundaries. Apply has no previous
 * equivalent — S89 lives in that gap — and the gate registration here
 * (via appliesAt: ["import", "apply"]) is the structural fix that
 * Steps 12's apply-side gate run will activate.
 *
 * No bypass. If your YAML contains a SECRET or would wipe one, the fix
 * is "remove that from your YAML," not a flag.
 */
export const YAML_SHAPE_NORMAL: GateDefinition = {
    id: "YAML_SHAPE_NORMAL",
    category: "SHAPE",
    appliesAt: ["import", "apply"],
    requires: ["normalizedYaml"],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "YAML_SHAPE_BLOCKED",
    remediation: [
        { text: "Remove SECRET-class keys from your YAML — secrets live only on device." },
        { text: "For nested secrets, keep the parent table as an object and omit the secret child." },
    ],
    check: (ctx) => {
        const normalized = ctx.producers.normalizedYaml as NormalizedYaml;
        if (normalized.errors.length === 0) return { kind: "pass" };
        const lines = normalized.errors.map((e) => `  [${e.kind}] ${e.path}\n    ${e.detail}`);
        return {
            kind: "block",
            message:
                `YAML input would damage on-device SECRETs (${normalized.errors.length} issue(s)):\n` +
                lines.join("\n"),
        };
    },
};
