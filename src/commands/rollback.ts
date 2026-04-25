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

import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { copyFile, exists, readBytes, readText, statFollow } from "../fs/safeRead.ts";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import { createTarGz, extractTarGz, listTarGz } from "../fs/archive.ts";
import { isSafeRelativePath } from "../fs/paths.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import type { RollbackResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { writeInProgressMarker, clearInProgressMarker } from "../history/inProgress.ts";
import { withLock } from "../fs/lockfile.ts";
import { createHash } from "node:crypto";
import {
    countAllHistory,
    findHistoryEntryByIndex,
    type HistoryEntryWithIndex,
} from "../history/reader.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { computeChanges } from "../schema/diff.ts";
import { runPhase } from "../gates/orchestrator.ts";
import { CODE_EXEC_ADJACENT_REQUIRES_ACK } from "../gates/definitions/dual.ts";
import { appendGateEvent } from "../history/gateLog.ts";

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
    label: {
        type: "string",
        description: "advisory name for this rollback — shown in `kindly history`",
    },
    to: {
        type: "string",
        description: "roll back using history entry #N's safety snapshot (oldest = 1)",
    },
    "accept-code-exec": {
        type: "boolean",
        default: false,
        description:
            "consent to KOReader interpolating snapshot values into os.execute / " +
            "os.remove / shell calls (SSH_port, httpinspector_port, cover_image_path)",
    },
} as const satisfies FlagSpecs;

const SETTINGS_FILENAME = "settings.reader.lua";
const FAT_FILENAME = "plugins-patches.tar.gz";

export interface RollbackOptions {
    snapshotDir: string;
    dryRun?: boolean;
    safetySnapshot?: boolean;
    label?: string;
    acceptCodeExec?: boolean;
}

export function executeRollback(opts: RollbackOptions, env: CliEnv): RollbackResult {
    return withLock(env, "rollback", () => executeRollbackLocked(opts, env));
}

