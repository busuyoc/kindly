// COMPAT gate. Rejects imports whose declared compat block doesn't match
// the device kindly is currently talking to.

import type { GateDefinition } from "../types.ts";
import type { CompatResult } from "../../setup/compat.ts";
import { formatCompatIssue } from "../../setup/compat.ts";

/**
 * COMPAT_INCOMPATIBLE — v0.4 W compat-enforcement.
 *
 * When the Setup's `meta.compat` block declares koreader_version_{min,max}
 * or device restrictions that the detected device violates, refuse the
 * import. `--force` bypasses (the gate returns `bypass` via the generic
 * orchestrator path), reaching the "forced: true" branch of the
 * compatSummary renderer.
 *
 * Setups without a compat block pass (producer returns null → gate passes).
 */
export const COMPAT_INCOMPATIBLE: GateDefinition = {
    id: "COMPAT_INCOMPATIBLE",
    category: "COMPAT",
    appliesAt: ["import"],
    requires: ["compatResult"],
    firesIn: "always",
    bypassFlags: ["--force"],
    errorCode: "COMPAT_INCOMPATIBLE",
    remediation: [
        { text: "Pass --force to import anyway.", command: "kindly setup import <file> --force" },
    ],
    check: (ctx) => {
        const result = ctx.producers.compatResult as CompatResult | null;
        if (!result || result.blocking.length === 0) return { kind: "pass" };
        const blocking = result.blocking.map(formatCompatIssue);
        return {
            kind: "block",
            message:
                `Setup is not compatible with this device:\n  ${blocking.join("\n  ")}`,
        };
    },
};
