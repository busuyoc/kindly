// `kindly rollback <snapshot-dir>` — restore a pre-import/pre-apply
// safety snapshot byte-exact.
//
// The `setup import` (and `apply`) flow writes a timestamped pre-write
// copy into `<cwd>/.kindly/pre-import/<stamp>/` before mutating the
// device: `settings.reader.lua` for settings changes, and
// `plugins-patches.tar.gz` for fat installs. This command copies those
// back onto the device.
//
// Scope: this is NOT the same as `kindly restore` — that extracts a
// whole-tree v0.2 snapshot tarball. Rollback handles the finer-grained
// per-import safety net.
//
// Safety: before overwriting anything, rollback takes ITS OWN snapshot
// (unless --no-safety-snapshot) at `<cwd>/.kindly/pre-rollback/<stamp>/`.
// If the rollback itself goes wrong, you can roll it forward again.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import { createTarGz, extractTarGz, listTarGz } from "../fs/archive.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import type { RollbackResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";
import { appendHistoryEntry } from "../history/writer.ts";

const FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "show what would be restored without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "take a pre-rollback snapshot of current device state (invert with --no-safety-snapshot)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

const SETTINGS_FILENAME = "settings.reader.lua";
const FAT_FILENAME = "plugins-patches.tar.gz";

export interface RollbackOptions {
    snapshotDir: string;
    dryRun?: boolean;
    safetySnapshot?: boolean;
}

export function executeRollback(opts: RollbackOptions, env: CliEnv): RollbackResult {
    const snapshotDir = resolve(env.cwd, opts.snapshotDir);
    if (!existsSync(snapshotDir) || !statSync(snapshotDir).isDirectory()) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `snapshot not found or not a directory: ${snapshotDir}`,
            [{ text: "Pass a directory from `.kindly/pre-import/<stamp>/`." }],
        );
    }

    const settingsSnap = join(snapshotDir, SETTINGS_FILENAME);
    const fatSnap = join(snapshotDir, FAT_FILENAME);
    const hasSettings = existsSync(settingsSnap);
    const hasFat = existsSync(fatSnap);

    if (!hasSettings && !hasFat) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `snapshot ${snapshotDir} is empty — expected ${SETTINGS_FILENAME} or ${FAT_FILENAME}.`,
            [{ text: "Point at a kindly pre-import snapshot directory, not an arbitrary folder." }],
        );
    }

    const mount = resolveMount(env);
    const fatEntries: string[] = hasFat ? listTarGz(fatSnap) : [];

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            snapshotDir,
            settingsRestored: false,
            fatRestored: false,
            fatEntries,
            fatFileCount: 0,
            preRollbackDir: null,
        };
    }

    // Pre-rollback safety snapshot. Mirrors the snapshot we're rolling
    // BACK to, one level deeper: current device state → .kindly/pre-rollback/<stamp>/.
    let preRollbackDir: string | null = null;
    if (opts.safetySnapshot !== false) {
        const stamp = env.now().toISOString().replace(/[:.]/g, "-");
        preRollbackDir = join(env.cwd, ".kindly", "pre-rollback", stamp);
        mkdirSync(preRollbackDir, { recursive: true });
    }

    let settingsRestored = false;
    if (hasSettings) {
        // Mirror the pre-import layout: stamp dir holds the file directly,
        // no extra nesting. Do the backup ourselves and tell safeWrite to
        // skip its own timestamped archive.
        if (preRollbackDir && existsSync(mount.settingsPath)) {
            const settingsBackupPath = join(preRollbackDir, basename(mount.settingsPath));
            copyFileSync(mount.settingsPath, settingsBackupPath);
        }
        const buf = readFileSync(settingsSnap);
        safeWrite(mount.settingsPath, buf.toString("utf8"), {
            verifyLua: true,
            skipBackup: true,
        });
        settingsRestored = true;
    }

    let fatRestored = false;
    let fatFileCount = 0;
    if (hasFat) {
        if (preRollbackDir) {
            // createTarGz refuses empty input; filter to the paths still on device.
            const existing = fatEntries.filter(
                (p) => existsSync(join(mount.koreaderRoot, p)),
            );
            if (existing.length > 0) {
                const preFat = join(preRollbackDir, FAT_FILENAME);
                createTarGz({
                    cwd: mount.koreaderRoot,
                    paths: existing,
                    outputPath: preFat,
                });
            }
        }
        const r = extractTarGz({ archivePath: fatSnap, destRoot: mount.koreaderRoot });
        fatRestored = true;
        fatFileCount = r.fileCount;
    }

    appendHistoryEntry(env, "rollback", {
        snapshot_dir: snapshotDir,
        ...(preRollbackDir ? { pre_rollback_path: preRollbackDir } : {}),
    });

    return {
        mode: "rolled-back",
        snapshotDir,
        settingsRestored,
        fatRestored,
        fatEntries,
        fatFileCount,
        preRollbackDir,
    };
}

