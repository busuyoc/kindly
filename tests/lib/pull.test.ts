// Library-level tests for src/lib/pull.ts. Import directly (not via
// commands/) to lock the programmatic API: option shape, result shape, and
// the "no printing" contract that lets in-process consumers (serve, GUI)
// call it without stdout pollution.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executePull, type PullOptions } from "../../src/lib/pull.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-pull-"));
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
        lastfile: "/mnt/us/Books/a.epub",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-pull-w-"));
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

describe("executePull (library)", () => {
    test("happy path: writes kindly.yaml, returns populated result", () => {
        const r = executePull({}, env);
        expect(r.mode).toBe("minimal");
        expect(r.outputPath).toBe(join(workdir, "kindly.yaml"));
        expect(r.bytes).toBeGreaterThan(0);
        expect(r.droppedSecrets).toContain("zlibrary_password");
    });

    test("no printing — stdout and stderr stay empty", () => {
        executePull({}, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("PullOptions shape: full flag controls mode", () => {
        const opts: PullOptions = { full: true };
        const r = executePull(opts, env);
        expect(r.mode).toBe("full");
    });

    test("PullOptions shape: output overrides path", () => {
        const r = executePull({ output: "custom.yaml" }, env);
        expect(r.outputPath).toBe(join(workdir, "custom.yaml"));
        expect(readFileSync(r.outputPath, "utf8").length).toBeGreaterThan(0);
    });
});
