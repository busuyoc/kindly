// Library-level tests for src/lib/doctor.ts. Locks DoctorResult shape and
// the "no printing" contract. Note: doctor's contract is "never throws" —
// mount failure becomes a failing check, not an exception.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeDoctor } from "../../src/lib/doctor.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({
        avoid_flashing_ui: true,
        zlibrary_password: "hunter2",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-w-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeDoctor (library)", () => {
    test("happy path: all checks pass on a healthy fake kindle", () => {
        const r = executeDoctor(env);
        expect(r.ok).toBe(true);
        expect(r.checks.every((c) => c.ok)).toBe(true);
        expect(r.secretsPresent).toContain("zlibrary_password");
    });

    test("no printing — stdout and stderr stay empty", () => {
        executeDoctor(env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("mount failure becomes a failing check (no throw)", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        expect(() => executeDoctor(bad)).not.toThrow();
        const r = executeDoctor(bad);
        expect(r.ok).toBe(false);
        expect(r.checks[0]!.id).toBe("mount");
        expect(r.checks[0]!.ok).toBe(false);
    });
});
