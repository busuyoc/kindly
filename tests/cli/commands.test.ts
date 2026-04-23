// Integration tests that drive the CLI end-to-end against a simulated Kindle.
// A fake mount (tmpdir with koreader/ + settings.reader.lua) plus an injected
// CliEnv gives us full pull → diff → apply round-trips without spawning
// processes. No real Kindle required; these run in CI.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    const settingsPath = join(root, "koreader", "settings.reader.lua");
    writeFileSync(settingsPath, dumpSettingsFile(initialData, "./settings.reader.lua"));
    return root;
}

function makeEnv(cwd: string, mountOverride: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride,
            now: () => new Date("2026-04-21T12:00:00Z"),
        },
        out,
        err,
    };
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({
        avoid_flashing_ui: true,
        back_to_exit: "prompt",
        footer: { align: "left", battery: true } as any,
        plugins_disabled: { SSH: true } as any,
        // secrets — must never leak into YAML
        zlibrary_password: "hunter2",
        pinpadlock_pin_code: "1980",
        device_id: "ABC123",
        // ephemerals — dropped in --minimal
        lastfile: "/mnt/us/Books/a.epub",
        last_migration_date: 20260306,
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, fakeKindle));
});

describe("pull", () => {
    test("writes kindly.yaml in cwd by default", async () => {
        const code = await main(["pull"], env);
        expect(code).toBe(0);
        expect(existsSync(join(workdir, "kindly.yaml"))).toBe(true);
    });

    test("filters secrets and warns about them", async () => {
        await main(["pull"], env);
        const yaml = readFileSync(join(workdir, "kindly.yaml"), "utf8");
        expect(yaml).not.toContain("hunter2");
        expect(yaml).not.toContain("1980");
        expect(yaml).not.toContain("ABC123");
        expect(stderr.value).toContain("filtered");
        // secret key names are printed as an indented list to stdout
        expect(stdout.value).toContain("zlibrary_password");
    });

    test("--minimal drops ephemerals", async () => {
        await main(["pull"], env);
        const yaml = readFileSync(join(workdir, "kindly.yaml"), "utf8");
        expect(yaml).not.toContain("lastfile");
        expect(yaml).not.toContain("last_migration_date");
    });

    test("--full keeps ephemerals but still drops secrets", async () => {
        await main(["pull", "--full"], env);
        const yaml = readFileSync(join(workdir, "kindly.yaml"), "utf8");
        expect(yaml).toContain("lastfile");
        expect(yaml).not.toContain("hunter2");
    });

    test("refuses to overwrite without --force", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        const code = await main(["pull"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("already exists");
        expect(readFileSync(join(workdir, "kindly.yaml"), "utf8")).toBe("already here");
    });

    test("--force overwrites", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        const code = await main(["pull", "--force"], env);
        expect(code).toBe(0);
        expect(readFileSync(join(workdir, "kindly.yaml"), "utf8")).not.toBe("already here");
    });

    test("custom --output", async () => {
        await main(["pull", "--output", "my-config.yaml"], env);
        expect(existsSync(join(workdir, "my-config.yaml"))).toBe(true);
    });
});

describe("diff", () => {
    test("after pull, diff reports no changes (exit 0)", async () => {
        await main(["pull"], env);
        const code = await main(["diff"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no differences");
    });

    test("modified YAML shows changes (exit 1)", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        const yaml = readFileSync(yamlPath, "utf8")
            .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false");
        writeFileSync(yamlPath, yaml);

        const code = await main(["diff"], env);
        expect(code).toBe(1);
        expect(stdout.value).toContain("avoid_flashing_ui");
        expect(stdout.value).toContain("true");
        expect(stdout.value).toContain("false");
    });

    test("reports count of untracked on-device keys", async () => {
        await main(["pull"], env);
        const code = await main(["diff"], env);
        expect(stdout.value).toMatch(/on-device key\(s\) not tracked/);
    });

    test("missing YAML is an error", async () => {
        const code = await main(["diff"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not found");
    });
});

describe("apply", () => {
    test("no-op when YAML matches device", async () => {
        await main(["pull"], env);
        const before = readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no changes");
        // Device file unchanged
        expect(readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8"))
            .toBe(before);
    });

    test("--dry-run shows changes but doesn't write", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false")
        );
        const before = readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8");
        const code = await main(["apply", "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("avoid_flashing_ui");
        expect(stdout.value).toContain("--dry-run");
        expect(readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8"))
            .toBe(before);
    });

    test("writes changes and preserves secrets", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false")
        );

        const code = await main(["apply"], env);
        expect(code).toBe(0);

        const afterSrc = readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8");
        const afterParsed = parseSettingsFile(afterSrc) as Record<string, unknown>;

        expect(afterParsed.avoid_flashing_ui).toBe(false);
        // The critical invariant — secrets survive apply even though they
        // were never in the YAML we applied from:
        expect(afterParsed.zlibrary_password).toBe("hunter2");
        expect(afterParsed.pinpadlock_pin_code).toBe("1980");
        expect(afterParsed.device_id).toBe("ABC123");
        // Ephemerals survive too
        expect(afterParsed.lastfile).toBe("/mnt/us/Books/a.epub");
    });

    test("creates .old sibling (KOReader's own fallback path)", async () => {
        await main(["pull"], env);
        writeFileSync(
            join(workdir, "kindly.yaml"),
            readFileSync(join(workdir, "kindly.yaml"), "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false")
        );
        await main(["apply"], env);
        expect(existsSync(join(fakeKindle, "koreader", "settings.reader.lua.old"))).toBe(true);
    });

    test("creates a backup snapshot under --backup-dir", async () => {
        await main(["pull"], env);
        writeFileSync(
            join(workdir, "kindly.yaml"),
            readFileSync(join(workdir, "kindly.yaml"), "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false")
        );
        await main(["apply"], env);
        expect(existsSync(join(workdir, ".kindly", "backups"))).toBe(true);
    });

    test("nested tables: YAML overrides one field, keeps the others", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        // Change footer.align only. footer.battery must survive.
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8").replace(
                /footer:\n  align: left\n  battery: true/,
                "footer:\n  align: center\n  battery: true"
            )
        );
        await main(["apply"], env);
        const after = parseSettingsFile(
            readFileSync(join(fakeKindle, "koreader", "settings.reader.lua"), "utf8")
        ) as any;
        expect(after.footer.align).toBe("center");
        expect(after.footer.battery).toBe(true);
    });
});

