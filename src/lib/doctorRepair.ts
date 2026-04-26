// `kindly doctor --repair` — recover from a SIGKILL'd safeWrite or sweep
// orphan .tmp files. Mutating; takes the kindly lock. C10c.
//
// What it fixes:
//
//   1. Step-4 interruption: settings.reader.lua absent, .old present. KOReader
//      still boots from .old, but every kindly read path ENOENTs. We either:
//        - promote a surviving .tmp.<pid>.<rand> file IF its sha256 matches
//          the in-progress marker's intended_sha256 (the apply effectively
//          COMPLETES — the bytes are exactly what apply was about to commit), or
//        - rename .old back to settings.reader.lua (the apply is UNDONE).
//      Choice between the two is data-driven: a hash-matching .tmp is bit-
//      exact what we wanted to write, so promoting it is at least as safe
//      as restoring .old, and preserves the user's intended change.
//
//   2. Orphan tmps: any leftover settings.reader.lua.tmp.<pid>.<rand> in the
//      koreader/ dir, regardless of step-4 state, is removed. These can come
//      from S682-class crashes (step 2 succeeded, step 3 not yet — main
//      survives, .tmp leaks).
//
//   3. In-progress markers (.kindly/in-progress/*.json) are cleared after
//      the recovery decision is made. A marker whose sha256 matched a .tmp
//      we promoted is the closing entry for a successful interrupted apply;
//      one whose sha256 didn't match anything is discarded along with the
//      .old restoration.
//
// Mount-fingerprint check: if the marker carries a recorded fingerprint
// (C10a entries do; pre-C10a markers don't), we refuse to act when the
// currently-attached Kindle differs. This is the same defense as
// rollback's MOUNT_FINGERPRINT_MATCHES gate, applied to crash recovery:
// promoting a different Kindle's intended bytes onto this one would be
// silent cross-contamination of the worst kind.
//
// History: a successful repair appends a `rollback` history entry (the
// closest existing cmd shape — restored prior bytes onto the device) so
// the operation is auditable. We don't add a new HistoryCommand: repair
// is rare, the rollback semantics fit, and growing the union is a
// bigger change than this fix calls for.

import { createHash } from "node:crypto";
import {
    readdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { withLock } from "./../fs/lockfile.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
import { inProgressDir } from "../history/inProgress.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import {
    compareFingerprints, computeMountFingerprint, isFingerprintEmpty,
    type MountFingerprint,
} from "../device/fingerprint.ts";
import type { DoctorRepairResult } from "../types/results.ts";

export interface DoctorRepairOptions {
    dryRun?: boolean;
    /** Mirrors rollback's --force-mount: bypass the marker-vs-current
     *  fingerprint check. Use after a KOReader upgrade between crash
     *  and repair changed /koreader/git-rev. */
    forceMount?: boolean;
    /** Round 3 doctor HIGH (forged-marker promotion):
     *
     *  An in-progress marker is just a JSON file under `.kindly/in-
     *  progress/` and a tmp is a file under `koreader/`. Both
     *  directories are writable by anyone with USB access to the
     *  attached Kindle. A forged marker carrying an attacker-chosen
     *  `intended_sha256` paired with a forged tmp at any path will
     *  hash-match — at which point pre-fix doctor would promote the
     *  attacker's bytes onto the device as the canonical
     *  settings.reader.lua. One-flag RCE.
     *
     *  Default behaviour now restores `.old` in every interrupted
     *  case. Tmp promotion (the auto-recovery path that preserves
     *  the user's intended bytes) is opt-in via this flag. The
     *  remediation message tells the user the safer alternative is
     *  to re-run apply, which is reproducible from the same YAML.
     *  Anyone who explicitly passes --promote-tmp has been advised
     *  by the help text that they're trusting the on-disk marker. */
    promoteTmp?: boolean;
}

export function executeDoctorRepair(
    opts: DoctorRepairOptions,
    env: CliEnv,
): DoctorRepairResult {
    return withLock(env, "doctor:repair", () => executeDoctorRepairLocked(opts, env));
}

interface MarkerOnDisk {
    path: string;
    payload: {
        cmd?: string;
        settings_path?: string;
        intended_sha256?: string;
        mount?: MountFingerprint;
    };
}

