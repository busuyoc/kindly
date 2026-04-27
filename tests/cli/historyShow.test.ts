// `kindly history show <N>` — detail view of one mutation with a
// reconstructed settings diff.
//
// Coverage:
//   - bad args (no N, non-integer, 0, negative, extra positional)
//   - unknown N (empty history + out-of-range w/ valid-range hint)
//   - snapshot / setup:export / restore → "no settings pre-state"
//   - apply with missing backup file → diffUnavailable
//   - apply with no later mutation → "most recent" note, no diff
//   - apply → setup:import → diff reconstructed across cmds
//   - removed keys between two pre-states surface as `removed`
//   - --json envelope shape (entry + diff fields)
//   - diff groups by taxonomy

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { historyPath } from "../../src/history/writer.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

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

function seedHistory(cwd: string, entries: unknown[]): void {
    mkdirSync(join(cwd, ".kindly"), { recursive: true });
    writeFileSync(historyPath(cwd), entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

function writeLua(path: string, table: Record<string, string | number | boolean>): void {
    mkdirSync(join(path, ".."), { recursive: true });
    const lines = ["return {"];
    for (const [k, v] of Object.entries(table)) {
        const rendered = typeof v === "string" ? JSON.stringify(v) : String(v);
        lines.push(`    [${JSON.stringify(k)}] = ${rendered},`);
    }
    lines.push("}");
    lines.push("");
    writeFileSync(path, lines.join("\n"));
}

function writeLuaTable(path: string, table: LuaTable): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, dumpSettingsFile(table, "./settings.reader.lua"));
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-hshow-"));
});

describe("history show — argument validation", () => {
    test("no N → usage exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/usage/i);
    });

    test("non-integer N → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show", "abc"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/positive integer/i);
    });

    test("N = 0 → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show", "0"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/positive integer/i);
    });

    test("extra positional → exit 2", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show", "1", "extra"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/unexpected/i);
    });
});

describe("history show — lookup failures", () => {
    test("empty history → friendly exit 1", async () => {
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no history yet/i);
    });

    test("N out of range → cites valid range", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1 } },
        ]);
        const { env, err } = makeEnv(workdir);
        const code = await main(["history", "show", "9"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no history entry #9/);
        expect(err.value).toMatch(/1\.\.1/);
    });
});

describe("history show — entries without a settings pre-state", () => {
    test("snapshot → diffUnavailable, no diff block", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "snapshot", kindly_version: "0.3.0",
              index: 1, summary: { archive_path: "/out.tgz" } },
        ]);
        const { env, out } = makeEnv(workdir);
        const code = await main(["history", "show", "1"], env);
        expect(code).toBe(0);
        expect(out.value).toMatch(/#1/);
        expect(out.value).toMatch(/snapshot/);
        expect(out.value).toMatch(/does not capture a settings pre-state/);
    });

    test("setup:export → diffUnavailable", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "setup:export", kindly_version: "0.3.0",
              index: 1, summary: { output_path: "/x.kset", setup_id: "abcdef012345" } },
        ]);
        const { env, out } = makeEnv(workdir);
        await main(["history", "show", "1"], env);
        expect(out.value).toMatch(/does not capture a settings pre-state/);
    });

    test("restore → diffUnavailable (pre_restore_path is a tarball, not diffable here)", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "restore", kindly_version: "0.3.0",
              index: 1, summary: { archive_path: "/in.tgz", pre_restore_path: "/tmp/pre.tgz" } },
        ]);
        const { env, out } = makeEnv(workdir);
        await main(["history", "show", "1"], env);
        expect(out.value).toMatch(/does not capture a settings pre-state/);
    });
});

describe("history show — apply without usable pre-state", () => {
    test("apply with missing backup_path → diffUnavailable notes no recorded path", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1 } },
        ]);
        const { env, out } = makeEnv(workdir);
        await main(["history", "show", "1"], env);
        expect(out.value).toMatch(/no recorded pre-state/);
    });

    test("apply with backup_path that's gone from disk → diffUnavailable", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1, backup_path: "/does/not/exist.lua" } },
        ]);
        const { env, out } = makeEnv(workdir);
        await main(["history", "show", "1"], env);
        expect(out.value).toMatch(/pre-state file no longer on disk/);
    });

    test("apply with pre-state but no later mutation → most-recent note", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { night_mode: false });
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1, backup_path: backupA } },
        ]);
        const { env, out } = makeEnv(workdir);
        const code = await main(["history", "show", "1"], env);
        expect(code).toBe(0);
        expect(out.value).toMatch(/most recent settings change/);
    });
});

describe("history show — reconstructed diff", () => {
    test("two applies: diff of #1 captures keys that changed between the two pre-states", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { night_mode: false, home_dir: "/mnt/books" });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLua(backupB, { night_mode: true, home_dir: "/mnt/books" });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1, backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { settings_delta_n: 1, backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        const code = await main(["history", "show", "1", "--json"], env);
        expect(code).toBe(0);
        const env_ = JSON.parse(out.value);
        expect(env_.data.diff.toIndex).toBe(2);
        const keys = env_.data.diff.changes.map((c: { path: string[] }) => c.path.join("."));
        expect(keys).toContain("night_mode");
        expect(keys).not.toContain("home_dir");
    });

    test("apply → setup:import: diff crosses cmd kinds", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { night_mode: false });
        const preImport = join(workdir, ".kindly", "pre-import", "b");
        writeLua(join(preImport, "settings.reader.lua"), { night_mode: true });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { settings_delta_n: 1, backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "setup:import", kindly_version: "0.3.0",
              index: 2, summary: { settings_delta_n: 1, pre_import_path: preImport, setup_id: "abcdef012345" } },
        ]);
        const { env, out } = makeEnv(workdir);
        await main(["history", "show", "1"], env);
        expect(out.value).toMatch(/changes between #1 and #2/);
    });

    test("keys removed between pre-states are reported as removed", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { obsolete: "gone", keep: "stays" });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLua(backupB, { keep: "stays" });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        await main(["history", "show", "1", "--json"], env);
        const env_ = JSON.parse(out.value);
        const kinds = env_.data.diff.changes.map((c: { kind: string }) => c.kind);
        expect(kinds).toContain("removed");
    });
});

