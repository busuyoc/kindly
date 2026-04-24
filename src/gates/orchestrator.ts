// Gate orchestrator. Given a boundary, a built context, and run options,
// run every registered gate whose (appliesAt × firesIn) matches, and
// return a report the caller can inspect.
//
// The orchestrator is purely mechanical: no policy lives here, only
// filtering + producer materialization + result aggregation. Adding a
// gate means adding a row to the registry — the orchestrator picks it
// up without code change.
//
// At Step 4 (scaffold), the registry + producer map are both empty, so
// every runGates call returns a vacuous report (blocked=false). Tests
// verify the filtering logic against mock registries.

import { GATES } from "./registry.ts";
import { PRODUCERS } from "./producers/index.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import type {
    GateBoundary,
    GateContext,
    GateDefinition,
    GateResult,
    Producer,
} from "./types.ts";

export interface FiredGate {
    id: string;
    boundary: GateBoundary;
    result: GateResult;
}

export interface GateReport {
    fired: FiredGate[];
    /** True iff any gate returned `kind: "block"` without a bypass match. */
    blocked: boolean;
    /** IDs of gates that blocked. Empty if blocked === false. */
    blockingGates: string[];
}

export interface RunGatesOptions {
    dryRun?: boolean;
    strictImports?: boolean;
    /** Optional override — lets tests inject a scoped registry. Defaults to
     *  the module-level `GATES`. */
    registry?: ReadonlyArray<GateDefinition>;
    /** Optional override for producer map — same reason. */
    producers?: Readonly<Record<string, Producer<unknown>>>;
}

function shouldFire(
    gate: GateDefinition,
    boundary: GateBoundary,
    dryRun: boolean,
    strictImports: boolean,
): boolean {
    if (!gate.appliesAt.includes(boundary)) return false;
    switch (gate.firesIn) {
        case "always":
            return true;
        case "non-dry-run":
            return !dryRun;
        case "strict-imports-only":
            return strictImports;
    }
}

/** Turn `block` into `bypass` when any of the gate's bypassFlags appears
 *  truthy in ctx.opts. Convention: a flag named `--foo-bar` is surfaced
 *  on opts as `fooBar: true` after CLI parsing. We check both
 *  camelCase and the raw flag form for robustness. */
function applyBypass(
    gate: GateDefinition,
    result: GateResult,
    ctx: GateContext,
): GateResult {
    if (result.kind !== "block") return result;
    for (const flag of gate.bypassFlags) {
        if (isFlagActive(flag, ctx)) return { kind: "bypass", byFlag: flag };
    }
    return result;
}

function isFlagActive(flag: string, ctx: GateContext): boolean {
    // Strip leading -- and camel-case: --accept-sensitive → acceptSensitive
    const normalized = flag.replace(/^--/, "").split("-")
        .map((seg, i) => i === 0 ? seg : seg[0].toUpperCase() + seg.slice(1))
        .join("");
    if (ctx.opts[normalized]) return true;
    // Fallback: exact raw flag as key (some callers may pass this way).
    if (ctx.opts[flag]) return true;
    return false;
}

/**
 * Materialize every producer required by any gate that will fire in this
 * run. One call per producer; results land in ctx.producers by name. A
 * required producer missing from the map is a registry misconfiguration
 * — throw so the bug surfaces immediately.
 */
function materializeProducers(
    gates: ReadonlyArray<GateDefinition>,
    producers: Readonly<Record<string, Producer<unknown>>>,
    ctx: GateContext,
): void {
    const needed = new Set<string>();
    for (const g of gates) for (const r of g.requires) needed.add(r);
    for (const name of needed) {
        const prod = producers[name];
        if (!prod) {
            throw new Error(
                `gates orchestrator: gate requires unknown producer "${name}". ` +
                "Producer must be registered in src/gates/producers/index.ts.",
            );
        }
        ctx.producers[name] = prod(ctx);
    }
}

/**
 * Run every registered gate whose (appliesAt × firesIn) matches this
 * invocation, and return a GateReport.
 *
 * Order: gates fire in registry declaration order. Order matters only
 * for which block-message gets surfaced first by the CLI layer; a
 * report with multiple blocks is still fully populated (caller can
 * choose how to render them).
 */
export function runGates(
    boundary: GateBoundary,
    ctx: GateContext,
    opts: RunGatesOptions = {},
): GateReport {
    const dryRun = opts.dryRun ?? false;
    const strictImports = opts.strictImports ?? false;
    const registry = opts.registry ?? GATES;
    const producers = opts.producers ?? PRODUCERS;

    // Propagate run flags into ctx so gates can read them uniformly.
    ctx.dryRun = dryRun;
    ctx.strictImports = strictImports;
    ctx.boundary = boundary;

    const firing = registry.filter((g) =>
        shouldFire(g, boundary, dryRun, strictImports),
    );

    materializeProducers(firing, producers, ctx);

    const fired: FiredGate[] = [];
    const blockingGates: string[] = [];

    for (const gate of firing) {
        const raw = gate.check(ctx);
        const resolved = applyBypass(gate, raw, ctx);
        fired.push({ id: gate.id, boundary, result: resolved });
        if (resolved.kind === "block") blockingGates.push(gate.id);
    }

    return {
        fired,
        blocked: blockingGates.length > 0,
        blockingGates,
    };
}

/**
 * Run a single phase: build a context from the provided inputs, run the
 * given registry subset, and throw if anything blocks. One-liner for
 * each phase-gate-run in a multi-phase consumer (e.g. lib/importSetup.ts).
 *
 * Consolidates the "build ctx → run gates → throw if blocked" boilerplate
 * into one helper so each phase is declarative.
 */
export function runPhase(input: {
    boundary: GateBoundary;
    registry: ReadonlyArray<GateDefinition>;
    opts: Record<string, unknown>;
    dryRun: boolean;
    strictImports: boolean;
}): GateReport {
    // Defer the import of buildBaseContext to avoid a circular import
    // (context.ts imports types.ts only; orchestrator.ts imports context
    // here via require-style dynamic import) — but we actually just
    // construct the shape inline since it's trivial.
    const ctx: GateContext = {
        boundary: input.boundary,
        dryRun: input.dryRun,
        strictImports: input.strictImports,
        opts: input.opts,
        producers: {},
    };
    const report = runGates(input.boundary, ctx, {
        dryRun: input.dryRun,
        strictImports: input.strictImports,
        registry: input.registry,
    });
    if (report.blocked) throwFirstBlocking(report, input.registry);
    return report;
}

/**
 * Translate a blocking GateReport into a thrown KindlyError — the
 * user-facing failure mode the pre-refactor inline gates produced.
 *
 * Uses the first blocking gate's message (dynamic) plus the gate
 * definition's static remediation. Tests with injected registries pass
 * their registry via the second arg.
 *
 * Only call this when `report.blocked === true`. Never returns.
 */
export function throwFirstBlocking(
    report: GateReport,
    registry: ReadonlyArray<GateDefinition> = GATES,
): never {
    const first = report.fired.find((f) => f.result.kind === "block");
    if (!first || first.result.kind !== "block") {
        throw new Error(
            "throwFirstBlocking called with non-blocking report — " +
            "caller should check report.blocked first",
        );
    }
    const gate = registry.find((g) => g.id === first.id);
    if (!gate) {
        throw new Error(
            `throwFirstBlocking: gate "${first.id}" is in the report but ` +
            "not in the supplied registry",
        );
    }
    throw new KindlyError(
        ErrorCodes[gate.errorCode],
        first.result.message,
        gate.remediation ?? [],
    );
}
