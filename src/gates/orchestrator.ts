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
import { validateContextOpts } from "./contextSchema.ts";
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
    /** S605: true iff any gate returned `kind: "warn"`. Non-blocking;
     *  consumers map this to exit code 4. */
    warned: boolean;
    /** IDs of gates that warned. Empty if warned === false. */
    warningGates: string[];
}

/** Called once per gate whose result is `bypass`, `block`, or `warn`.
 *  `pass` results do NOT trigger the logger (too noisy). The orchestrator
 *  calls this synchronously; consumers typically write to
 *  `.kindly/gate-events.jsonl` via `appendGateEvent`. */
export type GateEventLogger = (fired: FiredGate) => void;

export interface RunGatesOptions {
    dryRun?: boolean;
    strictImports?: boolean;
    /** Optional override — lets tests inject a scoped registry. Defaults to
     *  the module-level `GATES`. */
    registry?: ReadonlyArray<GateDefinition>;
    /** Optional override for producer map — same reason. */
    producers?: Readonly<Record<string, Producer<unknown>>>;
    /** Called for each bypass/block outcome. No-op by default — consumers
     *  that want observability pass a logger. */
    logger?: GateEventLogger;
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
 *
 * R6 (review hardening): each producer call is wrapped in try/catch.
 * An exception from a producer (e.g. signerTrust on a malformed sidecar,
 * or a side-effecting producer hitting an unexpected I/O failure) used
 * to propagate as a raw `Error` and crash the apply with an unstructured
 * stderr line. Now it's typed as `KindlyError(GATE_PRODUCER_FAILED, ...)`
 * carrying the producer name and original message — `kindly doctor` and
 * the --json envelope can act on it predictably. The pre-existing S2123
 * synthetic block-log logging in `runGates` remains intact for the audit
 * trail.
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
            // Registry misconfiguration is still a hard throw — it's a
            // build-time bug, not a runtime input.
            throw new Error(
                `gates orchestrator: gate requires unknown producer "${name}". ` +
                "Producer must be registered in src/gates/producers/index.ts.",
            );
        }
        try {
            ctx.producers[name] = prod(ctx);
        } catch (e) {
            // R6 (review hardening): producers that already throw
            // KindlyError carry an intentional, granular code (e.g.
            // signerTrust → SETUP_SIGNATURE_INVALID for a tampered
            // sidecar). Preserve those — wrapping them in
            // GATE_PRODUCER_FAILED would erase the policy-grade
            // signal callers branch on. Only raw `Error` / non-
            // KindlyError throws (an unhandled producer bug) get
            // wrapped, since those have no stable code to surface.
            if (e instanceof KindlyError) throw e;
            const err = e as Error;
            throw new KindlyError(
                ErrorCodes.GATE_PRODUCER_FAILED,
                `gate context unavailable: producer ${name} failed: ${err.message ?? String(e)}`,
                [{
                    text: `producer "${name}" threw an untyped error while ` +
                          `materializing gate context. This is a kindly bug — ` +
                          `please file an issue with --json output if reproducible.`,
                }],
            );
        }
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

    // Round 6 S2123: a producer that throws (e.g. signerTrust on a
    // malformed sidecar) used to propagate before any logger.call —
    // .kindly/gate-events.jsonl recorded nothing about the failure,
    // and `kindly doctor` reported zero recent bypasses for an event
    // the user just witnessed. Emit a synthetic block-log entry for
    // every gate that requires the failed producer, so the audit
    // trail captures what blocked the run, then re-throw.
    try {
        materializeProducers(firing, producers, ctx);
    } catch (e) {
        if (opts.logger) {
            for (const gate of firing) {
                if (!gate.requires.length) continue;
                opts.logger({
                    id: gate.id,
                    boundary,
                    result: {
                        kind: "block",
                        message: `producer failed: ${(e as Error).message}`,
                    },
                });
            }
        }
        throw e;
    }

    const fired: FiredGate[] = [];
    const blockingGates: string[] = [];
    const warningGates: string[] = [];

    for (const gate of firing) {
        const raw = gate.check(ctx);
        const resolved = applyBypass(gate, raw, ctx);
        const entry: FiredGate = { id: gate.id, boundary, result: resolved };
        fired.push(entry);
        if (resolved.kind === "block") blockingGates.push(gate.id);
        else if (resolved.kind === "warn") warningGates.push(gate.id);
        if (opts.logger && resolved.kind !== "pass") opts.logger(entry);
    }

    return {
        fired,
        blocked: blockingGates.length > 0,
        blockingGates,
        warned: warningGates.length > 0,
        warningGates,
    };
}

/** Extract warn-tier firings from a report into the `{id, message}` shape
 *  result types carry. Helper used by apply / restore / importSetup so
 *  the projection doesn't drift between callers. */
export function collectWarnings(
    report: GateReport,
): Array<{ id: string; message: string }> {
    const out: Array<{ id: string; message: string }> = [];
    for (const f of report.fired) {
        if (f.result.kind === "warn") {
            out.push({ id: f.id, message: f.result.message });
        }
    }
    return out;
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
    /** Step 14: observability hook. Called for bypass/block events. */
    logger?: GateEventLogger;
}): GateReport {
    // R7 (review hardening): per-boundary contract check. Catches the
    // boundary-dispatcher-forgot-a-field class of bug before producers
    // materialize and gates fire. See gates/contextSchema.ts.
    validateContextOpts(input.boundary, input.opts);
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
        logger: input.logger,
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
