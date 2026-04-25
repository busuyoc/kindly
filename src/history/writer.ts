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
//   - index           1-based monotonic counter. Stable across rotation —
//                   the same entry keeps its number even after it moves to
//                   .kindly/history-archive/YYYY-MM.jsonl (W17).
//   - summary         command-specific fields — flat bag, JSON-stringify drops
//                    undefined so each cmd only populates what applies
//
// Durability (C3/S1421): write the full updated active file to a per-PID
// tmp + fsync + atomic rename. The earlier `openSync(a) + writeSync +
// fsync` was POSIX-atomic only for sub-PIPE_BUF writes (4096 Linux, 512
// darwin); Angle CC measured 99.97% torn reads at 200 KB on darwin. The
// rename-based pipeline is sub-millisecond at our file sizes (≤ 500 lines
// × ~1 KB) and gives readers either the pre-write or post-write state, no
// torn-line state.
//
// Rotation (W17): once the active file holds HISTORY_ROTATION_THRESHOLD
// entries, the NEXT append moves the existing entries into
// .kindly/history-archive/<YYYY-MM>.jsonl (bucketed by each entry's own ts)
// and the active file is truncated to empty. The new entry is then the
// only one in the active file. Indexes continue monotonically — the new
// entry's index is (last-archived-index + 1).
//
// Rotation is NOT atomic. If the process dies between `appendFileSync`
// on the archive and `writeFileSync("")` on the active file, the entire
// batch (up to HISTORY_ROTATION_THRESHOLD entries) ends up in both
// places — and repeated crashes at the same point COMPOUND, so a run
// of N failures produces N copies of the batch in the archive. The
// reader handles this by preferring active over archive in
// `findHistoryEntryByIndex` and by deduping on `index` in
// `countAllHistory` / `iterateAllEntries` consumers, so correctness is
// preserved; only the archive file grows. We don't try harder (e.g.,
// staging file + rename) because kindly is a single-user desktop tool
// and a mid-rotation crash is vanishingly rare on macOS.
//
// Concurrency: assumes ONE writer per cwd. Two `kindly apply` processes
// racing on the same working directory would interleave appends; the
// JSONL format stays well-formed line-by-line, but index collisions are
// possible if both read `active` at the same offset. Kindle workflows
// are single-user — we don't guard against this. A file lock would be
// the fix if we ever grow a parallel harness.
//
// Non-op / dry-run: we do NOT log those. "mutation" means the device or
// user-state actually changed. apply mode="no-op"/"dry-run" → no entry.

import {
    appendFileSync,
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    renameSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";

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
    /** 1-based monotonic counter; stable across rotation. Present on all
     *  entries emitted by W17 onward. Pre-W17 files may omit it — readers
     *  fall back to line position. */
    index: number;
    summary: HistorySummary;
}

export const HISTORY_ROTATION_THRESHOLD = 500;

export function historyPath(cwd: string): string {
    return join(cwd, ".kindly", "history.jsonl");
}

export function historyArchiveDir(cwd: string): string {
    return join(cwd, ".kindly", "history-archive");
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
    const p = historyPath(env.cwd);
    mkdirSync(dirname(p), { recursive: true });

    // Read existing active entries to decide (a) the next index and (b)
    // whether rotation should fire before this write. A crash-partial last
    // line is tolerated by try-parse — same rule as the W15 reader.
    const active = readActiveRaw(p);
    let nextIndex = highestIndexOf(active) + 1;
    if (nextIndex === 1) {
        // Active is empty or has only malformed lines. Continue from the
        // highest index seen in archive files, if any.
        nextIndex = highestArchivedIndex(env.cwd) + 1;
    }

    if (active.length >= HISTORY_ROTATION_THRESHOLD) {
        rotateActive(env.cwd, p, active);
    }

    const entry: HistoryEntry = {
        ts: env.now().toISOString(),
        cmd,
        ...(opts?.label ? { label: opts.label } : {}),
        kindly_version: pkg.version,
        index: nextIndex,
        summary,
    };
    const line = JSON.stringify(entry) + "\n";

    // C3/S1421: rather than openSync("a") + writeSync (atomic only for
    // sub-PIPE_BUF), serialize the full active body and rename a tmp into
    // place. After rotation `active` holds the previously-read entries
    // (skipped if rotation just emptied it); append the new line and write
    // atomically. Rename gives readers either the pre- or post-write state.
    const remainingActive = active.length >= HISTORY_ROTATION_THRESHOLD ? [] : active;
    const body = remainingActive.map((e) => JSON.stringify(e) + "\n").join("") + line;
    const tmp = p + ".tmp." + process.pid + "." + randomBytes(4).toString("hex");
    const fd = openSync(tmp, "wx");
    try {
        writeSync(fd, body);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, p);
    return entry;
}

// Read the active file and return every well-formed entry. Malformed lines
// (partial last write after a crash) are silently dropped — they're the
// reader's concern to count, not the writer's.
function readActiveRaw(path: string): HistoryEntry[] {
    if (!exists(path, "derived-from-cwd")) return [];
    const raw = readText(path, "derived-from-cwd");
    const entries: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        try {
            entries.push(JSON.parse(line) as HistoryEntry);
        } catch {
            /* skip */
        }
    }
    return entries;
}

function highestIndexOf(entries: HistoryEntry[]): number {
    let max = 0;
    for (const e of entries) {
        if (typeof e.index === "number" && e.index > max) max = e.index;
    }
    return max;
}

function highestArchivedIndex(cwd: string): number {
    const dir = historyArchiveDir(cwd);
    if (!exists(dir, "derived-from-cwd")) return 0;
    let max = 0;
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const raw = readText(join(dir, f), "derived-from-cwd");
        for (const line of raw.split("\n")) {
            if (line.length === 0) continue;
            try {
                const parsed = JSON.parse(line) as HistoryEntry;
                if (typeof parsed.index === "number" && parsed.index > max) {
                    max = parsed.index;
                }
            } catch {
                /* skip */
            }
        }
    }
    return max;
}

// Move all entries out of the active file into per-month archives. Each
// entry is bucketed by its own `ts` month (YYYY-MM), so if a rotation
// spans a month boundary the archives split cleanly. Archive files are
// append-only — a second rotation within the same month adds to the
// existing file.
function rotateActive(cwd: string, activePath: string, entries: HistoryEntry[]): void {
    const archiveDir = historyArchiveDir(cwd);
    mkdirSync(archiveDir, { recursive: true });

    const byMonth = new Map<string, HistoryEntry[]>();
    for (const e of entries) {
        const month = monthKey(e.ts);
        const bucket = byMonth.get(month);
        if (bucket) bucket.push(e);
        else byMonth.set(month, [e]);
    }
    for (const [month, items] of byMonth) {
        const out = join(archiveDir, `${month}.jsonl`);
        const content = items.map((e) => JSON.stringify(e) + "\n").join("");
        appendFileSync(out, content);
    }
    writeFileSync(activePath, "");
}

function monthKey(ts: string): string {
    // ISO 8601 starts with "YYYY-MM" — no parsing needed.
    return ts.slice(0, 7);
}
