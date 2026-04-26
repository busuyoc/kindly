// SHAPE gates. Structural conformance checks on the data being imported
// or applied.

import type { GateDefinition } from "../types.ts";
import type { ValidationReport } from "../../schema/report.ts";
import type { NormalizedYaml } from "../producers/normalizedYaml.ts";
import type { ControlByteReport } from "../producers/controlByteHits.ts";
import type { PathContentReport } from "../producers/pathContentHits.ts";
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

/**
 * CONTROL_BYTES_IN_VALUE — C11 (Batch O closure).
 *
 * Rejects YAML strings that contain raw control bytes (NUL, ESC, BEL, CR,
 * etc.) at SECRET / code-exec-adjacent / sensitive-* keys. Closes the
 * S321 / S322 / S324 chain where YAML-supplied bytes propagate through
 * settings.reader.lua into KOReader's logging, dialog rendering, or HTTP
 * client (CRLF smuggle).
 *
 * Structural, not consent-bearing. There is no legitimate use case for a
 * raw ESC inside `extra_plugin_paths` or a CR inside `kosync.username`.
 * Fires on import + apply, never bypassable. The error message lists hex
 * codepoints, never the raw value (that would re-emit attacker bytes
 * through stderr — Batch M sibling concern).
 */
export const CONTROL_BYTES_IN_VALUE: GateDefinition = {
    id: "CONTROL_BYTES_IN_VALUE",
    category: "SHAPE",
    appliesAt: ["import", "apply", "restore"],
    requires: ["controlByteHits"],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "CONTROL_BYTES_IN_VALUE",
    remediation: [
        { text: "Remove the control bytes (ESC, CR, NUL, BEL, ...) from the listed value(s)." },
        { text: "If the YAML came from an untrusted source, treat the file as hostile and do not apply." },
    ],
    check: (ctx) => {
        const report = ctx.producers.controlByteHits as ControlByteReport;
        if (report.hits.length === 0) return { kind: "pass" };
        const lines = report.hits.map((h) =>
            `  [${h.class}] ${h.path}\n    forbidden bytes: ${h.bytes.join(", ")}`,
        );
        return {
            kind: "block",
            message:
                `YAML contains control bytes inside SECRET / SENSITIVE / code-exec ` +
                `string value(s) (${report.hits.length} hit(s)):\n` +
                lines.join("\n"),
        };
    },
};

/**
 * PATH_CONTENT_HEURISTIC — S602. Warn-tier (S605) advisory on
 * sensitive-fs / sensitive-code-exec path values whose content matches a
 * suspicious pattern:
 *
 *   - traversal:    contains a `..` segment.
 *   - out-of-tree:  absolute path NOT under `/mnt/us/`.
 *
 * Non-bypassable per the warn-tier contract — the message IS the UX.
 * False-positive prone (developers running KOReader on macOS / Linux
 * legitimately have non-/mnt/us paths) so warn-not-block is the right
 * tier. CLI maps `report.warned` to exit code 4.
 *
 * Fires on import + apply + restore — the same scope as
 * CONTROL_BYTES_IN_VALUE, since the same threat model applies at every
 * boundary that can write user-supplied path values to settings.reader.lua.
 *
 * Why warn for absolute-out-of-tree (not block): the heuristic is
 * imperfect. Block belongs to CONTROL_BYTES_IN_VALUE (no legitimate use)
 * and to S89 (structurally wrong). Path content is suggestive, not
 * conclusive — surface it and let the user decide.
 */
export const PATH_CONTENT_HEURISTIC: GateDefinition = {
    id: "PATH_CONTENT_HEURISTIC",
    category: "SHAPE",
    appliesAt: ["import", "apply", "restore"],
    requires: ["pathContentHits"],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "YAML_SHAPE_BLOCKED",  // unused — warn-only gate.
    check: (ctx) => {
        const report = ctx.producers.pathContentHits as PathContentReport;
        if (report.hits.length === 0) return { kind: "pass" };
        const lines = report.hits.map((h) =>
            `  [${h.kind}] ${h.path} = ${JSON.stringify(h.value)}`,
        );
        return {
            kind: "warn",
            message:
                `Path-typed value(s) look suspicious (${report.hits.length} hit(s)):\n` +
                lines.join("\n") + "\n" +
                `  - 'traversal' = path contains a '..' segment.\n` +
                `  - 'out-of-tree' = absolute path not under /mnt/us/.\n` +
                `Review the listed value(s); apply will continue (warn only).`,
        };
    },
};

/**
 * SCHEMA_FINDINGS_WARN — S603. Apply-side warn-tier surfacing of
 * `validateSettings` findings (unknown keys + type mismatches).
 *
 * Why a separate gate from SCHEMA_VIOLATION: SCHEMA_VIOLATION is the
 * import-side strict-mode block (only fires under --strict and only for
 * the unwaived class). On apply, kindly has no --strict surface and no
 * `--allow-unknown-keys` waiver, but the same findings still matter —
 * a typo in `kindly.yaml` silently writes an unknown key to device that
 * KOReader will ignore. Warn-tier surfaces this without changing exit
 * codes for legitimate plugin-scoped extensions.
 *
 * Non-bypassable per the warn-tier contract.
 */
export const SCHEMA_FINDINGS_WARN: GateDefinition = {
    id: "SCHEMA_FINDINGS_WARN",
    category: "SHAPE",
    appliesAt: ["apply"],
    requires: ["schemaFindings"],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "YAML_SHAPE_BLOCKED",  // unused — warn-only gate.
    check: (ctx) => {
        const report = ctx.producers.schemaFindings as ValidationReport | null;
        if (!report) return { kind: "pass" };
        if (report.unknownKeys.length === 0
            && report.typeMismatches.length === 0) return { kind: "pass" };
        return {
            kind: "warn",
            message:
                `Schema findings on apply (warn only):\n${formatValidationReport(report)}`,
        };
    },
};
