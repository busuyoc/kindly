// Unit tests for the history append-only writer.
//
// Scope: the writer module itself (src/history/writer.ts). Not concerned
// with command-level wiring — that's covered by tests/cli/historyEmit.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendHistoryEntry, historyPath, type HistoryEntry } from "../../src/history/writer.ts";

import pkg from "../../package.json" with { type: "json" };

function makeEnv(cwd: string, iso: string) {
    return { cwd, now: () => new Date(iso) };
}

function readJsonlEntries(path: string): HistoryEntry[] {
    const raw = readFileSync(path, "utf8");
    return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-hist-"));
});

describe("appendHistoryEntry — file layout", () => {
    test("creates .kindly/history.jsonl under cwd", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 3 });

        const p = historyPath(workdir);
        expect(p).toBe(join(workdir, ".kindly", "history.jsonl"));
        expect(existsSync(p)).toBe(true);
    });

    test("creates .kindly/ if missing", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        expect(existsSync(join(workdir, ".kindly"))).toBe(false);

        appendHistoryEntry(env, "snapshot", { archive_path: "/tmp/foo.tar.gz" });
        expect(existsSync(join(workdir, ".kindly"))).toBe(true);
    });
});

describe("appendHistoryEntry — entry shape", () => {
    test("emits JSON object per line with trailing newline", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 2 });

        const raw = readFileSync(historyPath(workdir), "utf8");
        expect(raw.endsWith("\n")).toBe(true);
        const lines = raw.split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(1);
        const parsed = JSON.parse(lines[0]!);
        expect(parsed.cmd).toBe("apply");
        expect(parsed.ts).toBe("2026-04-22T12:00:00.000Z");
        expect(parsed.kindly_version).toBe(pkg.version);
        expect(parsed.summary).toEqual({ settings_delta_n: 2 });
    });

    test("label included when provided, absent when not", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        appendHistoryEntry(env, "apply", { settings_delta_n: 1 }, { label: "before-experiment" });

        const entries = readJsonlEntries(historyPath(workdir));
        expect(entries[0]!.label).toBeUndefined();
        expect(entries[1]!.label).toBe("before-experiment");
    });

    test("summary skips undefined fields", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", {
            settings_delta_n: 5,
            backup_path: undefined,
        });

        const entry = readJsonlEntries(historyPath(workdir))[0]!;
        expect(Object.keys(entry.summary)).toEqual(["settings_delta_n"]);
    });

    test("returns the entry it wrote", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        const entry = appendHistoryEntry(env, "rollback", {
            snapshot_dir: "/tmp/snap",
            pre_rollback_path: "/tmp/pre",
        });
        expect(entry.cmd).toBe("rollback");
        expect(entry.summary.snapshot_dir).toBe("/tmp/snap");
    });
});

describe("appendHistoryEntry — append semantics", () => {
    test("two calls produce two lines, newest last", () => {
        const env1 = makeEnv(workdir, "2026-04-22T12:00:00Z");
        const env2 = makeEnv(workdir, "2026-04-22T12:05:00Z");

        appendHistoryEntry(env1, "snapshot", { archive_path: "/tmp/a.tgz" });
        appendHistoryEntry(env2, "apply",    { settings_delta_n: 1 });

        const entries = readJsonlEntries(historyPath(workdir));
        expect(entries.length).toBe(2);
        expect(entries[0]!.cmd).toBe("snapshot");
        expect(entries[1]!.cmd).toBe("apply");
        expect(entries[0]!.ts < entries[1]!.ts).toBe(true);
    });

    test("never overwrites — file grows monotonically", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        const sizeA = statSync(historyPath(workdir)).size;

        appendHistoryEntry(env, "apply", { settings_delta_n: 2 });
        const sizeB = statSync(historyPath(workdir)).size;

        expect(sizeB).toBeGreaterThan(sizeA);
    });

    test("supports every HistoryCommand discriminator", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply",        { settings_delta_n: 1 });
        appendHistoryEntry(env, "snapshot",     {});
        appendHistoryEntry(env, "restore",      {});
        appendHistoryEntry(env, "rollback",     {});
        appendHistoryEntry(env, "setup:import", {});
        appendHistoryEntry(env, "setup:export", {});

        const entries = readJsonlEntries(historyPath(workdir));
        expect(entries.map((e) => e.cmd)).toEqual([
            "apply", "snapshot", "restore", "rollback", "setup:import", "setup:export",
        ]);
    });
});

describe("appendHistoryEntry — atomic-rename durability (C3/S1421)", () => {
    test("never leaves a sibling .tmp file after a successful append", () => {
        const env = makeEnv(workdir, "2026-04-25T12:00:00Z");
        for (let i = 0; i < 10; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: i });
        }
        const dir = join(workdir, ".kindly");
        const leftovers = readdirSync(dir).filter((n) => n.startsWith("history.jsonl.tmp."));
        expect(leftovers).toEqual([]);
    });

    test("each append leaves the file in a fully-parseable state (no torn lines)", () => {
        const env = makeEnv(workdir, "2026-04-25T12:00:00Z");
        // Write a 200-entry file so the body crosses PIPE_BUF (4096 darwin/linux).
        for (let i = 0; i < 200; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: i });
        }
        const raw = readFileSync(historyPath(workdir), "utf8");
        const lines = raw.split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(200);
        // Every line must parse cleanly — torn writes would surface as a
        // JSON.parse throw partway through.
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
    });
});
