// Safe-write pipeline for settings.reader.lua and friends.
//
// The invariant we must maintain: KOReader's loader does
//   pcall(dofile(path)) || pcall(dofile(path .. ".old"))
// so a successful write must leave `path` parseable, AND a crash mid-write
// must leave EITHER path OR path.old parseable.
//
// Sequence:
//   1. Snapshot existing `path` into .kindly/backups/<iso>/<filename>
//   2. Write new content to `path.tmp` + fsync(fd) + fsync(dir)
//   3. If `path` exists, rename it to `path.old` (KOReader's own fallback)
//   4. Rename `path.tmp` → `path` (POSIX atomic on same filesystem)
//   5. fsync(dir)
//   6. Verify: re-read `path`, compare bytes to what we intended to write,
//      parse it, and confirm parseSettingsFile succeeds.
//      If any check fails: rollback via `path.old` and throw.
//
// The .kindly/backups archive is additive and never touched by KOReader —
// it exists so the user can recover a configuration from N writes ago, not
// just the immediately previous one.

import {
    closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync,
    openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { parseSettingsFile } from "../lua/reader.ts";

export type SafeWriteOptions = {
    /** Where to archive pre-write snapshots. Defaults to <cwd>/.kindly/backups. */
    backupDir?: string;
    /**
     * If true, run the parser over the final file and throw if it fails.
     * Defaults to true. Only disable for non-Lua files.
     */
    verifyLua?: boolean;
};

export type SafeWriteResult = {
    path: string;
    backupPath: string | null;
    oldPath: string | null;       // path.old, if we created one
    bytesWritten: number;
};

export function safeWrite(
    path: string,
    content: string,
    opts: SafeWriteOptions = {}
): SafeWriteResult {
    const verifyLua = opts.verifyLua ?? true;
    const backupDir = opts.backupDir ?? join(process.cwd(), ".kindly", "backups");

    const dir = dirname(path);
    if (!existsSync(dir)) {
        throw new Error(`parent directory does not exist: ${dir}`);
    }

    const tmpPath = path + ".tmp";
    const oldPath = path + ".old";
    let backupPath: string | null = null;

    // 1. Archive snapshot of the pre-write file (if any).
    if (existsSync(path)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const archiveRoot = join(backupDir, stamp);
        mkdirSync(archiveRoot, { recursive: true });
        backupPath = join(archiveRoot, basename(path));
        copyFileSync(path, backupPath);
    }

    // 2. Write content to .tmp and fsync it (the file + its directory).
    const buf = Buffer.from(content, "utf8");
    // Clean up stale .tmp from a previous crashed run before opening.
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    const fd = openSync(tmpPath, "wx");
    try {
        let offset = 0;
        while (offset < buf.length) {
            offset += writeSync(fd, buf, offset, buf.length - offset);
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    fsyncDir(dir);

    // 3. Rotate existing → .old so KOReader's built-in fallback has something
    //    to fall back TO if step 4 is interrupted.
    let rotated = false;
    if (existsSync(path)) {
        // If a stale .old from a previous run exists, overwriting is fine —
        // rename is atomic and replaces the destination.
        renameSync(path, oldPath);
        rotated = true;
    }

    // 4. Promote .tmp → path. Atomic on POSIX (same filesystem).
    try {
        renameSync(tmpPath, path);
    } catch (e) {
        // Rollback: put the original back so we don't leave a gap.
        if (rotated && existsSync(oldPath)) {
            try { renameSync(oldPath, path); } catch {}
        }
        throw e;
    }
    fsyncDir(dir);

    // 5. Verify: re-read and (optionally) re-parse. If this fails we're in a
    //    bad spot but we have both the .old sibling and the timestamped
    //    backup to fall back on — restore from .old and throw.
    try {
        const readBack = readFileSync(path, "utf8");
        if (readBack !== content) {
            throw new Error(
                `post-write verify failed: file on disk does not match intended content ` +
                `(${readBack.length} bytes read vs ${content.length} written)`
            );
        }
        if (verifyLua) {
            // Throws LuaParseError if the output isn't parseable.
            parseSettingsFile(readBack);
        }
    } catch (verifyErr) {
        if (rotated && existsSync(oldPath)) {
            try {
                unlinkSync(path);
                renameSync(oldPath, path);
            } catch {}
        }
        throw verifyErr;
    }

    return {
        path,
        backupPath,
        oldPath: rotated ? oldPath : null,
        bytesWritten: buf.length,
    };
}

// Best-effort directory fsync. On macOS/Linux this forces the rename/create
// to hit disk; on filesystems that don't support it we just swallow the
// error rather than abort the whole write.
function fsyncDir(dir: string): void {
    try {
        const fd = openSync(dir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch {
        // Directory fsync isn't supported on all filesystems (notably
        // vfat-on-macOS variants). Not fatal.
    }
}