function executeDoctorRepairLocked(
    opts: DoctorRepairOptions,
    env: CliEnv,
): DoctorRepairResult {
    const mount = resolveMount(env);
    const settingsPath = mount.settingsPath;
    const koreaderDir = dirname(settingsPath);
    const settingsBase = basename(settingsPath);

    // Inventory: tmps in koreader/, in-progress markers, and the
    // step-4 state (main absent + .old present).
    const tmps = listOrphanTmps(koreaderDir, settingsBase);
    const markers = readMarkers(env);
    const interrupted = detectInterruptedApply(settingsPath);

    // Mount fingerprint: refuse to operate against a Kindle that doesn't
    // match any marker's recorded fingerprint. We only check markers
    // that actually carry one — pre-C10a markers / repairs originating
    // from non-C10a code paths fall through to today's behavior.
    if (!opts.forceMount) {
        const currentFp = computeMountFingerprint(mount);
        for (const m of markers) {
            const recorded = m.payload.mount;
            if (!recorded || isFingerprintEmpty(recorded)) continue;
            const cmp = compareFingerprints(recorded, currentFp);
            if (!cmp.match) {
                throw new KindlyError(
                    ErrorCodes.MOUNT_FINGERPRINT_MISMATCH,
                    `in-progress marker ${m.path} was recorded on a different Kindle:\n  ${cmp.differences.join("\n  ")}`,
                    [
                        { text: "Connect the original Kindle and re-run." },
                        {
                            text: "If you upgraded KOReader between the crash and now, override with --force-mount.",
                            command: "kindly doctor --repair --force-mount",
                        },
                    ],
                );
            }
        }
    }

    // No interruption AND no orphan tmps AND no markers → nothing to do.
    if (!interrupted && tmps.length === 0 && markers.length === 0) {
        return {
            mode: "no-op",
            settingsPath,
            settingsRecovery: "none",
            sweptTmps: [],
            clearedMarkers: [],
        };
    }

    // Round 3 doctor HIGH: tmp promotion is now opt-in. Without
    // --promote-tmp the recovery decision is "restore .old or
    // nothing" — auto-promotion of attacker-controllable bytes is
    // off by default. The user can still recover their intended
    // bytes by re-running `kindly apply <yaml>` (deterministic
    // from the YAML), which is a safer recovery path.
    const promote = opts.promoteTmp ? pickPromotableTmp(markers, tmps) : null;

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            settingsPath,
            settingsRecovery: promote ? "promoted-tmp" : (interrupted ? "restored-old" : "none"),
            sweptTmps: tmps
                .filter((t) => t !== promote?.tmpPath)
                .map((t) => t),
            clearedMarkers: markers.map((m) => m.path),
        };
    }

    let settingsRecovery: DoctorRepairResult["settingsRecovery"] = "none";

    if (promote) {
        // Promote the matching tmp to canonical. If main is somehow
        // present here (concurrent rare race), unlink it first — the
        // marker's hash is the authoritative intended bytes.
        try { unlinkSync(settingsPath); } catch { /* not present, fine */ }
        renameSync(promote.tmpPath, settingsPath);
        settingsRecovery = "promoted-tmp";
    } else if (interrupted) {
        // Restore .old to canonical. KOReader's own boot path already
        // copes with this state; we're closing the kindly-side ENOENT.
        renameSync(interrupted.oldPath, settingsPath);
        settingsRecovery = "restored-old";
    }

    // Sweep every tmp (including the one we just promoted's siblings,
    // if any). Best-effort: a missing file means another process
    // already cleaned it up.
    const swept: string[] = [];
    for (const t of tmps) {
        if (promote && t === promote.tmpPath) continue;
        try {
            unlinkSync(t);
            swept.push(t);
        } catch {
            /* gone already */
        }
    }

    // Clear markers — the recovery decision has been made.
    const cleared: string[] = [];
    for (const m of markers) {
        try {
            unlinkSync(m.path);
            cleared.push(m.path);
        } catch {
            /* gone already */
        }
    }

    if (settingsRecovery !== "none" || swept.length > 0) {
        appendHistoryEntry(env, "rollback", {
            snapshot_dir: settingsPath,
        }, {
            label: `doctor --repair (${settingsRecovery})`,
            mount: computeMountFingerprint(mount),
        });
    }

    return {
        mode: "repaired",
        settingsPath,
        settingsRecovery,
        sweptTmps: swept,
        clearedMarkers: cleared,
    };
}

function listOrphanTmps(dir: string, settingsBase: string): string[] {
    // safeWrite tmps follow `<settingsBase>.tmp.<pid>.<hex>`. Any matching
    // file in the koreader/ dir is a candidate; we don't filter by mtime
    // because a ZFS-backed mount could legitimately preserve old tmps.
    const prefix = settingsBase + ".tmp.";
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const n of names) {
        if (!n.startsWith(prefix)) continue;
        const full = join(dir, n);
        try {
            const st = statSync(full);
            if (!st.isFile()) continue;
        } catch {
            continue;
        }
        out.push(full);
    }
    return out;
}

function readMarkers(env: CliEnv): MarkerOnDisk[] {
    const dir = inProgressDir(env.cwd);
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out: MarkerOnDisk[] = [];
    for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const full = join(dir, n);
        try {
            const raw = readFileSync(full, "utf8");
            const parsed = JSON.parse(raw);
            out.push({ path: full, payload: parsed });
        } catch {
            // Malformed marker — leave it on disk so a human can
            // inspect it; don't let it crash the repair.
        }
    }
    return out;
}

function pickPromotableTmp(
    markers: MarkerOnDisk[],
    tmps: string[],
): { marker: MarkerOnDisk; tmpPath: string } | null {
    if (tmps.length === 0) return null;
    for (const m of markers) {
        const want = m.payload.intended_sha256;
        if (!want) continue;
        for (const t of tmps) {
            if (hashFile(t) === want) return { marker: m, tmpPath: t };
        }
    }
    return null;
}

function hashFile(path: string): string | null {
    try {
        const buf = readFileSync(path);
        return createHash("sha256").update(buf).digest("hex");
    } catch {
        return null;
    }
}
