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

export async function runRollback(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const snapArg = positional[0];
    if (!snapArg) throw new ArgError("usage: kindly rollback <snapshot-dir> [options]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    const snapshotDir = resolve(env.cwd, snapArg);
    if (!existsSync(snapshotDir) || !statSync(snapshotDir).isDirectory()) {
        throw new Error(`snapshot not found or not a directory: ${snapshotDir}`);
    }

    const settingsSnap = join(snapshotDir, SETTINGS_FILENAME);
    const fatSnap = join(snapshotDir, FAT_FILENAME);
    const hasSettings = existsSync(settingsSnap);
    const hasFat = existsSync(fatSnap);

    if (!hasSettings && !hasFat) {
        throw new Error(
            `snapshot ${snapshotDir} is empty — expected ${SETTINGS_FILENAME} or ${FAT_FILENAME}.`
        );
    }

    if (flags.mount) env = { ...env, mountOverride: flags.mount };
    const mount = resolveMount(env);

    heading(env, `rollback from ${snapshotDir}`);

    const fatEntries: string[] = hasFat ? listTarGz(fatSnap) : [];
    if (hasSettings) {
        info(env, `  settings: ${SETTINGS_FILENAME} (${statSync(settingsSnap).size} bytes)`);
    }
    if (hasFat) {
        info(env, `  fat state: ${fatEntries.length} path(s) will be restored from ${FAT_FILENAME}`);
        for (const e of fatEntries.slice(0, 12)) info(env, dim(env, `    - ${e}`));
        if (fatEntries.length > 12) info(env, dim(env, `    ... and ${fatEntries.length - 12} more`));
    }

    if (flags["dry-run"]) {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return 0;
    }

    // Pre-rollback safety snapshot. Mirrors the snapshot we're rolling
    // BACK to, one level deeper: current device state → .kindly/pre-rollback/<stamp>/.
    let preRollbackDir: string | null = null;
    if (flags["safety-snapshot"]) {
        const stamp = env.now().toISOString().replace(/[:.]/g, "-");
        preRollbackDir = join(env.cwd, ".kindly", "pre-rollback", stamp);
        mkdirSync(preRollbackDir, { recursive: true });
    }

    if (hasSettings) {
        // Mirror the pre-import layout: stamp dir holds the file directly,
        // no extra nesting. Do the backup ourselves and tell safeWrite to
        // skip its own timestamped archive.
        let settingsBackupPath: string | null = null;
        if (preRollbackDir && existsSync(mount.settingsPath)) {
            settingsBackupPath = join(preRollbackDir, basename(mount.settingsPath));
            copyFileSync(mount.settingsPath, settingsBackupPath);
        }
        const buf = readFileSync(settingsSnap);
        safeWrite(mount.settingsPath, buf.toString("utf8"), {
            verifyLua: true,
            skipBackup: true,
        });
        ok(env, `restored ${SETTINGS_FILENAME} → ${mount.settingsPath}`);
        if (settingsBackupPath) info(env, dim(env, `  pre-rollback backup: ${settingsBackupPath}`));
    }

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
                info(env, dim(env, `  pre-rollback backup: ${preFat}  (${existing.length} path(s))`));
            }
        }
        const r = extractTarGz({ archivePath: fatSnap, destRoot: mount.koreaderRoot });
        ok(env, `restored ${r.fileCount} plugin/patch file(s) → ${mount.koreaderRoot}`);
    }

    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
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