function executeRollbackLocked(opts: RollbackOptions, env: CliEnv): RollbackResult {
    const snapshotDir = resolve(env.cwd, opts.snapshotDir);
    if (!exists(snapshotDir, "user-provided") || !statFollow(snapshotDir, "user-provided").isDirectory()) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `snapshot not found or not a directory: ${snapshotDir}`,
            [{ text: "Pass a directory from `.kindly/pre-import/<stamp>/`." }],
        );
    }

    const settingsSnap = join(snapshotDir, SETTINGS_FILENAME);
    const fatSnap = join(snapshotDir, FAT_FILENAME);
    const hasSettings = exists(settingsSnap, "user-provided");
    const hasFat = exists(fatSnap, "user-provided");

    if (!hasSettings && !hasFat) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `snapshot ${snapshotDir} is empty — expected ${SETTINGS_FILENAME} or ${FAT_FILENAME}.`,
            [{ text: "Point at a kindly pre-import snapshot directory, not an arbitrary folder." }],
        );
    }

    const mount = resolveMount(env);
    const fatEntries: string[] = hasFat ? listTarGz(fatSnap) : [];

    // Path-safety pre-scan (F8). These archives come from disk — they're
    // ours by construction — but honor the same "verify before extract"
    // rule as restore, for defense in depth.
    for (const e of fatEntries) {
        if (e.endsWith("/")) continue;
        if (!isSafeRelativePath(e)) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_UNSAFE_PATH,
                `snapshot archive contains unsafe path: ${e}`,
                [{ text: "This shouldn't happen for a kindly-produced snapshot. Do not roll back from this directory; report the issue." }],
            );
        }
    }

    // C7 / S606: code-exec-adjacent keys (SSH_port, httpinspector_port,
    // cover_image_path) require --accept-code-exec consent at rollback,
    // mirroring apply and restore. Other gate families don't apply: a
    // rollback restores kindly's own snapshot bytes, so the SENSITIVE/
    // DESTRUCTIVE consents would have fired (or been ack'd) when those
    // bytes first hit the device. Code-exec is the orthogonal hazard
    // that survives the original gating — its consent is a separate
    // mental model, gated independently every time.
    runRollbackGates(snapshotDir, hasSettings, mount.settingsPath, opts, env);

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
    let settingsMarkerPath: string | null = null;
    if (hasSettings) {
        // Mirror the pre-import layout: stamp dir holds the file directly,
        // no extra nesting. Do the backup ourselves and tell safeWrite to
        // skip its own timestamped archive.
        if (preRollbackDir && exists(mount.settingsPath, "derived-from-mount")) {
            const settingsBackupPath = join(preRollbackDir, basename(mount.settingsPath));
            copyFile(mount.settingsPath, "derived-from-mount", settingsBackupPath, "derived-from-cwd");
        }
        const buf = readBytes(settingsSnap, "user-provided");
        const content = buf.toString("utf8");
        // C10: crash-recovery marker covers the safeWrite + history-append
        // window so a SIGKILL mid-rollback shows up in `kindly doctor`.
        settingsMarkerPath = writeInProgressMarker(env, {
            cmd: "rollback",
            started_at: env.now().toISOString(),
            pid: process.pid,
            settings_path: mount.settingsPath,
            intended_sha256: createHash("sha256").update(content).digest("hex"),
            snapshot_dir: snapshotDir,
        });
        safeWrite(mount.settingsPath, content, {
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
                (p) => exists(join(mount.koreaderRoot, p), "derived-from-mount"),
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
    }, opts.label ? { label: opts.label } : undefined);

    if (settingsMarkerPath) clearInProgressMarker(settingsMarkerPath);

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

function runRollbackGates(
    snapshotDir: string,
    hasSettings: boolean,
    deviceSettingsPath: string,
    opts: RollbackOptions,
    env: CliEnv,
): void {
    if (!hasSettings) return;
    const settingsSnap = join(snapshotDir, SETTINGS_FILENAME);

    let fromSnapshot: Record<string, LuaValue>;
    try {
        fromSnapshot = parseSettingsFile(
            readBytes(settingsSnap, "user-provided").toString("utf8"),
        ) as Record<string, LuaValue>;
    } catch {
        // Snapshot file unparseable — skip the gate. KOReader will reject
        // it on its own load path. Mirrors restore's lenient stance
        // (S606 is a rollback-side echo of the same parser-strictness
        // decision).
        return;
    }

    let onDevice: Record<string, LuaValue> = {};
    if (exists(deviceSettingsPath, "derived-from-mount")) {
        try {
            onDevice = parseSettingsFile(
                readText(deviceSettingsPath, "derived-from-mount"),
            ) as Record<string, LuaValue>;
        } catch {
            // Device file unparseable → treat as empty so the gate flags
            // any code-exec-adjacent key the snapshot would re-introduce.
        }
    }

    const changes = computeChanges(onDevice, fromSnapshot);

    runPhase({
        boundary: "rollback",
        registry: [CODE_EXEC_ADJACENT_REQUIRES_ACK],
        dryRun: opts.dryRun ?? false,
        strictImports: false,
        opts: {
            changes,
            acceptCodeExec: !!opts.acceptCodeExec,
        },
        logger: (fired) => {
            if (fired.result.kind === "bypass") {
                appendGateEvent(env, {
                    gate_id: fired.id,
                    boundary: fired.boundary,
                    kind: "bypass",
                    bypass_flag: fired.result.byFlag,
                });
            } else if (fired.result.kind === "block") {
                appendGateEvent(env, {
                    gate_id: fired.id,
                    boundary: fired.boundary,
                    kind: "block",
                });
            }
        },
    });
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
    return exists(join(result.snapshotDir, SETTINGS_FILENAME), "user-provided");
}

// Resolve a 1-based history index (oldest = 1) to the matching mutation's
// pre-* safety snapshot directory. This is the `--to <N>` bridge: users
// pick an entry out of `kindly history`, we locate its backup for rollback.
//
// Not every entry is rollable:
//   - apply        → parent of backup_path (dir holds settings.reader.lua)
//   - setup:import → pre_import_path (dir holds settings + optional fat tar)
//   - rollback     → pre_rollback_path (dir; rolling back a rollback)
//   - restore      → pre_restore_path is a tarball, not a dir — redirect
//                   user to `kindly restore <path>`
//   - snapshot     → no device mutation, nothing to roll back
//   - setup:export → no device mutation
//
// Entries with --no-safety-snapshot at origin have no pre-* field at all.
export function resolveSnapshotFromHistory(
    index: number,
    cwd: string,
): { snapshotDir: string; entry: HistoryEntryWithIndex } {
    const total = countAllHistory(cwd);
    if (total === 0) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `no history yet — nothing to roll back to.`,
            [{ text: "Run `kindly history` to confirm, or pass a snapshot directory directly." }],
        );
    }
    const entry = findHistoryEntryByIndex(cwd, index);
    if (!entry) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `no history entry #${index} (history has ${total} entries, valid range 1..${total}).`,
            [{ text: "Run `kindly history` to see the available indexes.", command: "kindly history" }],
        );
    }

    const s = entry.summary;
    if (entry.cmd === "apply" && s.backup_path) {
        return { snapshotDir: dirname(s.backup_path), entry };
    }
    if (entry.cmd === "setup:import" && s.pre_import_path) {
        return { snapshotDir: s.pre_import_path, entry };
    }
    if (entry.cmd === "rollback" && s.pre_rollback_path) {
        return { snapshotDir: s.pre_rollback_path, entry };
    }
    if (entry.cmd === "restore" && s.pre_restore_path) {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `history entry #${index} is a \`restore\` — rollback operates on per-mutation snapshot directories, not whole-tree archives.`,
            [{
                text: "Extract the pre-restore archive with `kindly restore` instead.",
                command: `kindly restore ${s.pre_restore_path}`,
            }],
        );
    }
    if (entry.cmd === "snapshot" || entry.cmd === "setup:export") {
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `history entry #${index} is a \`${entry.cmd}\` — it produces an archive but doesn't modify the device, so there's nothing to roll back.`,
            [{ text: "Pick an entry for `apply`, `setup:import`, or `rollback` from `kindly history`." }],
        );
    }
    throw new KindlyError(
        ErrorCodes.SNAPSHOT_INVALID,
        `history entry #${index} (${entry.cmd}) has no safety snapshot on record — was it run with --no-safety-snapshot?`,
        [{ text: "Pass a snapshot directory directly, or pick a different entry." }],
    );
}

