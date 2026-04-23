// Library-level tests for src/lib/doctor.ts. Locks DoctorResult shape and
// the "no printing" contract. Note: doctor's contract is "never throws" —
// mount failure becomes a failing check, not an exception.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeDoctor } from "../../src/lib/doctor.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-"));
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
        zlibrary_password: "hunter2",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-doctor-w-"));
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

describe("executeDoctor (library)", () => {
    test("happy path: all checks pass on a healthy fake kindle", () => {
        const r = executeDoctor(env);
        expect(r.ok).toBe(true);
        expect(r.checks.every((c) => c.ok)).toBe(true);
        expect(r.secretsPresent).toContain("zlibrary_password");
    });

    test("no printing — stdout and stderr stay empty", () => {
        executeDoctor(env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("mount failure becomes a failing check (no throw)", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        expect(() => executeDoctor(bad)).not.toThrow();
        const r = executeDoctor(bad);
        expect(r.ok).toBe(false);
        expect(r.checks[0]!.id).toBe("mount");
        expect(r.checks[0]!.ok).toBe(false);
        // 90 §2: mount-missing is fatal (kindly can't function).
        expect(r.checks[0]!.severity).toBe("fatal");
    });
});

describe("executeDoctor — 90 §2/§4 severity taxonomy + exit policy", () => {
    test("every check carries severity and category", () => {
        const r = executeDoctor(env);
        for (const c of r.checks) {
            expect(["fatal", "error", "warning", "info"]).toContain(c.severity);
            expect(typeof c.category).toBe("string");
            expect(c.category.length).toBeGreaterThan(0);
        }
    });

    test("legacy `ok` field is derived from severity (back-compat §4.1)", () => {
        const r = executeDoctor(env);
        for (const c of r.checks) {
            const expected = c.severity === "fatal" || c.severity === "error"
                ? false : true;
            expect(c.ok).toBe(expected);
        }
    });

    test("DoctorResult.ok = no fatal/error findings (§2 exit policy)", () => {
        // Healthy kindle: all info → ok.
        expect(executeDoctor(env).ok).toBe(true);

        // Mount missing: one fatal → !ok.
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        expect(executeDoctor(bad).ok).toBe(false);
    });

    test("checks are ordered (severity desc, category asc, id asc) §4.2", () => {
        const bad: CliEnv = { ...env, mountOverride: "/nonexistent/mount" };
        const r = executeDoctor(bad);
        // Fatal checks come first.
        const severities = r.checks.map((c) => c.severity);
        const firstNonFatal = severities.findIndex((s) => s !== "fatal");
        const afterFatal = firstNonFatal < 0
            ? []
            : severities.slice(firstNonFatal);
        expect(afterFatal.every((s) => s !== "fatal")).toBe(true);
    });

    test("mount category is 'mount'; settings checks are 'settings'", () => {
        const r = executeDoctor(env);
        const cats = Object.fromEntries(r.checks.map((c) => [c.id, c.category]));
        expect(cats.mount).toBe("mount");
        expect(cats.settings_present).toBe("settings");
        expect(cats.settings_parseable).toBe("settings");
        expect(cats.old_parseable).toBe("settings");
    });

    test("corrupt .old → warning (not fatal): KOReader fallback, kindly itself fine", () => {
        // Seed a corrupt .old next to the healthy settings file.
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        writeFileSync(settingsPath + ".old", "return { not valid lua");

        const r = executeDoctor(env);
        const oldCheck = r.checks.find((c) => c.id === "old_parseable")!;
        expect(oldCheck.severity).toBe("warning");
        // Overall result still ok — kindly keeps working.
        expect(r.ok).toBe(true);
    });
});