describe("history show — --json envelope", () => {
    test("emits HistoryShowResult inside the standard envelope", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { night_mode: false });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLua(backupB, { night_mode: true });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        const code = await main(["history", "show", "1", "--json"], env);
        expect(code).toBe(0);
        const env_ = JSON.parse(out.value);
        expect(env_.$schema_version).toBe(1);
        expect(env_.command).toBe("history:show");
        expect(env_.status).toBe("ok");
        expect(env_.data.entry.index).toBe(1);
        expect(env_.data.entry.cmd).toBe("apply");
        expect(env_.data.diff.toIndex).toBe(2);
        expect(env_.data.diff.fromPath).toBe(backupA);
        expect(env_.data.diff.toPath).toBe(backupB);
        expect(Array.isArray(env_.data.diff.changes)).toBe(true);
        expect(typeof env_.data.diff.grouped).toBe("object");
    });

    test("--json for a snapshot entry: entry present, diff absent, diffUnavailable set", async () => {
        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "snapshot", kindly_version: "0.3.0",
              index: 1, summary: { archive_path: "/out.tgz" } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        await main(["history", "show", "1", "--json"], env);
        const env_ = JSON.parse(out.value);
        expect(env_.data.diff).toBeUndefined();
        expect(env_.data.diffUnavailable).toMatch(/does not capture/);
    });
});

describe("history show — robustness", () => {
    test("removed keys emit EXACTLY ONE change each (no spurious changed→undefined)", async () => {
        // Regression guard: the pre-fix code wrapped the "after" record in
        // a synthesized object that explicitly set removed keys to
        // undefined, which slipped through computeChanges as "changed" —
        // then the manual loop also pushed "removed", duplicating the
        // entry. One `removed` per key, zero `changed` for those keys.
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLua(backupA, { gone_a: "x", gone_b: 9, keep: true });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLua(backupB, { keep: true });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        await main(["history", "show", "1", "--json"], env);
        const payload = JSON.parse(out.value);
        const changes = payload.data.diff.changes as Array<{ kind: string; path: string[] }>;

        const forGoneA = changes.filter((c) => c.path.join(".") === "gone_a");
        const forGoneB = changes.filter((c) => c.path.join(".") === "gone_b");
        expect(forGoneA.length).toBe(1);
        expect(forGoneA[0]!.kind).toBe("removed");
        expect(forGoneB.length).toBe(1);
        expect(forGoneB[0]!.kind).toBe("removed");
    });

    test("non-object pre-state (e.g. scalar return) → diffUnavailable", async () => {
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        mkdirSync(join(backupA, ".."), { recursive: true });
        writeFileSync(backupA, "return 42\n");
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLua(backupB, { x: 1 });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        const code = await main(["history", "show", "1", "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(out.value);
        expect(payload.data.diff).toBeUndefined();
        expect(payload.data.diffUnavailable).toMatch(/did not parse to a settings table/);
    });

    test("S2027: removed nested-secret subtree must not leak via diff payload", async () => {
        // Round-5 S2027 closure: when a nested table holding secrets
        // (e.g. kosync.userkey) is removed between two backups, the
        // pre-fix code emitted a `removed` Change whose `prev` carried
        // the full subtree — secret values reached the JSON envelope.
        // Fix: filterForYaml(before, "full") strips secrets BEFORE
        // diffing, so they never enter the diff payload.
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLuaTable(backupA, {
            kosync: { userkey: "SUPER_SECRET_VALUE_2027", username: "alice" },
            home_dir: "/mnt/books",
        });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLuaTable(backupB, { home_dir: "/mnt/books" });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        await main(["history", "show", "1", "--json"], env);
        expect(out.value).not.toContain("SUPER_SECRET_VALUE_2027");
    });

    test("S2027: removed top-level secret key must not leak via diff payload", async () => {
        // Even a top-level exfil=secret key (e.g. device_id) being
        // removed between snapshots must not leak through history show.
        const backupA = join(workdir, ".kindly", "backups", "a", "settings.reader.lua");
        writeLuaTable(backupA, {
            device_id: "DEVICE_ID_SECRET_2027",
            home_dir: "/mnt/books",
        });
        const backupB = join(workdir, ".kindly", "backups", "b", "settings.reader.lua");
        writeLuaTable(backupB, { home_dir: "/mnt/books" });

        seedHistory(workdir, [
            { ts: "2026-04-22T12:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 1, summary: { backup_path: backupA } },
            { ts: "2026-04-22T12:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              index: 2, summary: { backup_path: backupB } },
        ]);
        const { env, out } = makeEnv(workdir, { jsonMode: true });
        await main(["history", "show", "1", "--json"], env);
        expect(out.value).not.toContain("DEVICE_ID_SECRET_2027");
    });
});
