// Unit tests for in-progress crash markers (C10).
//
// Markers exist to close the SIGKILL window between safeWrite returning
// and history.jsonl being appended (S680/S1180/S1181). The marker is
// written before the pipeline starts and cleared after history is
// appended; if it survives, doctor surfaces it as `progress.crashed_apply`.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    clearInProgressMarker, inProgressDir, writeInProgressMarker,
} from "../../src/history/inProgress.ts";
import type { CliEnv } from "../../src/cli/env.ts";
import { StringWriter } from "../../src/cli/env.ts";

function makeEnv(cwd: string): CliEnv {
    return {
        cwd,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        now: () => new Date("2026-04-25T12:00:00Z"),
    };
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-inprog-"));
});

describe("writeInProgressMarker", () => {
    test("creates .kindly/in-progress/ and a JSON file with payload", () => {
        const env = makeEnv(workdir);
        const path = writeInProgressMarker(env, {
            cmd: "apply",
            started_at: env.now().toISOString(),
            pid: 12345,
            settings_path: "/Volumes/Kindle/koreader/settings.reader.lua",
            intended_sha256: "abc123",
        });
        expect(existsSync(path)).toBe(true);
        expect(path.startsWith(inProgressDir(workdir))).toBe(true);
        const payload = JSON.parse(readFileSync(path, "utf8"));
        expect(payload.cmd).toBe("apply");
        expect(payload.pid).toBe(12345);
        expect(payload.intended_sha256).toBe("abc123");
    });

    test("filename includes cmd, pid, and stamp so concurrent invocations don't collide", () => {
        const env = makeEnv(workdir);
        const a = writeInProgressMarker(env, {
            cmd: "apply", started_at: "2026-04-25T12:00:00.001Z",
            pid: 1, settings_path: "/x",
        });
        const b = writeInProgressMarker(env, {
            cmd: "apply", started_at: "2026-04-25T12:00:00.002Z",
            pid: 2, settings_path: "/x",
        });
        expect(a).not.toBe(b);
        const entries = readdirSync(inProgressDir(workdir));
        expect(entries.length).toBe(2);
    });

    test("setup:import cmd writes filename without ':' (filesystem-safe)", () => {
        const env = makeEnv(workdir);
        const path = writeInProgressMarker(env, {
            cmd: "setup:import", started_at: env.now().toISOString(),
            pid: 99, settings_path: "/x",
        });
        expect(path).not.toContain(":");
        expect(path).toContain("setup-import-");
    });
});

describe("clearInProgressMarker", () => {
    test("removes the marker file", () => {
        const env = makeEnv(workdir);
        const path = writeInProgressMarker(env, {
            cmd: "rollback", started_at: env.now().toISOString(),
            pid: 1, settings_path: "/x",
        });
        clearInProgressMarker(path);
        expect(existsSync(path)).toBe(false);
    });

    test("removes the empty in-progress dir afterward", () => {
        const env = makeEnv(workdir);
        const path = writeInProgressMarker(env, {
            cmd: "apply", started_at: env.now().toISOString(),
            pid: 1, settings_path: "/x",
        });
        clearInProgressMarker(path);
        expect(existsSync(inProgressDir(workdir))).toBe(false);
    });

    test("leaves dir alone when other markers still present", () => {
        const env = makeEnv(workdir);
        const a = writeInProgressMarker(env, {
            cmd: "apply", started_at: "2026-04-25T12:00:00.001Z",
            pid: 1, settings_path: "/x",
        });
        writeInProgressMarker(env, {
            cmd: "apply", started_at: "2026-04-25T12:00:00.002Z",
            pid: 2, settings_path: "/x",
        });
        clearInProgressMarker(a);
        expect(existsSync(inProgressDir(workdir))).toBe(true);
        expect(readdirSync(inProgressDir(workdir)).length).toBe(1);
    });

    test("missing marker does not throw (best-effort cleanup)", () => {
        expect(() =>
            clearInProgressMarker(join(workdir, "nonexistent.json"))
        ).not.toThrow();
    });
});

describe("doctor surfaces stale markers", () => {
    test("progress.crashed_apply finding per surviving marker", async () => {
        const { executeDoctor } = await import("../../src/lib/doctor.ts");
        // Build a fake kindle for doctor to chew through.
        const fakeKindle = mkdtempSync(join(tmpdir(), "kindly-fake-"));
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(fakeKindle, "koreader"));
        writeFileSync(
            join(fakeKindle, "koreader", "settings.reader.lua"),
            "-- ./settings.reader.lua\nreturn {\n}\n",
        );

        const env: CliEnv = {
            cwd: workdir,
            stdout: new StringWriter(),
            stderr: new StringWriter(),
            color: false,
            mountOverride: fakeKindle,
            now: () => new Date("2026-04-25T12:00:00Z"),
        };

        // Plant a stale marker.
        writeInProgressMarker(env, {
            cmd: "apply",
            started_at: "2026-04-24T10:00:00Z",
            pid: 4242,
            settings_path: join(fakeKindle, "koreader", "settings.reader.lua"),
            intended_sha256: "deadbeef",
        });

        const r = executeDoctor(env);
        const findings = r.checks.filter((c) => c.id === "progress.crashed_apply");
        expect(findings.length).toBe(1);
        expect(findings[0]!.severity).toBe("warning");
        expect(findings[0]!.label).toContain("apply");
        expect(findings[0]!.label).toContain("4242");
        expect(findings[0]!.data?.pid).toBe(4242);
    });

    test("no progress findings when in-progress dir is absent", async () => {
        const { executeDoctor } = await import("../../src/lib/doctor.ts");
        const fakeKindle = mkdtempSync(join(tmpdir(), "kindly-fake-"));
        const { mkdirSync } = await import("node:fs");
        mkdirSync(join(fakeKindle, "koreader"));
        writeFileSync(
            join(fakeKindle, "koreader", "settings.reader.lua"),
            "-- ./settings.reader.lua\nreturn {\n}\n",
        );

        const env: CliEnv = {
            cwd: workdir,
            stdout: new StringWriter(),
            stderr: new StringWriter(),
            color: false,
            mountOverride: fakeKindle,
            now: () => new Date("2026-04-25T12:00:00Z"),
        };

        const r = executeDoctor(env);
        const findings = r.checks.filter((c) => c.id === "progress.crashed_apply");
        expect(findings.length).toBe(0);
    });
});
