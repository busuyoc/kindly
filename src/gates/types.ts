// Gate registry types. Imported by registry.ts, orchestrator.ts, and
// every definitions/*.ts file. Pure type declarations — no runtime
// dependencies on the rest of gates/, so no circular-import risk.
//
// See docs/infra/99-gates-refactor-plan.md §Architecture for the
// producers-plus-gates model. Short version: a *producer* is a pure
// function over `GateContext` that materializes a shared data
// artifact (e.g. sensitiveHits, scanReport). A *gate* is a predicate
// over producer outputs; it returns pass / block / bypass.

import type { ErrorCodes } from "../types/errors.ts";

// ---- trust boundaries ---------------------------------------------------

/** Where in kindly's mutation path does this gate fire? */
export type GateBoundary = "import" | "apply";

// ---- gate taxonomy ------------------------------------------------------

/** Groups gates by their threat-model role. Drives rendering/labeling;
 *  no orchestration effect. */
export type GateCategory =
    | "IDENTITY"     // hash assertions, provenance checks
    | "CONSENT"      // FAT ack, SENSITIVE ack
    | "INTEGRITY"    // catalog hash verification, Lua scanner
    | "COMPAT"       // KOReader version + device family
    | "SHAPE"        // schema validation, YAML input normalizer
    | "DESTRUCTION"  // replace-removal cap, destructive-YAML cap
    | "DUAL";        // compound consent (W31a)

/** When in an invocation the gate's predicate should run.
 *
 *  - "always":               every invocation (including --dry-run).
 *  - "non-dry-run":          skip when opts.dryRun is true (preview safe).
 *  - "strict-imports-only":  skip unless opts.strictImports is true
 *                            (CI preflight mode).
 *
 *  This is the field that makes S340/S341 unrepresentable — the
 *  registry schema requires a concrete answer to "when does this fire?"
 *  at declaration time. No inline `!opts.dryRun` guard, no silent drift. */
export type GateFiresIn = "always" | "non-dry-run" | "strict-imports-only";

// ---- gate runtime I/O ---------------------------------------------------

/** Shared data passed into every gate's check(). Populated by the
 *  boundary-specific `buildContext()`. Producer outputs live in
 *  `producers` keyed by producer name. */
export interface GateContext {
    boundary: GateBoundary;
    dryRun: boolean;
    strictImports: boolean;
    /** Boundary-specific options (parsed CLI flags + opts object). Typed
     *  loosely here because each boundary consumes different fields;
     *  gate-side narrowing happens inside each check(). */
    opts: Record<string, unknown>;
    /** Memoized producer outputs. The orchestrator materializes each
     *  producer in `gate.requires` exactly once per run and stashes the
     *  result here. Gates read their required keys; missing keys are a
     *  registry misconfiguration (fail-fast in orchestrator). */
    producers: Record<string, unknown>;
}

/** Outcome of a single gate's check(). */
export type GateResult =
    | { kind: "pass" }
    | { kind: "block"; message: string; details?: unknown }
    | { kind: "bypass"; byFlag: string };

// ---- producer ----------------------------------------------------------

/** A producer is a pure function over ctx that returns a cacheable data
 *  artifact. Keyed by a short name in the PRODUCERS map. Orchestrator
 *  computes each required producer once per run. */
export type Producer<T = unknown> = (ctx: GateContext) => T;

// ---- gate definition ---------------------------------------------------

/** One row of the gate registry. Every field is required; the schema
 *  forces a conscious answer at declaration time. */
export interface GateDefinition {
    /** Stable short name (SCREAMING_SNAKE). Used in history.jsonl entries,
     *  architecture test whitelists, error messages. */
    id: string;

    category: GateCategory;

    /** Which trust boundaries this gate fires at. A single gate can apply
     *  to both import and apply (e.g. YAML_SHAPE_NORMAL). */
    appliesAt: GateBoundary[];

    /** Producer names the gate needs. Orchestrator errors if a required
     *  producer isn't registered in PRODUCERS. Empty if the gate reads
     *  only ctx.opts. */
    requires: string[];

    firesIn: GateFiresIn;

    /** Flags that the consumer can pass to bypass a block. Order-insensitive;
     *  any matching flag turns a `block` result into a `bypass`. Empty
     *  means the gate cannot be bypassed (e.g. --strict-imports gates). */
    bypassFlags: string[];

    /** The ErrorCodes registry key thrown when the gate blocks and no
     *  bypass flag matches. */
    errorCode: keyof typeof ErrorCodes;

    /** Static remediation hints shown when the gate blocks. Dynamic
     *  details (actual mismatch values, variable paths, etc.) belong in
     *  the block message. Empty/omitted → no remediation, which a
     *  few gates legitimately have (e.g. hash mismatch is its own
     *  remediation). */
    remediation?: Array<{ text: string; command?: string }>;

    /** Pure predicate: reads ctx, returns a GateResult. No side effects,
     *  no throws — blocking is expressed via GateResult.kind==="block". */
    check: (ctx: GateContext) => GateResult;
}
