// Typed result + --json envelope tests for `kindly setup export`.
// Covers executeSetupExport directly (data shape) plus the --json wire
// contract, --dry-run path, and the SCHEMA_VIOLATION / OUTPUT_EXISTS
// error codes.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupExport } from "../../src/commands/setup.ts";

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-sej-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(
        join(kor, "settings.reader.lua"),
        `return {\n    ["font_size"] = 22,\n    ["show_status_bar"] = true,\n}\n`,
    );
    return root;
}

let fakeKindle: string;
let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    fakeKindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-sej-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-sej-d-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: fakeKindle,
        setupsDir,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeSetupExport", () => {
    test("device-mode export returns populated typed result", () => {
        const out = join(workdir, "out.kset.yaml");
        const r = executeSetupExport({ name: "dev", output: out }, env);
        expect(r.mode).toBe("exported");
        expect(r.outputPath).toBe(out);
        expect(r.sourceMode).toBe("device");
        expect(r.applyMode).toBe("additive");
        expect(r.isFat).toBe(false);
        expect(r.settingsCount).toBeGreaterThan(0);
        expect(r.bytesWritten).toBeGreaterThan(0);
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
        expect(r.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(existsSync(out)).toBe(true);
    });

    test("--dry-run sets mode + skips write", () => {
        const out = join(workdir, "dry.kset.yaml");
        const r = executeSetupExport({ name: "dry", output: out, dryRun: true }, env);
        expect(r.mode).toBe("dry-run");
        expect(existsSync(out)).toBe(false);
        // bytesWritten still informative for the lean path.
        expect(r.bytesWritten).toBeGreaterThan(0);
    });

    test("--strict + unknown key → SCHEMA_VIOLATION", () => {
        // Plant a key the KOReader schema doesn't know.
        const korSettings = join(fakeKindle, "koreader", "settings.reader.lua");
        writeFileSync(korSettings, `return {\n    ["totally_made_up_key"] = 1,\n}\n`);

        expect(() => executeSetupExport(
            { name: "x", output: join(workdir, "s.kset.yaml"), strict: true },
            env,
        )).toThrow(/--strict/);
    });

    test("existing output without --force → OUTPUT_EXISTS", () => {
        const out = join(workdir, "dup.kset.yaml");
        writeFileSync(out, "# already here\n");
        expect(() => executeSetupExport({ name: "dup", output: out }, env))
            .toThrow(/already exists/);
    });
});

describe("setup export --json", () => {
    test("emits envelope with export data", async () => {
        const out = join(workdir, "out.kset.yaml");
        const code = await main(
            ["setup", "export", "mine", "--output", out, "--json"],
            env,
        );
        expect(code).toBe(0);
        const { command, status, data } = JSON.parse(stdout.value);
        expect(command).toBe("setup export");
        expect(status).toBe("ok");
        expect(data.mode).toBe("exported");
        expect(data.outputPath).toBe(out);
        expect(data.isFat).toBe(false);
        expect(typeof data.bytesWritten).toBe("number");
        // Rendering-only fields shouldn't leak.
        expect(data.schemaFindings).toBeUndefined();
        expect(data.sourcePath).toBeUndefined();
        expect(data.fatLuaBytes).toBeUndefined();
        // Text lines shouldn't appear in stdout either.
        expect(stdout.value).not.toContain("exported setup");
    });

    test("--dry-run --json emits dry-run mode, no write", async () => {
        const out = join(workdir, "dry.kset.yaml");
        const code = await main(
            ["setup", "export", "mine", "--output", out, "--dry-run", "--json"],
            env,
        );
        expect(code).toBe(0);
        const { data } = JSON.parse(stdout.value);
        expect(data.mode).toBe("dry-run");
        expect(existsSync(out)).toBe(false);
    });

    test("OUTPUT_EXISTS surfaces as error envelope", async () => {
        const out = join(workdir, "dup.kset.yaml");
        writeFileSync(out, "# already\n");
        const code = await main(
            ["setup", "export", "x", "--output", out, "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("OUTPUT_EXISTS");
    });
});
