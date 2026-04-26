// Q2 Option B filter-invariance check for fat .kset manifests.
//
// The signing contract: a publisher signs a `.kset` only if its bytes
// are already invariant under kindly's filter; the verifier re-runs the
// same check and rejects anything that fails. That way a compromised
// publisher pipeline can't silently produce signed-but-malformed bytes,
// because the verifier doesn't trust the publisher's filter — it runs
// its own.
//
// What "filter-invariant" means in v0.13 (filter_version "v0.13.0"):
//
//   1. Every string in the manifest is in Unicode NFC form.
//   2. No string in the manifest contains a forbidden codepoint:
//        - C0 controls 0x00-0x08, 0x0B-0x1F (TAB 0x09 and LF 0x0A allowed;
//          bare CR 0x0D rejected).
//        - DEL 0x7F and C1 controls 0x80-0x9F.
//        - Any Cf "format" codepoint (ZWSP U+200B, ZWNJ, ZWJ, BOM,
//          RLO/LRO, soft hyphen, etc.).
//      Together this is the union of `\p{Cc}` (minus TAB/LF) and `\p{Cf}`,
//      which exactly matches what `parseYamlSafe` rejects on the verify
//      side (src/fs/yamlSafe.ts assertNfcKeys + INVISIBLE_OR_CONTROL_RE,
//      Lead 19). Without parity, an honest publisher whose source had
//      ZWSP keys could sign under v0.12.0 (which didn't catch Cf) and
//      every verifier would fail closed at parse time — signed-but-
//      unusable bytes (round 3 filter-parity HIGH).
//
// v0.12.0 -> v0.13.0 bump: filter rule (2) tightened to include Cf and
// the C1 range. ACCEPTED_FILTER_VERSIONS in signing.ts retains v0.12.0
// for the documented one-release grace window — sigs made under v0.12
// still verify if their bytes happen to satisfy the v0.13 rules
// (most do; only ones with Cf/C1 codepoints break).
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

// Built via RegExp(string,...) so escape sequences are unambiguous on disk
// (no embedded raw control bytes). Members:
//   \x00-\x08  C0 controls minus TAB
//   \x0B-\x1F  C0 controls minus LF, plus VT/FF/CR/etc.
//   \x7F-\x9F  DEL + C1 controls
//   \p{Cf}         Unicode "format" category (ZWSP, ZWNJ, ZWJ, BOM, RLO, ...)
const FORBIDDEN_RE = new RegExp(
    "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\p{Cf}]",
    "gu",
);

function findForbiddenBytes(s: string): string[] {
    const out: string[] = [];
    FORBIDDEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FORBIDDEN_RE.exec(s)) !== null) {
        const cp = m[0].codePointAt(0)!;
        out.push("0x" + cp.toString(16).toUpperCase().padStart(2, "0"));
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
    return `manifest is not filter-invariant under v0.13.0 (${vs.length} violation${vs.length === 1 ? "" : "s"}):\n${head.join("\n")}${more}`;
}

/** Run the v0.13.0 filter check across every string in the manifest.
 *  Throws FilterInvariantError on any violation; returns silently
 *  otherwise. Pure function — no I/O, no host state. */
export function assertManifestFilterInvariant(m: SetupManifest): void {
    const violations: FilterViolation[] = [];
    walk(m, "", violations);
    if (violations.length > 0) throw new FilterInvariantError(violations);
}
