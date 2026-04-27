// Pure path predicates used by archive handling and manifest validation.
// Lives here (not under src/setup/) because fs/archive.ts — which sits
// below setup/ in the layering — needs it for extraction safety.

// Round 3 filter-parity MED: reject any Cf "format" or Cc "control"
// codepoint anywhere in a segment. This is symmetric with the v0.13.0
// filterCheck rule (src/setup/filterCheck.ts) and parseYamlSafe's
// invisible-key rejection (src/fs/yamlSafe.ts, Lead 19). Without it,
// signed `.kset` archives could ship plugin paths like
// `SSH<U+200B>.koplugin/main.lua` past every textual check (NFC-equal
// to itself, no `/`, not `.` or `..` after collapse) and the on-device
// installer would create a directory whose name visually collides with
// a real plugin or contains RLO bytes that flip later log lines.
// Built via RegExp(string,...) so the source has no embedded raw
// control bytes. \p{Cc} is U+0000-U+001F + U+007F-U+009F; \p{Cf} is
// the entire Unicode "format" category.
const SEGMENT_INVISIBLE_RE = new RegExp("[\\p{Cc}\\p{Cf}]", "u");

// S2201: cap path and per-segment lengths at parse time. FAT32's long
// filename limit is 255 UTF-16 code units per component, and a 1024-
// char total relative path comfortably fits inside Linux PATH_MAX (4096)
// even when joined under a longer extraction root. Without this cap,
// pathological manifest entries (4-MiB single component) reach
// writeFileSync and crash mid-install with ENAMETOOLONG, leaving a
// half-applied state on FAT32 (S542 sibling). Defence-in-depth: the
// kernel would catch this anyway, but failing at parse keeps the safety
// snapshot intact and produces a structured SetupSchemaError.
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;

// Reject any path that could escape the extraction root or be
// interpreted as a non-relative path on any platform. Archives and
// manifests come from strangers; "by shape, not by trust" is the rule.
// The koreader/ layout is POSIX, so "/" is the only valid separator —
// backslashes are rejected outright.
export function isSafeRelativePath(p: string): boolean {
    if (p.length === 0) return false;
    if (p.length > MAX_PATH_LENGTH) return false;    // S2201
    if (p.includes("\0")) return false;              // null byte
    if (p.startsWith("/")) return false;             // POSIX absolute
    if (/^[a-zA-Z]:/.test(p)) return false;          // Windows drive letter
    if (p.includes("\\")) return false;              // Windows separator
    for (const seg of p.split("/")) {
        if (seg.length > MAX_SEGMENT_LENGTH) return false; // S2201
        if (SEGMENT_INVISIBLE_RE.test(seg)) return false;
        // S965 (Angle X): compare against NFC-normalized segment so that
        // visually-identical bytes — ZWSP-suffixed `.`, NFD-decomposed
        // segments, BOM-prefixed `..` — cannot pass the strict-equality
        // check by shape. Zero-width controls (ZWSP/ZWNJ/ZWJ/WJ/BOM) are
        // stripped before normalizing so a segment built from `.` plus
        // ZWSP collapses to `.` and is rejected. Without this, the
        // predicate's "by shape, not by trust" comment overstates the
        // guarantee — see Lead 19 / S690 cousin findings. (The leading
        // SEGMENT_INVISIBLE_RE check above now also rejects these
        // outright, but the strip-then-collapse keeps the layered
        // defence in place.)
        // U+200B-U+200D = ZWSP/ZWNJ/ZWJ; U+2060 = WJ; U+FEFF = BOM/ZWNBSP.
        const norm = seg.normalize("NFC").replace(/[​-‍⁠﻿]/g, "");
        if (norm === "" || norm === "." || norm === "..") return false;
        // empty: leading/trailing/double slash; `.`: current-dir segment
        // that would collapse `./X` to the parent dir (S690 wipe primitive
        // via installPluginFiles seg=`.` → rmSync(pluginsRoot)); `..`: escape.
    }
    return true;
}
