// Barrel re-export for gate definitions. Each category file
// (identity.ts, consent.ts, integrity.ts, compat.ts, shape.ts,
// destruction.ts, dual.ts) declares its GateDefinition objects and
// exports them by name. registry.ts imports from here or directly from
// the category files.

export { MANIFEST_HASH_ASSERT } from "./identity.ts";
export {
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    SENSITIVE_REQUIRES_ACK,
} from "./consent.ts";
export {
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
} from "./integrity.ts";
export { COMPAT_INCOMPATIBLE } from "./compat.ts";
export { SCHEMA_VIOLATION } from "./shape.ts";
