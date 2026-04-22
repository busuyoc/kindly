// `kindly rollback --to <N>` — resolve the snapshot by history index.
//
// Coverage:
//   - --to on an apply entry resolves backup_path's parent dir and restores
//   - --to on a setup:import entry resolves pre_import_path
//   - --to on a prior rollback resolves pre_rollback_path (rolling back a rollback)
//   - --to on a restore entry → helpful redirect to `kindly restore`
//   - --to on a snapshot / setup:export entry → "nothing to roll back"
//   - --to on an entry with no pre-* field → clear error
//   - --to 0 / --to abc / --to 999 → ArgError / KindlyError with useful text
//   - --to + positional mutual exclusion
//   - empty history → friendly error
//   - integration: 3 apply mutations, --to 1 restores state before the 1st
//   - rollback --to also appends its own history entry (existing behavior)

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { historyPath } from "../../src/history/writer.ts";

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-rbto-k-"));
    const koreaderRoot = join(root, "koreader");
    mkdirSync(koreaderRoot);
    const settingsPath = join(koreaderRoot, "settings.reader.lua");
    writeFileSync(settingsPath, `return {\n    ["night_mode"] = false,\n}\n`);
    return { root, settingsPath };
}

function makeEnv(cwd: string, mountOverride: string): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd, stdout: out, stderr: err, color: false, mountOverride,
            now: () => new Date("2026-04-22T12:00:00Z"),
        },
        out, err,
    };
}

function seedHistory(cwd: string, entries: unknown[]): void {
    mkdirSync(join(cwd, ".kindly"), { recursive: true });
    writeFileSync(historyPath(cwd), entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

function seedSettingsBackup(cwd: string, stamp: string, content: string): string {
    const dir = join(cwd, ".kindly", "backups", stamp);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "settings.reader.lua");
    writeFileSync(path, content);
    return path;
}

function seedPreImportDir(cwd: string, stamp: string, settings: string): string {
    const dir = join(cwd, ".kindly", "pre-import", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.reader.lua"), settings);
    return dir;
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-rbto-w-"));
});

describe("rollback --to — argument validation", () => {
    test("--to + positional → ArgError exit 2", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "/some/dir", "--to", "1"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/mutually exclusive/i);
    });

    test("--to abc → ArgError", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "abc"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/--to must be a positive integer/i);
    });

    test("--to 0 → ArgError", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "0"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/positive integer/i);
    });

    test("--to -3 → ArgError", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "-3"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/positive integer/i);
    });

    test("no args → usage mentions both forms", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/--to <N>/);
    });
});

describe("rollback --to — history lookup", () => {
    test("empty history → friendly exit 1", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no history yet/i);
    });

    test("index out of range → cites valid range", async () => {
        const backupPath = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", "return {}\n");
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: backupPath } },
        ]);

        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "5"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no history entry #5/);
        expect(err.value).toMatch(/1\.\.1/);
    });
});

