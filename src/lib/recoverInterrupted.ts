// R8 (review hardening): TTY-prompt recovery for interrupted-apply state.
//
// Background: when safeWrite is interrupted between rename steps, the
// device is left with `settings.reader.lua` absent and `.old` present.
// KOReader's loader copes (it falls back to .old); kindly's read paths
// don't (they ENOENT on the canonical name). Pre-R8, every pull/diff/
// apply on this state threw `SETTINGS_INTERRUPTED_APPLY` pointing the
// user at `kindly doctor --repair`. Two-step recovery is friction at
// the worst possible moment — the target user (crash-recovery, device
// upgraders) is already stressed.
//
// R8 makes recovery one step on TTY:
//   - --auto-repair (any context): run repair, continue.
//   - TTY (default): prompt "[Y/n]"; "y"/"" → repair + continue;
//                    "n" → throw the structured error.
//   - non-TTY (default): throw (script-friendly; CI doesn't get an
//                        unexpected mutation).
//   - --json (any context): throw (structured envelope path is sacred).
//
// `executeDoctorRepair` is non-destructive in the recovery sense — it
// promotes a hash-matched `.tmp` or restores `.old`. No data is lost.

import { readSync } from "node:fs";
import type { CliEnv } from "../cli/env.ts";
import type { InterruptedApplyState } from "../fs/interruptedApply.ts";
import { executeDoctorRepair } from "./doctorRepair.ts";

export interface RecoverOptions {
    /** True: run repair without prompting. False: throw without prompting.
     *  Undefined (default): prompt on TTY, throw otherwise. */
    autoRepair?: boolean;
    /** Test injection. Replaces the TTY prompt with a deterministic
     *  function. Production never passes this. */
    promptInjector?: (question: string) => string;
}

export type RecoverDecision = "repaired" | "throw";

/** Decide whether to recover an interrupted-apply state automatically,
 *  via interactive prompt, or punt to the caller (throw). On "repaired"
 *  the caller should re-detect / continue; on "throw" the caller should
 *  surface `SETTINGS_INTERRUPTED_APPLY` with the original remediation. */
export function handleInterruptedApply(
    state: InterruptedApplyState,
    env: CliEnv,
    opts: RecoverOptions = {},
): RecoverDecision {
    if (opts.autoRepair === true) {
        env.stderr.write(
            `kindly: recovering interrupted apply (--auto-repair)\n` +
            `  ${state.settingsPath} missing; ${state.oldPath} survives\n`,
        );
        executeDoctorRepair({}, env);
        return "repaired";
    }
    // --json mode: structured envelope path. Never prompt — JSON consumers
    // are scripts that can't answer interactive questions. Same for
    // explicit --no-auto-repair (autoRepair === false), should that be
    // wired in a future iteration.
    if (opts.autoRepair === false) return "throw";
    if (env.jsonMode) return "throw";
    if (!isTty(env)) return "throw";

    const prompt =
        `\nkindly: detected interrupted apply\n` +
        `  ${state.settingsPath} missing; ${state.oldPath} survives.\n` +
        `Run 'kindly doctor --repair' to recover now? [Y/n] `;
    const answerRaw = (opts.promptInjector ?? defaultPrompt)(prompt);
    const answer = answerRaw.trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
        executeDoctorRepair({}, env);
        return "repaired";
    }
    return "throw";
}

function isTty(env: CliEnv): boolean {
    // CliEnv may carry an explicit `tty` flag for test injection. Fall
    // back to process.stdin.isTTY at runtime.
    const explicit = (env as CliEnv & { tty?: boolean }).tty;
    if (typeof explicit === "boolean") return explicit;
    return Boolean(process.stdin.isTTY);
}

function defaultPrompt(question: string): string {
    process.stdout.write(question);
    const buf = Buffer.alloc(256);
    try {
        const n = readSync(0, buf, 0, 256, null);
        return buf.subarray(0, n).toString("utf8");
    } catch {
        // EBADF, EAGAIN, EOF — fall back to "no": refuse the recovery
        // rather than guess. The caller surfaces the structured error.
        return "n";
    }
}
