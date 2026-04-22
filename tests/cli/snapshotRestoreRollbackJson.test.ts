// Direct tests for executeSnapshot/Restore/Rollback typed results and their
// --json envelope wrapping. Covers the preview/mutation surface the GUI
// will most heavily consume.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSnapshot } from "../../src/commands/snapshot.ts";
import { executeRestore } from "../../src/commands/restore.ts";
import { executeRollback } from "../../src/commands/rollback.ts";

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-srj-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), `return {\n    ["a"] = 1,\n}\n`);
    writeFileSync(join(kor, "history.lua"), "return {}\n");
    mkdirSync(join(kor, "patches"));
    writeFileSync(join(kor, "patches", "user.lua"), "-- my patch\n");
    mkdirSync(join(kor, "plugins", "sample.koplugin"), { recursive: true });
    writeFileSync(join(kor, "plugins", "sample.koplugin", "main.lua"), "-- x\n");
    return root;
}

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    fakeKindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-srj-w-"));
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

describe("executeSnapshot", () => {
    test("returns archive path + bytes + included/skipped", () => {
        const result = executeSnapshot({}, env);
        expect(result.archivePath).toMatch(/kindly-snapshot-.*\.tar\.gz$/);
        expect(result.bytesWritten).toBeGreaterThan(0);
        expect(result.includedPaths).toContain("settings.reader.lua");
        expect(result.includedPaths).toContain("patches");
        expect(result.includedPaths).toContain("plugins");
        // defaults.custom.lua not present on fake kindle → skipped.
        expect(result.skippedPaths).toContain("defaults.custom.lua");
    });

    test("--json emits envelope with SnapshotResult data", async () => {
        const code = await main(["snapshot", "--json"], env);
        expect(code).toBe(0);
        const { data, command, status } = JSON.parse(stdout.value);
        expect(command).toBe("snapshot");
        expect(status).toBe("ok");
        expect(typeof data.archivePath).toBe("string");
        expect(typeof data.bytesWritten).toBe("number");
        expect(Array.isArray(data.includedPaths)).toBe(true);
        // Secret-warning text must NOT appear in stdout under --json.
        expect(stdout.value).not.toContain("plaintext");
    });
});

describe("executeRestore", () => {
    test("dry-run returns entries + mode + fileCount=0", async () => {
        await main(["snapshot"], env);
        const archive = readdirSync(workdir).find((f) => f.endsWith(".tar.gz"))!;
        stdout.reset();

        const result = executeRestore({
            archive: join(workdir, archive),
            dryRun: true,
        }, env);

        expect(result.mode).toBe("dry-run");
        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.fileCount).toBe(0);
        expect(result.safetySnapshotPath).toBeNull();
    });

    test("restored writes + records safety snapshot path", async () => {
        await main(["snapshot"], env);
        const archive = readdirSync(workdir).find((f) => f.endsWith(".tar.gz"))!;

        const result = executeRestore({
            archive: join(workdir, archive),
        }, env);

        expect(result.mode).toBe("restored");
        expect(result.fileCount).toBeGreaterThan(0);
        expect(result.safetySnapshotPath).toMatch(/\.kindly\/pre-restore\//);
        expect(existsSync(result.safetySnapshotPath!)).toBe(true);
    });

    test("ARCHIVE_NOT_FOUND error envelope via --json", async () => {
        const code = await main(
            ["restore", "/nowhere/nope.tar.gz", "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.error.code).toBe("ARCHIVE_NOT_FOUND");
    });

    test("--no-safety-snapshot leaves safetySnapshotPath null", async () => {
        await main(["snapshot"], env);
        const archive = readdirSync(workdir).find((f) => f.endsWith(".tar.gz"))!;

        const result = executeRestore({
            archive: join(workdir, archive),
            safetySnapshot: false,
        }, env);
        expect(result.safetySnapshotPath).toBeNull();
    });
});

describe("executeRollback", () => {
    test("SNAPSHOT_INVALID when dir doesn't exist", () => {
        expect(() => executeRollback({ snapshotDir: "/nope" }, env))
            .toThrow(/snapshot not found/);
    });

    test("SNAPSHOT_INVALID when dir is empty", () => {
        const snap = mkdtempSync(join(tmpdir(), "kindly-empty-"));
        expect(() => executeRollback({ snapshotDir: snap }, env))
            .toThrow(/empty/);
    });

    test("dry-run returns mode and fatEntries without writing", () => {
        // Plant a fake pre-import snapshot.
        const snap = join(workdir, "snap");
        mkdirSync(snap, { recursive: true });
        writeFileSync(join(snap, "settings.reader.lua"), `return {\n    ["b"] = 2,\n}\n`);

        const result = executeRollback({
            snapshotDir: snap, dryRun: true,
        }, env);
        expect(result.mode).toBe("dry-run");
        expect(result.settingsRestored).toBe(false);
        expect(result.preRollbackDir).toBeNull();
    });

    test("rolled-back writes settings + records preRollbackDir", () => {
        const snap = join(workdir, "snap");
        mkdirSync(snap, { recursive: true });
        writeFileSync(join(snap, "settings.reader.lua"), `return {\n    ["rolled"] = true,\n}\n`);

        const result = executeRollback({ snapshotDir: snap }, env);
        expect(result.mode).toBe("rolled-back");
        expect(result.settingsRestored).toBe(true);
        expect(result.fatRestored).toBe(false);
        expect(result.preRollbackDir).toMatch(/\.kindly\/pre-rollback\//);
    });

    test("--json wraps RollbackResult in an envelope", async () => {
        const snap = join(workdir, "snap");
        mkdirSync(snap, { recursive: true });
        writeFileSync(join(snap, "settings.reader.lua"), `return {\n    ["b"] = 2,\n}\n`);

        const code = await main(["rollback", snap, "--dry-run", "--json"], env);
        expect(code).toBe(0);
        const { data, command } = JSON.parse(stdout.value);
        expect(command).toBe("rollback");
        expect(data.mode).toBe("dry-run");
        expect(data.snapshotDir).toBe(snap);
    });
});
