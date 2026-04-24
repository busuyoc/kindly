// Producer: replaceWarnings.
//
// Passthrough over ctx.opts.replaceWarnings. The computation
// (computeReplaceWarnings in importSetup.ts) stays inline during the
// migration. Consumed by STRICT_REPLACE_REMOVAL_CAP (Step 9) — the
// consumer-facing warning variant is rendered from the SetupImportResult
// directly, not through a gate.

import type { SetupImportResult } from "../../types/results.ts";
import type { GateContext, Producer } from "../types.ts";

export type ReplaceWarnings = SetupImportResult["replaceWarnings"];

export const replaceWarnings: Producer<ReplaceWarnings> = (ctx: GateContext) => {
    return (ctx.opts.replaceWarnings as ReplaceWarnings | undefined) ?? null;
};
