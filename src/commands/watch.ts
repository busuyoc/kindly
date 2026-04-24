// `kindly watch` — long-running stream of `.kindly/history.jsonl` deltas.
//
// The GUI (or any automation) spawns `kindly watch` once; we emit one JSON
// line per new history entry. Unlike `serve`, this is push-only: no stdin
// protocol, just a stream on stdout.
//
// Wire protocol ($watch_protocol = 1):
//
//   stdout, on start:
//     {"$watch_protocol":1,"type":"hello","kindly_version":"...",
//      "history_path":"/abs/path","watermark":N,"started_at":"<ISO>"}
//
//   stdout, per new entry:
//     {"$watch_protocol":1,"type":"entry","entry":{...HistoryEntryWithIndex}}
//
//   stdout, when the active file was truncated past our watermark:
//     {"$watch_protocol":1,"type":"rotated","gap":{"from":A,"to":B}}
//
// `watermark` in hello = highest `index` currently in the active file at
// start. Tail -f semantics: the stream only emits entries appended AFTER
// watch starts. A GUI that needs the prior log calls `kindly history --json`
// first, then `watch` for deltas.
//
// Crash recovery: pass `--from N` to replay entries with index > N at
// startup. Useful if the GUI was offline and wants to catch up without
// invoking `history`.
//
// Rotation (W17): the active file is truncated when it reaches
// HISTORY_ROTATION_THRESHOLD entries. Old entries move to
// .kindly/history-archive/<YYYY-MM>.jsonl; indexes remain monotonic. We
// detect a rotation when the smallest index in the active file is greater
// than lastSeen + 1 and emit a single `rotated` event with the gap. The
// new entry itself is then emitted normally.
//
// Crash-partial lines: readActiveRaw silently drops them (same rule as the
// writer). A partial last line gets retried on the next change event —
// either the next append completes it (become a well-formed entry we
// emit), or a second crash appended another partial (we keep dropping
// until something parseable lands).

import { watch as fsWatch } from "node:fs";
import { dirname } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { historyPath, type HistoryEntry } from "../history/writer.ts";

import pkg from "../../package.json" with { type: "json" };
const KINDLY_VERSION: string = pkg.version;

export const WATCH_PROTOCOL_VERSION = 1;

const FLAGS = {
    from: {
        type: "string",
        description: "replay entries with index greater than this value at startup",
    },
    json: { type: "boolean", description: "(no-op; watch is always JSON)" },
} as const satisfies FlagSpecs;

export interface WatchOptions {
    /** Replay entries with index > fromIndex at startup. Default: skip all. */
    fromIndex?: number;
}

export const watchHelp = `
kindly watch — stream history deltas over stdout.

usage: kindly watch [--from N]

Writes one line of JSON per new mutation appended to .kindly/history.jsonl.
Runs until stdin closes or the process is killed. --json is implicit — every
line is machine-readable.

Options:
  --from N     at startup, replay any entries with index > N (crash recovery).
               Default: only future entries (tail -f semantics).

Protocol ($watch_protocol = 1):

  Hello (once on start):
    {"$watch_protocol":1,"type":"hello","kindly_version":"...",
     "history_path":"...","watermark":N,"started_at":"<ISO>"}

  Entry (per new line appended):
    {"$watch_protocol":1,"type":"entry","entry":{...}}

  Rotation (active file truncated past our position):
    {"$watch_protocol":1,"type":"rotated","gap":{"from":A,"to":B}}
`.trim();

// ── Testable core ─────────────────────────────────────────────────────────

type WatchEvent =
    | { $watch_protocol: 1; type: "hello"; kindly_version: string; history_path: string; watermark: number; started_at: string }
    | { $watch_protocol: 1; type: "entry"; entry: HistoryEntry }
    | { $watch_protocol: 1; type: "rotated"; gap: { from: number; to: number } };

function emit(env: CliEnv, ev: WatchEvent): void {
    env.stdout.write(JSON.stringify(ev) + "\n");
}

function readActive(path: string): HistoryEntry[] {
    if (!exists(path, "derived-from-cwd")) return [];
    const raw = readText(path, "derived-from-cwd");
    const out: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        try {
            const parsed = JSON.parse(line) as HistoryEntry;
            if (typeof parsed.index === "number") out.push(parsed);
        } catch { /* partial-last or otherwise malformed, skip */ }
    }
    return out;
}

function highestIndex(entries: HistoryEntry[]): number {
    let max = 0;
    for (const e of entries) if (e.index > max) max = e.index;
    return max;
}

