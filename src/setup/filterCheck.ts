// Q2 Option B filter-invariance check for fat .kset manifests.
//
// The signing contract: a publisher signs a `.kset` only if its bytes
// are already invariant under kindly's filter; the verifier re-runs the
// same check and rejects anything that fails. That way a compromised
// publisher pipeline can't silently produce signed-but-malformed bytes,
// because the verifier doesn't trust the publisher's filter — it runs
// its own.
//
// What "filter-invariant" means in v0.12 (filter_version "v0.12.0"):
//
//   1. Every string in the manifest is in Unicode NFC form.
//   2. No string in the manifest contains a forbidden control byte
//      (0x00-0x08, 0x0B-0x0C, 0x0D, 0x0E-0x1F, 0x7F). LF (0x0A) and TAB
//      (0x09) are allowed; bare CR is not.
//
// These rules are deliberately minimal — they're the structural ones
// that follow directly from §2 Layer 3 (canonical-stability) and the
// Batch O renderer-injection findings. Adding rules in v0.13 bumps
// filter_version, which the W39 verifier checks before accepting any
// signature.
//
// Out of scope here on purpose:
//   - SECRET-key denylist on manifest.settings: lean .ksets pass
//     settings through; tightening that needs a curation policy
//     decision, not a filter rule.
//   - File-content classification: file bytes are content-hashed
//     separately by canonical.ts; their classification (Lua scanner,
//     plugin catalog) belongs to C5/C6 not the filter.

import type { SetupManifest } from "./schema.ts";

export type FilterViolation = {
    /** Dotted path to the offending node — `meta.name`,
     *  `plugins.files[2].path`, etc. */
    path: string;
    kind: "non-nfc" | "control-byte";
    /** Hex codepoints of the offending bytes (control-byte only). */
    bytes?: string[];
};

export class FilterInvariantError extends Error {
    constructor(public readonly violations: FilterViolation[]) {
        super(formatViolations(violations));
        this.name = "FilterInvariantError";
    }
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

function walk(value: unknown, path: string, out: FilterViolation[]): void {
    if (typeof value === "string") {
        if (value.normalize("NFC") !== value) {
            out.push({ path, kind: "non-nfc" });
        }
        const bytes = findForbiddenBytes(value);
        if (bytes.length > 0) out.push({ path, kind: "control-byte", bytes });
        return;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            walk(value[i], `${path}[${i}]`, out);
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            // Map keys are strings — they're part of the manifest content
            // and just as exposed to NFC drift / injection as values.
            if (k.normalize("NFC") !== k) {
                out.push({ path: path ? `${path}.${k}` : k, kind: "non-nfc" });
            }
            const keyBytes = findForbiddenBytes(k);
            if (keyBytes.length > 0) {
                out.push({
                    path: path ? `${path}.${k}` : k,
                    kind: "control-byte",
                    bytes: keyBytes,
                });
            }
            walk(v, path ? `${path}.${k}` : k, out);
        }
    }
    // numbers / booleans / null — nothing to check.
}

function formatViolations(vs: FilterViolation[]): string {
    if (vs.length === 0) return "no violations";
    const head = vs.slice(0, 3).map((v) => {
        if (v.kind === "non-nfc") return `  ${v.path}: non-NFC string`;
        return `  ${v.path}: control byte(s) ${v.bytes!.join(",")}`;
    });
    const more = vs.length > 3 ? `\n  ...and ${vs.length - 3} more` : "";
    return `manifest is not filter-invariant under v0.12.0 (${vs.length} violation${vs.length === 1 ? "" : "s"}):\n${head.join("\n")}${more}`;
}

/** Run the v0.12.0 filter check across every string in the manifest.
 *  Throws FilterInvariantError on any violation; returns silently
 *  otherwise. Pure function — no I/O, no host state. */
export function assertManifestFilterInvariant(m: SetupManifest): void {
    const violations: FilterViolation[] = [];
    walk(m, "", violations);
    if (violations.length > 0) throw new FilterInvariantError(violations);
}
