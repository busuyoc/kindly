// `kindly history` — list mutations from .kindly/history.jsonl.
//
// Coverage:
//   - empty / missing file → friendly message, exit 0
//   - --limit truncates, --since filters
//   - reverse-chronological display (newest first), index counts oldest=1
//   - partial last line (crash mid-write) is tolerated, malformed counted
//   - --json envelope shape
//   - bad --limit / --since → ArgError exit 2

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { historyPath } from "../../src/history/writer.ts";

function makeEnv(cwd: string, opts?: { jsonMode?: boolean }): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd, stdout: out, stderr: err, color: false,
            now: () => new Date("2026-04-22T12:00:00Z"),
            ...(opts?.jsonMode ? { jsonMode: true } : {}),
        },
        out, err,
    };
}

// Seed history.jsonl with the given entries (oldest first as written).
function seedHistory(cwd: string, lines: string[]): void {
    mkdirSync(join(cwd, ".kindly"), { recursive: true });
    writeFileSync(historyPath(cwd), lines.map((l) => l + "\n").join(""));
}

function makeEntry(opts: {
    ts: string; cmd: string; label?: string; settings_delta_n?: number;
}): string {
    const summary: Record<string, unknown> = {};
    if (opts.settings_delta_n !== undefined) summary.settings_delta_n = opts.settings_delta_n;
    return JSON.stringify({
        ts: opts.ts,
        cmd: opts.cmd,
        ...(opts.label ? { label: opts.label } : {}),
        kindly_version: "0.3.0",
        summary,
    });
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-hcmd-"));
});

describe("history — empty / missing", () => {
    test("missing .kindly/ → friendly message, exit 0", async () => {
        const { env, out } = makeEnv(workdir);
        const code = await main(["history"], env);
        expect(code).toBe(0);
        expect(out.value).toMatch(/no history yet/i);
    });

    test("file exists but empty → same friendly message", async () => {
        seedHistory(workdir, []);
        const { env, out } = makeEnv(workdir);
        const code = await main(["history"], env);
        expect(code).toBe(0);
        expect(out.value).toMatch(/no history yet/i);
    });
});

describe("history — display", () => {
    test("default shows newest first with index counted from oldest", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-22T12:00:00.000Z", cmd: "apply",    settings_delta_n: 1 }),
            makeEntry({ ts: "2026-04-22T12:05:00.000Z", cmd: "snapshot" }),
            makeEntry({ ts: "2026-04-22T12:10:00.000Z", cmd: "apply",    settings_delta_n: 3, label: "experiment" }),
        ]);

        const { env, out } = makeEnv(workdir);
        await main(["history"], env);

        const lines = out.value.split("\n").filter((l) => l.startsWith("#"));
        expect(lines.length).toBe(3);
        // Newest first → #3 on top.
        expect(lines[0]).toContain("#3");
        expect(lines[0]).toContain("apply");
        expect(lines[0]).toContain("experiment");
        expect(lines[2]).toContain("#1");
    });

    test("--limit N caps display, footer mentions hidden entries", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-22T12:00:00.000Z", cmd: "apply", settings_delta_n: 1 }),
            makeEntry({ ts: "2026-04-22T12:05:00.000Z", cmd: "apply", settings_delta_n: 2 }),
            makeEntry({ ts: "2026-04-22T12:10:00.000Z", cmd: "apply", settings_delta_n: 3 }),
        ]);

        const { env, out } = makeEnv(workdir);
        await main(["history", "--limit", "2"], env);

        const indexLines = out.value.split("\n").filter((l) => l.startsWith("#"));
        expect(indexLines.length).toBe(2);
        expect(indexLines[0]).toContain("#3");
        expect(indexLines[1]).toContain("#2");
        expect(out.value).toMatch(/1 older entry not shown/);
    });

    test("--limit 0 means unlimited", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-22T12:00:00.000Z", cmd: "apply", settings_delta_n: 1 }),
            makeEntry({ ts: "2026-04-22T12:05:00.000Z", cmd: "apply", settings_delta_n: 2 }),
        ]);

        const { env, out } = makeEnv(workdir);
        await main(["history", "--limit", "0"], env);

        const indexLines = out.value.split("\n").filter((l) => l.startsWith("#"));
        expect(indexLines.length).toBe(2);
        expect(out.value).not.toMatch(/older entr/);
    });

    test("--since filters out earlier entries", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-21T10:00:00.000Z", cmd: "apply", settings_delta_n: 1 }),
            makeEntry({ ts: "2026-04-22T11:00:00.000Z", cmd: "apply", settings_delta_n: 2 }),
            makeEntry({ ts: "2026-04-22T13:00:00.000Z", cmd: "apply", settings_delta_n: 3 }),
        ]);

        const { env, out } = makeEnv(workdir);
        await main(["history", "--since", "2026-04-22T12:00:00Z"], env);

        const indexLines = out.value.split("\n").filter((l) => l.startsWith("#"));
        expect(indexLines.length).toBe(1);
        expect(indexLines[0]).toContain("#3");
    });

    test("--since matches everything → 'no entries since' message", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-22T11:00:00.000Z", cmd: "apply", settings_delta_n: 1 }),
        ]);

        const { env, out } = makeEnv(workdir);
        await main(["history", "--since", "2026-04-23T00:00:00Z"], env);

        expect(out.value).toMatch(/no entries since 2026-04-23/);
    });
});

