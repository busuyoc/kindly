// Read `.kindly/history.jsonl` for `kindly history`, `rollback --to <N>`,
// and the future GUI watch mode.
//
// Tolerates two failure modes the writer can produce:
//   1. Crash mid-write → last line is partial JSON. Drop it.
//   2. File doesn't exist yet → first invocation, return empty.
//
// Numeric index: each entry gets a 1-based `index` field counted from the
// OLDEST entry in the file. This is the stable handle `rollback --to 5`
// (W16) will resolve against; it's stable across rotations because rotation
// (W17) keeps the active file's indexing intact.

import { existsSync, readFileSync } from "node:fs";

import { historyPath, type HistoryEntry } from "./writer.ts";

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
    /** Filtered + truncated entries, newest first. */
    entries: HistoryEntryWithIndex[];
    /** Number of entries that matched filters before `limit` truncation. */
    matched: number;
    /** Total parsed entries in the file (malformed lines excluded). */
    total: number;
    /** Number of malformed lines skipped. Usually 0; ≥1 means crash recovery. */
    malformed: number;
    /** Absolute path to the history file (whether it exists or not). */
    path: string;
}

export function readHistoryFile(opts: ReadHistoryOptions): HistoryReadResult {
    const path = historyPath(opts.cwd);

    if (!existsSync(path)) {
        return { entries: [], matched: 0, total: 0, malformed: 0, path };
    }

    const raw = readFileSync(path, "utf8");
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
            entries.push({ ...parsed, index: entries.length + 1 });
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

    // Reverse-chronological display.
    const reversed = filtered.slice().reverse();
    const limited = opts.limit !== undefined && opts.limit >= 0
        ? reversed.slice(0, opts.limit)
        : reversed;

    return { entries: limited, matched, total, malformed, path };
}