export async function runRollback(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const snapArg = positional[0];

    if (flags.to !== undefined && snapArg !== undefined) {
        throw new ArgError("--to <N> and a positional snapshot-dir are mutually exclusive");
    }
    if (flags.to === undefined && !snapArg) {
        throw new ArgError("usage: kindly rollback <snapshot-dir> | --to <N> [options]");
    }
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    let resolvedDir: string;
    if (flags.to !== undefined) {
        const n = Number(flags.to);
        if (!Number.isInteger(n) || n < 1) {
            throw new ArgError(`--to must be a positive integer (got ${JSON.stringify(flags.to)})`);
        }
        resolvedDir = resolveSnapshotFromHistory(n, env.cwd).snapshotDir;
    } else {
        resolvedDir = snapArg!;
    }

    const result = executeRollback({
        snapshotDir: resolvedDir,
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
        label: flags.label,
        acceptCodeExec: flags["accept-code-exec"],
    }, env);

    if (env.jsonMode) emitJson(env, "rollback", result);
    else renderRollback(result, env);
    return 0;
}

export const rollbackHelp = `
kindly rollback <snapshot-dir> | --to <N>

Roll back a kindly-imported Setup (or kindly apply) by copying a
timestamped safety snapshot back onto the device.

Two ways to pick the snapshot:
  - explicit directory from .kindly/pre-import/<stamp>/, .kindly/backups/<stamp>/, etc.
  - --to <N> where N is a history index (run \`kindly history\` to list them).
    The oldest entry is #1; indexes are stable across history rotations.

Usage:
  kindly rollback <snapshot-dir> [--dry-run] [--no-safety-snapshot]
                                 [--label <text>] [--mount <path>]
                                 [--accept-code-exec]
  kindly rollback --to <N>       [--dry-run] [--no-safety-snapshot]
                                 [--label <text>] [--mount <path>]
                                 [--accept-code-exec]

Options:
  --to <N>              resolve snapshot from history entry #N
  --dry-run             list what would be restored; don't write
  --no-safety-snapshot  skip the pre-rollback backup of current state
                        (default: safety snapshot is ON — saved to
                         .kindly/pre-rollback/<stamp>/)
  --label <text>        advisory name logged into kindly history
  --mount <path>        point at a specific Kindle mount
  --accept-code-exec    consent to KOReader interpolating snapshot values
                        into os.execute / os.remove / shell calls
                        (SSH_port, httpinspector_port, cover_image_path)

\`--to <N>\` works for apply, setup:import, and prior rollback entries.
restore entries point you at the archive (\`kindly restore <path>\`); snapshot
and setup:export don't modify the device so there's nothing to undo.

This is different from \`kindly restore\`: restore extracts a whole-tree
v0.2 snapshot tarball; rollback handles the finer-grained per-mutation
safety net produced by setup import / apply.
`.trim();
