// Producer: schemaFindings.
//
// Passthrough over ctx.opts.schemaFindings. `validateSettings` (from
// src/schema/report.ts) stays inline in importSetup.ts — the result
// populates both the gate input AND the SetupImportResult.schemaFindings
// field for post-import rendering, so computing once inline and passing
// both ways is the minimum-duplication approach.

import type { ValidationReport } from "../../schema/report.ts";
import type { GateContext, Producer } from "../types.ts";

export const schemaFindings: Producer<ValidationReport | null> =
    (ctx: GateContext) => {
        return (ctx.opts.schemaFindings as ValidationReport | null | undefined)
            ?? null;
    };
