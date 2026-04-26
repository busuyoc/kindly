// S603 — apply-side warn-tier surfacing of validateSettings findings.
// Distinct from SCHEMA_VIOLATION (import-side --strict block).

import { describe, test, expect } from "bun:test";
import { SCHEMA_FINDINGS_WARN } from "../../src/gates/definitions/shape.ts";
import type { GateContext } from "../../src/gates/types.ts";
import type { ValidationReport } from "../../src/schema/report.ts";

function ctxWith(report: ValidationReport | null): GateContext {
    return {
        boundary: "apply",
        dryRun: false,
        strictImports: false,
        opts: {},
        producers: { schemaFindings: report },
    };
}

describe("SCHEMA_FINDINGS_WARN gate", () => {
    test("passes when schemaFindings is null (manifest had no settings)", () => {
        expect(SCHEMA_FINDINGS_WARN.check(ctxWith(null))).toEqual({ kind: "pass" });
    });

    test("passes when validator found nothing", () => {
        const r: ValidationReport = { totalKeys: 0, unknownKeys: [], typeMismatches: [] };
        expect(SCHEMA_FINDINGS_WARN.check(ctxWith(r))).toEqual({ kind: "pass" });
    });

    test("warns on unknown keys", () => {
        const r: ValidationReport = {
            totalKeys: 1,
            unknownKeys: [{ key: "totally_made_up_key", actualType: "string" }],
            typeMismatches: [],
        };
        const out = SCHEMA_FINDINGS_WARN.check(ctxWith(r));
        expect(out.kind).toBe("warn");
        if (out.kind === "warn") {
            expect(out.message).toContain("totally_made_up_key");
        }
    });

    test("warns on type mismatches", () => {
        const r: ValidationReport = {
            totalKeys: 1,
            unknownKeys: [],
            typeMismatches: [
                { key: "anti_alias_ui", expectedType: "boolean", actualType: "string" },
            ],
        };
        const out = SCHEMA_FINDINGS_WARN.check(ctxWith(r));
        expect(out.kind).toBe("warn");
        if (out.kind === "warn") {
            expect(out.message).toContain("anti_alias_ui");
        }
    });

    test("apply-only — does not fire on import (SCHEMA_VIOLATION owns that)", () => {
        expect(SCHEMA_FINDINGS_WARN.appliesAt).toEqual(["apply"]);
    });

    test("non-bypassable — empty bypassFlags", () => {
        expect(SCHEMA_FINDINGS_WARN.bypassFlags).toEqual([]);
    });

    test("fires always (no --strict gate at apply)", () => {
        expect(SCHEMA_FINDINGS_WARN.firesIn).toBe("always");
    });
});
