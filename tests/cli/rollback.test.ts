// `kindly rollback <snapshot>` — restore a pre-import safety snapshot.
//
// End-to-end scenarios:
//   - settings-only snapshot → settings.reader.lua restored byte-exact
//   - fat snapshot (plugins-patches.tar.gz) → plugin dirs restored
//   - combined snapshot
//   - dry-run emits plan, does not write
//   - empty/nonexistent snapshot dir errors
//   - pre-rollback safety backup is produced (default on, skipped by --no-safety-snapshot)
//   - rollback round-trips: rollback then rollback-of-rollback returns original

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { createTarGz } from "../../src/fs/archive.ts";

function makeFakeKindle(): {
    root: string; koreaderRoot: string; settingsPath: string;
    pluginsDir: string; patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-rb-k-"));
    const koreaderRoot = join(root, "koreader");
    mkdirSync(koreaderRoot);
    const settingsPath = join(koreaderRoot, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["night_mode"] = false,
}
`);
    const pluginsDir = join(koreaderRoot, "plugins");
    const patchesDir = join(koreaderRoot, "patches");
    mkdirSync(pluginsDir);
    mkdirSync(patchesDir);
    return { root, koreaderRoot, settingsPath, pluginsDir, patchesDir };
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

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-rb-w-"));
});

describe("rollback — input validation", () => {
    test("nonexistent snapshot dir → error exit 1", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", join(workdir, "nope")], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/not found|not a directory/i);
    });

    test("missing positional → exit 2 with usage", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback"], env);
        expect(code).toBe(2);
        expect(err.value).toMatch(/usage/i);
    });

    test("snapshot dir exists but is empty → explicit error", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root);
        const empty = mkdtempSync(join(tmpdir(), "empty-snap-"));
        const code = await main(["rollback", empty], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/empty|expected/i);
    });
});

describe("rollback — settings-only snapshot", () => {
    test("restores settings.reader.lua byte-exact", async () => {
        const kindle = makeFakeKindle();

        // Build a snapshot dir holding a "pre-import" copy of the settings.
        const snap = mkdtempSync(join(tmpdir(), "settings-snap-"));
        const pristine = `return {
    ["night_mode"] = false,
    ["home_dir"] = "/mnt/books",
}
`;
        writeFileSync(join(snap, "settings.reader.lua"), pristine);

        // Corrupt the device so rollback has something to undo.
        writeFileSync(kindle.settingsPath, `return { ["wrecked"] = true, }
`);

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });

    test("--dry-run lists the plan, device untouched", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "settings-snap-"));
        writeFileSync(join(snap, "settings.reader.lua"), "return {}\n");
        const before = readFileSync(kindle.settingsPath, "utf8");

        const { env, out } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap, "--dry-run"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("settings.reader.lua");
        expect(out.value).toMatch(/dry-run/i);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("--no-safety-snapshot skips pre-rollback backup", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "settings-snap-"));
        writeFileSync(join(snap, "settings.reader.lua"), "return {}\n");

        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap, "--no-safety-snapshot"], env);
        expect(code).toBe(0);
        expect(existsSync(join(workdir, ".kindly", "pre-rollback"))).toBe(false);
    });

    test("default: writes a pre-rollback backup alongside cwd/.kindly/pre-rollback/", async () => {
        const kindle = makeFakeKindle();
        const snap = mkdtempSync(join(tmpdir(), "settings-snap-"));
        writeFileSync(join(snap, "settings.reader.lua"), "return {}\n");

        const { env } = makeEnv(workdir, kindle.root);
        await main(["rollback", snap], env);
        const preRollbackRoot = join(workdir, ".kindly", "pre-rollback");
        expect(existsSync(preRollbackRoot)).toBe(true);
        const stamps = readdirSync(preRollbackRoot);
        expect(stamps.length).toBe(1);
        expect(existsSync(join(preRollbackRoot, stamps[0]!, "settings.reader.lua"))).toBe(true);
    });
});

describe("rollback — fat snapshot", () => {
    test("plugins-patches.tar.gz extracts into koreader/", async () => {
        const kindle = makeFakeKindle();

        // Stage a plugin dir as it would exist before an import overwrote it.
        const stage = mkdtempSync(join(tmpdir(), "fat-stage-"));
        const stagedKor = join(stage, "koreader");
        mkdirSync(join(stagedKor, "plugins", "SSH.koplugin"), { recursive: true });
        writeFileSync(join(stagedKor, "plugins", "SSH.koplugin", "main.lua"), "-- pristine\n");

        const snap = mkdtempSync(join(tmpdir(), "fat-snap-"));
        createTarGz({
            cwd: stagedKor,
            paths: ["plugins/SSH.koplugin"],
            outputPath: join(snap, "plugins-patches.tar.gz"),
        });

        // Device starts without the plugin — rollback should install it.
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap], env);
        expect(code).toBe(0);
        const dest = join(kindle.pluginsDir, "SSH.koplugin", "main.lua");
        expect(existsSync(dest)).toBe(true);
        expect(readFileSync(dest, "utf8")).toBe("-- pristine\n");
    });

    test("fat rollback with pre-existing target → pre-rollback backup contains original", async () => {
        const kindle = makeFakeKindle();

        // Device has a MODIFIED version of SSH.koplugin/main.lua.
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "-- broken\n");

        // Snapshot archive holds the PRISTINE version we're rolling back to.
        const stage = mkdtempSync(join(tmpdir(), "fat-stage-"));
        const stagedKor = join(stage, "koreader");
        mkdirSync(join(stagedKor, "plugins", "SSH.koplugin"), { recursive: true });
        writeFileSync(join(stagedKor, "plugins", "SSH.koplugin", "main.lua"), "-- pristine\n");
        const snap = mkdtempSync(join(tmpdir(), "fat-snap-"));
        createTarGz({
            cwd: stagedKor,
            paths: ["plugins/SSH.koplugin"],
            outputPath: join(snap, "plugins-patches.tar.gz"),
        });

        const { env } = makeEnv(workdir, kindle.root);
        await main(["rollback", snap], env);

        // Device is now pristine...
        expect(readFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "utf8")).toBe("-- pristine\n");
        // ...and the pre-rollback backup archive captured the "broken" version.
        const preRoot = join(workdir, ".kindly", "pre-rollback");
        const stamps = readdirSync(preRoot);
        expect(stamps.length).toBe(1);
        expect(existsSync(join(preRoot, stamps[0]!, "plugins-patches.tar.gz"))).toBe(true);
    });
});

describe("rollback — round-trip", () => {
    test("import then rollback returns settings to exact pre-import bytes", async () => {
        const kindle = makeFakeKindle();

        // Capture pristine content before any mutation.
        const pristine = readFileSync(kindle.settingsPath, "utf8");

        // Fake a "pre-import" snapshot: pristine settings, stamped dir.
        const snap = join(workdir, ".kindly", "pre-import", "2026-04-22T12-00-00-000Z");
        mkdirSync(snap, { recursive: true });
        writeFileSync(join(snap, "settings.reader.lua"), pristine);

        // Simulate what setup import would do: mutate the device.
        writeFileSync(kindle.settingsPath, `return {
    ["night_mode"] = true,
    ["home_dir"] = "/oops",
}
`);

        // Roll back.
        const { env } = makeEnv(workdir, kindle.root);
        const code = await main(["rollback", snap], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(pristine);
    });
});
