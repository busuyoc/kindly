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
    return (REQUIRED_FIELDS[boundary] ?? []).includes(field);
}

/**
 * Throws `KindlyError(GATE_CONTEXT_INVALID)` if any required field for
 * `boundary` is absent (===undefined) on `opts`. Called by `runPhase`
 * before producers materialize.
 *
 * Note: presence is checked, not type. The `as` casts in gates already
 * narrow type, and a wrong-typed value would surface as a different
 * downstream error. The R7 invariant is "the field exists" — that's
 * what catches the boundary-dispatch bug.
 */
export function validateContextOpts(
    boundary: GateBoundary,
    opts: Record<string, unknown>,
): void {
    const required = REQUIRED_FIELDS[boundary] ?? [];
    const missing: string[] = [];
    for (const f of required) {
        if (opts[f] === undefined) missing.push(f);
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
