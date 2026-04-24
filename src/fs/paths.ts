// Pure path predicates used by archive handling and manifest validation.
// Lives here (not under src/setup/) because fs/archive.ts — which sits
// below setup/ in the layering — needs it for extraction safety.

// Reject any path that could escape the extraction root or be
// interpreted as a non-relative path on any platform. Archives and
// manifests come from strangers; "by shape, not by trust" is the rule.
// The koreader/ layout is POSIX, so "/" is the only valid separator —
// backslashes are rejected outright.
export function isSafeRelativePath(p: string): boolean {
    if (p.length === 0) return false;
    if (p.includes("\0")) return false;              // null byte
    if (p.startsWith("/")) return false;             // POSIX absolute
    if (/^[a-zA-Z]:/.test(p)) return false;          // Windows drive letter
    if (p.includes("\\")) return false;              // Windows separator
    for (const seg of p.split("/")) {
        if (seg === "" || seg === "." || seg === "..") return false;
        // empty: leading/trailing/double slash; `.`: current-dir segment
        // that would collapse `./X` to the parent dir (S690 wipe primitive
        // via installPluginFiles seg=`.` → rmSync(pluginsRoot)); `..`: escape.
    }
    return true;
}
