// `.kindly/kindly.lock` — process-exclusive lock for mutating commands.
//
// Why: two `kindly apply` processes against the same cwd / mount can
// interleave at safeWrite (S981 — both racing on a shared `.tmp` name)
// and at history append (S1421 — torn writes on >PIPE_BUF entries).
// Per-PID tmp paths and atomic-rename history close those windows
// individually; the lockfile gives serial ordering for everything else
// (gate state, in-progress markers, backup rotation timestamps).
//
// Scope: mutating commands only — apply, setup:import, rollback,
// restore, snapshot. Read-only commands (pull, diff, history, watch,
// doctor) deliberately stay lock-free per Angle CC §S1427: holding the
// lock for `kindly history` would block apply for the duration of a
// human reading their log.
//
// Design: exclusive create with `O_WRONLY | O_CREAT | O_EXCL` (Node's
// "wx" flag). Portable across darwin / linux / win32, no flock(2)
// dependency. The lock payload records pid + cmd + start time so that
// stale-lock detection can read it: if the holding pid is dead
// (`process.kill(pid, 0)` → ESRCH), we treat the lock as abandoned and
// take it over. EPERM (process exists in another uid namespace) means
// the process is alive — we don't take over.
//
// One retry after stale cleanup is sufficient: if a third process beat
// us to the cleanup we surface LOCK_HELD rather than spin.

import {
    closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CliEnv } from "../cli/env.ts";
import { ErrorCodes, KindlyError } from "../types/errors.ts";

export interface LockHandle {
    path: string;
    fd: number;
}

interface LockPayload {
    pid: number;
    cmd: string;
    started_at: string;
}

export function lockPath(cwd: string): string {
    return join(cwd, ".kindly", "kindly.lock");
}

export function acquireLock(env: CliEnv, cmd: string): LockHandle {
    const path = lockPath(env.cwd);
    mkdirSync(dirname(path), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(path, "wx");
            const payload: LockPayload = {
                pid: process.pid,
                cmd,
                started_at: env.now().toISOString(),
            };
            writeSync(fd, JSON.stringify(payload) + "\n");
            return { path, fd };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }

        // Lock file present — check whether the holder is still alive.
        const holder = readHolder(path);
        if (holder && isPidAlive(holder.pid)) {
            throw new KindlyError(
                ErrorCodes.LOCK_HELD,
                `another kindly process holds the lock: pid ${holder.pid} ` +
                `(${holder.cmd}, started ${holder.started_at})`,
                [
                    { text: "Wait for the other process to finish, or stop it." },
                    {
                        text: "If you're sure no kindly is running, remove the lock file.",
                        command: `rm ${path}`,
                    },
                ],
            );
        }
        if (!holder) {
            // Empty / unparseable lock file. Could be a partial write from a
            // killed process that died between create and writeSync, or a
            // file someone touched by hand. Treat as stale and clear.
            try { unlinkSync(path); } catch { /* race with another acquirer */ }
            continue;
        }
        // Holder is dead — take it over.
        try { unlinkSync(path); } catch { /* race */ }
    }

    throw new KindlyError(
        ErrorCodes.LOCK_HELD,
        `failed to acquire ${path} after stale-lock cleanup; another process may be racing`,
        [{ text: "Retry in a moment, or remove the lock file manually." }],
    );
}

export function releaseLock(handle: LockHandle): void {
    try { closeSync(handle.fd); } catch { /* fd may already be closed */ }
    try { unlinkSync(handle.path); } catch { /* lock may have been cleaned up by another process */ }
}

/** Run `fn` while holding the lock. Releases on success and on throw. */
export function withLock<T>(env: CliEnv, cmd: string, fn: () => T): T {
    const handle = acquireLock(env, cmd);
    try {
        return fn();
    } finally {
        releaseLock(handle);
    }
}

function readHolder(path: string): LockPayload | null {
    try {
        const raw = readFileSync(path, "utf8");
        const line = raw.split("\n")[0] ?? "";
        if (line.length === 0) return null;
        const parsed = JSON.parse(line) as Partial<LockPayload>;
        if (typeof parsed.pid !== "number") return null;
        return {
            pid: parsed.pid,
            cmd: typeof parsed.cmd === "string" ? parsed.cmd : "?",
            started_at: typeof parsed.started_at === "string" ? parsed.started_at : "?",
        };
    } catch {
        return null;
    }
}

function isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // EPERM: process exists but we can't signal it (different uid).
        // Treat as alive — we have no business taking over its lock.
        if (code === "EPERM") return true;
        return false;
    }
}
