// End-to-end: every mutating command writes exactly one history line on
// success, and zero lines on no-op / dry-run.
//
// This locks the "mutation = one history entry" invariant across the six
// command surfaces. W15's `kindly history` will read this file; any breakage
// here would produce silent gaps in the log.

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { historyPath, type HistoryEntry } from "../../src/history/writer.ts";
import { createTarGz } from "../../src/fs/archive.ts";

function makeFakeKindle(): { root: string; koreaderRoot: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-he-k-"));
    const koreaderRoot = join(root, "koreader");
    mkdirSync(koreaderRoot);
    const settingsPath = join(koreaderRoot, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["night_mode"] = false,
    ["home_dir"] = "/mnt/books",
}
`);
    mkdirSync(join(koreaderRoot, "plugins"));
    mkdirSync(join(koreaderRoot, "patches"));
    return { root, koreaderRoot, settingsPath };
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

function readHistory(cwd: string): HistoryEntry[] {
    const p = historyPath(cwd);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
        .split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-he-w-"));
});

describe("history emission — apply", () => {
    test("successful apply writes one entry with settings_delta_n and backup_path", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["apply"], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(1);
        expect(entries[0]!.cmd).toBe("apply");
        expect(entries[0]!.summary.settings_delta_n).toBe(1);
        expect(entries[0]!.summary.backup_path).toBeTruthy();
        expect(entries[0]!.kindly_version).toBeTruthy();
    });

    test("no-op apply writes NO history entry", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: false\nhome_dir: /mnt/books\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["apply"], env);
        expect(readHistory(workdir)).toEqual([]);
    });

    test("dry-run apply writes NO history entry", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["apply", "--dry-run"], env);
        expect(readHistory(workdir)).toEqual([]);
    });
});

describe("history emission — snapshot", () => {
    test("writes one entry with archive_path", async () => {
        const kindle = makeFakeKindle();
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["snapshot", "--output", join(workdir, "snap.tar.gz")], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(1);
        expect(entries[0]!.cmd).toBe("snapshot");
        expect(entries[0]!.summary.archive_path).toBe(join(workdir, "snap.tar.gz"));
    });
});

describe("history emission — restore", () => {
    test("successful restore writes one entry with archive_path and pre_restore_path", async () => {
        const kindle = makeFakeKindle();
        const archivePath = join(workdir, "snap.tar.gz");
        createTarGz({
            cwd: kindle.koreaderRoot,
            paths: ["settings.reader.lua"],
            outputPath: archivePath,
        });

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["restore", archivePath], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(1);
        expect(entries[0]!.cmd).toBe("restore");
        expect(entries[0]!.summary.archive_path).toBe(archivePath);
        expect(entries[0]!.summary.pre_restore_path).toBeTruthy();
    });

    test("dry-run restore writes NO history entry", async () => {
        const kindle = makeFakeKindle();
        const archivePath = join(workdir, "snap.tar.gz");
        createTarGz({
            cwd: kindle.koreaderRoot,
            paths: ["settings.reader.lua"],
            outputPath: archivePath,
        });

        const { env } = makeEnv(workdir, kindle.root);
        await main(["restore", archivePath, "--dry-run"], env);
        expect(readHistory(workdir)).toEqual([]);
    });
});

describe("history emission — rollback", () => {
    test("successful rollback writes one entry with snapshot_dir and pre_rollback_path", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "pre-import-"));
        writeFileSync(join(snap, "settings.reader.lua"), `return { ["night_mode"] = false, }
`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(1);
        expect(entries[0]!.cmd).toBe("rollback");
        expect(entries[0]!.summary.snapshot_dir).toBe(snap);
        expect(entries[0]!.summary.pre_rollback_path).toBeTruthy();
    });

    test("dry-run rollback writes NO history entry", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "pre-import-"));
        writeFileSync(join(snap, "settings.reader.lua"), "return {}\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["rollback", snap, "--dry-run"], env);
        expect(readHistory(workdir)).toEqual([]);
    });
});

describe("history emission — setup export", () => {
    test("successful export writes one entry with output_path and setup_id", async () => {
        const kindle = makeFakeKindle();
        const outPath = join(workdir, "test.kset.yaml");

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["setup", "export", "test-setup", "--output", outPath], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(1);
        expect(entries[0]!.cmd).toBe("setup:export");
        expect(entries[0]!.summary.output_path).toBe(outPath);
        expect(entries[0]!.summary.setup_id).toMatch(/^[0-9a-f]{12}$/);
    });

    test("dry-run export writes NO history entry", async () => {
        const kindle = makeFakeKindle();
        const outPath = join(workdir, "test.kset.yaml");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["setup", "export", "test-setup", "--output", outPath, "--dry-run"], env);
        expect(readHistory(workdir)).toEqual([]);
    });
});

describe("history emission — setup import", () => {
    test("successful import writes one entry with setup_id and plugins_delta", async () => {
        const kindle = makeFakeKindle();
        const exportPath = join(workdir, "test.kset.yaml");

        // First export a setup we can then import.
        const { env: exportEnv } = makeEnv(workdir, kindle.root);
        await main(["setup", "export", "test-setup", "--output", exportPath], exportEnv);

        // Mutate the device so the import is not a no-op.
        writeFileSync(kindle.settingsPath, `return {
    ["night_mode"] = true,
    ["home_dir"] = "/different",
}
`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["setup", "import", exportPath], env);
        expect(code).toBe(0);

        const entries = readHistory(workdir);
        // Two entries: export (from setup phase) + import.
        const importEntries = entries.filter((e) => e.cmd === "setup:import");
        expect(importEntries.length).toBe(1);
        expect(importEntries[0]!.summary.setup_id).toMatch(/^[0-9a-f]{12}$/);
        expect(importEntries[0]!.summary.plugins_delta).toBeTruthy();
        expect(typeof importEntries[0]!.summary.plugins_delta!.disabled_count).toBe("number");
    });

    test("no-op import (device already matches) writes NO import entry", async () => {
        const kindle = makeFakeKindle();
        const exportPath = join(workdir, "test.kset.yaml");

        const { env: exportEnv } = makeEnv(workdir, kindle.root);
        await main(["setup", "export", "test-setup", "--output", exportPath], exportEnv);

        const { env } = makeEnv(workdir, kindle.root);
        await main(["setup", "import", exportPath, "--yes"], env);

        const imports = readHistory(workdir).filter((e) => e.cmd === "setup:import");
        expect(imports).toEqual([]);
    });
});

describe("history emission — --label flag", () => {
    test("apply --label persists the label into history", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["apply", "--label", "before-experiment"], env);

        const entries = readHistory(workdir);
        expect(entries[0]!.label).toBe("before-experiment");
    });

    test("snapshot --label persists the label", async () => {
        const kindle = makeFakeKindle();
        const { env } = makeEnv(workdir, kindle.root);
        await main(
            ["snapshot", "--output", join(workdir, "snap.tar.gz"), "--label", "weekly-backup"],
            env,
        );
        expect(readHistory(workdir)[0]!.label).toBe("weekly-backup");
    });

    test("rollback --label persists the label", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "pre-import-"));
        writeFileSync(join(snap, "settings.reader.lua"), `return { ["night_mode"] = false, }
`);

        const { env } = makeEnv(workdir, kindle.root);
        await main(["rollback", snap, "--label", "undo-experiment"], env);

        expect(readHistory(workdir)[0]!.label).toBe("undo-experiment");
    });

    test("setup import --label persists the label", async () => {
        const kindle = makeFakeKindle();
        const exportPath = join(workdir, "test.kset.yaml");

        const { env: exportEnv } = makeEnv(workdir, kindle.root);
        await main(["setup", "export", "test-setup", "--output", exportPath], exportEnv);

        writeFileSync(kindle.settingsPath, `return {
    ["night_mode"] = true,
    ["home_dir"] = "/different",
}
`);

        const { env } = makeEnv(workdir, kindle.root);
        await main(["setup", "import", exportPath, "--label", "night-theme"], env);

        const imports = readHistory(workdir).filter((e) => e.cmd === "setup:import");
        expect(imports[0]!.label).toBe("night-theme");
    });

    test("labels are advisory — collisions allowed", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");
        const { env: e1 } = makeEnv(workdir, kindle.root);
        await main(["apply", "--label", "experiment"], e1);

        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: false\nhome_dir: /mnt/books\n");
        const { env: e2 } = makeEnv(workdir, kindle.root);
        await main(["apply", "--label", "experiment"], e2);

        const entries = readHistory(workdir);
        expect(entries.length).toBe(2);
        expect(entries[0]!.label).toBe("experiment");
        expect(entries[1]!.label).toBe("experiment");
    });

    test("no --label → no label field in entry", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["apply"], env);

        const entry = readHistory(workdir)[0]!;
        expect("label" in entry).toBe(false);
    });
});

describe("history emission — multi-command sequence", () => {
    test("three mutations produce three ordered entries", async () => {
        const kindle = makeFakeKindle();
        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: true\nhome_dir: /mnt/books\n");

        const { env: e1 } = makeEnv(workdir, kindle.root);
        await main(["apply"], e1);

        const { env: e2 } = makeEnv(workdir, kindle.root);
        await main(["snapshot", "--output", join(workdir, "snap.tar.gz")], e2);

        writeFileSync(join(workdir, "kindly.yaml"),
            "night_mode: false\nhome_dir: /mnt/books\n");
        const { env: e3 } = makeEnv(workdir, kindle.root);
        await main(["apply"], e3);

        const entries = readHistory(workdir);
        expect(entries.map((e) => e.cmd)).toEqual(["apply", "snapshot", "apply"]);
    });
});
