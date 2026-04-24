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
import { MANIFEST_HASH_ASSERT } from "./definitions/identity.ts";
import {
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    SENSITIVE_REQUIRES_ACK,
} from "./definitions/consent.ts";
import {
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
} from "./definitions/integrity.ts";

// Each gate definition lives in its own category file under ./definitions/.
// The flat array below concatenates them in declaration order — which is
// also the firing order when the orchestrator iterates. A blocking gate's
// error is the first block the CLI surfaces.

export const GATES: ReadonlyArray<GateDefinition> = [
    MANIFEST_HASH_ASSERT,
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
    SENSITIVE_REQUIRES_ACK,
    // (more land here as Steps 8-11 port each gate category)
];

/** For tests / internal tooling: override the registry in a scoped way. */
export function withRegistry<T>(
    registry: ReadonlyArray<GateDefinition>,
    fn: (registry: ReadonlyArray<GateDefinition>) => T,
): T {
    return fn(registry);
}
