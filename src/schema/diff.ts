// Compute a structured list of changes that `apply` would make to the device.
//
// Semantics match kindly's non-destructive apply:
//   - A key in YAML but not on device → "added"
//   - A key present in both with different values → "changed"
//   - A key on device but not in YAML → NOT a change (apply preserves it)
//
// Nested tables are diffed key-by-key (shallow one level deep — KOReader
// nests at most 2-3 levels, e.g. kosync.userkey, footer.align,
// navbar_topbar_config.side.clock). Deeper nesting falls back to "replace
// whole subtree" which matches how our writer serializes and how KOReader
// reads it back.

import type { LuaValue } from "../lua/writer.ts";

export type Change =
    | { kind: "added"; path: string[]; next: LuaValue }
    | { kind: "changed"; path: string[]; prev: LuaValue; next: LuaValue };

export function computeChanges(
    onDevice: Record<string, LuaValue>,
    fromYaml: Record<string, LuaValue>
): Change[] {
    const changes: Change[] = [];
    // Iterate in sorted order so output is deterministic across runs.
    for (const k of Object.keys(fromYaml).sort()) {
        diffInto(changes, [k], onDevice[k], fromYaml[k]);
    }
    return changes;
}

function diffInto(
    out: Change[],
    path: string[],
    prev: LuaValue | undefined,
    next: LuaValue
): void {
    // New key.
    if (prev === undefined) {
        out.push({ kind: "added", path, next });
        return;
    }
    // Both scalars or arrays — compare by value.
    if (!isPlainObject(prev) || !isPlainObject(next)) {
        if (!deepEqual(prev, next)) {
            out.push({ kind: "changed", path, prev, next });
        }
        return;
    }
    // Both plain objects: recurse.
    const p = prev as Record<string, LuaValue>;
    const n = next as Record<string, LuaValue>;
    for (const k of Object.keys(n).sort()) {
        diffInto(out, [...path, k], p[k], n[k]!);
    }
}

function isPlainObject(v: unknown): boolean {
    return v !== null
        && typeof v === "object"
        && !Array.isArray(v)
        && !(v instanceof Map);
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => deepEqual(x, b[i]));
    }
    if (typeof a === "object") {
        const ao = a as Record<string, unknown>;
        const bo = b as Record<string, unknown>;
        const ak = Object.keys(ao).sort();
        const bk = Object.keys(bo).sort();
        if (ak.length !== bk.length) return false;
        for (let i = 0; i < ak.length; i++) {
            if (ak[i] !== bk[i]) return false;
            if (!deepEqual(ao[ak[i]!], bo[bk[i]!])) return false;
        }
        return true;
    }
    return false;
}
