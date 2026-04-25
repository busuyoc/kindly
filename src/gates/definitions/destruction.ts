// DESTRUCTION gates. Gates that protect against import flows that would
// wipe or destroy unrecoverable amounts of user state.

import type { GateDefinition } from "../types.ts";
import type { ReplaceWarnings } from "../producers/replaceWarnings.ts";
import type { Change } from "../../schema/diff.ts";
import { classifyKey } from "../../schema/classify.ts";

const DESTRUCTIVE_REMOVAL_THRESHOLD = 5;

/**
 * STRICT_REPLACE_REMOVAL_CAP — W34d + W34e.
 *
 * Under --strict-imports, a replace-mode Setup that would remove more
 * than REPLACE_REMOVAL_WARN_THRESHOLD top-level USER keys is almost
 * certainly not what a CI pipeline intended to import. Block with a
 * specific count + sample-key preview so the operator can distinguish
 * "misconfigured manifest" from "intentional wipe".
 *
 * The producer output (replaceWarnings) is null for additive-mode
 * imports or when the removal count is below threshold; both cases
 * result in `kind: "pass"`.
 *
 * Consumer-facing (non-strict) renders the same payload as a warning
 * banner in the import result — no gate involved, the banner is a
 * render-layer concern. The gate only applies the strict-imports
 * refusal.
 */
export const STRICT_REPLACE_REMOVAL_CAP: GateDefinition = {
    id: "STRICT_REPLACE_REMOVAL_CAP",
    category: "DESTRUCTION",
    appliesAt: ["import"],
    requires: ["replaceWarnings"],
    firesIn: "strict-imports-only",
    bypassFlags: [],
    errorCode: "STRICT_IMPORT_BLOCKED",
    remediation: [
        { text: "Verify the Setup's apply_mode and the device state are what you expect, or drop --strict-imports." },
    ],
    check: (ctx) => {
        const warnings = ctx.producers.replaceWarnings as ReplaceWarnings;
        if (!warnings) return { kind: "pass" };
        const sample = warnings.sampleKeys.join(", ");
        return {
            kind: "block",
            message:
                `--strict-imports: replace-mode Setup would remove ` +
                `${warnings.removedUserKeys} top-level USER key(s) ` +
                `(threshold ${warnings.threshold}). First few: ${sample}`,
        };
    },
};

/**
 * DESTRUCTIVE_YAML_SHAPE — apply-side mass-removal cap (C1c).
 *
 * Activated only when the apply registry includes this gate, which the
 * apply command does only under `--untrusted-yaml`. In that mode, a
 * YAML that would remove ≥ 5 top-level USER keys versus the device is
 * almost certainly hostile or misconfigured — bypass with
 * `--accept-destructive` if the removal is intentional.
 *
 * Most legitimate kindly applies are additive (YAML keys overwrite,
 * untouched device keys are preserved by the shallow merge). Removals
 * surface only when the YAML supplies a non-table at a parent (e.g.
 * `kosync: null` — already trapped by YAML_SHAPE_NORMAL) or when a
 * future YAML construct slips past the shape gate. Defense-in-depth.
 *
 * Threshold (5) is the spec default per docs/infra/99-gates-refactor-
 * plan.md §Open decisions; tune from observed apply runs.
 */
export const DESTRUCTIVE_YAML_SHAPE: GateDefinition = {
    id: "DESTRUCTIVE_YAML_SHAPE",
    category: "DESTRUCTION",
    appliesAt: ["apply"],
    requires: [],
    firesIn: "non-dry-run",
    bypassFlags: ["--accept-destructive"],
    errorCode: "DESTRUCTIVE_YAML_SHAPE",
    remediation: [
        { text: "Inspect the diff before accepting.", command: "kindly diff" },
        { text: "Pass --accept-destructive to consent to the mass removal." },
    ],
    check: (ctx) => {
        const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
        const removedUserKeys = changes
            .filter((c) => c.kind === "removed" && c.path.length === 1)
            .filter((c) => classifyKey(c.path[0]!) === "USER")
            .map((c) => c.path[0]!);
        if (removedUserKeys.length < DESTRUCTIVE_REMOVAL_THRESHOLD) {
            return { kind: "pass" };
        }
        const sample = removedUserKeys.slice(0, 5).join(", ");
        return {
            kind: "block",
            message:
                `--untrusted-yaml: this YAML would remove ` +
                `${removedUserKeys.length} top-level USER key(s) ` +
                `(threshold ${DESTRUCTIVE_REMOVAL_THRESHOLD}). First few: ${sample}`,
        };
    },
};
