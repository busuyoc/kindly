// Thin wrapper over the system `tar` command.
//
// We shell out rather than pull in a pure-TS tar library because:
//   - macOS and every Kindle ship with BSD/GNU tar
//   - native tar handles symlinks, permissions, and Kindle's vfat filesystem
//     more reliably than any JS implementation we'd bundle
//   - we never need to inspect archive contents beyond "list the paths",
//     which tar can do via `-t`.
//
// All paths in the archive are stored relative to a given root, so the same
// archive can be extracted into a different koreader/ root (useful for
// testing against a simulated Kindle without touching /Volumes/Kindle).

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { exists, statFollow } from "./safeRead.ts";
import { isSafeRelativePath } from "./paths.ts";
import {
    assertGzipMagic, inspectTarGz, MalformedArchiveError,
} from "./tarInspect.ts";

export { MalformedArchiveError } from "./tarInspect.ts";

export type CreateOptions = {
    /** Root directory whose children will be archived. Paths inside the
     *  archive are stored relative to this directory. */
    cwd: string;
    /** List of paths (relative to cwd) to include. Non-existent entries
     *  are skipped silently with a warning in the result. */
    paths: string[];
    /** Archive output path (.tar.gz). Parent directory is created if missing. */
    outputPath: string;
};

export type CreateResult = {
    archivePath: string;
    bytesWritten: number;
    includedPaths: string[];
    skippedPaths: string[];   // paths in `paths` that didn't exist on disk
};

