// Unit tests for the .kindly/kindly.lock process-exclusive lockfile (C3).

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    acquireLock, lockPath, releaseLock, withLock,
} from "../../src/fs/lockfile.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { KindlyError } from "../../src/types/errors.ts";

let workdir: string;
let env: CliEnv;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-lock-"));
    env = {
        cwd: workdir,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        now: () => new Date("2026-04-25T12:00:00Z"),
    };
});

describe("acquireLock / releaseLock", () => {
    test("creates the lockfile under .kindly/", () => {
        const h = acquireLock(env, "apply");
        expect(existsSync(lockPath(workdir))).toBe(true);
        expect(h.path).toBe(lockPath(workdir));
        const payload = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0]!);
        expect(payload.cmd).toBe("apply");
        expect(payload.pid).toBe(process.pid);
        releaseLock(h);
    });

    test("releaseLock removes the lockfile", () => {
        const h = acquireLock(env, "apply");
        releaseLock(h);
        expect(existsSync(lockPath(workdir))).toBe(false);
    });

    test("second acquire while held throws LOCK_HELD with our own pid", () => {
        const h = acquireLock(env, "apply");
        try {
            expect(() => acquireLock(env, "apply")).toThrow(KindlyError);
            try { acquireLock(env, "apply"); }
            catch (e) {
                expect((e as KindlyError).code).toBe("LOCK_HELD");
                expect((e as Error).message).toContain(`pid ${process.pid}`);
            }
        } finally {
            releaseLock(h);
        }
    });

    test("re-acquires when the lockfile names a dead pid (stale takeover)", () => {
        // Plant a lock file claiming a pid that doesn't exist.
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        const dead = 999999;
        writeFileSync(
            lockPath(workdir),
            JSON.stringify({ pid: dead, cmd: "apply", started_at: "2026-04-24T00:00:00Z" }) + "\n",
        );
        // Sanity: ensure the planted pid really is unknown to the kernel.
        let alive = true;
        try { process.kill(dead, 0); } catch { alive = false; }
        expect(alive).toBe(false);

        const h = acquireLock(env, "apply");
        const payload = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0]!);
        expect(payload.pid).toBe(process.pid);
        releaseLock(h);
    });

    test("re-acquires when the lockfile is empty (partial-write artifact)", () => {
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        writeFileSync(lockPath(workdir), "");
        const h = acquireLock(env, "apply");
        expect(JSON.parse(readFileSync(h.path, "utf8").split("\n")[0]!).pid).toBe(process.pid);
        releaseLock(h);
    });
});

describe("withLock", () => {
    test("releases on success", () => {
        const r = withLock(env, "apply", () => 42);
        expect(r).toBe(42);
        expect(existsSync(lockPath(workdir))).toBe(false);
    });

    test("releases on throw", () => {
        expect(() => withLock(env, "apply", () => {
            throw new Error("boom");
        })).toThrow("boom");
        expect(existsSync(lockPath(workdir))).toBe(false);
    });

    test("nested mutating commands in same process are blocked", () => {
        expect(() =>
            withLock(env, "apply", () => {
                withLock(env, "rollback", () => 1);
            })
        ).toThrow(KindlyError);
    });
});
