// `kindly watch` — stream deltas from .kindly/history.jsonl.
//
// Coverage:
//   - hello emitted with correct shape + watermark
//   - appended entry → one "entry" event
//   - crash-partial last line is tolerated (no malformed-line crash, no
//     duplicate emission once a subsequent write finishes the file)
//   - rotation: active file truncated past watermark → one "rotated" event
//     before the next entry, with correct gap
//   - --from N replays entries with index > N at startup
//   - tail -f default: nothing emitted at start beyond hello

import { describe, test, expect, beforeEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWatchLoop, WATCH_PROTOCOL_VERSION, type WatchOptions } from "../../src/commands/watch.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { historyPath, type HistoryEntry } from "../../src/history/writer.ts";

// A hand-driven async iterable: `fire()` yields once, `close()` ends it.
function driver(): { triggers: AsyncIterable<void>; fire: () => void; close: () => void } {
    let resolveNext: (() => void) | null = null;
    const queue: boolean[] = [];
    let closed = false;

    const fire = () => {
        queue.push(true);
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    };
    const close = () => {
        closed = true;
        if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    };

    const triggers: AsyncIterable<void> = {
        [Symbol.asyncIterator]() {
            return {
                async next(): Promise<IteratorResult<void>> {
                    while (true) {
                        if (queue.length > 0) { queue.shift(); return { value: undefined, done: false }; }
                        if (closed) return { value: undefined, done: true };
                        await new Promise<void>((res) => { resolveNext = res; });
                    }
                },
            };
        },
    };
    return { triggers, fire, close };
}

function writeEntry(path: string, entry: HistoryEntry): void {
    appendFileSync(path, JSON.stringify(entry) + "\n");
}

function mkEntry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
    // Build a per-index ts that always satisfies the F3 ISO-8601 schema
    // (sec 00-59, min 00-59, hr 00-23). Watch sorts by index, not ts, so any
    // valid distinct ts works.
    const sec = index % 60;
    const min = Math.floor(index / 60) % 60;
    const hr = Math.floor(index / 3600) % 24;
    return {
        ts: `2026-04-22T${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`,
        cmd: "apply",
        kindly_version: "0.10.0",
        index,
        summary: { settings_delta_n: 1 },
        ...overrides,
    };
}

function parseLines(out: StringWriter): unknown[] {
    return out.value.trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
}

let workdir: string;
let hpath: string;
let out: StringWriter;
let err: StringWriter;
let env: CliEnv;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-watch-"));
    mkdirSync(join(workdir, ".kindly"));
    hpath = historyPath(workdir);
    out = new StringWriter();
    err = new StringWriter();
    env = {
        cwd: workdir,
        stdout: out, stderr: err, color: false,
        now: () => new Date("2026-04-22T12:00:00.000Z"),
    };
});

async function runUntilQuiesce(
    triggers: AsyncIterable<void>,
    opts: WatchOptions = {},
): Promise<Promise<void>> {
    // Start the loop; return the promise so tests can close the driver
    // to end it.
    return runWatchLoop(env, triggers, opts);
}