// Create a gzipped tar archive. Returns what was and wasn't included so
// callers can surface "you asked for X but it wasn't present" warnings.
export function createTarGz(opts: CreateOptions): CreateResult {
    const { cwd, paths, outputPath } = opts;

    if (!exists(cwd, "user-provided")) {
        throw new Error(`archive source does not exist: ${cwd}`);
    }
    const outDir = dirname(outputPath);
    if (!exists(outDir, "user-provided")) mkdirSync(outDir, { recursive: true });

    // Round 3 disk-hygiene F1: refuse to write the archive through a
    // pre-staged symlink at outputPath. `tar -czf` happily follows a
    // symlink and overwrites whatever it points to, which composes with
    // the predictable-stamp callsites (pre-restore/<isoStamp>.tar.gz):
    // an attacker who can write under .kindly/ pre-stages a symlink at
    // the predicted path and redirects the tar output to clobber a file
    // outside the snapshot dir. lstatSync inspects the link itself, not
    // the target. ENOENT is the expected case (no prior file, fresh
    // write); any other lstat failure should bubble up.
    try {
        const st = lstatSync(outputPath);
        if (st.isSymbolicLink()) {
            throw new Error(
                `refusing to write archive through symlink at ${outputPath}`,
            );
        }
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const included: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
        if (exists(`${cwd}/${p}`, "user-provided")) included.push(p);
        else skipped.push(p);
    }

    if (included.length === 0) {
        throw new Error(`no input paths exist under ${cwd}; refusing to create empty archive`);
    }

    // -C cwd: change directory before archiving so paths are relative.
    // -c: create, -z: gzip, -f: output file.
    // We do NOT use --no-xattrs / --no-mac-metadata here; archiving them
    // is fine and extraction just drops them on non-Darwin systems.
    const args = ["-czf", outputPath, "-C", cwd, ...included];
    const r = spawnSync("tar", args, { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar failed (exit ${r.status}): ${r.stderr}`);
    }

    return {
        archivePath: outputPath,
        bytesWritten: statFollow(outputPath, "user-provided").size,
        includedPaths: included,
        skippedPaths: skipped,
    };
}

export type ExtractOptions = {
    archivePath: string;
    /** Root directory to extract into. Created if missing. Existing files
     *  are OVERWRITTEN by default (that's the whole point of restore). */
    destRoot: string;
    /** Reject archives larger than this many bytes on disk. A2 defense:
     *  kindly has never legitimately needed >100 MiB archives. Override
     *  only if you know what you're doing. */
    maxArchiveBytes?: number;
    /** Reject archives whose gzip trailer reports more than this many
     *  uncompressed bytes. Combined with maxArchiveBytes this bounds the
     *  compression bomb blast radius — see A9 in 87. */
    maxUncompressedBytes?: number;
    /** Reject archives whose uncompressed:compressed ratio exceeds this.
     *  Legitimate text archives top out around 10:1; plugin source trees
     *  are denser but stay under 50:1. */
    maxCompressionRatio?: number;
};

export type ExtractResult = {
    destRoot: string;
    fileCount: number;
};

/** Thrown when an archive lists a path that could escape the extraction
 *  root (absolute, contains "..", null byte, drive letter, or backslash).
 *  F8 from 87 — never let `tar -xzf` operate on an archive we haven't
 *  validated first. */
export class UnsafeArchivePathError extends Error {
    constructor(public readonly path: string) {
        super(`archive contains unsafe path: ${path}`);
        this.name = "UnsafeArchivePathError";
    }
}

/** Thrown when an archive exceeds one of the compression-bomb guards
 *  (archive bytes, uncompressed bytes, or compression ratio). A9 from 87. */
export class ArchiveTooLargeError extends Error {
    constructor(
        message: string,
        public readonly kind: "archive_bytes" | "uncompressed_bytes" | "ratio",
        public readonly observed: number,
        public readonly limit: number,
    ) {
        super(message);
        this.name = "ArchiveTooLargeError";
    }
}

const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;       // 100 MiB
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;  // 500 MiB
const DEFAULT_MAX_COMPRESSION_RATIO = 100;                 // 100:1

/** Read the gzip trailer via `gzip -l` to learn the declared uncompressed
 *  size. The gzip ISIZE field is uncompressed-size mod 2^32, which is
 *  only fully trustworthy when combined with an archive-bytes cap (so a
 *  legit archive couldn't expand past 4 GiB anyway). Returns null if
 *  gzip can't parse the file. */
function readGzipSizes(archivePath: string): { compressed: number; uncompressed: number } | null {
    const r = spawnSync("gzip", ["-l", archivePath], { encoding: "utf8" });
    if (r.status !== 0) return null;
    // Output is two lines: header + data. Data line starts with two
    // integers (compressed, uncompressed) followed by a ratio and name.
    const lines = r.stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const tokens = lines[lines.length - 1]!.trim().split(/\s+/);
    if (tokens.length < 2) return null;
    const compressed = Number(tokens[0]);
    const uncompressed = Number(tokens[1]);
    if (!Number.isFinite(compressed) || !Number.isFinite(uncompressed)) return null;
    return { compressed, uncompressed };
}

/** A9 + C4: reject archives likely to be compression bombs BEFORE
 *  extraction. Three gzip-level caps + per-entry tar-header cap +
 *  hardlink/symlink rejection. Any one trips the refusal. Throws
 *  ArchiveTooLargeError or MalformedArchiveError. */
function enforceSizeCaps(archivePath: string, opts: ExtractOptions): void {
    const maxArchive = opts.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    const maxUncompressed = opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    const maxRatio = opts.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO;

    // C4: format-sniff before any other work — closes S941.
    assertGzipMagic(archivePath);

    const archiveBytes = statFollow(archivePath, "user-provided").size;
    if (archiveBytes > maxArchive) {
        throw new ArchiveTooLargeError(
            `archive is ${archiveBytes} bytes, exceeds ${maxArchive} limit`,
            "archive_bytes", archiveBytes, maxArchive,
        );
    }
    const sizes = readGzipSizes(archivePath);
    // C4: fail closed when the gzip trailer can't be read. After the
    // magic-byte check this should be rare, but the previous open-
    // coded skip would silently disable the uncompressed and ratio
    // guards on any archive `gzip -l` couldn't parse.
    if (sizes === null) {
        throw new ArchiveTooLargeError(
            "archive gzip trailer unreadable; refusing to extract without size bound",
            "uncompressed_bytes", -1, maxUncompressed,
        );
    }
    if (sizes.uncompressed > maxUncompressed) {
        throw new ArchiveTooLargeError(
            `archive expands to ${sizes.uncompressed} bytes, exceeds ${maxUncompressed} limit`,
            "uncompressed_bytes", sizes.uncompressed, maxUncompressed,
        );
    }
    if (sizes.compressed > 0) {
        const ratio = sizes.uncompressed / sizes.compressed;
        if (ratio > maxRatio) {
            throw new ArchiveTooLargeError(
                `archive compression ratio is ${ratio.toFixed(1)}:1, exceeds ${maxRatio}:1 limit`,
                "ratio", Math.round(ratio), maxRatio,
            );
        }
    }

    // C4: walk tar headers in memory and (a) sum per-entry declared
    // sizes — catches sparse-tar bombs where ISIZE ≪ sum of file sizes,
    // and (b) reject hardlink (typeflag 1) and symlink (typeflag 2)
    // entries before tar lays them down.
    const inspection = inspectTarGz(archivePath, maxUncompressed);
    if (inspection.totalApparentBytes > maxUncompressed) {
        throw new ArchiveTooLargeError(
            `archive's tar headers declare ${inspection.totalApparentBytes} bytes of files, exceeds ${maxUncompressed} limit`,
            "uncompressed_bytes", inspection.totalApparentBytes, maxUncompressed,
        );
    }
    for (const e of inspection.entries) {
        if (e.type === "hardlink") {
            throw new MalformedArchiveError(
                `archive contains hardlink entry (typeflag 1) at ${e.path}; kindly does not extract links`,
            );
        }
        if (e.type === "symlink") {
            throw new MalformedArchiveError(
                `archive contains symlink entry (typeflag 2) at ${e.path}; kindly does not extract links`,
            );
        }
        if (e.type === "sparse") {
            // S1452: GNU old-style sparse (typeflag "S"). Stored size is
            // small, real expanded size lives in the GNU sparse map and
            // can be many GB. ISIZE and totalApparentBytes both miss it.
            throw new MalformedArchiveError(
                `archive contains GNU sparse entry (typeflag S) at ${e.path}; kindly does not extract sparse files`,
            );
        }
    }
}

