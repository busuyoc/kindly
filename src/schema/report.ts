// Aggregated schema validation across a whole settings table.
//
// The validator in settings.ts answers "is this one key/value pair OK?".
// This module walks a top-level settings table, runs the validator per
// key, and groups the results into:
//
//   unknownKeys      — present in settings but not in schema (typo suspects)
//   typeMismatches   — key exists in schema but value type disagrees
//
// v1 walks top-level keys only. Nested-table structure (e.g. footer.align)
// is not in the schema yet — the top-level key "footer" is validated as
// type=table, its inner contents are opaque.

import { validateKey, type Schema, type SchemaKeyType } from "./settings.ts";

export type UnknownKeyReport = {
    key: string;
    actualType: SchemaKeyType;
};

export type TypeMismatchReport = {
    key: string;
    expectedType: SchemaKeyType;
    actualType: SchemaKeyType;
};

export type ValidationReport = {
    totalKeys: number;
    unknownKeys: UnknownKeyReport[];
    typeMismatches: TypeMismatchReport[];
};

export function validateSettings(
    settings: Record<string, unknown>,
    schema: Schema,
): ValidationReport {
    const unknownKeys: UnknownKeyReport[] = [];
    const typeMismatches: TypeMismatchReport[] = [];
    const keys = Object.keys(settings).sort();
    for (const key of keys) {
        const r = validateKey(schema, key, settings[key]);
        if (!r.known) {
            unknownKeys.push({ key, actualType: r.actualType });
            continue;
        }
        if (r.typeMatch === false) {
            typeMismatches.push({
                key,
                expectedType: r.expectedType!,
                actualType: r.actualType,
            });
        }
    }
    return { totalKeys: keys.length, unknownKeys, typeMismatches };
}

export function formatValidationReport(report: ValidationReport): string {
    const lines: string[] = [];
    if (report.unknownKeys.length > 0) {
        lines.push(`unknown keys (${report.unknownKeys.length}) — likely typos or plugin-scoped:`);
        for (const u of report.unknownKeys) {
            lines.push(`  - ${u.key}  (value is ${u.actualType})`);
        }
    }
    if (report.typeMismatches.length > 0) {
        lines.push(`type mismatches (${report.typeMismatches.length}):`);
        for (const t of report.typeMismatches) {
            lines.push(`  - ${t.key}: expected ${t.expectedType}, got ${t.actualType}`);
        }
    }
    return lines.join("\n");
}

export function hasFindings(report: ValidationReport): boolean {
    return report.unknownKeys.length > 0 || report.typeMismatches.length > 0;
}
