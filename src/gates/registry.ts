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
import { MANIFEST_HASH_ASSERT, MOUNT_FINGERPRINT_MATCHES } from "./definitions/identity.ts";
import {
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    SENSITIVE_REQUIRES_ACK,
    STRICT_SENSITIVE_CHANGES,
} from "./definitions/consent.ts";
import {
    STRICT_REPLACE_REMOVAL_CAP,
    DESTRUCTIVE_YAML_SHAPE,
} from "./definitions/destruction.ts";
import { EXTRA_PLUGIN_PATHS_DUAL, CODE_EXEC_ADJACENT_REQUIRES_ACK } from "./definitions/dual.ts";
import {
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
} from "./definitions/integrity.ts";
import { COMPAT_INCOMPATIBLE } from "./definitions/compat.ts";
import {
    SCHEMA_VIOLATION,
    YAML_SHAPE_NORMAL,
    PATH_CONTENT_HEURISTIC,
    SCHEMA_FINDINGS_WARN,
} from "./definitions/shape.ts";

// Each gate definition lives in its own category file under ./definitions/.
// The flat array below concatenates them in declaration order — which is
// also the firing order when the orchestrator iterates. A blocking gate's
// error is the first block the CLI surfaces.

export const GATES: ReadonlyArray<GateDefinition> = [
    MANIFEST_HASH_ASSERT,
    MOUNT_FINGERPRINT_MATCHES,
    YAML_SHAPE_NORMAL,
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
    COMPAT_INCOMPATIBLE,
    SCHEMA_VIOLATION,
    SCHEMA_FINDINGS_WARN,
    PATH_CONTENT_HEURISTIC,
    STRICT_REPLACE_REMOVAL_CAP,
    STRICT_SENSITIVE_CHANGES,
    SENSITIVE_REQUIRES_ACK,
    EXTRA_PLUGIN_PATHS_DUAL,
    CODE_EXEC_ADJACENT_REQUIRES_ACK,
    DESTRUCTIVE_YAML_SHAPE,
];

/** For tests / internal tooling: override the registry in a scoped way. */
export function withRegistry<T>(
    registry: ReadonlyArray<GateDefinition>,
    fn: (registry: ReadonlyArray<GateDefinition>) => T,
): T {
    return fn(registry);
}