describe("init", () => {
    test("minimal preset writes a valid YAML", async () => {
        const code = await main(["init", "minimal"], env);
        expect(code).toBe(0);
        const yaml = readFileSync(join(workdir, "kindly.yaml"), "utf8");
        expect(yaml).toContain("avoid_flashing_ui: true");
        expect(yaml).toContain("plugins_disabled:");
    });

    test("unknown preset errors", async () => {
        const code = await main(["init", "bogus"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("unknown preset");
    });

    test("missing preset name errors", async () => {
        const code = await main(["init"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("usage");
    });
});

describe("doctor", () => {
    test("all green on a healthy fake Kindle", async () => {
        const code = await main(["doctor"], env);
        expect(code).toBe(4);
        expect(stdout.value).toContain("Kindle mount:");
        expect(stdout.value).toContain("settings.reader.lua");
        expect(stdout.value).toContain("parseable");
    });

    test("lists on-device secrets so user knows what to back up elsewhere", async () => {
        await main(["doctor"], env);
        expect(stdout.value).toContain("zlibrary_password");
        expect(stdout.value).toContain("pinpadlock_pin_code");
        expect(stdout.value).toContain("device_id");
    });

    test("fails cleanly when mount doesn't exist", async () => {
        const bad = makeEnv(workdir, "/nonexistent/mount");
        const code = await main(["doctor"], bad.env);
        expect(code).toBe(1);
        // doctor renders its own check lines to stdout (they're output, not
        // error messages — doctor's job is to describe what's wrong).
        expect(bad.out.value).toContain("Kindle mount");
        expect(bad.out.value).toContain("doesn't look like a Kindle");
    });
});

describe("top-level dispatcher", () => {
    test("--help prints overview", async () => {
        const code = await main(["--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly");
        expect(stdout.value).toContain("pull");
        expect(stdout.value).toContain("apply");
    });

    test("unknown command exits 2 with help", async () => {
        const code = await main(["nope"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown command");
    });

    test("unknown flag on a command exits 2 with per-command help", async () => {
        const code = await main(["pull", "--bogus"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown flag");
        expect(stderr.value).toContain("kindly pull");
    });

    test("per-command --help", async () => {
        const code = await main(["pull", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly pull");
    });

    test("--version prints the version and exits 0", async () => {
        const code = await main(["--version"], env);
        expect(code).toBe(0);
        expect(stdout.value).toMatch(/^kindly \d+\.\d+\.\d+\s*$/);
    });

    test("-v is a short alias for --version", async () => {
        const code = await main(["-v"], env);
        expect(code).toBe(0);
        expect(stdout.value).toMatch(/^kindly \d+\.\d+\.\d+/);
    });

    test("kindly help <cmd> prints that command's help", async () => {
        const code = await main(["help", "pull"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly pull");
        expect(stdout.value).toContain("--full");
    });

    test("kindly help <cmd> works for setup (subcommand dispatcher)", async () => {
        const code = await main(["help", "setup"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly setup");
        expect(stdout.value).toContain("export");
        expect(stdout.value).toContain("import");
    });

    test("kindly help <unknown> exits 2 with top-level help", async () => {
        const code = await main(["help", "nope"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown command");
    });

    test("bare kindly help falls back to top-level overview", async () => {
        const code = await main(["help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly");
        expect(stdout.value).toContain("pull");
    });

    test("top-level help groups commands by category", async () => {
        const code = await main(["--help"], env);
        expect(code).toBe(0);
        // All v0.3 commands still listed somewhere in the grouped output.
        for (const cmd of ["pull", "apply", "diff", "init", "doctor", "snapshot", "restore", "setup"]) {
            expect(stdout.value).toContain(cmd);
        }
        // The new categories are visible.
        expect(stdout.value).toMatch(/Device state/);
        expect(stdout.value).toMatch(/Shareable Setups/);
    });
});
