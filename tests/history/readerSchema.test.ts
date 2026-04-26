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
});