function minIndex(entries: HistoryEntry[]): number {
    if (entries.length === 0) return 0;
    let min = entries[0]!.index;
    for (const e of entries) if (e.index < min) min = e.index;
    return min;
}

/** Scan once and emit any new events. Returns updated lastSeen.
 *
 *  Callers should invoke this on every filesystem change notification, plus
 *  once at startup (after hello) to flush anything already present above the
 *  watermark (e.g., --from replay). */
export function scanOnce(env: CliEnv, path: string, lastSeen: number): number {
    const entries = readActive(path);
    if (entries.length === 0) return lastSeen;

    // Rotation detection: the smallest index in active skips past lastSeen.
    // This means the entries between lastSeen+1 and min-1 were archived.
    // lastSeen === 0 means "never saw anything" — no rotation to report.
    const oldest = minIndex(entries);
    if (lastSeen > 0 && oldest > lastSeen + 1) {
        emit(env, {
            $watch_protocol: WATCH_PROTOCOL_VERSION,
            type: "rotated",
            gap: { from: lastSeen + 1, to: oldest - 1 },
        });
    }

    let cursor = lastSeen;
    const sorted = entries.slice().sort((a, b) => a.index - b.index);
    for (const e of sorted) {
        if (e.index <= cursor) continue;
        emit(env, { $watch_protocol: WATCH_PROTOCOL_VERSION, type: "entry", entry: e });
        cursor = e.index;
    }
    return cursor;
}

/** Read and run. `triggers` yields once per filesystem event (or a tick);
 *  every yield triggers a rescan. Returns when `triggers` is exhausted. */
export async function runWatchLoop(
    env: CliEnv,
    triggers: AsyncIterable<void>,
    opts: WatchOptions = {},
): Promise<void> {
    const path = historyPath(env.cwd);

    // Watermark: highest index currently in active at start. Setting
    // lastSeen to the watermark means we emit nothing from before — tail -f.
    // --from overrides with a caller-supplied baseline (crash recovery).
    const initial = readActive(path);
    const watermark = highestIndex(initial);
    let lastSeen = opts.fromIndex !== undefined ? opts.fromIndex : watermark;

    emit(env, {
        $watch_protocol: WATCH_PROTOCOL_VERSION,
        type: "hello",
        kindly_version: KINDLY_VERSION,
        history_path: path,
        watermark,
        started_at: env.now().toISOString(),
    });

    // --from replay: if the caller asked for everything after N, flush
    // matching entries before waiting on the first event.
    if (opts.fromIndex !== undefined && opts.fromIndex < watermark) {
        lastSeen = scanOnce(env, path, lastSeen);
    }

    for await (const _ of triggers) {
        lastSeen = scanOnce(env, path, lastSeen);
    }
}

// ── Production wrapper ────────────────────────────────────────────────────

function parseFromIndex(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new ArgError(`--from expects a non-negative integer (got: ${raw})`);
    }
    return n;
}

/** An async iterable that yields once for every fs.watch event on the
 *  .kindly/ directory, filtered to history.jsonl. We watch the directory
 *  (not the file) so first-ever writes — when the file doesn't exist yet —
 *  still trigger. Closes when stdin ends. */
async function* fsWatchTriggers(cwd: string): AsyncGenerator<void> {
    const dir = dirname(historyPath(cwd));
    const file = "history.jsonl";
    let resolveNext: (() => void) | null = null;
    let pending = false;
    let closed = false;

    const watcher = exists(dir, "derived-from-cwd") ? fsWatch(dir, (_ev, name) => {
        if (name !== null && name !== file) return;
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
        else pending = true;
    }) : null;

    const onStdinEnd = () => {
        closed = true;
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    };
    process.stdin.on("end", onStdinEnd);
    process.stdin.on("close", onStdinEnd);
    process.stdin.resume();

    try {
        while (!closed) {
            if (pending) { pending = false; yield; continue; }
            await new Promise<void>((res) => { resolveNext = res; });
            if (closed) break;
            yield;
        }
    } finally {
        if (watcher) watcher.close();
        process.stdin.removeListener("end", onStdinEnd);
        process.stdin.removeListener("close", onStdinEnd);
        process.stdin.pause();
    }
}

export async function runWatch(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    if (positional.length > 0) {
        throw new ArgError(`watch takes no positional arguments (got: ${positional.join(" ")})`);
    }
    const opts: WatchOptions = {};
    if (flags.from !== undefined) opts.fromIndex = parseFromIndex(flags.from);

    await runWatchLoop(env, fsWatchTriggers(env.cwd), opts);
    return 0;
}
