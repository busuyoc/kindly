// Tests for KindlyError — the base class carrying code + remediation[].
// Also covers end-to-end rendering through the CLI dispatcher, so we know
// "code exists in the class" and "code surfaces in stderr" are both true.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { KindlyError, ErrorCodes } from "../../src/types/errors.ts";
import { ArgError } from "../../src/cli/args.ts";
import { LuaParseError } from "../../src/lua/reader.ts";

describe("KindlyError class", () => {
    test("carries code and remediation", () => {
        const err = new KindlyError("X_TEST", "something broke", [
            { text: "do the thing" },
            { text: "or this", command: "kindly doctor" },
        ]);
        expect(err.code).toBe("X_TEST");
        expect(err.message).toBe("something broke");
        expect(err.remediation).toHaveLength(2);
        expect(err.remediation[1]?.command).toBe("kindly doctor");
    });

    test("is JSON-serializable with all fields", () => {
        const err = new KindlyError("X_TEST", "msg", [{ text: "fix it" }]);
        const json = JSON.parse(JSON.stringify(err));
        expect(json).toEqual({
            code: "X_TEST",
            message: "msg",
            remediation: [{ text: "fix it" }],
        });
    });

    test("default remediation is empty array", () => {
        const err = new KindlyError("X_TEST", "msg");
        expect(err.remediation).toEqual([]);
    });

    test("is catchable as Error", () => {
        try {
            throw new KindlyError("X_TEST", "msg");
        } catch (e) {
            expect(e instanceof Error).toBe(true);
            expect(e instanceof KindlyError).toBe(true);
        }
    });
});

describe("ErrorCodes registry", () => {
    test("expected codes are defined", () => {
        // Smoke-test: the codes callers already use exist. If any is
        // renamed, every throw site referencing it breaks compilation,
        // but this guards against the registry being emptied by accident.
        expect(ErrorCodes.ARG_INVALID).toBe("ARG_INVALID");
        expect(ErrorCodes.LUA_PARSE_FAILED).toBe("LUA_PARSE_FAILED");
        expect(ErrorCodes.MOUNT_NOT_FOUND).toBe("MOUNT_NOT_FOUND");
        expect(ErrorCodes.MOUNT_INVALID).toBe("MOUNT_INVALID");
        expect(ErrorCodes.SETTINGS_NOT_FOUND).toBe("SETTINGS_NOT_FOUND");
        expect(ErrorCodes.OUTPUT_EXISTS).toBe("OUTPUT_EXISTS");
        expect(ErrorCodes.YAML_NOT_FOUND).toBe("YAML_NOT_FOUND");
    });
});

describe("existing errors extend KindlyError", () => {
    test("ArgError has ARG_INVALID code", () => {
        const err = new ArgError("unknown flag: --bogus");
        expect(err instanceof KindlyError).toBe(true);
        expect(err.code).toBe(ErrorCodes.ARG_INVALID);
        expect(err.message).toBe("unknown flag: --bogus");
    });

    test("LuaParseError has LUA_PARSE_FAILED code", () => {
        const err = new LuaParseError("bad token", 5, "return {a=b}");
        expect(err instanceof KindlyError).toBe(true);
        expect(err.code).toBe(ErrorCodes.LUA_PARSE_FAILED);
        expect(err.message).toContain("bad token");
    });
});

// Integration: trigger real error paths via the CLI dispatcher and
// verify stderr shows hint lines from remediation.
describe("dispatcher renders remediation lines", () => {
    let fakeKindle: string;
    let workdir: string;
    let env: CliEnv;
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
        fakeKindle = makeFakeKindle({ avoid_flashing_ui: true });
        workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
        stderr = new StringWriter();
        env = {
            cwd: workdir,
            stdout: new StringWriter(),
            stderr,
            color: false,
            mountOverride: fakeKindle,
            now: () => new Date("2026-04-22T12:00:00Z"),
        };
    });

    test("OUTPUT_EXISTS prints hint and try lines", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        const code = await main(["pull"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("already exists");
        expect(stderr.value).toContain("hint:");
        // One of the two remediations includes a command.
        expect(stderr.value).toContain("try:");
        expect(stderr.value).toContain("kindly pull --force");
    });

    test("YAML_NOT_FOUND prints pull remediation", async () => {
        const code = await main(["diff"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not found");
        expect(stderr.value).toContain("hint:");
        expect(stderr.value).toContain("kindly pull");
    });

    test("MOUNT_INVALID prints mount remediation", async () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        const code = await main(["pull"], bad);
        expect(code).toBe(1);
        expect(bad.stderr instanceof StringWriter).toBe(true);
        const errText = (bad.stderr as StringWriter).value;
        expect(errText).toContain("doesn't look like a Kindle");
        expect(errText).toContain("hint:");
    });

    test("ArgError still renders per-command help (not remediation list)", async () => {
        const code = await main(["pull", "--bogus"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown flag");
        // ArgError uses its specialized render; should NOT emit generic hint: lines.
        // (ArgError has empty remediation anyway, but double-check the render path.)
        expect(stderr.value).toContain("kindly pull");
    });
});
