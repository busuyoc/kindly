// Producer: codeExecAdjacentHits.
//
// Walks the change list and returns sorted dotted paths whose changes
// intersect the data-driven `code_exec_adjacent` denylist
// (src/schema/classify.ts + data/classify/settings.v1.json). Consumed
// by CODE_EXEC_ADJACENT_REQUIRES_ACK (DUAL category).
//
// Orthogonal to `sensitiveHits`: a key can be BOTH sensitive-ssh
// (SSH_port) and code-exec-adjacent. Each consent axis has its own
// producer so the gates remain independent — passing --accept-sensitive
// does NOT imply code-exec consent.
//
// Depends on ctx.opts.changes. If changes is missing/empty, returns [].

import { isCodeExecAdjacent } from "../../schema/classify.ts";
import type { Change } from "../../schema/diff.ts";
import type { GateContext, Producer } from "../types.ts";

export const codeExecAdjacentHits: Producer<string[]> = (ctx: GateContext) => {
    const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
    const hits = new Set<string>();
    for (const c of changes) {
        const dotted = c.path.join(".");
        if (isCodeExecAdjacent(dotted)) hits.add(dotted);
        // Also handle subtree-carrier case: a top-level change whose new
        // value is an object containing a code-exec-adjacent key.
        if (c.kind === "added" || c.kind === "changed") {
            collectNested(c.path, c.next, hits);
        }
        if (c.kind === "removed" || c.kind === "changed") {
            collectNested(c.path, c.prev, hits);
        }
    }
    return [...hits].sort();
};

function collectNested(
    prefix: readonly string[],
    value: unknown,
    out: Set<string>,
): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const full = [...prefix, k];
        const dotted = full.join(".");
        if (isCodeExecAdjacent(dotted)) out.add(dotted);
        collectNested(full, v, out);
    }
}
