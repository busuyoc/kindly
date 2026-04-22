// Direct tests for executeApply + executeDoctor typed results and their
// --json wrapping via main(). Pair of typedResults.test.ts for pull/diff.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { executeApply } from "../../src/commands/apply.ts";
import { executeDoctor } from "../../src/commands/doctor.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
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
        back_to_exit: "prompt",
        zlibrary_password: "hunter2",
        lastfile: "/mnt/us/Books/a.epub",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeApply typed result", () => {
    test("no-op when device already matches YAML", async () => {
        await main(["pull"], env);
        const result = executeApply({}, env);
        expect(result.mode).toBe("no-op");
        expect(result.changes).toEqual([]);
        expect(result.backupPath).toBeNull();
        expect(result.oldPath).toBeNull();
        expect(result.bytesWritten).toBe(0);
        expect(result.yamlPath).toBe(join(workdir, "kindly.yaml"));
        expect(result.settingsPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua"));
    });

    test("dry-run returns changes without writing", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );

        const result = executeApply({ dryRun: true }, env);
        expect(result.mode).toBe("dry-run");
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]!.kind).toBe("changed");
        expect(result.backupPath).toBeNull();
        expect(result.bytesWritten).toBe(0);
    });

    test("applied writes, returns backup + old + bytes", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );

        const result = executeApply({}, env);
        expect(result.mode).toBe("applied");
        expect(result.changes).toHaveLength(1);
        expect(result.backupPath).toMatch(/\.kindly\/backups\//);
        expect(result.oldPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua.old"));
        expect(result.bytesWritten).toBeGreaterThan(0);
    });

    test("result is JSON-serializable", async () => {
        await main(["pull"], env);
        const result = executeApply({ dryRun: true }, env);
        expect(() => JSON.stringify(result)).not.toThrow();
    });
});

describe("apply --json", () => {
    test("no-op case emits envelope with mode=no-op", async () => {
        await main(["pull"], env);
        stdout.reset();

        const code = await main(["apply", "--json"], env);
        expect(code).toBe(0);

        const { data, status, command } = JSON.parse(stdout.value);
        expect(status).toBe("ok");
        expect(command).toBe("apply");
        expect(data.mode).toBe("no-op");
        expect(data.changes).toEqual([]);
    });

    test("dry-run case emits envelope with mode=dry-run and populated changes", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );
        stdout.reset();

        const code = await main(["apply", "--dry-run", "--json"], env);
        expect(code).toBe(0);
        const { data } = JSON.parse(stdout.value);
        expect(data.mode).toBe("dry-run");
        expect(data.changes).toHaveLength(1);
        expect(data.changes[0].path).toEqual(["avoid_flashing_ui"]);
    });

    test("YAML_NOT_FOUND → structured error envelope on stderr", async () => {
        const code = await main(["apply", "--json"], env);
        expect(code).toBe(1);
        expect(stdout.value).toBe("");
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("YAML_NOT_FOUND");
    });
});

describe("executeDoctor typed result", () => {
    test("all checks pass against a healthy fake kindle", () => {
        const result = executeDoctor(env);
        expect(result.ok).toBe(true);
        expect(result.checks.map((c) => c.id)).toContain("mount");
        expect(result.checks.map((c) => c.id)).toContain("settings_present");
        expect(result.checks.map((c) => c.id)).toContain("settings_parseable");
        expect(result.checks.every((c) => c.ok)).toBe(true);
    });

    test("secretsPresent lists zlibrary_password", () => {
        const result = executeDoctor(env);
        expect(result.secretsPresent).toContain("zlibrary_password");
    });

    test("mount failure short-circuits with a failing mount check", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        const result = executeDoctor(bad);
        expect(result.ok).toBe(false);
        expect(result.checks).toHaveLength(1);
        expect(result.checks[0]!.id).toBe("mount");
        expect(result.checks[0]!.ok).toBe(false);
    });

    test("result is JSON-serializable", () => {
        const result = executeDoctor(env);
        expect(() => JSON.stringify(result)).not.toThrow();
    });
});

describe("doctor --json", () => {
    test("healthy device → ok envelope, exit 0", async () => {
        const code = await main(["doctor", "--json"], env);
        expect(code).toBe(0);
        const { data, status } = JSON.parse(stdout.value);
        expect(status).toBe("ok");
        expect(data.ok).toBe(true);
        expect(Array.isArray(data.checks)).toBe(true);
        expect(data.secretsPresent).toContain("zlibrary_password");
    });

    test("failing mount → envelope with data.ok=false, exit 1", async () => {
        const bad: CliEnv = {
            ...env,
            mountOverride: "/nonexistent/mount",
            stdout: new StringWriter(),
            stderr: new StringWriter(),
        };
        const code = await main(["doctor", "--json"], bad);
        expect(code).toBe(1);
        const { data, status } = JSON.parse((bad.stdout as StringWriter).value);
        // NOTE: status is "ok" because doctor's "mount failed" is a reported
        // result, not a thrown error. The command ran successfully; its
        // verdict is simply that the device is unhealthy.
        expect(status).toBe("ok");
        expect(data.ok).toBe(false);
    });
});
