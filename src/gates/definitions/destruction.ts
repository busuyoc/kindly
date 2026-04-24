// DESTRUCTION gates. Gates that protect against import flows that would
// wipe or destroy unrecoverable amounts of user state.

import type { GateDefinition } from "../types.ts";
import type { ReplaceWarnings } from "../producers/replaceWarnings.ts";

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