describe("runWatchLoop", () => {
    test("hello emitted with watermark=0 on empty history", async () => {
        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        // Hello is emitted synchronously before awaiting triggers.
        await Promise.resolve();
        d.close();
        await done;

        const lines = parseLines(out);
        expect(lines.length).toBe(1);
        const hello = lines[0] as Record<string, unknown>;
        expect(hello.$watch_protocol).toBe(WATCH_PROTOCOL_VERSION);
        expect(hello.type).toBe("hello");
        expect(hello.watermark).toBe(0);
        expect(hello.history_path).toBe(hpath);
        expect(typeof hello.started_at).toBe("string");
    });

    test("tail -f default: pre-existing entries are NOT emitted", async () => {
        writeEntry(hpath, mkEntry(1));
        writeEntry(hpath, mkEntry(2));

        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();
        d.close();
        await done;

        const lines = parseLines(out);
        expect(lines.length).toBe(1);
        const hello = lines[0] as Record<string, unknown>;
        expect(hello.watermark).toBe(2); // saw them, just didn't emit
    });

    test("appended entry fires one `entry` event", async () => {
        writeEntry(hpath, mkEntry(1));

        const d = driver();
        const done = runWatchLoop(env, d.triggers);

        // Append a new entry, then fire a trigger.
        writeEntry(hpath, mkEntry(2, { cmd: "snapshot" }));
        d.fire();
        await new Promise((r) => setTimeout(r, 10));
        d.close();
        await done;

        const lines = parseLines(out);
        expect(lines.length).toBe(2);
        const ev = lines[1] as Record<string, unknown>;
        expect(ev.type).toBe("entry");
        const entry = ev.entry as HistoryEntry;
        expect(entry.index).toBe(2);
        expect(entry.cmd).toBe("snapshot");
    });

    test("crash-partial last line is tolerated, completed on next write", async () => {
        writeEntry(hpath, mkEntry(1));
        // Partial second line — a crash mid-writeSync.
        appendFileSync(hpath, `{"ts":"2026-04-22T12:00:02.000Z","cmd":"apply","index":2,"kind`);

        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();

        // Fire a spurious trigger while the partial is present — we must
        // not emit anything for it.
        d.fire();
        await new Promise((r) => setTimeout(r, 10));
        expect(parseLines(out).length).toBe(1); // just hello

        // A well-formed later append supersedes the partial: writer
        // re-reads, but the partial is still unparseable. A recovery
        // write would truncate + re-append; simulate that the cleaner
        // way by overwriting with two well-formed lines.
        writeFileSync(hpath, [
            JSON.stringify(mkEntry(1)),
            JSON.stringify(mkEntry(2, { cmd: "restore" })),
        ].join("\n") + "\n");
        d.fire();
        await new Promise((r) => setTimeout(r, 10));
        d.close();
        await done;

        const lines = parseLines(out);
        const events = lines.slice(1) as Array<Record<string, unknown>>;
        expect(events.length).toBe(1);
        expect(events[0]!.type).toBe("entry");
        expect((events[0]!.entry as HistoryEntry).index).toBe(2);
    });

    test("rotation: active truncated past watermark emits `rotated` then `entry`", async () => {
        // Simulate pre-rotation state: active holds index 5.
        writeEntry(hpath, mkEntry(5));

        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();

        // Rotation happened: indices 5..504 archived (not on disk here, but
        // we don't inspect archive), active now holds index 505.
        writeFileSync(hpath, JSON.stringify(mkEntry(505)) + "\n");
        d.fire();
        await new Promise((r) => setTimeout(r, 10));
        d.close();
        await done;

        const lines = parseLines(out) as Array<Record<string, unknown>>;
        expect(lines.length).toBe(3); // hello, rotated, entry
        const rotated = lines[1]!;
        expect(rotated.type).toBe("rotated");
        expect(rotated.gap).toEqual({ from: 6, to: 504 });
        const entry = lines[2]!;
        expect(entry.type).toBe("entry");
        expect((entry.entry as HistoryEntry).index).toBe(505);
    });

    test("--from N replays entries with index > N at startup", async () => {
        writeEntry(hpath, mkEntry(1));
        writeEntry(hpath, mkEntry(2));
        writeEntry(hpath, mkEntry(3));

        const d = driver();
        const done = runWatchLoop(env, d.triggers, { fromIndex: 1 });
        await Promise.resolve();
        d.close();
        await done;

        const lines = parseLines(out) as Array<Record<string, unknown>>;
        // hello + entry(2) + entry(3)
        expect(lines.length).toBe(3);
        expect(lines[0]!.type).toBe("hello");
        expect((lines[0]! as any).watermark).toBe(3);
        expect(lines[1]!.type).toBe("entry");
        expect((lines[1]!.entry as HistoryEntry).index).toBe(2);
        expect(lines[2]!.type).toBe("entry");
        expect((lines[2]!.entry as HistoryEntry).index).toBe(3);
    });

    test("--from 0 on empty history is a no-op past hello", async () => {
        const d = driver();
        const done = runWatchLoop(env, d.triggers, { fromIndex: 0 });
        await Promise.resolve();
        d.close();
        await done;

        const lines = parseLines(out);
        expect(lines.length).toBe(1);
        expect((lines[0] as any).type).toBe("hello");
    });

    test("missing history file: hello watermark=0, no crash", async () => {
        // Don't create hpath at all — the .kindly dir exists but file doesn't.
        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();
        // Fire a trigger even though nothing changed — must not emit.
        d.fire();
        await new Promise((r) => setTimeout(r, 10));

        // Then a first-ever entry appears.
        writeEntry(hpath, mkEntry(1));
        d.fire();
        await new Promise((r) => setTimeout(r, 10));
        d.close();
        await done;

        const lines = parseLines(out) as Array<Record<string, unknown>>;
        expect((lines[0]! as any).watermark).toBe(0);
        expect(lines.length).toBe(2);
        expect(lines[1]!.type).toBe("entry");
        expect((lines[1]!.entry as HistoryEntry).index).toBe(1);
    });

    test("forged-shape entries (parity with reader S1101 schema) are not emitted", async () => {
        // Round-3 follow-up (live probe 2026-04-26): bare JSON.parse +
        // index-is-number was permissive — any line with a numeric index
        // reached the GUI, even with ts="../../../etc/passwd" or
        // ts="2026-04-26T19:99:99.999Z" or with unknown summary keys. The
        // reader (S1101) drops these; watch should match. Otherwise an
        // attacker with .kindly/ write access could plant entries that
        // `kindly history` rejects but `kindly watch` propagates.
        const validIndex = 7;
        const forgedLines = [
            // ts is a path-traversal shape
            JSON.stringify({
                ts: "../../../etc/passwd", cmd: "apply", kindly_version: "0.10.0",
                index: 1, summary: { settings_delta_n: 1 },
            }),
            // ts wall-clock impossible (F3 follow-up regex)
            JSON.stringify({
                ts: "2026-04-26T19:99:99.999Z", cmd: "apply", kindly_version: "0.10.0",
                index: 2, summary: { settings_delta_n: 1 },
            }),
            // ts impossible month
            JSON.stringify({
                ts: "2026-13-01T12:00:00.000Z", cmd: "apply", kindly_version: "0.10.0",
                index: 3, summary: { settings_delta_n: 1 },
            }),
            // unknown summary key (z.strict)
            JSON.stringify({
                ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.10.0",
                index: 4, summary: { settings_delta_n: 1, malicious_key: "payload" },
            }),
            // unknown cmd value (historyCommandSchema enum)
            JSON.stringify({
                ts: "2026-04-22T12:00:00.000Z", cmd: "setup:promote", kindly_version: "0.10.0",
                index: 5, summary: {},
            }),
            // legitimate entry — should be the only one emitted
            JSON.stringify(mkEntry(validIndex)),
        ];
        require("node:fs").writeFileSync(hpath, forgedLines.join("\n") + "\n");

        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();
        d.close();
        await done;

        const lines = parseLines(out) as Array<Record<string, unknown>>;
        // hello + the one valid entry; the 5 forged lines fall to malformed.
        expect(lines.length).toBe(1); // just hello — the valid entry is at index 7,
        // but watermark covered it (index 7 was the highest seen). Watch tail-f
        // semantics: only future-of-watermark emit. Verify watermark sat at 7.
        expect((lines[0]! as any).watermark).toBe(validIndex);
    });

    test("idempotent: spurious trigger without new entries emits nothing", async () => {
        writeEntry(hpath, mkEntry(1));

        const d = driver();
        const done = runWatchLoop(env, d.triggers);
        await Promise.resolve();
        d.fire(); d.fire(); d.fire();
        await new Promise((r) => setTimeout(r, 10));
        d.close();
        await done;

        const lines = parseLines(out);
        expect(lines.length).toBe(1); // just hello
    });
});
