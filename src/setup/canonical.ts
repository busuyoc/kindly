// Canonical YAML + content hashing for Setup manifests.
//
// Two manifests with identical data but different input key order must
// produce identical bytes — that's what makes content-hashing usable as
// identity. We enforce this by sorting keys recursively before dumping.
//
// The hash is sha256(canonical_utf8_bytes). Because embedded file hashes
// live INSIDE the manifest (see schema.ts EmbeddedFileSchema), the archive
// format that carries fat Setups (tar.gz) does not influence identity.
// Setup identity is a property of the manifest alone.
//
// Library-stability risk: if a future `yaml` release changes its plain-string
// quoting heuristic, canonical output would shift and existing hashes would
// no longer round-trip. Mitigations:
//   1. The snapshot test in tests/setup/canonical.test.ts asserts exact
//      output bytes for a known fixture — any library drift breaks CI.
//   2. Callers verify an on-disk manifest by hashing its bytes directly, not
//      by re-canonicalizing — so existing shared Setups stay valid even if
//      we later change how we emit.

import { stringify as yamlStringify } from "yaml";
import { createHash } from "node:crypto";
import type { SetupManifest } from "./schema.ts";

// Deep-sort object keys; primitives pass through. Most arrays preserve
// order — but arrays whose elements are objects with a `path` string
// field (the EmbeddedFile shape — plugins.files, patches) are sorted by
// path code-units. S905 / Angle C: without this, embedded-file arrays
// inherit `walkCollect`'s order, which in turn depends on readdir()'s
// platform-specific ordering and (pre-S901) locale. Sorting these
// arrays here makes canonical output a pure function of logical content.
function sortRecursive(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
        const mapped = v.map(sortRecursive);
        if (isEmbeddedFileArray(mapped)) {
            return [...mapped].sort((a, b) => {
                const ap = (a as { path: string }).path;
                const bp = (b as { path: string }).path;
                return ap < bp ? -1 : ap > bp ? 1 : 0;
            });
        }
        return mapped;
    }
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue; // strip undefined — optional absent fields
        sorted[k] = sortRecursive(val);
    }
    return sorted;
}

function isEmbeddedFileArray(arr: unknown[]): boolean {
    if (arr.length === 0) return false;
    for (const el of arr) {
        if (el === null || typeof el !== "object" || Array.isArray(el)) return false;
        const path = (el as Record<string, unknown>).path;
        if (typeof path !== "string") return false;
    }
    return true;
}

// Canonical YAML form: lexicographically sorted keys at every depth,
// 2-space indent, no line wrapping, trailing newline, block style.
// Two SetupManifests deep-equal to each other produce identical strings.
export function canonicalizeManifest(m: SetupManifest): string {
    const sorted = sortRecursive(m);
    const out = yamlStringify(sorted, {
        indent: 2,
        lineWidth: 0,         // disable wrapping — stable line boundaries
        minContentWidth: 0,   // no wrap-adjustment heuristic
        // sortMapEntries is redundant (we pre-sorted) but belt-and-braces.
        sortMapEntries: true,
    });
    return out.endsWith("\n") ? out : out + "\n";
}

// sha256 over canonical bytes. Returns "sha256:<64 lowercase hex>".
// The "sha256:" prefix is the same shape EmbeddedFileSchema uses, so
// manifest hashes and file hashes are visually distinguishable only by
// where they appear (not by format).
export function manifestHash(m: SetupManifest): string {
    const bytes = Buffer.from(canonicalizeManifest(m), "utf8");
    const h = createHash("sha256").update(bytes).digest("hex");
    return `sha256:${h}`;
}

// Hash of raw bytes (for verifying an on-disk manifest file without
// re-canonicalizing — the bytes-on-disk ARE the identity).
export function hashBytes(bytes: Uint8Array | string): string {
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    const h = createHash("sha256").update(buf).digest("hex");
    return `sha256:${h}`;
}

// Short identifier for display (e.g. in `kindly setup list` output).
// First 12 hex chars = 48 bits of entropy — more than enough for one
// user's local setup library, not meant as a globally-unique ID.
export function shortId(hashOrManifest: string | SetupManifest): string {
    const full = typeof hashOrManifest === "string"
        ? hashOrManifest
        : manifestHash(hashOrManifest);
    const hex = full.startsWith("sha256:") ? full.slice(7) : full;
    return hex.slice(0, 12);
}
