// Read `.kindly/history.jsonl` for `kindly history`, `rollback --to <N>`,
// and the future GUI watch mode.
//
// Tolerates two failure modes the writer can produce:
//   1. Crash mid-write → last line is partial JSON. Drop it.
//   2. File doesn't exist yet → first invocation, return empty.
//
// Numeric index: each entry carries its own monotonic `index` field (W17).
// For pre-W17 entries that lack the field, we fall back to line position
// (1-based, counted from the oldest entry in the file). The index is the
// stable handle `rollback --to N` (W16) resolves against, and remains the
// same even after an entry moves into `.kindly/history-archive/`.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";

import {
    historyArchiveDir,
    historyPath,
    type HistoryEntry,
} from "./writer.ts";

export interface HistoryEntryWithIndex extends HistoryEntry {
    /** 1-based, oldest = 1. Stable handle for `rollback --to N`. */
    index: number;
}

export interface ReadHistoryOptions {
    cwd: string;
    /** ISO timestamp; entries with ts < since are excluded. */
    since?: string;
    /** After filtering + reversing, keep only the first N (the most recent). */
    limit?: number;
}

export interface HistoryReadResult {
    /** Filtered + truncated entries from the active file, newest first. */
    entries: HistoryEntryWithIndex[];
    /** Number of entries that matched filters before `limit` truncation. */
    matched: number;
    /** Total parsed entries in the active file (malformed lines excluded). */
    total: number;
    /** Number of malformed lines skipped. Usually 0; ≥1 means crash recovery. */
    malformed: number;
    /** Absolute path to the active history file (whether it exists or not). */
    path: string;
    /** True iff `.kindly/history-archive/` exists with at least one .jsonl file. */
    hasArchives: boolean;
}

export function readHistoryFile(opts: ReadHistoryOptions): HistoryReadResult {
    const path = historyPath(opts.cwd);
    const hasArchives = hasAnyArchives(opts.cwd);

    if (!exists(path, "derived-from-cwd")) {
        return { entries: [], matched: 0, total: 0, malformed: 0, path, hasArchives };
    }

    const raw = readText(path, "derived-from-cwd");
    const lines = raw.split("\n");

    // A clean append leaves a trailing "\n" → split's last element is "".
    // A crash mid-write leaves a partial JSON object as the last element.
    // Both look the same to the parser: try-parse each, drop on failure.
    const entries: HistoryEntryWithIndex[] = [];
    let malformed = 0;
    for (const line of lines) {
        if (line.length === 0) continue;
        try {
            const parsed = JSON.parse(line) as HistoryEntry;
            const idx = typeof parsed.index === "number"
                ? parsed.index
                : entries.length + 1;
            entries.push({ ...parsed, index: idx });
        } catch {
            malformed++;
        }
    }
    const total = entries.length;

    let filtered = entries;
    if (opts.since) {
        filtered = filtered.filter((e) => e.ts >= opts.since!);
    }
    const matched = filtered.length;

    const reversed = filtered.slice().reverse();
    const limited = opts.limit !== undefined && opts.limit >= 0
        ? reversed.slice(0, opts.limit)
        : reversed;

    return { entries: limited, matched, total, malformed, path, hasArchives };
}

// Look up one entry by its monotonic `index`, searching the active file
// first and then archives (newest month first so the common case — a
// recent entry just rotated — returns quickly). Returns null when no
// entry with that index exists anywhere. Active-first ordering also
// naturally handles the rotation crash window (W17): if the same entry
// appears in both active and archive (archive-append succeeded, truncate
// didn't), we return the active copy and ignore the archive duplicate.
export function findHistoryEntryByIndex(
    cwd: string,
    index: number,
): HistoryEntryWithIndex | null {
    for (const e of iterateAllEntries(cwd)) {
        if (e.index === index) return e;
    }
    return null;
}

// Total entries across active + archives (well-formed only). Used for
// range-error messages in rollback --to. Dedupes by `index` so a
// rotation-crash duplicate doesn't inflate the count.
export function countAllHistory(cwd: string): number {
    const seen = new Set<number>();
    for (const e of iterateAllEntries(cwd)) seen.add(e.index);
    return seen.size;
}

// Iterate every well-formed entry across active + archives. Order:
// active (oldest → newest), then archives newest-month-first (matching
// findHistoryEntryByIndex's search order). Callers that need dedupe
// should track seen indexes — archive files may contain duplicates of
// active entries if a rotation crashed between archive-append and
// active-truncate.
export function* iterateAllEntries(
    cwd: string,
): Generator<HistoryEntryWithIndex> {
    yield* parseEntriesFromFile(historyPath(cwd));

    const dir = historyArchiveDir(cwd);
    if (!exists(dir, "derived-from-cwd")) return;
    const archives = readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
    for (const f of archives) {
        yield* parseEntriesFromFile(join(dir, f));
    }
}

function hasAnyArchives(cwd: string): boolean {
    const dir = historyArchiveDir(cwd);
    if (!exists(dir, "derived-from-cwd")) return false;
    return readdirSync(dir).some((f) => f.endsWith(".jsonl"));
}

function* parseEntriesFromFile(
    path: string,
): Generator<HistoryEntryWithIndex> {
    if (!exists(path, "derived-from-cwd")) return;
    const raw = readText(path, "derived-from-cwd");
    let positional = 0;
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        positional++;
        try {
            const parsed = JSON.parse(line) as HistoryEntry;
            const idx = typeof parsed.index === "number" ? parsed.index : positional;
            yield { ...parsed, index: idx };
        } catch {
            /* skip malformed */
        }
    }
}
