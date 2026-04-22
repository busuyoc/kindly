// Library-level tests for src/lib/setupExport.ts. Locks the programmatic
// API (SetupExportOptions, ExportResultWithSchema) and the "no printing"
// contract. Focused smoke coverage — full behavior lives in
// tests/cli/setupExport*.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    executeSetupExport,
    type SetupExportOptions,
} from "../../src/lib/setupExport.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-sx-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["avoid_flashing_ui"] = true,
    ["refresh_rate"] = 8,
    ["zlibrary_password"] = "hunter2",
    ["plugins_disabled"] = { ["SSH"] = true },
}
`);
    return root;
}

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    fakeKindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-sx-w-"));
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

describe("executeSetupExport (library)", () => {
    test("happy path: dryRun returns populated result without writing", () => {
        const opts: SetupExportOptions = { name: "demo", dryRun: true };
        const r = executeSetupExport(opts, env);
        expect(r.mode).toBe("dry-run");
        expect(r.name).toBe("demo");
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
        expect(r.sourceMode).toBe("device");
        expect(r.droppedSecrets).toContain("zlibrary_password");
        expect(r.pluginsDisabledCount).toBe(1);
        expect(existsSync(r.outputPath)).toBe(false);
    });

    test("no printing — stdout and stderr stay empty", () => {
        executeSetupExport({ name: "demo", dryRun: true }, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("SetupExportOptions shape: template source bypasses device read", () => {
        const r = executeSetupExport(
            { name: "t", template: "minimal-ui", dryRun: true, output: "out.kset.yaml" },
            // a separate env with no mountOverride; template mode shouldn't need a mount
            { ...env, mountOverride: "/nonexistent" },
        );
        expect(r.sourceMode).toBe("template");
        expect(r.templateId).toBe("minimal-ui");
        expect(r.sourcePath).toBeNull();
    });

    test("SetupExportOptions shape: force writes and bytesWritten > 0", () => {
        const outPath = join(workdir, "demo.kset.yaml");
        writeFileSync(outPath, "placeholder\n");
        const r = executeSetupExport(
            { name: "demo", output: "demo.kset.yaml", force: true },
            env,
        );
        expect(r.mode).toBe("exported");
        expect(r.bytesWritten).toBeGreaterThan(0);
        expect(r.outputPath).toBe(outPath);
    });
});
