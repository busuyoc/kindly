// Tests for --KINDLY_TRACE opt-in invocation trace.
//
// The contract these tests lock in:
//   - Off by default (env.trace undefined/false → no .kindly/trace.jsonl written)
//   - When env.trace=true, every invocation appends exactly one JSONL line
//   - Entry shape: {ts, cmd, argv_hash, duration_ms, exit_code, warnings_n}
//   - argv is hashed, never stored raw (no secret leakage)
//   - Same argv → same hash (determinism)
//   - Error paths still write a trace entry with the right exit_code
//   - Rotation: when active file ≥10MB, it's moved to trace-archive/

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
    statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import {
    hashArgv, writeTraceEntry, TRACE_ROTATE_BYTES,
} from "../../src/cli/trace.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

function readTrace(dir: string): Array<Record<string, unknown>> {
    const file = join(dir, ".kindly", "trace.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({ avoid_flashing_ui: true });
    workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
    env = {
        cwd: workdir,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("trace: off by default", () => {
    test("no .kindly/trace.jsonl created when env.trace is unset", async () => {
        await main(["pull"], env);
        expect(existsSync(join(workdir, ".kindly", "trace.jsonl"))).toBe(false);
    });

    test("no trace written even on successful --json invocation", async () => {
        await main(["pull", "--json"], env);
        expect(existsSync(join(workdir, ".kindly", "trace.jsonl"))).toBe(false);
    });
});

describe("trace: enabled", () => {
    beforeEach(() => { env = { ...env, trace: true }; });

    test("successful pull writes exactly one entry", async () => {
        const code = await main(["pull"], env);
        expect(code).toBe(0);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(1);

        const e = entries[0]!;
        expect(e.ts).toBe("2026-04-22T12:00:00.000Z");
        expect(e.cmd).toBe("pull");
        expect(typeof e.argv_hash).toBe("string");
        expect((e.argv_hash as string).length).toBe(12);
        expect(typeof e.duration_ms).toBe("number");
        expect(e.exit_code).toBe(0);
        expect(e.warnings_n).toBe(0);
    });

    test("each invocation appends a new line", async () => {
        await main(["pull"], env);
        await main(["diff"], env);
        await main(["diff"], env);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(3);
        expect(entries.map((e) => e.cmd)).toEqual(["pull", "diff", "diff"]);
    });

    test("error path still writes a trace entry with non-zero exit_code", async () => {
        // diff before pull → YAML_NOT_FOUND, exit 1
        const code = await main(["diff"], env);
        expect(code).toBe(1);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.cmd).toBe("diff");
        expect(entries[0]!.exit_code).toBe(1);
    });

    test("ArgError writes a trace entry with exit_code 2", async () => {
        const code = await main(["pull", "--bogus"], env);
        expect(code).toBe(2);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.exit_code).toBe(2);
    });

    test("unknown command writes a trace entry", async () => {
        const code = await main(["nonexistent"], env);
        expect(code).toBe(2);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.cmd).toBe("nonexistent");
    });

    test("--help and --version are also traced", async () => {
        await main(["--help"], env);
        await main(["--version"], env);

        const entries = readTrace(workdir);
        expect(entries).toHaveLength(2);
        expect(entries.map((e) => e.cmd)).toEqual(["--help", "--version"]);
        expect(entries.every((e) => e.exit_code === 0)).toBe(true);
    });
});

describe("hashArgv: secret-safe", () => {
    test("deterministic: same argv → same hash", () => {
        expect(hashArgv(["pull", "--json"])).toBe(hashArgv(["pull", "--json"]));
    });

    test("different argv → different hash", () => {
        expect(hashArgv(["pull"])).not.toBe(hashArgv(["diff"]));
        expect(hashArgv(["pull", "--json"])).not.toBe(hashArgv(["pull"]));
    });

    test("raw argv never appears in the hash output", () => {
        const secret = "sk-live-thisisaverysecrettokendonotleak";
        const hash = hashArgv(["login", "--token", secret]);
        expect(hash).not.toContain(secret);
        expect(hash).not.toContain("sk-live");
    });

    test("hash is 12 hex chars", () => {
        const hash = hashArgv(["pull"]);
        expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe("trace: secret-free end-to-end", () => {
    beforeEach(() => { env = { ...env, trace: true }; });

    test("argv values like tokens never appear in the trace file", async () => {
        // --mount takes a path that could theoretically leak a sensitive
        // filesystem layout. We hash argv, so the raw path is not in the file.
        await main(["pull", "--mount", "/Users/alice/secret-kindle-backup"], env);
        const raw = readFileSync(join(workdir, ".kindly", "trace.jsonl"), "utf8");
        expect(raw).not.toContain("/Users/alice");
        expect(raw).not.toContain("secret-kindle-backup");
    });
});

describe("trace: rotation", () => {
    test("active file at ≥10MB is renamed into trace-archive/ before the next write", () => {
        const dir = join(workdir, ".kindly");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "trace.jsonl");
        // Seed a file that just crosses the rotation threshold.
        writeFileSync(file, "x".repeat(TRACE_ROTATE_BYTES));
        expect(statSync(file).size).toBe(TRACE_ROTATE_BYTES);

        writeTraceEntry(env, {
            ts: "2026-04-22T12:00:00.000Z",
            cmd: "pull",
            argv_hash: "abc123def456",
            duration_ms: 10,
            exit_code: 0,
            warnings_n: 0,
        });

        // Archive dir exists and has exactly one file (the rotated-out one).
        const archive = join(dir, "trace-archive");
        expect(existsSync(archive)).toBe(true);
        const archived = readdirSync(archive);
        expect(archived).toHaveLength(1);
        expect(archived[0]).toContain("2026-04-22");

        // Active file now contains only the new entry.
        const active = readFileSync(file, "utf8").split("\n").filter(Boolean);
        expect(active).toHaveLength(1);
        expect(JSON.parse(active[0]!).cmd).toBe("pull");
    });

    test("writing below the threshold does not rotate", () => {
        const dir = join(workdir, ".kindly");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "trace.jsonl"), "x".repeat(1024));

        writeTraceEntry(env, {
            ts: "2026-04-22T12:00:00.000Z",
            cmd: "pull",
            argv_hash: "abc123def456",
            duration_ms: 10,
            exit_code: 0,
            warnings_n: 0,
        });

        expect(existsSync(join(dir, "trace-archive"))).toBe(false);
    });
});

describe("trace: robustness", () => {
    test("best-effort: a broken .kindly path doesn't crash the command", async () => {
        // Plant a file where the trace dir would go. mkdirSync(dir, {recursive})
        // throws ENOTDIR — the trace write must swallow it, leaving the
        // user-facing command unaffected.
        writeFileSync(join(workdir, ".kindly"), "i am a file, not a dir");
        const bad: CliEnv = { ...env, trace: true };

        const code = await main(["pull"], bad);
        expect(code).toBe(0);
    });
});