describe("rollback --to — resolution by command", () => {
    test("apply entry → uses parent of backup_path, restores settings", async () => {
        const kindle = makeFakeKindle();
        const pristine = `return {\n    ["home_dir"] = "/mnt/books",\n}\n`;
        const backupPath = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", pristine);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 2, backup_path: backupPath } },
        ]);

        // Corrupt device so rollback has something to undo.
        writeFileSync(kindle.settingsPath, `return { ["wrecked"] = true, }\n`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });

    test("setup:import entry → resolves pre_import_path directly", async () => {
        const kindle = makeFakeKindle();
        const pristine = `return {\n    ["theme"] = "light",\n}\n`;
        const preImport = seedPreImportDir(workdir, "2026-04-22T11-00-00-000Z", pristine);
        seedHistory(workdir, [
            { ts: "2026-04-22T11:00:00.000Z", cmd: "setup:import", kindly_version: "0.3.0",
              summary: { settings_delta_n: 3, pre_import_path: preImport, setup_id: "abc123" } },
        ]);

        writeFileSync(kindle.settingsPath, `return { ["broken"] = true, }\n`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });

    test("rollback entry → resolves pre_rollback_path (unroll a rollback)", async () => {
        const kindle = makeFakeKindle();
        const state = `return {\n    ["fresh"] = true,\n}\n`;
        // Build a prior-rollback snapshot dir.
        const prevRoll = join(workdir, ".kindly", "pre-rollback", "2026-04-22T09-00-00-000Z");
        mkdirSync(prevRoll, { recursive: true });
        writeFileSync(join(prevRoll, "settings.reader.lua"), state);

        seedHistory(workdir, [
            { ts: "2026-04-22T09:00:00.000Z", cmd: "rollback", kindly_version: "0.3.0",
              summary: { snapshot_dir: "/ignored", pre_rollback_path: prevRoll } },
        ]);

        writeFileSync(kindle.settingsPath, `return { ["other"] = 1, }\n`);
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(state);
    });

    test("restore entry → refuses with pointer to `kindly restore`", async () => {
        const kindle = makeFakeKindle();
        seedHistory(workdir, [
            { ts: "2026-04-22T09:00:00.000Z", cmd: "restore", kindly_version: "0.3.0",
              summary: { archive_path: "/in.tgz", pre_restore_path: "/tmp/pre.tgz" } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/`restore`/);
        expect(err.value).toMatch(/kindly restore/);
    });

    test("snapshot entry → `nothing to roll back`", async () => {
        const kindle = makeFakeKindle();
        seedHistory(workdir, [
            { ts: "2026-04-22T09:00:00.000Z", cmd: "snapshot", kindly_version: "0.3.0",
              summary: { archive_path: "/out.tgz" } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/snapshot/);
        expect(err.value).toMatch(/nothing to roll back/i);
    });

    test("setup:export entry → `nothing to roll back`", async () => {
        const kindle = makeFakeKindle();
        seedHistory(workdir, [
            { ts: "2026-04-22T09:00:00.000Z", cmd: "setup:export", kindly_version: "0.3.0",
              summary: { output_path: "/x.kset", setup_id: "abc" } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/nothing to roll back/i);
    });

    test("apply entry missing backup_path → `no safety snapshot on record`", async () => {
        const kindle = makeFakeKindle();
        seedHistory(workdir, [
            { ts: "2026-04-22T09:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1 } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no safety snapshot/i);
    });
});

describe("rollback --to — multi-mutation scenario", () => {
    test("3 apply entries, --to 1 restores the earliest backup", async () => {
        const kindle = makeFakeKindle();
        const v1 = `return {\n    ["step"] = 1,\n}\n`;
        const v2 = `return {\n    ["step"] = 2,\n}\n`;
        const v3 = `return {\n    ["step"] = 3,\n}\n`;

        // Each apply copies the pre-apply settings into .kindly/backups/<stamp>/.
        const b1 = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", v1);
        const b2 = seedSettingsBackup(workdir, "2026-04-22T10-05-00-000Z", v2);
        const b3 = seedSettingsBackup(workdir, "2026-04-22T10-10-00-000Z", v3);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: b1 } },
            { ts: "2026-04-22T10:05:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: b2 } },
            { ts: "2026-04-22T10:10:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: b3 } },
        ]);

        // Current device state is something else.
        writeFileSync(kindle.settingsPath, `return {\n    ["step"] = 4,\n}\n`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(0);
        // --to 1 resolves to the parent dir of b1; restores v1.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(v1);
    });

    test("--to appends its own history entry (rollback command counted)", async () => {
        const kindle = makeFakeKindle();
        const v1 = `return {\n    ["step"] = 1,\n}\n`;
        const b1 = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", v1);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: b1 } },
        ]);

        const { env } = makeEnv(workdir, kindle.root);
        await main(["rollback", "--to", "1", "--label", "undo-a"], env);

        const lines = readFileSync(historyPath(workdir), "utf8").trim().split("\n");
        expect(lines.length).toBe(2);
        const last = JSON.parse(lines[1]!);
        expect(last.cmd).toBe("rollback");
        expect(last.label).toBe("undo-a");
    });
});

describe("rollback --to --dry-run", () => {
    test("--to 1 --dry-run resolves the snapshot but doesn't write", async () => {
        const kindle = makeFakeKindle();
        const before = readFileSync(kindle.settingsPath, "utf8");
        const pristine = `return {\n    ["clean"] = true,\n}\n`;
        const backupPath = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", pristine);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: backupPath } },
        ]);

        const { env, out } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1", "--dry-run"], env);
        expect(code).toBe(0);
        expect(out.value).toMatch(/dry-run/i);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });
});
