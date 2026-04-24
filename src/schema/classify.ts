// Key classifier for settings.reader.lua. Three-axis model since W33+
// (gates-refactor). Source of truth: data/classify/settings.v1.json —
// sibling asset to data/schemas/ and data/taxonomy/.
//
// Three orthogonal axes per key (or dotted nested path):
//   exfil   — "secret" | "normal".  Never emit secret values.
//   change  — "none" | "sensitive-*" | "destructive".  Gate changes at
//             trust boundaries (import, apply).
//   hygiene — "persistent" | "ephemeral".  Drop flappy state in minimal
//             pull mode.
//
// Missing axes default to the safe-for-USER cell: exfil=normal,
// change=none, hygiene=persistent. Adding a new key is one JSON row.
//
// The previous four-class enum (SECRET | SENSITIVE | EPHEMERAL | USER)
// is preserved as a compat projection via classifyKey(). See docs/infra/
// 99-gates-refactor-plan.md §Step 3 for the migration rationale.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Change } from "./diff.ts";
import type { LuaValue } from "../lua/writer.ts";

// ---- axis types ---------------------------------------------------------

export type ExfilClass = "secret" | "normal";

export type ChangeClass =
    | "none"
    | "sensitive-network"
    | "sensitive-ssh"
    | "sensitive-code-exec"
    | "sensitive-fs"
    | "sensitive-debug"
    | "sensitive-service"
    | "destructive";

export type HygieneClass = "persistent" | "ephemeral";

/** Legacy four-class enum. Derived from the three axes via classifyKey().
 *  Kept exported for downstream consumers during the Step 3→10 transition. */
export type Classification = "SECRET" | "SENSITIVE" | "EPHEMERAL" | "USER";

// ---- data load ----------------------------------------------------------

interface KeyEntry {
    exfil?: ExfilClass;
    change?: ChangeClass;
    hygiene?: HygieneClass;
}

interface Rule {
    suffix?: string;
    regex?: string;
    set: Partial<KeyEntry>;
}

interface ClassifyData {
    $schema_version: 1;
    curated_at: string;
    keys: Record<string, KeyEntry>;
    rules: Rule[];
    code_exec_adjacent?: string[];
}

const DATA_PATH = resolve(import.meta.dir, "../../data/classify/settings.v1.json");

const VALID_EXFIL: ReadonlySet<string> = new Set(["secret", "normal"]);
const VALID_CHANGE: ReadonlySet<string> = new Set([
    "none", "sensitive-network", "sensitive-ssh",
    "sensitive-code-exec", "sensitive-fs", "sensitive-debug",
    "sensitive-service", "destructive",
]);
const VALID_HYGIENE: ReadonlySet<string> = new Set(["persistent", "ephemeral"]);

function validateEntry(label: string, e: Partial<KeyEntry>): void {
    if (e.exfil !== undefined && !VALID_EXFIL.has(e.exfil)) {
        throw new Error(`classify data: invalid exfil class for ${label}: ${e.exfil}`);
    }
    if (e.change !== undefined && !VALID_CHANGE.has(e.change)) {
        throw new Error(`classify data: invalid change class for ${label}: ${e.change}`);
    }
    if (e.hygiene !== undefined && !VALID_HYGIENE.has(e.hygiene)) {
        throw new Error(`classify data: invalid hygiene class for ${label}: ${e.hygiene}`);
    }
}

const DATA: ClassifyData = (() => {
    const raw = JSON.parse(readFileSync(DATA_PATH, "utf8")) as ClassifyData;
    if (raw.$schema_version !== 1) {
        throw new Error(`classify data: unsupported $schema_version=${raw.$schema_version}`);
    }
    for (const [k, e] of Object.entries(raw.keys)) validateEntry(k, e);
    for (const rule of raw.rules ?? []) {
        if (rule.suffix === undefined && rule.regex === undefined) {
            throw new Error("classify data: rule must have either suffix or regex");
        }
        validateEntry(rule.suffix ?? rule.regex ?? "?", rule.set);
    }
    return raw;
})();

const REGEX_RULES: ReadonlyArray<{ re: RegExp; set: Partial<KeyEntry> }> =
    (DATA.rules ?? [])
        .filter((r) => r.regex !== undefined)
        .map((r) => ({ re: new RegExp(r.regex!), set: r.set }));

const SUFFIX_RULES: ReadonlyArray<{ suffix: string; set: Partial<KeyEntry> }> =
    (DATA.rules ?? [])
        .filter((r) => r.suffix !== undefined)
        .map((r) => ({ suffix: r.suffix!, set: r.set }));

/** Look up an entry for a top-level key OR a dotted nested path
 *  (e.g. "kosync.userkey"). Exact match wins; rules (suffix then regex)
 *  fall through. Missing entries return an empty object — callers project
 *  through the *Class functions, which default to the safe cell. */
