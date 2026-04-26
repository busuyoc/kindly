// In-progress markers for crash detection. C10.
//
// Apply / setup-import / rollback all run a multi-step pipeline:
//   safeWrite (6 atomic-rename steps) → appendHistoryEntry
//
// A SIGKILL anywhere in the safeWrite pipeline OR between safeWrite
// returning and the history append leaves the device in a state that
// looks consistent on disk (`.old` covers KOReader's loader fallback)
// but loses the audit trail entirely — there's no record kindly ever
// touched the device. S680/S1180/S1181 confirmed this empirically:
// kill at any of the 6 steps drops the history line.
//
// Mitigation: write a crash-recovery marker BEFORE the pipeline starts,
// delete it AFTER history is appended. If the process dies anywhere in
// between, the marker survives and `kindly doctor` reports it as
// `progress.crashed_apply`.
//
// Per-PID + ISO-timestamped filename so concurrent invocations don't
// collide and so doctor can show "started 4h ago" if the marker is
// stale.

import { mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliEnv } from "../cli/env.ts";
import type { MountFingerprint } from "../device/fingerprint.ts";

export interface InProgressPayload {
    cmd: "apply" | "setup:import" | "rollback";
    started_at: string;
    pid: number;
    settings_path: string;
    intended_sha256?: string;
    /** C10a / S1390: physical Kindle identity at marker-write time.
     *  doctor --repair refuses to act on a marker whose mount differs
     *  from the currently-attached device. */
    mount?: MountFingerprint;
    [k: string]: unknown;
}

export function inProgressDir(cwd: string): string {
    return join(cwd, ".kindly", "in-progress");
}

export function writeInProgressMarker(env: CliEnv, payload: InProgressPayload): string {
    const dir = inProgressDir(env.cwd);
    mkdirSync(dir, { recursive: true });
    const stamp = payload.started_at.replace(/[:.]/g, "-");
    const filename = `${payload.cmd.replace(":", "-")}-${payload.pid}-${stamp}.json`;
    const path = join(dir, filename);
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
    return path;
}

export function clearInProgressMarker(path: string): void {
    try {
        unlinkSync(path);
    } catch {
        // Best-effort: a missing marker means the process already
        // recovered or doctor cleaned it up. Either way, don't fail
        // the calling command for a cleanup miss.
    }
    // Best-effort prune of empty directory — keeps doctor scans cheap
    // and `.kindly/in-progress/` from sticking around as litter on
    // long-lived workspaces.
    try {
        rmdirSync(dirname(path));
    } catch {
        // Non-empty (concurrent apply still running) or already gone.
    }
}
