// Producer registry. Keyed by the short name that gates reference in
// their `requires` field. The orchestrator materializes each required
// producer exactly once per runGates invocation and stashes the result
// in ctx.producers.
//
// At Step 4 (scaffold), the registry is EMPTY. Steps 6-11 populate it
// as gates that depend on producers are ported.

import type { Producer } from "../types.ts";
import { manifestIdentity } from "./manifestIdentity.ts";
import { sensitiveHits } from "./sensitiveHits.ts";
import { pluginHashReport } from "./pluginHashReport.ts";
import { scanReport } from "./scanReport.ts";
import { compatResult } from "./compatResult.ts";
import { schemaFindings } from "./schemaFindings.ts";

export const PRODUCERS: Readonly<Record<string, Producer<unknown>>> = {
    manifestIdentity,
    sensitiveHits,
    pluginHashReport,
    scanReport,
    compatResult,
    schemaFindings,
    // (more land here alongside each gate migration)
};
