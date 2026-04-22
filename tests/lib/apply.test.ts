// Library-level tests for src/lib/apply.ts. Locks the programmatic API:
// ApplyOptions shape, ApplyResult shape, and the "no printing" contract.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeApply, type ApplyOptions } from "../../src/lib/apply.ts";
import { executePull } from "../../src/lib/pull.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-apply-"));
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
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-apply-w-"));
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

describe("executeApply (library)", () => {
    test("happy path: no-op when device matches YAML", () => {
        executePull({}, env);
        const r = executeApply({}, env);
        expect(r.mode).toBe("no-op");
        expect(r.changes).toEqual([]);
        expect(r.backupPath).toBeNull();
    });

    test("no printing — stdout and stderr stay empty", () => {
        executePull({}, env);
        executeApply({ dryRun: true }, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("ApplyOptions shape: dryRun short-circuits before write", () => {
        executePull({}, env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );
        const opts: ApplyOptions = { dryRun: true };
        const r = executeApply(opts, env);
        expect(r.mode).toBe("dry-run");
        expect(r.changes).toHaveLength(1);
        expect(r.bytesWritten).toBe(0);
    });

    test("ApplyOptions shape: file + backupDir honored", () => {
        executePull({ output: "alt.yaml" }, env);
        writeFileSync(
            join(workdir, "alt.yaml"),
            readFileSync(join(workdir, "alt.yaml"), "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );
        const r = executeApply({ file: "alt.yaml", backupDir: "custom-backups" }, env);
        expect(r.mode).toBe("applied");
        expect(r.backupPath).toContain("custom-backups");
    });
});
