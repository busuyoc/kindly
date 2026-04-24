// Barrel re-export for gate definitions. Each category file
// (identity.ts, consent.ts, integrity.ts, compat.ts, shape.ts,
// destruction.ts, dual.ts) declares its GateDefinition objects and
// exports them by name. registry.ts imports from here or directly from
// the category files.

export { MANIFEST_HASH_ASSERT } from "./identity.ts";
