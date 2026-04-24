// Producer: pluginHashReport.
//
// Passthrough over ctx.opts.pluginHashReport. The actual hash computation
// (`computePluginHashReport` in src/lib/importSetup.ts) stays where it is
// during the migration — it depends on mount-loaded catalog + detected
// version, which aren't yet threaded into the gate context. A later
// consolidation (Step 10) could move the computation into the producer.
//
// Consumed by STRICT_PLUGIN_HASH_CHECK (Step 7) and — via the same
// ctx.opts shape — by the still-inline W32 FAT_REQUIRES_ACK renderer in
// importSetup.ts.

import type { PluginHashReport } from "../../catalog/verify.ts";
import type { GateContext, Producer } from "../types.ts";

export const pluginHashReport: Producer<PluginHashReport | null> =
    (ctx: GateContext) => {
        return (ctx.opts.pluginHashReport as PluginHashReport | null | undefined)
            ?? null;
    };
