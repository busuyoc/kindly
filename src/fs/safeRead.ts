// Provenance-labeled filesystem reads.
//
// Every filesystem read in kindly has a provenance — where did the path
// come from, and therefore how much do we trust it? Most sites run
// `readFileSync(p, "utf8")` with no label attached; that makes it hard
// to reason about which symlink-follow is "the user's choice" vs. "a
// malicious archive planting a symlink at an extraction root".
//
// This module wraps the raw node:fs calls so every read carries a
// PathProvenance tag. The runtime behavior change is small and
// deliberate: for paths labeled "extracted-archive" we refuse to
// follow symlinks (lstat-first, throw on link). For every other label
// we preserve the existing behavior (follow symlinks, existsSync
// semantics, etc.) because those paths were produced by the user or
// by code the user controls (the mount they pointed us at, their own
// .kindly/ tree).
//
// In short: this is a labeling refactor, not a new enforcement layer.
// The one enforcement that IS consolidated here is the symlink rejection
// inside tarball extraction staging — previously inlined in
// src/setup/unpack.ts, now expressed via the "extracted-archive"
// provenance so every read from a stranger's archive goes through a
// single choke point.

import {
    copyFileSync,
    existsSync,
    lstatSync,
    readFileSync,
    statSync,
    type Stats,
} from "node:fs";

export type PathProvenance =
    | "user-provided"       // argv, --mount, --file, positional
    | "derived-from-mount"  // join(mount.root, ...)
    | "derived-from-cwd"    // .kindly/ local tree
    | "extracted-archive";  // tmpdir post tar-extract

export class SafeReadError extends Error {
    readonly code: string;
    readonly path: string;
    constructor(message: string, code: string, path: string) {
        super(message);
        this.name = "SafeReadError";
        this.code = code;
        this.path = path;
    }
}

/**
 * Throw if `path` is a symlink. Only called for "extracted-archive"
 * reads — every other provenance is allowed to follow symlinks, because
 * the user (or code under the user's control) produced that path.
 *
 * Uses `lstatSync`, not `statSync`, so a symlink doesn't get resolved
 * and read under us. If the path doesn't exist, this is a no-op
 * (the caller's read will throw ENOENT with its native message).
 */
function rejectSymlinkFromArchive(path: string): void {
    let st: Stats;
    try {
        st = lstatSync(path);
    } catch {
        // Non-existent path — let the subsequent read surface the
        // native ENOENT. This matches the pre-refactor shape where
        // unpack.ts assumed extracted files exist by the time it
        // lstat's them.
        return;
    }
    if (st.isSymbolicLink()) {
        throw new SafeReadError(
            `refusing to follow symlink inside extracted archive: ${path}`,
            "ARCHIVE_SYMLINK",
            path,
        );
    }
}

export function readText(path: string, prov: PathProvenance): string {
    if (prov === "extracted-archive") rejectSymlinkFromArchive(path);
    return readFileSync(path, "utf8");
}

export function readBytes(path: string, prov: PathProvenance): Buffer {
    if (prov === "extracted-archive") rejectSymlinkFromArchive(path);
    return readFileSync(path);
}

export function exists(path: string, prov: PathProvenance): boolean {
    // existsSync follows symlinks and returns false for broken links —
    // that's the current behavior at every callsite, keep it.
    // For extracted-archive we still answer "does it exist" truthfully;
    // the symlink rejection fires on the subsequent read/stat.
    void prov;
    return existsSync(path);
}

/**
 * Follow-symlinks stat. Mirrors `statSync(path)` — the default behavior
 * for every non-archive read.
 */
export function statFollow(path: string, prov: PathProvenance): Stats {
    if (prov === "extracted-archive") rejectSymlinkFromArchive(path);
    return statSync(path);
}

/**
 * No-follow stat. Mirrors `lstatSync(path)`. For "extracted-archive"
 * this is also the safety check: if the entry IS a symlink, we throw
 * before returning (matching the intent of unpack.ts's explicit
 * `lstatSync(...).isSymbolicLink()` checks).
 */
export function statNoFollow(path: string, prov: PathProvenance): Stats {
    if (prov === "extracted-archive") {
        // Evaluate once, throw on symlink, return the same stat result
        // so callers don't double-lstat.
        const st = lstatSync(path);
        if (st.isSymbolicLink()) {
            throw new SafeReadError(
                `refusing to follow symlink inside extracted archive: ${path}`,
                "ARCHIVE_SYMLINK",
                path,
            );
        }
        return st;
    }
    return lstatSync(path);
}

/**
 * Copy src → dst. The read side is subject to provenance rules (archive
 * sources are symlink-rejected); the destination is treated as a
 * node:fs.copyFileSync target — it inherits whatever the filesystem
 * does with the destination path.
 */
export function copyFile(
    src: string,
    srcProv: PathProvenance,
    dst: string,
    dstProv: PathProvenance,
): void {
    if (srcProv === "extracted-archive") rejectSymlinkFromArchive(src);
    // dstProv is accepted for symmetry and future write-side policies;
    // the present behavior doesn't differentiate.
    void dstProv;
    copyFileSync(src, dst);
}
