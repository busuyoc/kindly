// Producer: pathContentHits.
//
// S602 — classify-aware path-content heuristic. Walks the YAML-parsed
// settings dict and reports string values at sensitive-fs / sensitive-
// code-exec paths whose CONTENT looks suspicious:
//
//   - traversal:    value contains a `..` path segment (split by `/`).
//                   Path traversal in a config has no legitimate use case;
//                   warn so the user can audit.
//   - out-of-tree:  value is an absolute path NOT under `/mnt/us/`. On
//                   Kindle this is the user-data root; absolute paths
//                   elsewhere typically mean either a non-Kindle
//                   environment (legitimate) or a hostile YAML pointing
//                   at /etc, /proc, etc. (false-positive-prone, hence
//                   warn-tier per S605).
//
// Sister to controlByteHits but catches printable-ASCII patterns the byte
// gate doesn't see (`..`, `/etc/passwd`, etc.). Kept separate because the
// outcomes differ — control bytes BLOCK (no legitimate use), path content
// WARNS (false-positive prone).
//
// Scope: change=sensitive-fs (15 path-typed keys) plus change=sensitive-
// code-exec (extra_plugin_paths). sensitive-network values are URLs — a
// different shape, gated elsewhere.

import { changeClass } from "../../schema/classify.ts";
import type { GateContext, Producer } from "../types.ts";

export type PathContentHitKind = "traversal" | "out-of-tree";

export interface PathContentHit {
    /** Dotted path to the offending value (or `key[i]` for array elements). */
    path: string;
    kind: PathContentHitKind;
    /** The suspicious string itself. Safe to echo: classify already
     *  guarantees the path is at a sensitive-fs/code-exec key, and the
     *  CONTROL_BYTES_IN_VALUE gate has already rejected control bytes by
     *  the time this producer's output is rendered (gates fire in
     *  registry order; control-bytes precedes path-content). */
    value: string;
}

export interface PathContentReport {
    hits: PathContentHit[];
}

const KINDLE_ROOT_PREFIX = "/mnt/us/";

/** Returns the hit kind, or null if the value looks benign. Public for
 *  test visibility — hits are derived from the same predicate. */
export function classifyPathContent(value: string): PathContentHitKind | null {
    if (value === "") return null;
    if (value.split("/").includes("..")) return "traversal";
    if (value.startsWith("/") && value !== "/mnt/us"
        && !value.startsWith(KINDLE_ROOT_PREFIX)) {
        return "out-of-tree";
    }
    return null;
}

function isPathClass(classifyPath: string): boolean {
    const c = changeClass(classifyPath);
    return c === "sensitive-fs" || c === "sensitive-code-exec";
}

function walk(
    value: unknown,
    path: string,
    classifyPath: string,
    hits: PathContentHit[],
): void {
    if (typeof value === "string") {
        if (!isPathClass(classifyPath)) return;
        const kind = classifyPathContent(value);
        if (kind !== null) hits.push({ path, kind, value });
        return;
    }
    if (Array.isArray(value)) {
        // Array elements inherit the parent's classification — extra_plugin_paths
        // is `[string]` and each element is a path.
        for (let i = 0; i < value.length; i++) {
            walk(value[i], `${path}[${i}]`, classifyPath, hits);
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const next = path === "" ? k : `${path}.${k}`;
            walk(v, next, next, hits);
        }
    }
    // numbers, booleans, null — not paths.
}

export const pathContentHits: Producer<PathContentReport> = (ctx: GateContext) => {
    const data =
        (ctx.opts.yamlSettings as Record<string, unknown> | undefined) ?? {};
    const hits: PathContentHit[] = [];
    walk(data, "", "", hits);
    return { hits };
};
