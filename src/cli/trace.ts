// Opt-in self-dogfooding trace. Writes one line per invocation to
// `.kindly/trace.jsonl` when `KINDLY_TRACE=1` is set (or env.trace is true in
// tests). Disabled by default — this is strictly for Claudiu to measure his
// own friction, not telemetry.
//
// Entry shape (one JSON object per line):
//   {
//     "ts": "2026-04-22T12:00:00.000Z",
//     "cmd": "pull",
//     "argv_hash": "a1b2c3d4e5f6",    // sha256[:12], never raw argv
//     "duration_ms": 87,
//     "exit_code": 0,
//     "warnings_n": 0
//   }
//
// argv is never stored verbatim: a user may pass `--token sk-xxx` or similar
// in a flag value. We only keep a short hash so repeated invocations of the
// same argv correlate, without leaking contents.
//
// Rotation: when the active file would cross 10MB, it's renamed into
// `.kindly/trace-archive/<ts>.jsonl` and a fresh active file is started.
// All I/O failures are swallowed — a trace write must never break a command.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CliEnv } from "./env.ts";

export const TRACE_ROTATE_BYTES = 10 * 1024 * 1024;

export interface TraceEntry {
    ts: string;
    cmd: string;
    argv_hash: string;
    duration_ms: number;
    exit_code: number;
    warnings_n: number;
}

export function hashArgv(argv: readonly string[]): string {
    return createHash("sha256")
        .update(JSON.stringify(argv))
        .digest("hex")
        .slice(0, 12);
}

export function writeTraceEntry(env: CliEnv, entry: TraceEntry): void {
    try {
        const dir = resolve(env.cwd, ".kindly");
        const file = join(dir, "trace.jsonl");
        mkdirSync(dir, { recursive: true });

        if (existsSync(file) && statSync(file).size >= TRACE_ROTATE_BYTES) {
            const archDir = join(dir, "trace-archive");
            mkdirSync(archDir, { recursive: true });
            const stamp = entry.ts.replace(/[:.]/g, "-");
            renameSync(file, join(archDir, `${stamp}.jsonl`));
        }

        appendFileSync(file, JSON.stringify(entry) + "\n");
    } catch {
        // best-effort
    }
}
