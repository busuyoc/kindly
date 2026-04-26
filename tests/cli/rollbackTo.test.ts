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
              summary: { settings_delta_n: 3, pre_import_path: preImport, setup_id: "abc123def456" } },
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
              summary: { output_path: "/x.kset", setup_id: "abcdef012345" } },
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

describe("rollback --to — crosses archives (W17)", () => {
    test("--to N resolves an entry that was rotated to an archive file", async () => {
        const kindle = makeFakeKindle();
        const pristine = `return {\n    ["step"] = 1,\n}\n`;
        const backupPath = seedSettingsBackup(workdir, "2026-04-22T10-00-00-000Z", pristine);

        // Seed ONE apply entry in an ARCHIVE file (index 3), leaving active
        // empty. This mimics a post-rotation state where the user still
        // wants to roll back to an old mutation.
        const archiveDir = join(workdir, ".kindly", "history-archive");
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(
            join(archiveDir, "2026-04.jsonl"),
            JSON.stringify({
                ts: "2026-04-22T10:00:00.000Z",
                cmd: "apply",
                kindly_version: "0.3.0",
                index: 3,
                summary: { settings_delta_n: 1, backup_path: backupPath },
            }) + "\n",
        );

        writeFileSync(kindle.settingsPath, `return { ["drifted"] = 1, }\n`);
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "3"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });

    test("--to N resolves an archived setup:import entry via pre_import_path", async () => {
        const kindle = makeFakeKindle();
        const pristine = `return {\n    ["imported"] = true,\n}\n`;
        const preImportDir = seedPreImportDir(workdir, "2026-03-10T09-00-00-000Z", pristine);

        // Archived setup:import entry; active file is empty.
        const archiveDir = join(workdir, ".kindly", "history-archive");
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(
            join(archiveDir, "2026-03.jsonl"),
            JSON.stringify({
                ts: "2026-03-10T09:00:00.000Z",
                cmd: "setup:import",
                kindly_version: "0.3.0",
                index: 42,
                summary: { settings_delta_n: 2, pre_import_path: preImportDir, setup_id: "abc123def456" },
            }) + "\n",
        );

        writeFileSync(kindle.settingsPath, `return { ["drifted"] = 9, }\n`);
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "42"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });

    test("unknown --to N cites total across active + archives", async () => {
        // Two entries in archive, one in active → total 3.
        const archiveDir = join(workdir, ".kindly", "history-archive");
        mkdirSync(archiveDir, { recursive: true });
        writeFileSync(
            join(archiveDir, "2026-03.jsonl"),
            [
                JSON.stringify({ ts: "2026-03-15T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0", index: 1, summary: {} }),
                JSON.stringify({ ts: "2026-03-16T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0", index: 2, summary: {} }),
            ].join("\n") + "\n",
        );
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        writeFileSync(
            historyPath(workdir),
            JSON.stringify({ ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0", index: 3, summary: {} }) + "\n",
        );

        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "99"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/no history entry #99/);
        expect(err.value).toMatch(/1\.\.3/);
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

// Round 3 disk-hygiene F3: history.jsonl is in the same `.kindly/`
// directory as pre-import snapshots, so an attacker with cwd-write
// access can tamper history to point `pre_import_path` /
// `pre_rollback_path` / `backup_path` outside the expected subtype dir.
// Resolver must reject paths that don't resolve under the expected
// `<cwd>/.kindly/<subtype>/` root.
describe("rollback --to — F3 history-path subtype validation", () => {
    test("apply entry with backup_path outside .kindly/backups/ → SNAPSHOT_INVALID", async () => {
        const kindle = makeFakeKindle();
        // Stage a fake settings file outside .kindly/backups/.
        const evilDir = mkdtempSync(join(tmpdir(), "kindly-evil-"));
        const evilBackup = join(evilDir, "settings.reader.lua");
        writeFileSync(evilBackup, `return { ["pwned"] = true, }\n`);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: evilBackup } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/resolves outside/);
        expect(err.value).toMatch(/\.kindly\/backups/);
        // Device unchanged (rollback never executed).
        expect(readFileSync(kindle.settingsPath, "utf8")).not.toContain("pwned");
    });

    test("setup:import entry with pre_import_path outside .kindly/pre-import/ → SNAPSHOT_INVALID", async () => {
        const kindle = makeFakeKindle();
        const evilDir = mkdtempSync(join(tmpdir(), "kindly-evil-imp-"));
        writeFileSync(join(evilDir, "settings.reader.lua"), `return { ["x"] = 1, }\n`);
        seedHistory(workdir, [
            { ts: "2026-04-22T11:00:00.000Z", cmd: "setup:import", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, pre_import_path: evilDir, setup_id: "abcdef012345" } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/resolves outside/);
        expect(err.value).toMatch(/\.kindly\/pre-import/);
    });

    test("rollback entry with pre_rollback_path outside .kindly/pre-rollback/ → SNAPSHOT_INVALID", async () => {
        const kindle = makeFakeKindle();
        const evilDir = mkdtempSync(join(tmpdir(), "kindly-evil-rb-"));
        writeFileSync(join(evilDir, "settings.reader.lua"), `return { ["x"] = 1, }\n`);
        seedHistory(workdir, [
            { ts: "2026-04-22T11:00:00.000Z", cmd: "rollback", kindly_version: "0.3.0",
              summary: { snapshot_dir: "/ignored", pre_rollback_path: evilDir } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/resolves outside/);
        expect(err.value).toMatch(/\.kindly\/pre-rollback/);
    });

    test("path-traversal lookalike (`.kindly/backups-evil/...`) is rejected", async () => {
        const kindle = makeFakeKindle();
        // Stage a sibling dir whose name starts with "backups" to exercise
        // the trailing-separator guard on subtype prefix matching.
        const lookalikeDir = join(workdir, ".kindly", "backups-evil", "x");
        mkdirSync(lookalikeDir, { recursive: true });
        const lookalike = join(lookalikeDir, "settings.reader.lua");
        writeFileSync(lookalike, `return { ["pwned2"] = true, }\n`);
        seedHistory(workdir, [
            { ts: "2026-04-22T10:00:00.000Z", cmd: "apply", kindly_version: "0.3.0",
              summary: { settings_delta_n: 1, backup_path: lookalike } },
        ]);
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/resolves outside/);
    });
});

// Round-3 snapshot integrity hash-binding. The history entry records
// hashSnapshotDir(<snapshot>) at write time; rollback recomputes and
// compares before re-applying any bytes. A mismatch raises
// SNAPSHOT_HASH_MISMATCH and refuses to proceed; pre-round-3 entries
// without the hash are accepted (backward-compat).
describe("rollback --to — round-3 snapshot integrity hash-binding", () => {
    test("hash mismatch (tampered snapshot file) → SNAPSHOT_HASH_MISMATCH", async () => {
        const kindle = makeFakeKindle();
        const stamp = "2026-04-22T10-00-00-000Z";
        // Compute the hash for the *original* contents, write to history,
        // then mutate the file on disk to simulate tampering.
        const backupPath = seedSettingsBackup(workdir, stamp,
            `return {\n    ["night_mode"] = true,\n}\n`);
        const { hashSnapshotDir } = await import("../../src/history/snapshotHash.ts");
        const originalHash = hashSnapshotDir(join(workdir, ".kindly", "backups", stamp));
        // Tamper: flip a value (matches the threat model — attacker
        // swapped settings.reader.lua bytes between original write and
        // rollback read).
        writeFileSync(backupPath, `return {\n    ["pin"] = "9999",\n}\n`);

        seedHistory(workdir, [
            {
                ts: "2026-04-22T10:00:00.000Z",
                cmd: "apply",
                kindly_version: "0.3.0",
                summary: {
                    settings_delta_n: 1,
                    backup_path: backupPath,
                    snapshot_sha256: originalHash,
                },
            },
        ]);

        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/SNAPSHOT_HASH_MISMATCH|content hash does not match/i);
        // Device must NOT have been re-written from the tampered bytes.
        expect(readFileSync(kindle.settingsPath, "utf8")).not.toContain("pin");
        expect(readFileSync(kindle.settingsPath, "utf8")).not.toContain("9999");
    });

    test("hash matches (untampered snapshot) → rollback proceeds", async () => {
        const kindle = makeFakeKindle();
        const stamp = "2026-04-22T10-00-00-000Z";
        const backupPath = seedSettingsBackup(workdir, stamp,
            `return {\n    ["night_mode"] = true,\n}\n`);
        const { hashSnapshotDir } = await import("../../src/history/snapshotHash.ts");
        const originalHash = hashSnapshotDir(join(workdir, ".kindly", "backups", stamp));

        seedHistory(workdir, [
            {
                ts: "2026-04-22T10:00:00.000Z",
                cmd: "apply",
                kindly_version: "0.3.0",
                summary: {
                    settings_delta_n: 1,
                    backup_path: backupPath,
                    snapshot_sha256: originalHash,
                },
            },
        ]);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1", "--no-safety-snapshot"], env);
        expect(code).toBe(0);
        // Device updated from the (untampered) snapshot.
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("night_mode");
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("true");
    });

    test("pre-round-3 entry (no snapshot_sha256) is accepted (backward-compat)", async () => {
        const kindle = makeFakeKindle();
        const stamp = "2026-04-22T10-00-00-000Z";
        const backupPath = seedSettingsBackup(workdir, stamp,
            `return {\n    ["night_mode"] = true,\n}\n`);

        seedHistory(workdir, [
            {
                ts: "2026-04-22T10:00:00.000Z",
                cmd: "apply",
                kindly_version: "0.3.0",
                summary: {
                    settings_delta_n: 1,
                    backup_path: backupPath,
                    // intentionally NO snapshot_sha256 — pre-round-3 shape
                },
            },
        ]);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1", "--no-safety-snapshot"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("night_mode");
    });

    test("explicit snapshot dir bypasses hash binding (no recorded hash to compare)", async () => {
        // `kindly rollback <dir>` is the "I trust this dir" surface.
        // No history lookup, no hash check — caller asserts trust.
        const kindle = makeFakeKindle();
        const explicitDir = mkdtempSync(join(tmpdir(), "kindly-explicit-"));
        writeFileSync(join(explicitDir, "settings.reader.lua"),
            `return {\n    ["explicit"] = 1,\n}\n`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", explicitDir, "--no-safety-snapshot"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("explicit");
    });

    test("snapshot dir vanished (rotated/deleted) but history retains hash → SNAPSHOT_HASH_MISMATCH", async () => {
        const kindle = makeFakeKindle();
        const stamp = "2026-04-22T10-00-00-000Z";
        const backupPath = seedSettingsBackup(workdir, stamp,
            `return {\n    ["night_mode"] = true,\n}\n`);
        const { hashSnapshotDir } = await import("../../src/history/snapshotHash.ts");
        const originalHash = hashSnapshotDir(join(workdir, ".kindly", "backups", stamp));

        seedHistory(workdir, [
            {
                ts: "2026-04-22T10:00:00.000Z",
                cmd: "apply",
                kindly_version: "0.3.0",
                summary: {
                    settings_delta_n: 1,
                    backup_path: backupPath,
                    snapshot_sha256: originalHash,
                },
            },
        ]);

        // Simulate rotation/cleanup — remove the file from the snapshot
        // dir. The path-subtype assertion still passes (parent dir exists)
        // but hashSnapshotDir throws ENOENT on the file or returns a
        // different hash for an empty dir.
        const { rmSync } = await import("node:fs");
        rmSync(backupPath);

        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", "--to", "1"], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/SNAPSHOT_HASH_MISMATCH|content hash does not match|can't be hashed/i);
    });
});
