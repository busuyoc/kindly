// C10b: detect a settings.reader.lua write interrupted between safeWrite
// step-3 (rename original → .old) and step-4 (rename .tmp → original).
//
// Symptom on disk:
//   - settings.reader.lua          missing
//   - settings.reader.lua.old      present, parseable (was the prior good copy)
//   - settings.reader.lua.tmp.<...>  may be present (one or more orphan tmps)
//
// KOReader's loader copes with this state on its own — it falls back to
// .old at boot — so the device is bootable. But every kindly read path
// (pull, diff, doctor, history-show against the on-device file) ENOENTs
// because we look only at the canonical name. Surface a structured error
// pointing at `kindly doctor --repair` (C10c) rather than the raw ENOENT
// the previous code path produced.
//
// Fingerprint check is intentionally narrow: main absent + .old present.
// We don't read or parse anything here — that's `doctor --repair`'s job.
// A stale `.tmp` without a missing main is NOT an interrupted apply (it's
// an orphan from a different kind of failure, S682 / Lead 14 follow-up).

import { existsSync } from "node:fs";

export interface InterruptedApplyState {
    /** Canonical settings path that's currently absent. */
    settingsPath: string;
    /** The .old sibling that survived. */
    oldPath: string;
}

/** Returns the interrupted state when main is absent but `.old` is
 *  present. Returns null otherwise — the common case where either the
 *  file is normal (main present) or the device has no settings at all
 *  (both absent, e.g. fresh KOReader install). */
export function detectInterruptedApply(settingsPath: string): InterruptedApplyState | null {
    if (existsSync(settingsPath)) return null;
    const oldPath = settingsPath + ".old";
    if (!existsSync(oldPath)) return null;
    return { settingsPath, oldPath };
}
