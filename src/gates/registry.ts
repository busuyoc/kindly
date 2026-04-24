// The gate registry. Single source of truth for every policy gate that
// fires at any trust boundary (import, apply, future: snapshot-restore).
//
// Each gate is a GateDefinition — see types.ts for the shape, and
// docs/infra/99-gates-refactor-plan.md §Architecture for the producers-
// plus-gates rationale.
//
// At Step 4 (scaffold), the registry is EMPTY. Steps 5-9 populate it
// one gate-category at a time by importing GateDefinition objects from
// ./definitions/*.ts and appending them here.

import type { GateDefinition } from "./types.ts";

// Import gate definitions as they land. Each file exports one or more
// GateDefinition objects; the flat array below concatenates them in
// declaration order (which is the firing order — orchestrator iterates
// the array and a blocking gate's error is the first one the CLI surfaces).
//
// import { MANIFEST_HASH_ASSERT } from "./definitions/identity.ts";

export const GATES: ReadonlyArray<GateDefinition> = [
    // (populated by Steps 5-9)
];

/** For tests / internal tooling: override the registry in a scoped way. */
export function withRegistry<T>(
    registry: ReadonlyArray<GateDefinition>,
    fn: (registry: ReadonlyArray<GateDefinition>) => T,
): T {
    return fn(registry);
}
