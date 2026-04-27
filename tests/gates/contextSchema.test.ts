// R7 (review hardening): per-boundary required-fields contract.
// Validates that runPhase rejects malformed gate contexts before
// gates fire, surfacing them as GATE_CONTEXT_INVALID rather than
// silent passes.

import { describe, test, expect } from "bun:test";
import { runPhase } from "../../src/gates/orchestrator.ts";
import {
    validateContextOpts, isFieldRequired,
} from "../../src/gates/contextSchema.ts";
import { KindlyError } from "../../src/types/errors.ts";
import type { GateDefinition } from "../../src/gates/types.ts";

const noopGate: GateDefinition = {
    id: "NOOP",
    category: "SHAPE",
    appliesAt: ["import", "apply", "restore", "rollback"],
    requires: [],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "YAML_NOT_FOUND",
    check: () => ({ kind: "pass" }),
};

describe("R7: validateContextOpts — boundary contract", () => {
    test("apply boundary requires `changes`", () => {
        expect(isFieldRequired("apply", "changes")).toBe(true);
    });

    test("restore boundary requires `changes`", () => {
        expect(isFieldRequired("restore", "changes")).toBe(true);
    });

    test("rollback boundary requires `changes`", () => {
        expect(isFieldRequired("rollback", "changes")).toBe(true);
    });

    test("import boundary has no required fields (count fields default to 0)", () => {
        expect(isFieldRequired("import", "changes")).toBe(false);
        expect(isFieldRequired("import", "shippedPluginsCount")).toBe(false);
    });

    test("validateContextOpts throws GATE_CONTEXT_INVALID when apply missing `changes`", () => {
        try {
            validateContextOpts("apply", {});
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("GATE_CONTEXT_INVALID");
            expect((e as KindlyError).message).toContain("changes");
            expect((e as KindlyError).message).toContain("apply");
        }
    });

    test("validateContextOpts passes when required field is present (even if empty array)", () => {
        // The contract is "field exists", not "field is non-empty". An
        // intentionally-empty changes array is a legitimate apply input.
        expect(() => validateContextOpts("apply", { changes: [] })).not.toThrow();
    });

    test("validateContextOpts ignores extra fields", () => {
        // Optional/unknown fields are fine — gates use ?? defaults.
        expect(() => validateContextOpts("apply", {
            changes: [],
            extraField: "ignored",
            moreExtras: 42,
        })).not.toThrow();
    });
});

// R11 (red-team round-7 review followup): null-vs-undefined blind spot
// and unknown-boundary silent-pass.
describe("R11: null and unknown-boundary tightening", () => {
    test("validateContextOpts rejects `changes: null` (silent gate-skip primitive)", () => {
        // Pre-R11, `opts[f] === undefined` accepted null. Gates do
        // `(ctx.opts.changes as Change[] | undefined) ?? []` →
        // `null ?? []` → `[]`, silently passing when caller intent was
        // unclear/malicious. Now we reject null at the contract layer.
        try {
            validateContextOpts("apply", { changes: null });
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("GATE_CONTEXT_INVALID");
            expect((e as KindlyError).message).toContain("changes");
        }
    });

    test("validateContextOpts rejects unknown boundary string", () => {
        // Pre-R11, `REQUIRED_FIELDS[boundary] ?? []` returned [] for
        // typos. A caller passing `boundary: "appli"` (typo of "apply")
        // skipped all gate validation. Now we explicitly reject.
        try {
            // @ts-expect-error — testing runtime behavior on bad input
            validateContextOpts("appli", { changes: [] });
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("GATE_CONTEXT_INVALID");
            expect((e as KindlyError).message).toContain("unknown gate boundary");
            expect((e as KindlyError).message).toContain("appli");
            // Error lists the valid set so the typo is fixable.
            expect((e as KindlyError).message).toContain("apply");
        }
    });

    test("validateContextOpts still rejects undefined (R7 base behavior preserved)", () => {
        try {
            validateContextOpts("apply", { changes: undefined });
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("GATE_CONTEXT_INVALID");
        }
    });

    test("isFieldRequired returns false for unknown boundary (no crash)", () => {
        // The accessor is exposed for tests; a typo there should not
        // crash, just report "not required" so callers don't take
        // action on garbage.
        // @ts-expect-error — testing runtime safety
        expect(isFieldRequired("appli", "changes")).toBe(false);
    });
});

describe("R7: runPhase enforces the contract", () => {
    test("apply boundary without changes → GATE_CONTEXT_INVALID before gate.check fires", () => {
        let checkRan = false;
        const watchingGate: GateDefinition = {
            ...noopGate,
            id: "WATCHING",
            check: () => {
                checkRan = true;
                return { kind: "pass" };
            },
        };

        try {
            runPhase({
                boundary: "apply",
                registry: [watchingGate],
                opts: {}, // missing required `changes`
                dryRun: false,
                strictImports: false,
            });
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("GATE_CONTEXT_INVALID");
        }
        // Critical: contract check fires BEFORE gates run, so no gate
        // sees a partial context.
        expect(checkRan).toBe(false);
    });

    test("import boundary with no required fields → does not throw on empty opts", () => {
        const r = runPhase({
            boundary: "import",
            registry: [noopGate],
            opts: {}, // empty is valid for import
            dryRun: false,
            strictImports: false,
        });
        expect(r.blocked).toBe(false);
    });
});
