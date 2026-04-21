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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

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

    if (!existsSync(cwd)) {
        throw new Error(`archive source does not exist: ${cwd}`);
    }
    const outDir = dirname(outputPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const included: string[] = [];
    const skipped: string[] = [];
    for (const p of paths) {
        if (existsSync(`${cwd}/${p}`)) included.push(p);
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
        bytesWritten: statSync(outputPath).size,
        includedPaths: included,
        skippedPaths: skipped,
    };
}

export type ExtractOptions = {
    archivePath: string;
    /** Root directory to extract into. Created if missing. Existing files
     *  are OVERWRITTEN by default (that's the whole point of restore). */
    destRoot: string;
};

export type ExtractResult = {
    destRoot: string;
    fileCount: number;
};

export function extractTarGz(opts: ExtractOptions): ExtractResult {
    const { archivePath, destRoot } = opts;
    if (!existsSync(archivePath)) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    if (!existsSync(destRoot)) mkdirSync(destRoot, { recursive: true });

    // Count files first so we can report something concrete to the user.
    const listed = listTarGz(archivePath).filter((p) => !p.endsWith("/"));

    const r = spawnSync("tar", ["-xzf", archivePath, "-C", destRoot], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar extraction failed (exit ${r.status}): ${r.stderr}`);
    }

    return { destRoot, fileCount: listed.length };
}

// Return the list of paths stored in the archive. Used by restore --dry-run
// and by extractTarGz for file counting.
export function listTarGz(archivePath: string): string[] {
    if (!existsSync(archivePath)) {
        throw new Error(`archive not found: ${archivePath}`);
    }
    const r = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    if (r.status !== 0) {
        throw new Error(`tar listing failed (exit ${r.status}): ${r.stderr}`);
    }
    return r.stdout.split("\n").filter((l) => l.length > 0);
}
