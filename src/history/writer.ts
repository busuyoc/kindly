// `.kindly/history.jsonl` — append-only log of mutating commands.
//
// Every mutation kindly performs (apply, setup import, setup export, snapshot,
// restore, rollback) adds one line here. W15's `kindly history` reads the log
// back; W16's `rollback --to <N>` resolves a numeric ref against it; the
// future GUI (W29 watch mode) streams new lines as they're appended.
//
// Shape: one JSON object per line, newest last. Fields:
//   - ts              ISO 8601 UTC
//   - cmd             "apply" | "snapshot" | "restore" | "rollback"
//                   | "setup:import" | "setup:export"
//   - label?          W14 user-provided name (advisory; collisions allowed)
//   - kindly_version  package.json version at emit time
//   - summary         command-specific fields — flat bag, JSON-stringify drops
//                    undefined so each cmd only populates what applies
//
// Durability: open(a), write, fsync, close. A crash mid-write either leaves
// the entry committed (fsync returned) or the last line partial. W15's reader
// tolerates the partial-last-line case.
//
// Non-op / dry-run: we do NOT log those. "mutation" means the device or
// user-state actually changed. apply mode="no-op"/"dry-run" → no entry.

import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import pkg from "../../package.json" with { type: "json" };

export type HistoryCommand =
    | "apply"
    | "snapshot"
    | "restore"
    | "rollback"
    | "setup:import"
    | "setup:export";

export interface HistorySummary {
    /** # of settings keys changed (apply, setup:import). */
    settings_delta_n?: number;
    /** Plugin installs/skips and the count of `plugins.disabled` entries written. */
    plugins_delta?: {
        installed_files?: number;
        installed_patches?: number;
        skipped_files?: number;
        skipped_patches?: number;
        disabled_count?: number;
    };
    /** Pre-write backup inside .kindly/backups (apply). */
    backup_path?: string;
    /** Pre-import snapshot dir inside .kindly/pre-import (setup:import). */
    pre_import_path?: string;
    /** Pre-restore archive inside .kindly/pre-restore (restore). */
    pre_restore_path?: string;
    /** Pre-rollback snapshot dir inside .kindly/pre-rollback (rollback). */
    pre_rollback_path?: string;
    /** Archive path — snapshot output or restore input. */
    archive_path?: string;
    /** Output path for setup:export. */
    output_path?: string;
    /** Setup id (12-hex short hash) for setup:import / setup:export. */
    setup_id?: string;
    /** Source snapshot dir for rollback. */
    snapshot_dir?: string;
}

export interface HistoryEntry {
    ts: string;
    cmd: HistoryCommand;
    label?: string;
    kindly_version: string;
    summary: HistorySummary;
}

export function historyPath(cwd: string): string {
    return join(cwd, ".kindly", "history.jsonl");
}

interface AppendEnv {
    cwd: string;
    now: () => Date;
}

// Append one line. Throws on I/O failure — if .kindly isn't writable, the
// mutation that just succeeded has no durable audit trail, and we want that
// surfaced rather than silently swallowed.
export function appendHistoryEntry(
    env: AppendEnv,
    cmd: HistoryCommand,
    summary: HistorySummary,
    opts?: { label?: string },
): HistoryEntry {
    const entry: HistoryEntry = {
        ts: env.now().toISOString(),
        cmd,
        ...(opts?.label ? { label: opts.label } : {}),
        kindly_version: pkg.version,
        summary,
    };
    const p = historyPath(env.cwd);
    mkdirSync(dirname(p), { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    const fd = openSync(p, "a");
    try {
        writeSync(fd, line);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    return entry;
}