function lookup(keyOrPath: string): Partial<KeyEntry> {
    const exact = DATA.keys[keyOrPath];
    if (exact) return exact;
    for (const r of SUFFIX_RULES) {
        if (keyOrPath.endsWith(r.suffix)) return r.set;
    }
    for (const r of REGEX_RULES) {
        if (r.re.test(keyOrPath)) return r.set;
    }
    return {};
}

// ---- axis projections ---------------------------------------------------

/** Is the value at this key/path sensitive-to-exfiltrate? Default: normal. */
export function exfilClass(keyOrPath: string): ExfilClass {
    return lookup(keyOrPath).exfil ?? "normal";
}

/** Does changing this key cross a trust boundary? Default: none. */
export function changeClass(keyOrPath: string): ChangeClass {
    return lookup(keyOrPath).change ?? "none";
}

/** Is this key flappy state we should drop in minimal mode? Default: persistent. */
export function hygieneClass(keyOrPath: string): HygieneClass {
    return lookup(keyOrPath).hygiene ?? "persistent";
}

// ---- legacy enum (compat wrapper) ---------------------------------------

/** Legacy four-class projection. Priority: SECRET > SENSITIVE > EPHEMERAL > USER.
 *  Kept for compat; new callers should use the per-axis functions directly.
 *  Matches the pre-refactor semantics exactly — existing tests pass. */
export function classifyKey(key: string): Classification {
    if (exfilClass(key) === "secret") return "SECRET";
    if (changeClass(key) !== "none") return "SENSITIVE";
    if (hygieneClass(key) === "ephemeral") return "EPHEMERAL";
    return "USER";
}

// ---- derived Sets (internal + back-compat for closely-coupled helpers) ---

/** Top-level keys classified as sensitive-in-change. */
const SENSITIVE_TOPLEVEL: ReadonlySet<string> = new Set(
    Object.entries(DATA.keys)
        .filter(([k, e]) => e.change !== undefined && e.change !== "none" && !k.includes("."))
        .map(([k]) => k),
);

/** Dotted nested paths classified as sensitive-in-change. */
const SENSITIVE_NESTED: ReadonlySet<string> = new Set(
    Object.entries(DATA.keys)
        .filter(([k, e]) => e.change !== undefined && e.change !== "none" && k.includes("."))
        .map(([k]) => k),
);

// ---- public helpers (preserved API surface) ------------------------------

/** Is this parent.child a known nested secret path? */
export function isSecretPath(parent: string, child: string): boolean {
    return exfilClass(`${parent}.${child}`) === "secret";
}

/** Is this parent.child a known nested SENSITIVE path? */
export function isSensitivePath(parent: string, child: string): boolean {
    return changeClass(`${parent}.${child}`) !== "none";
}

/** Is this dotted string a known SENSITIVE top-level key or nested path?
 *  Used by the CLI layer to validate --accept-key= entries. */
export function isSensitiveKeyName(name: string): boolean {
    return SENSITIVE_TOPLEVEL.has(name) || SENSITIVE_NESTED.has(name);
}

/** Keys whose values KOReader interpolates into os.execute / os.remove /
 *  shell calls. Orthogonal to the `change` axis — a key can be both
 *  sensitive-ssh (SSH_port) or sensitive-service (httpinspector_port) AND
 *  code-exec-adjacent. Triggers the CODE_EXEC_ADJACENT_REQUIRES_ACK gate
 *  (bypass: --accept-code-exec), which fires independently of the
 *  SENSITIVE_REQUIRES_ACK gate because the mental model is different
 *  (code-exec consent vs data-flow consent). */
const CODE_EXEC_ADJACENT: ReadonlySet<string> = new Set(
    DATA.code_exec_adjacent ?? [],
);

/** Is the value at this key interpolated into a KOReader shell / os.remove /
 *  os.execute call? */
export function isCodeExecAdjacent(keyOrPath: string): boolean {
    return CODE_EXEC_ADJACENT.has(keyOrPath);
}

/** Return the direct nested children of `parent` that carry exfil=secret.
 *  Used by YAML_SHAPE_NORMAL (Step 11) to detect when a non-object value
 *  at a parent-of-secret path would wipe nested secrets on shallow-merge
 *  (the S89 structural bug). Example: for parent="kosync", returns
 *  ["userkey", "username"]. */
export function secretNestedChildrenOf(parent: string): string[] {
    const prefix = parent + ".";
    const out: string[] = [];
    for (const [k, e] of Object.entries(DATA.keys)) {
        if (e.exfil === "secret" && k.startsWith(prefix) && !k.slice(prefix.length).includes(".")) {
            out.push(k.slice(prefix.length));
        }
    }
    return out.sort();
}

// ---- domain label (UI) ---------------------------------------------------