describe("history — crash recovery", () => {
    test("partial last line is dropped, valid lines still shown, footer counts it", async () => {
        const goodA = makeEntry({ ts: "2026-04-22T12:00:00.000Z", cmd: "apply", settings_delta_n: 1 });
        const goodB = makeEntry({ ts: "2026-04-22T12:05:00.000Z", cmd: "snapshot" });
        const partial = '{"ts":"2026-04-22T12:10:00.000Z","cmd":"apply"';
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        writeFileSync(historyPath(workdir), goodA + "\n" + goodB + "\n" + partial);

        const { env, out } = makeEnv(workdir);
        const code = await main(["history"], env);
        expect(code).toBe(0);

        const indexLines = out.value.split("\n").filter((l) => l.startsWith("#"));
        expect(indexLines.length).toBe(2);
        expect(out.value).toMatch(/skipped 1 malformed line/i);
    });
});

describe("history — --json envelope", () => {
    test("emits HistoryResult inside the standard envelope", async () => {
        seedHistory(workdir, [
            makeEntry({ ts: "2026-04-22T12:00:00.000Z", cmd: "apply", settings_delta_n: 1 }),
            makeEntry({ ts: "2026-04-22T12:05:00.000Z", cmd: "apply", settings_delta_n: 2, label: "second" }),
        ]);

        const { env, out } = makeEnv(workdir);
        const code = await main(["history", "--json"], env);
        expect(code).toBe(0);

        const env_ = JSON.parse(out.value);
        expect(env_.$schema_version).toBe(1);
        expect(env_.command).toBe("history");
        expect(env_.status).toBe("ok");

        expect(env_.data.total).toBe(2);
        expect(env_.data.matched).toBe(2);
        expect(env_.data.malformed).toBe(0);
        expect(env_.data.limit).toBe(20);
        // Newest first.
        expect(env_.data.entries[0].index).toBe(2);
        expect(env_.data.entries[0].label).toBe("second");
        expect(env_.data.entries[1].index).toBe(1);
    });
});

describe("history — argument validation", () => {
    test("--limit non-integer → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "--limit", "abc"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/limit/i);
    });

    test("--limit negative → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "--limit", "-3"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/limit/i);
    });

    test("--since not parseable → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "--since", "yesterday"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/since/i);
    });

    test("unexpected positional → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "extra"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/unexpected/i);
    });
});
