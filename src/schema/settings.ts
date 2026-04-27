// Settings-key schema loader + per-key validator.
//
// The schema file is extracted from a KOReader source tree by
// scripts/extract-schema.ts and committed to data/schemas/. Each key gets
// an inferred type:
//
//   boolean | number | string | table | unknown
//
// "unknown" means we saw the key referenced in KOReader source (so it IS a
// real key) but could not pin down its type. We never reject an "unknown"
// key — only keys absent from the schema entirely are flagged as potential
// typos.

import { readText } from "../fs/safeRead.ts";

// Static import: bundled into `bun build --compile` output. Used when
// loadSchema() is called without an explicit path (the common case);
// callers passing a path go through readText for runtime override.
import bundledSchema from "../../data/schemas/settings.reader.lua.v1.json" with { type: "json" };

export type SchemaKeyType = "boolean" | "number" | "string" | "table" | "unknown";

export type SchemaKey = {
    type: SchemaKeyType;
    evidence: {
        methods: readonly string[];
        literals: readonly string[];
        observed: readonly string[];
        source: "method" | "literal" | "observed" | null;
    };
    call_sites: number;
};

export type Schema = {
    $schema_version: number;
    extracted_from: Record<string, unknown>;
    extracted_at: string;
    stats: Record<string, unknown>;
    keys: Record<string, SchemaKey>;
};

let defaultSchema: Schema | null = null;

export function loadSchema(path?: string): Schema {
    if (!path) {
        if (defaultSchema) return defaultSchema;
        defaultSchema = bundledSchema as Schema;
        return defaultSchema;
    }
    const raw = readText(path, "derived-from-cwd");
    return JSON.parse(raw) as Schema;
}

export type ValidateKeyResult = {
    known: boolean;
    // typeMatch is null when the key is unknown OR when the schema type is "unknown"
    // (we can't judge). Otherwise true/false.
    typeMatch: boolean | null;
    expectedType: SchemaKeyType | null;
    actualType: SchemaKeyType;
};

export function jsValueType(v: unknown): SchemaKeyType {
    if (v === null || v === undefined) return "unknown";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    if (typeof v === "string") return "string";
    if (typeof v === "object") return "table";
    return "unknown";
}

export function validateKey(schema: Schema, key: string, value: unknown): ValidateKeyResult {
    const entry = schema.keys[key];
    const actualType = jsValueType(value);
    if (!entry) {
        return { known: false, typeMatch: null, expectedType: null, actualType };
    }
    if (entry.type === "unknown") {
        return { known: true, typeMatch: null, expectedType: "unknown", actualType };
    }
    return {
        known: true,
        typeMatch: entry.type === actualType,
        expectedType: entry.type,
        actualType,
    };
}