/** Run both safety checks (compression-bomb + path traversal) without
 *  extracting. Callers that do filesystem work before extractTarGz —
 *  like restore taking a pre-restore safety snapshot — should call this
 *  up front so a malicious archive can't trigger any side effects. */
export function assertSafeArchive(archivePath: string, opts: Omit<ExtractOptions, "archivePath" | "destRoot"> = {}): void {
    if (!exists(archivePath, "user-provided")) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    enforceSizeCaps(archivePath, { ...opts, archivePath, destRoot: "" });
    const listed = listTarGz(archivePath).filter((p) => !p.endsWith("/"));
    for (const entry of listed) {
        if (!isSafeRelativePath(entry)) {
            throw new UnsafeArchivePathError(entry);
        }
    }
}

export function extractTarGz(opts: ExtractOptions): ExtractResult {
    const { archivePath, destRoot } = opts;
    if (!exists(archivePath, "user-provided")) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    if (!exists(destRoot, "user-provided")) mkdirSync(destRoot, { recursive: true });

    // Bomb guards + path-safety BEFORE extraction. Belt-and-suspenders
    // with caller-side assertSafeArchive — the choke point is here.
    enforceSizeCaps(archivePath, opts);
    const listed = listTarGz(archivePath).filter((p) => !p.endsWith("/"));
    for (const entry of listed) {
        if (!isSafeRelativePath(entry)) {
            throw new UnsafeArchivePathError(entry);
        }
    }

    const r = spawnSync("tar", ["-xzf", archivePath, "-C", destRoot], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar extraction failed (exit ${r.status}): ${r.stderr}`);
    }

    return { destRoot, fileCount: listed.length };
}

// Read a single archive entry's contents to memory without writing to disk.
// Used by restore to peek at settings.reader.lua and run classify-aware
// gates BEFORE any filesystem side effects. Returns null if the entry is
// not present in the archive.
export function extractFileToMemory(
    archivePath: string,
    entry: string,
): string | null {
    if (!exists(archivePath, "user-provided")) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    if (!isSafeRelativePath(entry)) {
        throw new UnsafeArchivePathError(entry);
    }
    assertGzipMagic(archivePath);
    // tar -O writes the file content to stdout. Exit status is non-zero
    // when the entry is missing — distinguish that from a real failure
    // by checking the listing.
    const r = spawnSync("tar", ["-xzOf", archivePath, entry], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status === 0) return r.stdout;
    const listed = listTarGz(archivePath);
    if (!listed.includes(entry)) return null;
    throw new Error(`tar extraction failed (exit ${r.status}): ${r.stderr}`);
}

// Return the list of paths stored in the archive. Used by restore --dry-run
// and by extractTarGz for file counting.
export function listTarGz(archivePath: string): string[] {
    if (!exists(archivePath, "user-provided")) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    assertGzipMagic(archivePath);
    const r = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar listing failed (exit ${r.status}): ${r.stderr}`);
    }
    return r.stdout.split("\n").filter((l) => l.length > 0);
}
