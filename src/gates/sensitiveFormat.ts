// Shared formatter for SENSITIVE change lines.
//
// Used by SENSITIVE_REQUIRES_ACK (consent.ts) and — during the migration
// window until Step 9 — by the inline STRICT_SENSITIVE_CHANGES check that
// still lives in lib/importSetup.ts. Moving these helpers here avoids
// duplicating the traversal logic and lets the old inline code keep
// producing identical output to the new gate.

import type { Change } from "../schema/diff.ts";
import type { LuaValue } from "../lua/writer.ts";

/** Descend into a LuaValue by a dotted-path tail. Returns undefined if
 *  any segment can't be traversed (scalar, array, Map, or missing key). */
export function descendLua(
    value: LuaValue | undefined,
    tail: readonly string[],
): LuaValue | undefined {
    let v: LuaValue | undefined = value;
    for (const k of tail) {
        if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
            return undefined;
        }
        v = (v as Record<string, LuaValue>)[k];
    }
    return v;
}

/** Render a LuaValue for the SENSITIVE warning list. Scalars go verbatim
 *  (JSON-encoded for strings); arrays/objects collapse to a shape hint
 *  per docs/88 §3.3. */
export function fmtSensitiveValue(v: LuaValue | undefined): string {
    if (v === undefined) return "(absent)";
    if (v === null) return "nil";
    if (Array.isArray(v)) return `<array of ${v.length} item(s)>`;
    if (v instanceof Map) return `<table with ${v.size} key(s)>`;
    if (typeof v === "object") {
        return `<object with ${Object.keys(v).length} key(s)>`;
    }
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

/** Locate the change that carries a SENSITIVE hit path and format the
 *  prev/next for the warning line. Returns "(added) → X", "Y → (removed)",
 *  or "Y → X" depending on the carrier change's kind. */
export function formatSensitiveChange(
    changes: readonly Change[],
    hitPath: string,
): string {
    const segments = hitPath.split(".");
    for (const c of changes) {
        if (segments.length < c.path.length) continue;
        let matches = true;
        for (let i = 0; i < c.path.length; i++) {
            if (c.path[i] !== segments[i]) { matches = false; break; }
        }
        if (!matches) continue;
        const tail = segments.slice(c.path.length);
        if (c.kind === "added") {
            const next = descendLua(c.next, tail);
            return `(added) → ${fmtSensitiveValue(next)}`;
        }
        if (c.kind === "removed") {
            const prev = descendLua(c.prev, tail);
            return `${fmtSensitiveValue(prev)} → (removed)`;
        }
        const prev = descendLua(c.prev, tail);
        const next = descendLua(c.next, tail);
        return `${fmtSensitiveValue(prev)} → ${fmtSensitiveValue(next)}`;
    }
    return "(change)";
}
