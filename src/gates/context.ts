// Gate context construction. One builder per trust boundary; the
// boundary-specific builder pulls the right options + producers-input
// fields into the shared GateContext shape.
//
// At Step 4 (scaffold), only a minimal baseline builder is exposed.
// Steps 6-12 flesh out per-boundary builders (buildImportContext,
// buildApplyContext) as the first gates consume real producer inputs.

import type { GateContext, GateBoundary } from "./types.ts";

export interface BaseContextInput {
    boundary: GateBoundary;
    dryRun: boolean;
    strictImports: boolean;
    /** Boundary-specific options. Opaque here — gates narrow at check() time. */
    opts: Record<string, unknown>;
}

/** Construct a baseline GateContext. Producer outputs populate during
 *  runGates (orchestrator materializes each required producer). */
export function buildBaseContext(input: BaseContextInput): GateContext {
    return {
        boundary: input.boundary,
        dryRun: input.dryRun,
        strictImports: input.strictImports,
        opts: input.opts,
        producers: {},
    };
}
