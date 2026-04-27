// R7 (review hardening): per-boundary required-fields contract.
//
// Background: gates and producers read fields off `ctx.opts` via patterns
// like `(ctx.opts.changes as Change[] | undefined) ?? []`. If a boundary
// (apply, import, restore, rollback) forgets to populate a required
// field, the gate silently treats the field as empty/zero and passes
// when it should have blocked. The pre-fix `as` casts hide the failure.
//
// This module declares per-boundary required fields. `runPhase` calls
// `validateContextOpts(boundary, opts)` before producers materialize and
// before gates fire — a missing field surfaces as
// `KindlyError(GATE_CONTEXT_INVALID)` with the specific field name, not
// a downstream NPE or silent pass.
//
// Optional fields are NOT enforced here — gates retain their existing
// `?? default` patterns for those, since "missing means no constraint"
// is intentional in many cases (e.g. acceptKey defaults to empty Set).
//
// Future extension (R7 follow-up, not in this pass): replace the `as`
// casts with typed accessors backed by per-boundary Zod schemas. That
// gives type-narrowing in addition to runtime validation. The current
// implementation focuses on the runtime guarantee.

import type { GateBoundary } from "./types.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

/**
 * Fields each boundary MUST populate before runGates is invoked. A
 * missing field at that boundary indicates a caller bug — the boundary
 * dispatcher (lib/apply.ts, lib/importSetup.ts, etc.) forgot to wire
 * the field through. Surfacing it as `GATE_CONTEXT_INVALID` makes the
 * bug fail fast instead of producing a misleading "no changes" pass.
 *
 * Fields not listed here are optional — gates use `?? default` when
 * they read them, and "missing" carries semantic meaning of its own.
 */
const REQUIRED_FIELDS: Record<GateBoundary, ReadonlyArray<string>> = {
    apply: ["changes"],
    import: [],
    restore: ["changes"],
    rollback: ["changes"],
};

/** True if the boundary requires the field. Exposed for tests. */
export function isFieldRequired(boundary: GateBoundary, field: string): boolean {
    if (!(boundary in REQUIRED_FIELDS)) return false;
    return REQUIRED_FIELDS[boundary].includes(field);
}

/**
 * Throws `KindlyError(GATE_CONTEXT_INVALID)` if any required field for
 * `boundary` is missing OR explicitly null on `opts`. Called by `runPhase`
 * before producers materialize.
 *
 * R11 (red-team round-7 review followup): two blind spots closed.
 *   1. Pre-fix `opts[f] === undefined` accepted `null`. Gates downstream
 *      do `(ctx.opts.changes as Change[] | undefined) ?? []` and
 *      `null ?? []` → `[]`, so a malicious `{changes: null}` opts
 *      would silently make gates see no changes and pass. Now both
 *      undefined and null fail the contract.
 *   2. `REQUIRED_FIELDS[boundary] ?? []` accepted typo'd boundaries —
 *      a caller passing `boundary: "appli"` got an empty required list
 *      and skipped all gate validation. Now an unknown boundary throws
 *      GATE_CONTEXT_INVALID with the valid set.
 *
 * Note: per-field type validation is still NOT done here. Wrong-typed
 * values (`changes: 42`) surface downstream as TypeError → wrapped
 * GATE_PRODUCER_FAILED via R6's catch. Adding a typed shape registry
 * is the R11 follow-up; this commit closes the silent-pass cases.
 */
export function validateContextOpts(
    boundary: GateBoundary,
    opts: Record<string, unknown>,
): void {
    if (!(boundary in REQUIRED_FIELDS)) {
        const valid = Object.keys(REQUIRED_FIELDS).join(", ");
        throw new KindlyError(
            ErrorCodes.GATE_CONTEXT_INVALID,
            `unknown gate boundary "${boundary}" — must be one of: ${valid}`,
            [{
                text: "this is a kindly bug — caller code passed an unrecognized " +
                      "boundary string. gate validation would have been skipped silently.",
            }],
        );
    }
    const required = REQUIRED_FIELDS[boundary];
    const missing: string[] = [];
    for (const f of required) {
        const v = opts[f];
        if (v === undefined || v === null) missing.push(f);
    }
    if (missing.length > 0) {
        throw new KindlyError(
            ErrorCodes.GATE_CONTEXT_INVALID,
            `gate context for boundary "${boundary}" missing required field(s): ${missing.join(", ")}`,
            [{
                text: "this is a kindly bug — please file an issue with --json output. " +
                      "the boundary dispatcher forgot to populate ctx.opts; gate decisions " +
                      "would have been silently incorrect.",
            }],
        );
    }
}
