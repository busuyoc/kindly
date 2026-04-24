// YAML ↔ Lua table converter.
//
// The contract: after `pull`, `kindly.yaml` holds a subset of what was in
// settings.reader.lua (minus secrets, minus ephemerals in --minimal mode).
// After `apply`, we merge that subset BACK into the live settings file —
// preserving any on-device keys we didn't touch, including the secrets
// themselves. This is the critical invariant: applying an incomplete YAML
// must not wipe the user's zlibrary password.
//
// We do not hand-roll YAML. The `yaml` package handles quoting edge cases
// (keys starting with numbers, values with colons, multiline strings).
// That's strictly a parser/emitter dependency — no schema enforcement.

import { stringify as yamlStringify } from "yaml";
import { parseYamlSafe } from "../fs/yamlSafe.ts";
import type { LuaTable, LuaValue } from "../lua/writer.ts";
import { ErrorCodes, KindlyError } from "../types/errors.ts";
import {
    classifyKey, filterForYaml, isSecretPath,
    type FilterMode, type FilterResult,
} from "./classify.ts";

// Lua tables use Maps for sparse/mixed-key cases; YAML has no equivalent, so
// we convert Maps to plain objects (numeric keys become string keys). This
// is a lossy conversion for integer-keyed sparse tables, but those don't
// appear in settings.reader.lua in practice (arrays are always dense 1..N,
// which our reader already converts to JS arrays).
function luaToPlain(v: LuaValue): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(luaToPlain);
    if (v instanceof Map) {
        const obj: Record<string, unknown> = {};
        for (const [k, val] of v.entries()) obj[String(k)] = luaToPlain(val);
        return obj;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = luaToPlain(val as LuaValue);
    return out;
}

// Inverse of luaToPlain. Plain JS values round-trip cleanly except for
// integer-keyed dicts (which we've already collapsed to arrays on read).
//
// `visited` tracks the current DFS recursion path. yaml@2 produces
// structurally-valid cyclic DOMs for inputs like `root: &a [*a]`; without
// this guard the recursion stack-overflows as RangeError (UNKNOWN-coded).
// Sibling structure-sharing (same object referenced at two non-overlapping
// paths) is preserved: we add on entry and remove on exit, so only
// self-referential cycles trip the guard.
function plainToLua(v: unknown, visited: WeakSet<object> = new WeakSet()): LuaValue {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v !== "object") {
        throw new Error(`cannot convert to Lua value: ${typeof v}`);
    }
    if (visited.has(v)) {
        throw new KindlyError(
            ErrorCodes.YAML_CYCLIC,
            "YAML document contains a cyclic anchor/alias reference",
            [{ text: "Remove the self-referential anchor or re-author the document without recursion." }],
        );
    }
    visited.add(v);
    try {
        if (Array.isArray(v)) return v.map(x => plainToLua(x, visited));
        const out: { [k: string]: LuaValue } = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = plainToLua(val, visited);
        }
        return out;
    } finally {
        visited.delete(v);
    }
}

export type ToYamlResult = {
    yaml: string;
    filter: FilterResult;
};

// Convert a parsed Lua table → filtered YAML string. The YAML is flat
// (matches Lua key names 1:1) and alphabetically ordered for stable diffs.
export function luaToYaml(data: LuaTable, mode: FilterMode): ToYamlResult {
    const plain = luaToPlain(data as LuaValue) as Record<string, unknown>;
    const filter = filterForYaml(plain, mode);

    // Sort keys alphabetically so `kindly pull` is idempotent (same file →
    // same YAML bytes, diffable across runs).
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(filter.kept).sort()) {
        sorted[k] = sortNested(filter.kept[k]);
    }

    const yaml = yamlStringify(sorted, {
        // Keep output stable & human-readable.
        lineWidth: 0,                // no line wrapping
        defaultStringType: "PLAIN",  // only quote when required
        defaultKeyType: "PLAIN",
    });
    return { yaml, filter };
}

function sortNested(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(sortNested);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = sortNested((v as Record<string, unknown>)[k]);
    }
    return sorted;
}

// Parse YAML → partial Lua table. Callers must merge this back into the
// on-device settings to avoid wiping secrets/ephemerals not present here.
export function yamlToLua(yaml: string): LuaTable {
    const parsed = parseYamlSafe(yaml);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("YAML root must be a map of settings keys");
    }
    return plainToLua(parsed) as LuaTable;
}

// Merge YAML-sourced settings INTO the on-device Lua table. YAML keys win;
// on-device keys not present in YAML are preserved untouched.
// This is what `kindly apply` uses: it's conservative (never deletes keys)
// because we can't tell whether a missing YAML key means "user wants this
// gone" or "user's YAML just doesn't track this key".
export function mergeYamlIntoLua(
    onDevice: Record<string, LuaValue>,
    fromYaml: Record<string, LuaValue>
): Record<string, LuaValue> {
    const out: Record<string, LuaValue> = { ...onDevice };
    for (const [k, v] of Object.entries(fromYaml)) {
        // For nested tables, shallow-merge so kosync.userkey (secret, not in
        // YAML) survives when we update kosync.auto_sync (in YAML).
        const existing = onDevice[k];
        if (
            v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)
            && existing !== null && typeof existing === "object"
            && !Array.isArray(existing) && !(existing instanceof Map)
        ) {
            out[k] = { ...(existing as Record<string, LuaValue>), ...(v as Record<string, LuaValue>) };
        } else {
            out[k] = v;
        }
    }
    return out;
}

// Replace-mode merge: used by `kindly setup import` when the manifest
// declares apply_mode: replace.
//
// Rules:
//   - SECRET + EPHEMERAL top-level keys on device are always preserved.
//   - USER top-level keys on device are REMOVED unless declared in manifest.
//   - Manifest-declared keys win. Nested maps are replaced wholesale,
//     EXCEPT known secret sub-paths (kosync.userkey, kosync.username) are
//     carried over from the prior on-device value. If the manifest didn't
//     declare the nested map at all, the whole on-device map is removed —
//     even a kosync.userkey goes with it, because kosync itself was a USER
//     key that the manifest didn't declare. This is consistent: secrets
//     inside a user-class parent only survive if the parent survives.
export function replaceYamlIntoLua(
    onDevice: Record<string, LuaValue>,
    fromManifest: Record<string, LuaValue>
): Record<string, LuaValue> {
    const out: Record<string, LuaValue> = {};

    // First: preserve SECRET + EPHEMERAL top-level keys unconditionally.
    for (const [k, v] of Object.entries(onDevice)) {
        const cls = classifyKey(k);
        if (cls === "SECRET" || cls === "EPHEMERAL") out[k] = v;
    }

    // Then: lay down every manifest-declared key. For nested maps, overlay
    // previously-known secret sub-paths from on-device.
    for (const [k, v] of Object.entries(fromManifest)) {
        const existing = onDevice[k];
        if (
            v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)
            && existing !== null && typeof existing === "object"
            && !Array.isArray(existing) && !(existing instanceof Map)
        ) {
            const nested: Record<string, LuaValue> = { ...(v as Record<string, LuaValue>) };
            // Re-inject nested secret paths from the pre-import value.
            for (const [ck, cv] of Object.entries(existing as Record<string, LuaValue>)) {
                if (isSecretPath(k, ck)) nested[ck] = cv;
            }
            out[k] = nested;
        } else {
            out[k] = v;
        }
    }

    return out;
}
