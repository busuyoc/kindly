import { describe, test, expect } from "bun:test";
import { runGates } from "../../src/gates/orchestrator.ts";
import { buildBaseContext } from "../../src/gates/context.ts";
import type { GateDefinition, Producer } from "../../src/gates/types.ts";

// ----------------------------------------------------------------------------
// Scaffold tests. At Step 4 the real registry is empty, so we inject
// mock registries via runGates's test hook to exercise the orchestrator's
// filtering, producer materialization, and bypass logic independently
// from the (future) live gate set.
// ----------------------------------------------------------------------------

function ctx(opts: Record<string, unknown> = {}) {
    return buildBaseContext({
        boundary: "import",
        dryRun: false,
        strictImports: false,
        opts,
    });
}

describe("runGates — empty registry", () => {
    test("returns vacuous report (fired=[], blocked=false)", () => {
        const r = runGates("import", ctx(), { registry: [], producers: {} });
        expect(r.fired).toEqual([]);
        expect(r.blocked).toBe(false);
        expect(r.blockingGates).toEqual([]);
    });

    test("works for 'apply' boundary too", () => {
        const r = runGates("apply", ctx(), { registry: [], producers: {} });
        expect(r.blocked).toBe(false);
    });
});

describe("runGates — appliesAt filter", () => {
    const importGate: GateDefinition = {
        id: "IMPORT_ONLY",
        category: "CONSENT",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "FAT_REQUIRES_ACK",
        check: () => ({ kind: "pass" }),
    };
    const applyGate: GateDefinition = {
        id: "APPLY_ONLY",
        category: "SHAPE",
        appliesAt: ["apply"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: () => ({ kind: "pass" }),
    };
    const bothGate: GateDefinition = {
        id: "BOTH",
        category: "SHAPE",
        appliesAt: ["import", "apply"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: () => ({ kind: "pass" }),
    };
    const registry = [importGate, applyGate, bothGate];

    test("import boundary fires import-applicable gates only", () => {
        const r = runGates("import", ctx(), { registry, producers: {} });
        expect(r.fired.map((f) => f.id).sort()).toEqual(["BOTH", "IMPORT_ONLY"]);
    });

    test("apply boundary fires apply-applicable gates only", () => {
        const r = runGates("apply", ctx(), { registry, producers: {} });
        expect(r.fired.map((f) => f.id).sort()).toEqual(["APPLY_ONLY", "BOTH"]);
    });
});

describe("runGates — firesIn filter", () => {
    const always: GateDefinition = {
        id: "ALWAYS",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: () => ({ kind: "pass" }),
    };
    const nonDryRun: GateDefinition = {
        id: "CONSUMER",
        category: "CONSENT",
        appliesAt: ["import"],
        requires: [],
        firesIn: "non-dry-run",
        bypassFlags: [],
        errorCode: "SENSITIVE_REQUIRES_ACK",
        check: () => ({ kind: "pass" }),
    };
    const strictOnly: GateDefinition = {
        id: "CI_STRICT",
        category: "CONSENT",
        appliesAt: ["import"],
        requires: [],
        firesIn: "strict-imports-only",
        bypassFlags: [],
        errorCode: "STRICT_IMPORT_BLOCKED",
        check: () => ({ kind: "pass" }),
    };
    const registry = [always, nonDryRun, strictOnly];

    test("vanilla run: always + non-dry-run; no strict-only", () => {
        const r = runGates("import", ctx(), { registry, producers: {} });
        expect(r.fired.map((f) => f.id).sort()).toEqual(["ALWAYS", "CONSUMER"]);
    });

    test("dry-run: always only", () => {
        const r = runGates("import", ctx(), {
            registry, producers: {}, dryRun: true,
        });
        expect(r.fired.map((f) => f.id)).toEqual(["ALWAYS"]);
    });

    test("strict-imports: all three", () => {
        const r = runGates("import", ctx(), {
            registry, producers: {}, strictImports: true,
        });
        expect(r.fired.map((f) => f.id).sort()).toEqual(
            ["ALWAYS", "CI_STRICT", "CONSUMER"],
        );
    });

    test("dry-run + strict-imports: always + strict-only, no consumer-ack", () => {
        const r = runGates("import", ctx(), {
            registry, producers: {}, dryRun: true, strictImports: true,
        });
        expect(r.fired.map((f) => f.id).sort()).toEqual(["ALWAYS", "CI_STRICT"]);
    });
});

describe("runGates — blocking + bypass", () => {
    const blockingGate: GateDefinition = {
        id: "BLOCKS",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: ["--accept-sensitive"],
        errorCode: "SENSITIVE_REQUIRES_ACK",
        check: () => ({ kind: "block", message: "not ok" }),
    };

    test("blocking gate without bypass → report.blocked = true", () => {
        const r = runGates("import", ctx(), {
            registry: [blockingGate], producers: {},
        });
        expect(r.blocked).toBe(true);
        expect(r.blockingGates).toEqual(["BLOCKS"]);
        expect(r.fired[0].result.kind).toBe("block");
    });

    test("bypass flag (camelCase) turns block into bypass", () => {
        const r = runGates("import", ctx({ acceptSensitive: true }), {
            registry: [blockingGate], producers: {},
        });
        expect(r.blocked).toBe(false);
        expect(r.fired[0].result.kind).toBe("bypass");
        if (r.fired[0].result.kind === "bypass") {
            expect(r.fired[0].result.byFlag).toBe("--accept-sensitive");
        }
    });
});

describe("runGates — warn tier (S605)", () => {
    const warnGate: GateDefinition = {
        id: "WARNS",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: ["--accept-sensitive"],
        errorCode: "SENSITIVE_REQUIRES_ACK",
        check: () => ({ kind: "warn", message: "looks fishy" }),
    };
    const blockGate: GateDefinition = {
        id: "BLOCKS",
        category: "CONSENT",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "SENSITIVE_REQUIRES_ACK",
        check: () => ({ kind: "block", message: "nope" }),
    };
    const passGate: GateDefinition = {
        id: "PASSES",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: [],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: () => ({ kind: "pass" }),
    };

    test("warn-only run: warned=true, blocked=false", () => {
        const r = runGates("import", ctx(), {
            registry: [warnGate], producers: {},
        });
        expect(r.blocked).toBe(false);
        expect(r.warned).toBe(true);
        expect(r.warningGates).toEqual(["WARNS"]);
        expect(r.blockingGates).toEqual([]);
        expect(r.fired[0].result.kind).toBe("warn");
    });

    test("pass + warn + block: both flags populated independently", () => {
        const r = runGates("import", ctx(), {
            registry: [passGate, warnGate, blockGate], producers: {},
        });
        expect(r.blocked).toBe(true);
        expect(r.blockingGates).toEqual(["BLOCKS"]);
        expect(r.warned).toBe(true);
        expect(r.warningGates).toEqual(["WARNS"]);
    });

    test("logger fires for warn (same channel as block/bypass)", () => {
        const seen: string[] = [];
        runGates("import", ctx(), {
            registry: [passGate, warnGate], producers: {},
            logger: (f) => seen.push(`${f.id}:${f.result.kind}`),
        });
        expect(seen).toEqual(["WARNS:warn"]);
    });

    test("warn is non-bypassable: --accept-sensitive does not clear warn", () => {
        const r = runGates("import", ctx({ acceptSensitive: true }), {
            registry: [warnGate], producers: {},
        });
        expect(r.warned).toBe(true);
        expect(r.warningGates).toEqual(["WARNS"]);
        expect(r.fired[0].result.kind).toBe("warn");
    });
});

describe("runGates — producer materialization", () => {
    let producerCalls = 0;
    const p: Producer<number> = () => {
        producerCalls++;
        return 42;
    };

    const gateA: GateDefinition = {
        id: "A",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: ["numberProducer"],
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: (c) => {
            expect(c.producers.numberProducer).toBe(42);
            return { kind: "pass" };
        },
    };
    const gateB: GateDefinition = {
        id: "B",
        category: "SHAPE",
        appliesAt: ["import"],
        requires: ["numberProducer"],  // same producer — must not re-call
        firesIn: "always",
        bypassFlags: [],
        errorCode: "YAML_NOT_FOUND",
        check: (c) => {
            expect(c.producers.numberProducer).toBe(42);
            return { kind: "pass" };
        },
    };

    test("producer called once even when two gates require it", () => {
        producerCalls = 0;
        runGates("import", ctx(), {
            registry: [gateA, gateB],
            producers: { numberProducer: p },
        });
        expect(producerCalls).toBe(1);
    });

    test("missing producer throws registry misconfiguration", () => {
        expect(() => {
            runGates("import", ctx(), {
                registry: [gateA],
                producers: {},  // gateA needs numberProducer
            });
        }).toThrow(/unknown producer/);
    });
});
