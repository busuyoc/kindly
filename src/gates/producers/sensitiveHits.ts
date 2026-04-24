// Producer: sensitiveHits.
//
// Walks the change list and returns the sorted, deduped set of dotted
// paths whose changes intersect a SENSITIVE key or nested path. Consumed
// by SENSITIVE_REQUIRES_ACK (Step 6), STRICT_SENSITIVE_CHANGES (Step 9),
// and EXTRA_PLUGIN_PATHS_DUAL (Step 9). The same data feeds the preview
// renderer's [SENSITIVE] markers via the SetupImportResult.sensitiveHits
// field on the import result.
//
// Depends on ctx.opts.changes (populated by the import-context builder
// after diff computation). If changes is missing/empty, returns [].

import { changeHitsSensitive } from "../../schema/classify.ts";
import type { Change } from "../../schema/diff.ts";
import type { GateContext, Producer } from "../types.ts";

export const sensitiveHits: Producer<string[]> = (ctx: GateContext) => {
    const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
    const hitSet = new Set<string>();
    for (const c of changes) {
        for (const p of changeHitsSensitive(c)) hitSet.add(p);
    }
    return [...hitSet].sort();
};
