// Producer: changes.
//
// Passthrough over ctx.opts.changes. The computation (computeChanges /
// computeReplaceChanges) stays inline in importSetup.ts — it depends on
// mount-read device state + flattened manifest + preservedKeys, all
// already computed there. A later pass could consolidate into a real
// producer body.
//
// Consumed by STRICT_SENSITIVE_CHANGES, EXTRA_PLUGIN_PATHS_DUAL (Step 9),
// and downstream gates in apply (Step 12).

import type { Change } from "../../schema/diff.ts";
import type { GateContext, Producer } from "../types.ts";

export const changes: Producer<Change[]> = (ctx: GateContext) => {
    return (ctx.opts.changes as Change[] | undefined) ?? [];
};
