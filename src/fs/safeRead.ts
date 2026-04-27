// Provenance-labeled filesystem reads.
//
// Every filesystem read in kindly has a provenance — where did the path
// come from, and therefore how much do we trust what it points at?
//
// Trust model per provenance:
//
//   "user-provided"      — user typed the path (argv, --mount, --file,
//                          positional). Follow symlinks; the user
//                          consented to their own filesystem shape.
//
//   "derived-from-cwd"   — path under the user's own .kindly/ tree or
//                          working directory. Host is the TCB. Follow.
//
//   "derived-from-mount" — path kindly constructed under a Kindle mount
//                          (join(mount.root, ...)). The mount is
//                          UNTRUSTED DATA: USB-writable, historically
//                          pwned via KOReader RCE, or shared hardware.
//                          A planted symlink at settings.reader.lua
//                          pointing to ~/.ssh/id_rsa would exfiltrate
//                          host secrets through LuaParseError leak
//                          (S281 class) or by pull writing the target
//                          bytes into kindly.yaml (S242). REJECT.
//                          Closes S211/S241/S242/S243 (Batch K).
//
//   "extracted-archive"  — path under a tmpdir we just tar-extracted
//                          from a stranger's .kset. REJECT symlinks
//                          before any read or follow-stat can resolve
//                          them (consolidates the checks previously
//                          inlined in src/setup/unpack.ts).
//
//   "container-output"   — path under a host tmpdir that an opaque
//                          process inside a Docker container just
//                          wrote to via a bind mount. The container
//                          is sandboxed (--network=none, ephemeral
//                          KO_HOME), but the bind mount is the one
//                          channel out. A planted symlink in
//                          /work/out/preview.png pointing at, e.g.,
//                          ~/.ssh/id_rsa would be followed by a
//                          host-side copyFileSync, exfiltrating the
//                          target through the user's --output PNG
//                          (W46-S1). REJECT.
//
// Rejection uses `lstatSync` at the boundary; SafeReadError with code
// "UNTRUSTED_SYMLINK" is thrown before the read proceeds. `exists()`
// is deliberately permissive — reporting "does this path resolve to
// something" is useful for flow-control and doesn't leak bytes; the
// symlink rejection fires on the subsequent read or follow-stat.

import {
    copyFileSync,
    existsSync,
    lstatSync,
    readFileSync,
    statSync,
    type Stats,
} from "node:fs";

export type PathProvenance =
    | "user-provided"       // argv, --mount, --file, positional — user consented
    | "derived-from-mount"  // join(mount.root, ...)            — UNTRUSTED
    | "derived-from-cwd"    // .kindly/ local tree              — host is TCB
    | "extracted-archive"   // tmpdir post tar-extract          — UNTRUSTED
    | "container-output";   // tmpdir written by a container    — UNTRUSTED

function isUntrusted(prov: PathProvenance): boolean {
    return prov === "extracted-archive"
        || prov === "derived-from-mount"
        || prov === "container-output";
}

export class SafeReadError extends Error {
    readonly code: string;
    readonly path: string;
    readonly provenance: PathProvenance;
    constructor(message: string, code: string, path: string, provenance: PathProvenance) {
        super(message);
        this.name = "SafeReadError";
        this.code = code;
        this.path = path;
        this.provenance = provenance;
    }
}

function symlinkOriginLabel(prov: PathProvenance): string {
    if (prov === "extracted-archive") return "inside extracted archive";
    if (prov === "container-output") return "in container-output bind mount";
    return "at mount-derived path";
}

/**
 * Throw if `path` is a symlink. Called for the two UNTRUSTED provenances
 * — "extracted-archive" and "derived-from-mount". Uses `lstatSync`, not
 * `statSync`, so a symlink is identified without resolving. Non-existent
 * paths are a no-op — the caller's read will surface the native ENOENT.
 */
function rejectSymlinkFromUntrusted(path: string, prov: PathProvenance): void {
    let st: Stats;
    try {
        st = lstatSync(path);
    } catch {
        return;
    }
    if (st.isSymbolicLink()) {
        throw new SafeReadError(
            `refusing to follow symlink ${symlinkOriginLabel(prov)}: ${path}`,
            "UNTRUSTED_SYMLINK",
            path,
            prov,
        );
    }
}

export function readText(path: string, prov: PathProvenance): string {
    if (isUntrusted(prov)) rejectSymlinkFromUntrusted(path, prov);
    return readFileSync(path, "utf8");
}

export function readBytes(path: string, prov: PathProvenance): Buffer {
    if (isUntrusted(prov)) rejectSymlinkFromUntrusted(path, prov);
    return readFileSync(path);
}

/**
 * Does the path resolve to something? Deliberately permissive for all
 * provenances — reports truthfully whether the target exists. Symlink
 * rejection fires on the next read/follow-stat that would resolve the
 * target. This matches the pre-refactor `existsSync` semantics at every
 * callsite and avoids the "false negative when a symlink targets an
 * existing file" confusion.
 */
export function exists(path: string, prov: PathProvenance): boolean {
    void prov;
    return existsSync(path);
}

/** Follow-symlinks stat. For UNTRUSTED provenances, rejects symlinks
 *  before the follow would leak target metadata (size, mtime). */
export function statFollow(path: string, prov: PathProvenance): Stats {
    if (isUntrusted(prov)) rejectSymlinkFromUntrusted(path, prov);
    return statSync(path);
}

/** No-follow stat. For UNTRUSTED provenances, reject if the entry IS a
 *  symlink (even though we're not following) — same policy as the other
 *  read helpers so callers reason uniformly. Returns the lstat result
 *  for non-symlink entries so callers don't double-lstat. */
export function statNoFollow(path: string, prov: PathProvenance): Stats {
    if (isUntrusted(prov)) {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) {
            throw new SafeReadError(
                `refusing to follow symlink ${symlinkOriginLabel(prov)}: ${path}`,
                "UNTRUSTED_SYMLINK",
                path,
                prov,
            );
        }
        return st;
    }
    return lstatSync(path);
}

/** Copy src → dst. The read side is subject to provenance rules (UNTRUSTED
 *  sources are symlink-rejected). The destination is a node:fs.copyFileSync
 *  target. `dstProv` is accepted for symmetry / future write-side policy. */
export function copyFile(
    src: string,
    srcProv: PathProvenance,
    dst: string,
    dstProv: PathProvenance,
): void {
    if (isUntrusted(srcProv)) rejectSymlinkFromUntrusted(src, srcProv);
    void dstProv;
    copyFileSync(src, dst);
}