export function renderRollback(result: RollbackResult, env: CliEnv): void {
    const mount = { settingsPath: "" }; // placeholder — real paths live on result
    void mount;

    heading(env, `rollback from ${result.snapshotDir}`);

    if (result.settingsRestored || (result.mode === "dry-run" && settingsPresent(result))) {
        info(env, `  settings: ${SETTINGS_FILENAME}`);
    }
    if (result.fatEntries.length > 0) {
        info(env, `  fat state: ${result.fatEntries.length} path(s) will be restored from ${FAT_FILENAME}`);
        for (const e of result.fatEntries.slice(0, 12)) info(env, dim(env, `    - ${e}`));
        if (result.fatEntries.length > 12) {
            info(env, dim(env, `    ... and ${result.fatEntries.length - 12} more`));
        }
    }

    if (result.mode === "dry-run") {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    if (result.settingsRestored) {
        ok(env, `restored ${SETTINGS_FILENAME}`);
        if (result.preRollbackDir) {
            info(env, dim(env, `  pre-rollback backup: ${result.preRollbackDir}`));
        }
    }
    if (result.fatRestored) {
        ok(env, `restored ${result.fatFileCount} plugin/patch file(s)`);
    }
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
}

// Dry-run result doesn't expose a boolean for "settings is in the snapshot"
// directly — infer from the fact that renderer is only called for non-empty
// snapshots (executeRollback throws otherwise). We detect settings presence
// by the FS state; but result.snapshotDir is trusted in renderer context.
function settingsPresent(result: RollbackResult): boolean {
    return existsSync(join(result.snapshotDir, SETTINGS_FILENAME));
}

export async function runRollback(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const snapArg = positional[0];
    if (!snapArg) throw new ArgError("usage: kindly rollback <snapshot-dir> [options]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeRollback({
        snapshotDir: snapArg,
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
    }, env);

    if (env.jsonMode) emitJson(env, "rollback", result);
    else renderRollback(result, env);
    return 0;
}

export const rollbackHelp = `
kindly rollback <snapshot-dir>

Roll back a kindly-imported Setup (or kindly apply) by copying a
timestamped safety snapshot back onto the device.

The snapshot dir is one of the directories under .kindly/pre-import/
(created automatically on every setup import / kindly apply). It can
contain:
  - settings.reader.lua           (pre-write copy of the settings file)
  - plugins-patches.tar.gz        (pre-install archive of affected plugin
                                   dirs and patch files)

Usage:
  kindly rollback <snapshot-dir> [--dry-run] [--no-safety-snapshot]
                                 [--mount <path>]

Options:
  --dry-run             list what would be restored; don't write
  --no-safety-snapshot  skip the pre-rollback backup of current state
                        (default: safety snapshot is ON — saved to
                         .kindly/pre-rollback/<stamp>/)
  --mount <path>        point at a specific Kindle mount

This is different from \`kindly restore\`: restore extracts a whole-tree
v0.2 snapshot tarball; rollback handles the finer-grained per-import
safety net produced by setup import / apply.
`.trim();
