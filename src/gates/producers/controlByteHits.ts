// Producer: controlByteHits.
//
// C11 (Batch O closure). Walks the YAML-parsed settings dict and reports
// string values that contain raw control bytes (0x00-0x08, 0x0B-0x0C,
// 0x0E-0x1F) at keys whose classification is SECRET, code-exec-adjacent,
// or any `sensitive-*` change-class.
//
// Why structural, not consent:
//   The byte-level hazard is a renderer-injection chain (Batch O S321
//   `extra_plugin_paths` → KOReader crash.log; S324 `kosync.username` →
//   HTTP header CRLF smuggle). No consent flag should let an attacker's
//   YAML inject ESC/CR/LF into a SENSITIVE/SECRET value — there is no
//   legitimate use case. The fix sits beside YAML_SHAPE_NORMAL: another
//   structural rejection that fires on every apply, no `--untrusted-yaml`
//   gate.
//
// Allowed bytes:
//   - 0x09 TAB (legitimate in user labels)
//   - 0x0A LF (legitimate in multi-line user content)
//   - 0x0D CR (paired with LF on Windows-authored YAML; rejecting bare CR
//     would still close the CRLF-smuggle chain since LF would also be
//     present — but bare CR is itself a smuggle vector, so we DO reject
//     it. CRLF-pair handling: since both bytes are smuggle-relevant, we
//     reject any value containing 0x0D regardless of pairing.)
//
// Concretely the byte set we reject is:
//   0x00 .. 0x08  (NUL through BS)
//   0x0B          (VT)
//   0x0C          (FF)
//   0x0D          (CR — bare or CRLF, both reject)
//   0x0E .. 0x1F  (SO through US — includes 0x1B ESC)
//   0x7F          (DEL)
//
// Classification scope:
//   - exfilClass(path) === "secret"      → reject
//   - changeClass(path) startsWith "sensitive-" → reject
//   - isCodeExecAdjacent(path)           → reject (subset of sensitive but
//     surfaced separately for the message)
//
// For walk depth: settings.reader.lua is shallow (1-2 levels of nesting
// for known SECRETs / SENSITIVEs; arrays of strings for path lists like
// `extra_plugin_paths`). We walk arbitrarily deep — classify by joining
// keys with `.`, treating array indices as path leaves so per-element
// strings inherit the parent's classification.
//
// Key-byte inspection (S960): when descending INTO an object whose own
// path is classified, each entry KEY is also user-controlled data —
// `plugins_disabled.<plugin_name>` carries the plugin name in the key,
// not the value (which is just `true`). We scan keys for forbidden
// bytes against the parent's classification at descent time.

import {
    exfilClass, changeClass, isCodeExecAdjacent,
} from "../../schema/classify.ts";
import type { GateContext, Producer } from "../types.ts";

export type ControlByteHitClass = "secret" | "code-exec" | "sensitive";

export interface ControlByteHit {
    /** Dotted path to the offending value (or `key[i]` for arrays). */
    path: string;
    /** Why this path is gated. */
    class: ControlByteHitClass;
    /** Hex codepoints of every offending byte found in the value, in
     *  order. Used in the gate message — never echo the raw value, since
     *  that would re-emit the attacker's bytes through stderr. */
    bytes: string[];
}

export interface ControlByteReport {
    hits: ControlByteHit[];
}

const FORBIDDEN_BYTE = (() => {
    const set = new Set<number>();
    for (let b = 0x00; b <= 0x08; b++) set.add(b);
    set.add(0x0B);
    set.add(0x0C);
    set.add(0x0D);
    for (let b = 0x0E; b <= 0x1F; b++) set.add(b);
    set.add(0x7F);
    return set;
})();

function findForbiddenBytes(s: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
        const cp = s.charCodeAt(i);
        if (FORBIDDEN_BYTE.has(cp)) {
            out.push("0x" + cp.toString(16).toUpperCase().padStart(2, "0"));
        }
    }
    return out;
}

function classifyForBytes(path: string): ControlByteHitClass | null {
    if (exfilClass(path) === "secret") return "secret";
    if (isCodeExecAdjacent(path)) return "code-exec";
    if (changeClass(path).startsWith("sensitive-")) return "sensitive";
    return null;
}

function walk(
    value: unknown,
    path: string,
    /** Classification path used for the lookup. Diverges from `path` only
     *  when we're inside an array — classify treats `foo[0]` as unknown,
     *  so array elements inherit the parent's classify path while their
     *  display `path` keeps the `[i]` suffix for the user. */
    classifyPath: string,
    hits: ControlByteHit[],
): void {
    if (typeof value === "string") {
        const cls = classifyForBytes(classifyPath);
        if (cls === null) return;
        const bytes = findForbiddenBytes(value);
        if (bytes.length > 0) {
            hits.push({ path, class: cls, bytes });
        }
        return;
    }
    if (Array.isArray(value)) {
        // Array elements inherit the parent's classification — an array
        // of strings (e.g. extra_plugin_paths) carries one classify entry
        // for the key, not per-index. Display path keeps `[i]` for clarity.
        for (let i = 0; i < value.length; i++) {
            walk(value[i], `${path}[${i}]`, classifyPath, hits);
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        // S960: if the parent path is classified, each entry KEY is
        // user-controlled data at the parent's classification level. Scan
        // key bytes against the parent before recursing into the value.
        const parentClass = classifyForBytes(classifyPath);
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const next = path === "" ? k : `${path}.${k}`;
            if (parentClass !== null) {
                const keyBytes = findForbiddenBytes(k);
                if (keyBytes.length > 0) {
                    hits.push({ path: next, class: parentClass, bytes: keyBytes });
                }
            }
            walk(v, next, next, hits);
        }
        return;
    }
    // numbers, booleans, null — no byte hazard.
}

export const controlByteHits: Producer<ControlByteReport> = (ctx: GateContext) => {
    const data =
        (ctx.opts.yamlSettings as Record<string, unknown> | undefined) ?? {};
    const hits: ControlByteHit[] = [];
    walk(data, "", "", hits);
    return { hits };
};
