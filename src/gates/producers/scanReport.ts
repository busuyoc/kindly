// Producer: scanReport.
//
// Passthrough over ctx.opts.scanReport. The scan itself (`scanShippedLuaFiles`
// in src/catalog/scanPipeline.ts) stays inline in importSetup.ts during
// the migration — it needs shippedPlugins + shippedPatches + files Map +
// the prior pluginHashReport (for catalog-MATCH suppression). Consolidation
// into a producer body is a Step 10 cleanup.
//
// Consumed by STRICT_SCANNER_FINDINGS (Step 7).

import type { ScanReport } from "../../types/results.ts";
import type { GateContext, Producer } from "../types.ts";

export const scanReport: Producer<ScanReport | null> =
    (ctx: GateContext) => {
        return (ctx.opts.scanReport as ScanReport | null | undefined) ?? null;
    };
