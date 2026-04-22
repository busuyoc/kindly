// Library-level tests for src/lib/diff.ts. Locks DiffOptions shape,
// DiffResult shape, and the "no printing" contract.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeDiff, type DiffOptions } from "../../src/lib/diff.ts";
import { executePull } from "../../src/lib/pull.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { ArgError } from "../../src/cli/args.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-diff-"));
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
        lastfile: "/mnt/us/Books/a.epub",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-diff-w-"));
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

describe("executeDiff (library)", () => {
    test("happy path: returns zero changes when YAML matches device", () => {
        executePull({}, env);
        const r = executeDiff({}, env);
        expect(r.changes).toEqual([]);
        expect(r.yamlPath).toBe(join(workdir, "kindly.yaml"));
        expect(r.settingsPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua"));
    });

    test("no printing — stdout and stderr stay empty", () => {
        executePull({}, env);
        executeDiff({}, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("DiffOptions shape: file points to alternate YAML", () => {
        executePull({ output: "alt.yaml" }, env);
        writeFileSync(
            join(workdir, "alt.yaml"),
            readFileSync(join(workdir, "alt.yaml"), "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );
        const opts: DiffOptions = { file: "alt.yaml" };
        const r = executeDiff(opts, env);
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]!.kind).toBe("changed");
    });

    test("DiffOptions shape: unknown category throws ArgError", () => {
        executePull({}, env);
        expect(() => executeDiff({ category: "not-a-real-category" }, env))
            .toThrow(ArgError);
    });
});
