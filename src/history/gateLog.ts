// Gate-firing observability log at `.kindly/gate-events.jsonl`.
//
// Separate from history.jsonl on purpose:
//   • history.jsonl records MUTATIONS (apply, import, snapshot, restore,
//     rollback). Its index field is load-bearing for `rollback --to N`
//     and `kindly history show`. Polluting that stream with per-gate
//     rows would inflate the index space and confuse rollback lookups.
//   • Gate events are observability — who bypassed which safety check,
//     how often, when. Different audience (doctor, future security
//     dashboard) and different volume (multiple per command).
//
// Volume: orchestrator logs BYPASS + BLOCK + WARN events only. PASS
// events are the common case and too noisy to record. A typical import
// fires ~12 gates and logs maybe 0–2 events (bypass via --accept-*,
// block if the operation is refused, or warn for advisory heuristics).
// Apply fires 1 gate and logs 0–1.
//
// No rotation yet (we're observing cadence before deciding a policy).
// Append-only; readers tolerate partial-last-line per the W15 rule.
//
// Consumed by kindly doctor (Step 15) to surface "N gates bypassed in
// the last 30 days" as a warning if N exceeds a threshold.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FiredGate } from "../gates/orchestrator.ts";
import type { GateBoundary } from "../gates/types.ts";

export interface GateEvent {
    ts: string;
    /** Gate id (registry key, e.g. "SENSITIVE_REQUIRES_ACK"). */
    gate_id: string;
    /** Trust boundary the gate fired at. */
    boundary: GateBoundary;
    /** Outcome: bypass means a flag dissolved a block; warn is a
     *  non-bypassable advisory (S605). */
    kind: "bypass" | "block" | "warn";
    /** For bypass: the flag that matched (e.g. "--accept-sensitive"). */
    bypass_flag?: string;
    /** Short summary — for SENSITIVE gates, list of hit paths (trimmed). */
    context_summary?: Record<string, unknown>;
}

/** Translate a FiredGate into a loggable GateEvent shape, or `null` for
 *  `pass` outcomes (which are too noisy to record). Single source of
 *  truth for the FiredGate→GateEvent mapping — used by every command's
 *  `logger:` callback so warn/block/bypass all log uniformly. */
export function gateEventFromFiredGate(
    fired: FiredGate,
): Omit<GateEvent, "ts"> | null {
    const base = { gate_id: fired.id, boundary: fired.boundary };
    switch (fired.result.kind) {
        case "pass":
            return null;
        case "bypass":
            return { ...base, kind: "bypass", bypass_flag: fired.result.byFlag };
        case "block":
            return { ...base, kind: "block" };
        case "warn":
            return { ...base, kind: "warn" };
    }
}

export function gateLogPath(cwd: string): string {
    return join(cwd, ".kindly", "gate-events.jsonl");
}

interface AppendEnv {
    cwd: string;
    now: () => Date;
}

/**
 * Append one gate event. Swallows write errors — kindly's mutations
 * themselves must not fail because an observability log was unwritable.
 * (Contrast history.jsonl which THROWS on write failure because the
 * mutation's audit trail is load-bearing.)
 */
export function appendGateEvent(
    env: AppendEnv,
    event: Omit<GateEvent, "ts">,
): void {
    const p = gateLogPath(env.cwd);
    try {
        mkdirSync(dirname(p), { recursive: true });
        const line = JSON.stringify({ ts: env.now().toISOString(), ...event }) + "\n";
        const fd = openSync(p, "a");
        try {
            writeSync(fd, line);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    } catch {
        // Observability — best-effort only.
    }
}
