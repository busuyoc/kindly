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
    STRICT_SENSITIVE_CHANGES,
} from "./consent.ts";
export { STRICT_REPLACE_REMOVAL_CAP } from "./destruction.ts";
export { EXTRA_PLUGIN_PATHS_DUAL } from "./dual.ts";
export {
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
} from "./integrity.ts";
export { COMPAT_INCOMPATIBLE } from "./compat.ts";
export { SCHEMA_VIOLATION, YAML_SHAPE_NORMAL, CONTROL_BYTES_IN_VALUE } from "./shape.ts";
