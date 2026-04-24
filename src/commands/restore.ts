// `kindly restore <archive>` — extract a snapshot over <mount>/koreader/.
//
// Safety:
//   - Takes a pre-restore snapshot of the CURRENT state first (unless
//     --no-safety-snapshot is passed). If the restore goes wrong, you can
//     re-extract that snapshot to roll back.
//   - `--dry-run` lists what would be extracted without writing anything.
//
// Overwrite semantics: tar replaces files file-by-file. Files present on
// device but not in the archive are LEFT UNTOUCHED (tar doesn't delete
// anything it doesn't know about — this is the sane default; if you want
// a clean slate, factory-reset first).

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import {
    ArchiveTooLargeError, assertSafeArchive, createTarGz, extractTarGz,
    listTarGz, UnsafeArchivePathError,
} from "../fs/archive.ts";
import { resolve } from "node:path";
import { exists } from "../fs/safeRead.ts";
import type { RestoreResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";
import { appendHistoryEntry } from "../history/writer.ts";

const FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "list what would be extracted without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "take a pre-restore snapshot of current device state (use --no-safety-snapshot to skip)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    label: {
        type: "string",
        description: "advisory name for this restore — shown in `kindly history`",
    },
} as const satisfies FlagSpecs;

const SAFETY_PATHS = [
    "settings.reader.lua",
    "settings.reader.lua.old",
    "defaults.custom.lua",
    "history.lua",
    "patches",
    "plugins",
];

export interface RestoreOptions {
    archive: string;
    dryRun?: boolean;
    safetySnapshot?: boolean;
    label?: string;
}

export function executeRestore(opts: RestoreOptions, env: CliEnv): RestoreResult {
    const archivePath = resolve(env.cwd, opts.archive);
    if (!exists(archivePath, "user-provided")) {
        throw new KindlyError(
            ErrorCodes.ARCHIVE_NOT_FOUND,
            `archive not found: ${archivePath}`,
            [{ text: "Pass a path to an existing .tar.gz produced by `kindly snapshot`." }],
        );
    }

    const mount = resolveMount(env);

    // Safety pre-scan: fail before taking a safety snapshot, before
    // reading the full entry list, before anything. A malicious archive
    // shouldn't cause ANY filesystem work on our side.
    try {
        assertSafeArchive(archivePath);
    } catch (e) {
        if (e instanceof UnsafeArchivePathError) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_UNSAFE_PATH,
                e.message,
                [{ text: "Archive was built outside kindly or tampered with; do not restore it. Produce a fresh snapshot with `kindly snapshot`." }],
            );
        }
        if (e instanceof ArchiveTooLargeError) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_TOO_LARGE,
                e.message,
                [{ text: "Archive exceeds kindly's compression-bomb guard. Verify its provenance before restoring." }],
            );
        }
        throw e;
    }
    const entries = listTarGz(archivePath);

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            archivePath,
            destRoot: mount.koreaderRoot,
            entries,
            fileCount: 0,
            safetySnapshotPath: null,
        };
    }

    // Pre-restore safety snapshot. Rollback = extract this back over the
    // koreader dir if something goes wrong.
    let safetySnapshotPath: string | null = null;
    if (opts.safetySnapshot !== false) {
        const safetyPath = resolve(
            env.cwd,
            ".kindly",
            "pre-restore",
            `${isoStamp(env.now())}.tar.gz`,
        );
        try {
            const saf = createTarGz({
                cwd: mount.koreaderRoot,
                paths: SAFETY_PATHS,
                outputPath: safetyPath,
            });
            safetySnapshotPath = saf.archivePath;
        } catch {
            // If the device is empty (fresh install with no settings file),
            // no safety snapshot is possible — leave safetySnapshotPath null,
            // the renderer surfaces that case with a warning.
        }
    }

    const res = extractTarGz({ archivePath, destRoot: mount.koreaderRoot });

    appendHistoryEntry(env, "restore", {
        archive_path: archivePath,
        ...(safetySnapshotPath ? { pre_restore_path: safetySnapshotPath } : {}),
    }, opts.label ? { label: opts.label } : undefined);

    return {
        mode: "restored",
        archivePath,
        destRoot: res.destRoot,
        entries,
        fileCount: res.fileCount,
        safetySnapshotPath,
    };
}

export function renderRestore(result: RestoreResult, env: CliEnv): void {
    if (result.mode === "dry-run") {
        heading(env, `would extract ${result.entries.length} entries into ${result.destRoot}:`);
        for (const e of result.entries.slice(0, 50)) info(env, `  ${e}`);
        if (result.entries.length > 50) {
            info(env, dim(env, `  ... and ${result.entries.length - 50} more`));
        }
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    if (result.safetySnapshotPath) {
        info(env, dim(env, `safety snapshot: ${result.safetySnapshotPath}`));
    } else {
        // Either the user skipped it (--no-safety-snapshot) or creation failed
        // because the device had nothing to snapshot. Warning only matters in
        // the latter case, and we can't tell here — so a single neutral note.
        info(env, dim(env, "no safety snapshot taken."));
    }

    info(env, dim(env, `extracting ${result.entries.length} entries into ${result.destRoot}...`));
    ok(env, `restored ${result.fileCount} file(s) into ${result.destRoot}`);
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
}

export async function runRestore(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const archive = positional[0];
    if (!archive) {
        throw new ArgError("usage: kindly restore <archive.tar.gz> [--dry-run]");
    }
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeRestore({
        archive,
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
        label: flags.label,
    }, env);

    if (env.jsonMode) emitJson(env, "restore", result);
    else renderRestore(result, env);
    return 0;
}

function isoStamp(d: Date): string {
    return d.toISOString().replace(/[:.]/g, "-");
}

export const restoreHelp = `
kindly restore <archive> — extract a snapshot back into the Kindle.

usage: kindly restore <archive.tar.gz> [--dry-run] [--no-safety-snapshot]
                                       [--label <text>] [--mount <path>]

  --dry-run              list entries without writing
  --no-safety-snapshot   skip the pre-restore snapshot of current state
  --label <text>         advisory name logged into kindly history
  --mount <path>         path to a mounted Kindle (auto-detect by default)

By default, takes a safety snapshot of the CURRENT device state first. If
restore goes wrong, re-extract that file to roll back. The safety snapshot
lives under <cwd>/.kindly/pre-restore/.

Restore overwrites file-by-file. Files on device not in the archive are
left untouched — use factory reset for a true clean slate.
`.trim();
