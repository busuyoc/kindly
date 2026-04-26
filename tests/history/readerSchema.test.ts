// S1101 — `kindly history` reader Zod-validates each JSONL entry, so an
// attacker who can inject lines into `.kindly/history.jsonl` can't smuggle
// invented `cmd` values or extra `summary` fields into the audit log. Bad
// lines fall into the malformed bucket alongside JSON-parse failures.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHistoryFile, iterateAllEntries } from "../../src/history/reader.ts";

let workdir: string;
const ts = "2026-04-26T12:00:00.000Z";

function writeHistory(lines: object[]): string {
    const dir = join(workdir, ".kindly");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "history.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
}

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-hist-schema-"));
});

describe("history reader — S1101 schema validation", () => {
    test("invented cmd value → entry counted as malformed, dropped", () => {
        // `setup:promote` is not a real command in v0.13. A future kindly
        // version may add it; until then, refuse.
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            { ts, cmd: "setup:promote", kindly_version: "0.13.0", index: 2, summary: {} },
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 3, summary: {} },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(1);
        expect(r.total).toBe(2);
        expect(r.entries.map((e) => e.index)).toEqual([3, 1]);
    });

    test("missing required field (summary) → entry dropped", () => {
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 2 },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(1);
        expect(r.total).toBe(1);
    });

    test("type-confused summary (settings_delta_n is a string) → dropped", () => {
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: { settings_delta_n: "many" } },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(1);
        expect(r.total).toBe(0);
    });

    test("unknown summary field → dropped (strict mode)", () => {
        // An attacker writes a forward-looking field hoping a future kindly
        // version will pick it up. Reject at read time.
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1,
              summary: { promotion_target: "/etc/passwd" } },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(1);
        expect(r.total).toBe(0);
    });

    test("unknown top-level entry field → dropped", () => {
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {},
              hijack: "rm -rf /" },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(1);
        expect(r.total).toBe(0);
    });

    test("malformed JSON and schema-invalid both count toward malformed", () => {
        const dir = join(workdir, ".kindly");
        mkdirSync(dir, { recursive: true });
        const p = join(dir, "history.jsonl");
        const good = JSON.stringify({ ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} });
        const badJson = "{not-valid-json";
        const badSchema = JSON.stringify({ ts, cmd: "haXXor", kindly_version: "x", index: 2, summary: {} });
        writeFileSync(p, [good, badJson, badSchema].join("\n") + "\n");

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(2);
        expect(r.total).toBe(1);
    });

    test("iterateAllEntries also rejects schema-invalid lines", () => {
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            { ts, cmd: "fake", kindly_version: "x", summary: {} },
            { ts, cmd: "snapshot", kindly_version: "0.13.0", index: 2, summary: {} },
        ]);

        const got = [...iterateAllEntries(workdir)];
        expect(got.map((e) => e.index)).toEqual([1, 2]);
    });

    test("legitimate pre-W17 entry without index → still accepted", () => {
        // Backwards-compat: index is optional. A pre-W17 entry has all the
        // other required fields and must round-trip.
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.10.0", summary: { settings_delta_n: 3 } },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(0);
        expect(r.total).toBe(1);
        expect(r.entries[0]!.index).toBe(1);
    });

    test("legitimate pre-C10a entry without mount → still accepted", () => {
        writeHistory([
            { ts, cmd: "apply", kindly_version: "0.11.0", index: 1, summary: {} },
        ]);

        const r = readHistoryFile({ cwd: workdir });
        expect(r.malformed).toBe(0);
        expect(r.total).toBe(1);
        expect(r.entries[0]!.mount).toBeUndefined();
    });

    // Round 3 history-rendering F3 (S362 sibling): ts must be ISO-8601.
    // Forged ts could poison `since` lex-filter or render as terminal-
    // injection bait. monthKey already enforces a regex on the slice;
    // make the schema match so all consumers see the same shape.
    describe("ts format validation (F3)", () => {
        test("non-ISO ts → entry dropped as malformed", () => {
            writeHistory([
                { ts, cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
                { ts: "not-a-real-timestamp", cmd: "apply", kindly_version: "0.13.0", index: 2, summary: {} },
                { ts, cmd: "apply", kindly_version: "0.13.0", index: 3, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(2);
            expect(r.entries.map((e) => e.index)).toEqual([3, 1]);
        });

        test("ts with traversal segment (`../../`) → dropped (S362 sibling)", () => {
            writeHistory([
                { ts: "../../../etc/passwd", cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });

        test("ts missing milliseconds (legacy variant) → dropped", () => {
            // toISOString always emits .sssZ; missing the millis is forged.
            writeHistory([
                { ts: "2026-04-26T12:00:00Z", cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });

        test("ts with trailing terminal-injection bytes → dropped", () => {
            writeHistory([
                { ts: "2026-04-26T12:00:00.000Z]0;pwn",
                  cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("legitimate ISO ts variants are accepted", () => {
            writeHistory([
                { ts: "2026-04-26T12:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
                { ts: "1999-12-31T23:59:59.999Z", cmd: "apply", kindly_version: "0.13.0", index: 2, summary: {} },
                { ts: "0000-01-01T00:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 3, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(0);
            expect(r.total).toBe(3);
        });

        // Round-3 follow-up (live probe 2026-04-26): a forged ts with the
        // right *digit count* but impossible wall-clock values
        // ("19:99:99.999Z") was accepted by the original digit-count-only
        // regex. Defense-in-depth held downstream (monthKey re-validates
        // the slice; renderer sanitizes; lex-compare is consistent), but
        // the entry rendering as a "valid" row was misleading. Tightened
        // to enforce semantic bounds.
        test("ts with impossible hour/min/sec values is rejected", () => {
            writeHistory([
                { ts: "2026-04-26T19:99:99.999Z", cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
                { ts: "2026-04-26T24:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 2, summary: {} },
                { ts: "2026-04-26T12:60:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 3, summary: {} },
                { ts: "2026-04-26T12:00:60.000Z", cmd: "apply", kindly_version: "0.13.0", index: 4, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(4);
            expect(r.total).toBe(0);
        });

        test("ts with impossible month/day values is rejected", () => {
            writeHistory([
                { ts: "2026-13-01T12:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 1, summary: {} },
                { ts: "2026-00-01T12:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 2, summary: {} },
                { ts: "2026-04-32T12:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 3, summary: {} },
                { ts: "2026-04-00T12:00:00.000Z", cmd: "apply", kindly_version: "0.13.0", index: 4, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(4);
            expect(r.total).toBe(0);
        });
    });

    // Round-3 history-rendering F4: read-time length caps on entry/summary
    // string fields. A forged entry with a 10MB label or kindly_version
    // would otherwise flow through `kindly history --json` as-is and
    // flood downstream consumers' stdout. Cap-violations now drop into
    // the malformed bucket alongside other schema rejections.
    describe("F4 — entry field length caps", () => {
        test("oversized label (>240 bytes) → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "apply", kindly_version: "0.13.0", index: 1,
                    label: "a".repeat(241), summary: {},
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });

        test("label at exact 240-byte cap is accepted", () => {
            writeHistory([
                {
                    ts, cmd: "apply", kindly_version: "0.13.0", index: 1,
                    label: "a".repeat(240), summary: {},
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(0);
            expect(r.total).toBe(1);
        });

        test("oversized kindly_version (>64 bytes) → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "apply", kindly_version: "0.13.0-" + "x".repeat(70),
                    index: 1, summary: {},
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("oversized backup_path (>8 KiB) → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "apply", kindly_version: "0.13.0", index: 1,
                    summary: { backup_path: "/" + "a".repeat(9000) },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("realistic path lengths (< 8 KiB) are accepted", () => {
            writeHistory([
                {
                    ts, cmd: "apply", kindly_version: "0.13.0", index: 1,
                    summary: {
                        backup_path: "/Users/x/proj/.kindly/backups/2026-04-26T12-00-00-000Z-abc/settings.reader.lua",
                        pre_import_path: "/Users/x/proj/.kindly/pre-import/2026-04-26T12-00-00-000Z-def",
                    },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(0);
            expect(r.total).toBe(1);
        });
    });

    // Round-3 history-rendering F5: setup_id has a fixed shape (12-byte
    // shortId, lowercase hex) at the writer side, but the schema accepted
    // any string. A forged entry with `setup_id: "../etc/passwd]0;..."`
    // would otherwise render raw in `history show`. Constrain to the
    // actual format.
    describe("F5 — setup_id shape", () => {
        test("setup_id with non-hex chars → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "setup:export", kindly_version: "0.13.0", index: 1,
                    summary: { setup_id: "../../../etc" },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("setup_id with uppercase hex → dropped", () => {
            // Writer emits lowercase only; uppercase is a forgery signal.
            writeHistory([
                {
                    ts, cmd: "setup:export", kindly_version: "0.13.0", index: 1,
                    summary: { setup_id: "ABCDEF012345" },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("setup_id of wrong length (< 12 chars) → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "setup:export", kindly_version: "0.13.0", index: 1,
                    summary: { setup_id: "abc" },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("setup_id of wrong length (> 12 chars) → dropped", () => {
            writeHistory([
                {
                    ts, cmd: "setup:export", kindly_version: "0.13.0", index: 1,
                    summary: { setup_id: "abcdef0123456" },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
        });

        test("legitimate 12-hex setup_id is accepted", () => {
            writeHistory([
                {
                    ts, cmd: "setup:export", kindly_version: "0.13.0", index: 1,
                    summary: { setup_id: "abcdef012345" },
                },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(0);
            expect(r.total).toBe(1);
        });
    });

    // Round-3 follow-up (live probe 2026-04-26): index must be a
    // non-negative safe integer. JSON parses literal
    // `99999999999999999999` to the f64 1e20 which sits past
    // MAX_SAFE_INTEGER; the writer's increment then rounds to the same
    // value, collapsing index monotonicity. Bounding at the schema lets
    // forged entries fall to the malformed bucket so `kindly history`
    // and `rollback --to N` keep their ordering invariants.
    describe("index bounds (f64 precision-loss defense)", () => {
        test("index past MAX_SAFE_INTEGER (1e20) → dropped", () => {
            const dir = join(workdir, ".kindly");
            mkdirSync(dir, { recursive: true });
            const p = join(dir, "history.jsonl");
            // Hand-write the line so JSON.parse coerces the literal to
            // f64 1e20; JSON.stringify({index: 1e20}) would emit the
            // exponential form, and either still > MAX_SAFE_INTEGER.
            const line = `{"ts":"${ts}","cmd":"apply","kindly_version":"0.13.0","index":99999999999999999999,"summary":{}}`;
            writeFileSync(p, line + "\n");
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });

        test("index at exact MAX_SAFE_INTEGER is accepted", () => {
            writeHistory([
                { ts, cmd: "apply", kindly_version: "0.13.0",
                  index: Number.MAX_SAFE_INTEGER, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(0);
            expect(r.total).toBe(1);
            expect(r.entries[0]!.index).toBe(Number.MAX_SAFE_INTEGER);
        });

        test("negative index → dropped", () => {
            writeHistory([
                { ts, cmd: "apply", kindly_version: "0.13.0", index: -1, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });

        test("fractional index → dropped", () => {
            writeHistory([
                { ts, cmd: "apply", kindly_version: "0.13.0", index: 1.5, summary: {} },
            ]);
            const r = readHistoryFile({ cwd: workdir });
            expect(r.malformed).toBe(1);
            expect(r.total).toBe(0);
        });
    });
});
