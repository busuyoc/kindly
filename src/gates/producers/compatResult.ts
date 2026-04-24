// Producer: compatResult.
//
// Passthrough over ctx.opts.compatResult. The actual compat computation
// (`checkCompat` in src/setup/compat.ts) stays inline in importSetup.ts
// during the migration — it needs mount-resolved KOReader version + device
// family, which are already computed there. Producer materializes the
// precomputed result into ctx.producers for COMPAT_INCOMPATIBLE to read.

import type { CompatResult } from "../../setup/compat.ts";
import type { GateContext, Producer } from "../types.ts";

export const compatResult: Producer<CompatResult | null> =
    (ctx: GateContext) => {
        return (ctx.opts.compatResult as CompatResult | null | undefined)
            ?? null;
    };