const DOMAIN_LABEL: Record<ChangeClass, string> = {
    "none": "other",
    "sensitive-network": "network",
    "sensitive-ssh": "ssh",
    "sensitive-code-exec": "code-exec",
    "sensitive-fs": "directory",
    "sensitive-debug": "debug",
    "sensitive-service": "service",
    "destructive": "destructive",
};

/** Threat-domain short label for a SENSITIVE key or nested path. Used for
 *  prefixing keys in the SENSITIVE warning list (88 §7). Unknown keys
 *  (changeClass===none) return "other". */
export function sensitiveDomain(dottedPath: string): string {
    return DOMAIN_LABEL[changeClass(dottedPath)] ?? "other";
}

// ---- sensitivity traversal (Change → affected SENSITIVE paths) ----------

/** Returns dotted paths of SENSITIVE keys reachable inside `value`, rooted
 *  at `pathPrefix`. Used by `changeHitsSensitive` to find embedded
 *  SENSITIVE paths when the diff engine short-circuits a subtree. See
 *  docs/88 §4.7 (LOAD-BEARING — A2 mitigation). */
function findSensitiveInValue(
    pathPrefix: readonly string[],
    value: LuaValue,
): string[] {
    const hits: string[] = [];
    if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
        return hits;
    }
    for (const [k, v] of Object.entries(value as Record<string, LuaValue>)) {
        const full = [...pathPrefix, k];
        const dotted = full.join(".");
        if (full.length === 1 && SENSITIVE_TOPLEVEL.has(dotted)) hits.push(dotted);
        else if (SENSITIVE_NESTED.has(dotted)) hits.push(dotted);
        hits.push(...findSensitiveInValue(full, v));
    }
    return hits;
}

/** Returns dotted paths of SENSITIVE keys touched by a single change entry.
 *  Handles both direct matches and subtree-carrier cases (88 §4.7). */
export function changeHitsSensitive(c: Change): string[] {
    const direct = c.path.join(".");
    const hits: string[] = [];
    if (c.path.length === 1 && SENSITIVE_TOPLEVEL.has(direct)) hits.push(direct);
    if (c.path.length >= 2 && SENSITIVE_NESTED.has(direct)) hits.push(direct);
    if (c.kind === "added" || c.kind === "changed") {
        hits.push(...findSensitiveInValue(c.path, c.next));
    }
    if (c.kind === "removed" || c.kind === "changed") {
        const prev = c.kind === "removed" ? c.prev : c.prev;
        hits.push(...findSensitiveInValue(c.path, prev));
    }
    return [...new Set(hits)];
}

/** Collect SENSITIVE paths reachable inside a manifest's settings block.
 *  Unlike changeHitsSensitive (diff-based), this surfaces every SENSITIVE
 *  key the Setup *declares*, regardless of on-device baseline. */
export function collectSensitiveFromSettings(
    settings: Record<string, unknown>,
): string[] {
    const hits: string[] = [];
    for (const [k, v] of Object.entries(settings)) {
        if (SENSITIVE_TOPLEVEL.has(k)) hits.push(k);
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            for (const child of Object.keys(v as Record<string, unknown>)) {
                const dotted = `${k}.${child}`;
                if (SENSITIVE_NESTED.has(dotted)) hits.push(dotted);
            }
        }
    }
    return [...new Set(hits)].sort();
}

// ---- YAML filter --------------------------------------------------------

export type FilterMode = "minimal" | "full";

export type FilterResult = {
    kept: Record<string, unknown>;
    droppedSecrets: string[];     // keys (or dotted paths) dropped as secrets
    droppedEphemerals: string[];  // keys dropped as ephemeral (only in minimal)
};

/** Produce a copy of `data` with secrets/ephemerals removed per `mode`.
 *  Secrets are ALWAYS removed; ephemerals only in `minimal`. */
export function filterForYaml(
    data: Record<string, unknown>,
    mode: FilterMode,
): FilterResult {
    const kept: Record<string, unknown> = {};
    const droppedSecrets: string[] = [];
    const droppedEphemerals: string[] = [];

    for (const [k, v] of Object.entries(data)) {
        if (exfilClass(k) === "secret") {
            droppedSecrets.push(k);
            continue;
        }
        if (hygieneClass(k) === "ephemeral" && mode === "minimal") {
            droppedEphemerals.push(k);
            continue;
        }

        // Nested secret scrubbing: kosync.userkey etc.
        if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) {
            const scrubbed: Record<string, unknown> = {};
            for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
                if (isSecretPath(k, ck)) {
                    droppedSecrets.push(`${k}.${ck}`);
                    continue;
                }
                scrubbed[ck] = cv;
            }
            kept[k] = scrubbed;
        } else {
            kept[k] = v;
        }
    }

    return { kept, droppedSecrets, droppedEphemerals };
}
