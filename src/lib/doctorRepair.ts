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
// History: a successful repair appends a dedicated `doctor:repair`
// history entry (round 6 S2122/S2114). The earlier shape — `cmd:
// "rollback"` with `summary.snapshot_dir = settingsPath` — was a
// lie: snapshot_dir is supposed to point at a directory, but the
// settings file is a `.lua`, so a future `rollback --to N` against
// that index would walk a non-directory and ENOTDIR. The new entry
// records `recovered_from` (the artifact promoted/restored), the
// `recovered_sha256` of the bytes committed, and `settings_recovery`
// so the audit trail can distinguish promote vs. restore.

import { createHash } from "node:crypto";
import {
    readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { withLock } from "./../fs/lockfile.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
import { inProgressDir } from "../history/inProgress.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { findControlByteHits } from "../gates/producers/controlByteHits.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import {
    compareFingerprints, computeMountFingerprint, isFingerprintEmpty,
    isFingerprintFull, type MountFingerprint,
} from "../device/fingerprint.ts";
import type { DoctorRepairResult } from "../types/results.ts";

export interface DoctorRepairOptions {
    dryRun?: boolean;
    /** Mirrors rollback's --force-mount: bypass the marker-vs-current
     *  fingerprint check. Use after a KOReader upgrade between crash
     *  and repair changed /koreader/git-rev. Also bypasses the round-6
     *  S2123 strict-fingerprint requirement (every recorded anchor
     *  must be non-null AND match) when a marker carries only a
     *  partial fingerprint. */
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
    /** Round 6 S2126 closure: when step-4 state is detected (main
     *  absent + `.old` present) but no in-progress marker references
     *  this settingsPath, we refuse to adopt `.old` by default. The
     *  attack vector is "fresh-install device + USB write of a single
     *  `.old` file": pre-fix `--repair` would adopt it as canonical.
     *  Legitimate kindly applies always write a marker before step 1,
     *  so a missing marker is the strong signal that this `.old` was
     *  not produced by an interrupted kindly run. `--accept-old` is
     *  the explicit user override for when they know the `.old` came
     *  from a SIGKILL during a pre-marker era apply (or a third-party
     *  tool) and they want kindly to adopt it anyway. */
    acceptOld?: boolean;
}

/** S2127 (red-team round-7 review followup): canonicalize a path for
 *  marker comparison. realpathSync resolves symlinks and (on
 *  case-insensitive filesystems like macOS HFS+/APFS default) returns
 *  the actual on-disk casing. Both sides of the comparison must run
 *  through this so a marker written when /Volumes/Kindle was the
 *  resolved target matches a runtime resolve through /private/var/...
 *  or with case-variant components.
 *
 *  realpath fails when the path doesn't exist (the canonical
 *  settings.reader.lua is exactly that during interrupted apply).
 *  Resolve the parent directory instead and re-attach the basename —
 *  parent always exists in the interrupted state. Last fallback is
 *  the normalized input string itself. */
function canonicalizePath(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        try {
            return join(realpathSync(dirname(p)), basename(p));
        } catch {
            return p;
        }
    }
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

    // Inventory: tmps in koreader/, doctor probe leftovers (S2118),
    // in-progress markers, and the step-4 state (main absent + .old
    // present).
    const tmps = listOrphanTmps(koreaderDir, settingsBase);
    const probeLeftovers = listProbeLeftovers(koreaderDir);
    const markers = readMarkers(env);
    const interrupted = detectInterruptedApply(settingsPath);

    // Round 6 S2123: a forged marker can carry a partial mount
    // fingerprint (e.g. only `device_version` set, the other two null).
    // `compareFingerprints` treats null-on-either-side as "no signal" by
    // design (so legit pre-fingerprint markers pass), but that
    // permissiveness lets an attacker bypass the cross-device gate by
    // matching a single coarse field. Fix: when the recorded mount
    // exists, require ALL three anchors on both sides; reject partial
    // fingerprints unless --force-mount.
    if (!opts.forceMount) {
        const currentFp = computeMountFingerprint(mount);
        for (const m of markers) {
            const recorded = m.payload.mount;
            if (!recorded || isFingerprintEmpty(recorded)) continue;
            if (!isFingerprintFull(recorded) || !isFingerprintFull(currentFp)) {
                throw new KindlyError(
                    ErrorCodes.MOUNT_FINGERPRINT_MISMATCH,
                    `in-progress marker ${m.path} carries a partial fingerprint; cross-device check cannot be trusted.`,
                    [
                        { text: "Reconnect the original Kindle, or pass --force-mount if you accept the risk." },
                        {
                            text: "Force the repair anyway:",
                            command: "kindly doctor --repair --force-mount",
                        },
                    ],
                );
            }
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

    // No interruption AND no orphan tmps AND no probe leftovers AND
    // no markers → nothing to do.
    if (!interrupted
        && tmps.length === 0
        && probeLeftovers.length === 0
        && markers.length === 0
    ) {
        return {
            mode: "no-op",
            settingsPath,
            settingsRecovery: "none",
            sweptTmps: [],
            clearedMarkers: [],
        };
    }

    // Round 6 S2126: detectInterruptedApply only checks "main absent +
    // .old present", which an attacker with USB write access can fake
    // on a fresh-install device by dropping a single `.old`. A
    // legitimate interrupted apply always wrote an in-progress marker
    // before safeWrite step 1, so a marker referencing this settingsPath
    // is the provenance signal that this state came from a kindly run.
    // Without it, refuse adoption unless the user explicitly opts in
    // with --accept-old (the override exists for pre-marker era applies
    // and third-party tools that left the device in step-4 shape).
    if (interrupted && !opts.acceptOld) {
        // S2127 (red-team round-7 review followup): marker path match
        // was exact string equality. macOS `/Volumes/Kindle` is HFS+
        // case-insensitive AND can be symlinked under /private; a
        // marker stored as `/Volumes/Kindle/koreader/settings.reader.lua`
        // won't string-match a runtime resolve as
        // `/private/var/folders/.../koreader/settings.reader.lua` or
        // `/volumes/kindle/koreader/...`. That false negative defeats
        // S2126 cold-install protection on the actual deployment
        // substrate. Compare canonicalized paths instead.
        const canonical = canonicalizePath(settingsPath);
        const hasMatchingMarker = markers.some((m) => {
            const mp = m.payload.settings_path;
            if (typeof mp !== "string") return false;
            return canonicalizePath(mp) === canonical;
        });
        if (!hasMatchingMarker) {
            throw new KindlyError(
                ErrorCodes.DOCTOR_REPAIR_REJECTED,
                `refusing to adopt ${interrupted.oldPath}: no in-progress marker references this settings path. The .old may not have come from an interrupted kindly apply.`,
                [
                    {
                        text: "Re-run apply (deterministic from the same YAML) instead of trusting unattributed bytes.",
                        command: "kindly apply <kindly.yaml>",
                    },
                    {
                        text: "If you trust this .old and want to adopt it anyway, opt in explicitly:",
                        command: "kindly doctor --repair --accept-old",
                    },
                ],
            );
        }
    }

    // Round 6 S2113: validate the .old bytes BEFORE we decide to
    // promote them. parseSettingsFile rejects malformed Lua; a
    // control-byte scan rejects byte-level injection chains in
    // SECRET / SENSITIVE / code-exec paths (the same structural rule
    // the apply-side input filter enforces). If validation fails we
    // refuse to adopt — the user can still re-run `kindly apply` to
    // get back to a known-good state.
    let oldValidation: ValidatedRecovery | null = null;
    if (interrupted) {
        oldValidation = validateRecoverableBytes(interrupted.oldPath, ".old");
    }

    // Round 6 S2125: --promote-tmp previously skipped parse + classify
    // + control-byte checks because hash-matching the marker was
    // assumed sufficient. It isn't — the marker's intended_sha256 is
    // attacker-controllable when the marker is forged. Validate the
    // tmp bytes the same way we validate .old before adoption.
    let promote: { marker: MarkerOnDisk; tmpPath: string; validation: ValidatedRecovery } | null = null;
    if (opts.promoteTmp) {
        const candidate = pickPromotableTmp(markers, tmps);
        if (candidate) {
            const tmpValidation = validateRecoverableBytes(candidate.tmpPath, ".tmp");
            promote = { ...candidate, validation: tmpValidation };
        }
    }

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            settingsPath,
            settingsRecovery: promote ? "promoted-tmp" : (interrupted ? "restored-old" : "none"),
            sweptTmps: [
                ...tmps.filter((t) => t !== promote?.tmpPath),
                ...probeLeftovers,
            ],
            clearedMarkers: markers.map((m) => m.path),
        };
    }

    let settingsRecovery: DoctorRepairResult["settingsRecovery"] = "none";
    let recoveredFrom: string | null = null;
    let recoveredSha256: string | null = null;

    if (promote) {
        // Promote the matching tmp to canonical. If main is somehow
        // present here (concurrent rare race), unlink it first — the
        // marker's hash is the authoritative intended bytes. We
        // already hashed the bytes during validation, so reuse that
        // for the audit trail rather than re-reading the file.
        try { unlinkSync(settingsPath); } catch { /* not present, fine */ }
        renameSync(promote.tmpPath, settingsPath);
        settingsRecovery = "promoted-tmp";
        recoveredFrom = promote.tmpPath;
        recoveredSha256 = promote.validation.sha256;
    } else if (interrupted && oldValidation) {
        // Restore .old to canonical. KOReader's own boot path already
        // copes with this state; we're closing the kindly-side ENOENT.
        renameSync(interrupted.oldPath, settingsPath);
        settingsRecovery = "restored-old";
        recoveredFrom = interrupted.oldPath;
        recoveredSha256 = oldValidation.sha256;
    }

    // Sweep every tmp (including the one we just promoted's siblings,
    // if any). Best-effort: a missing file means another process
    // already cleaned it up. S2118: also sweep `.doctor-mw-*` /
    // `.doctor-probe-*` leftovers from prior crashed `doctor` runs.
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
    for (const p of probeLeftovers) {
        try {
            // Probes are mkdtempSync dirs; rmSync(recursive) handles
            // both empty and partially-populated leftovers.
            rmSync(p, { recursive: true, force: true });
            swept.push(p);
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
        // Round 6 S2122/S2114: dedicated `doctor:repair` history shape.
        // recovered_from + recovered_sha256 distinguish "we restored
        // bytes we wrote" from "we restored attacker-planted bytes" —
        // the audit trail surfaces the artifact + hash so a future
        // operator can verify or correlate.
        appendHistoryEntry(env, "doctor:repair", {
            ...(recoveredFrom ? { recovered_from: recoveredFrom } : {}),
            ...(recoveredSha256 ? { recovered_sha256: `sha256:${recoveredSha256}` } : {}),
            settings_recovery: settingsRecovery,
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

interface ValidatedRecovery {
    /** Lowercase hex sha256 of the on-disk bytes. */
    sha256: string;
}

/** Parse-and-classify gate for any file we're about to rename onto
 *  settings.reader.lua. Round 6 S2112 / S2113 / S2125 closure:
 *
 *  Prior code did `renameSync(.old, settings)` and `renameSync(.tmp,
 *  settings)` with no validity check at all. An attacker who could
 *  drop arbitrary bytes at either path (USB write on the mount)
 *  controlled what kindly committed as canonical settings — including
 *  malformed Lua (which then poisoned every kindly read until
 *  manually repaired) and renderer-injection chains via control-byte-
 *  laden SECRET / SENSITIVE / code-exec values.
 *
 *  Defense:
 *    1. parseSettingsFile rejects malformed Lua — same parser apply
 *       uses, so what passes here will also be readable by
 *       `kindly pull` / `kindly diff` after repair.
 *    2. findControlByteHits enforces the apply-side structural input
 *       filter on the parsed dict — bytes 0x00-0x08, 0x0B-0x0D,
 *       0x0E-0x1F, 0x7F at SECRET / SENSITIVE / code-exec keys.
 *
 *  We compute the sha256 once here so the caller can record it in
 *  history without re-reading the bytes after rename. */
function validateRecoverableBytes(filePath: string, role: string): ValidatedRecovery {
    let raw: Buffer;
    try {
        raw = readFileSync(filePath);
    } catch (e) {
        throw new KindlyError(
            ErrorCodes.DOCTOR_REPAIR_REJECTED,
            `cannot read ${role} ${filePath}: ${(e as Error).message}`,
        );
    }
    const sha256 = createHash("sha256").update(raw).digest("hex");
    let parsed: unknown;
    try {
        parsed = parseSettingsFile(raw.toString("utf8"));
    } catch (e) {
        throw new KindlyError(
            ErrorCodes.DOCTOR_REPAIR_REJECTED,
            `${role} ${filePath} is not valid settings.reader.lua: ${(e as Error).message}`,
            [
                { text: "Re-run apply with the original YAML to rewrite a known-good settings file.", command: "kindly apply <kindly.yaml>" },
            ],
        );
    }
    const hits = findControlByteHits(parsed);
    if (hits.length > 0) {
        const sample = hits.slice(0, 3).map((h) => `${h.path} (${h.class}, bytes=${h.bytes.join(",")})`);
        throw new KindlyError(
            ErrorCodes.DOCTOR_REPAIR_REJECTED,
            `${role} ${filePath} contains control bytes at gated paths:\n  ${sample.join("\n  ")}${hits.length > 3 ? `\n  … and ${hits.length - 3} more` : ""}`,
            [
                { text: "Re-run apply from a clean YAML so the apply-side input filter rejects these bytes at write time.", command: "kindly apply <kindly.yaml>" },
            ],
        );
    }
    return { sha256 };
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

/** Round 6 S2118: doctor's `disk.mount_writable` check creates a
 *  `mkdtempSync(...".doctor-mw-...")` probe under the koreader/ dir
 *  and removes it. SIGINT (or any throw) before the rmSync ran left
 *  the probe dir on the mount. The repair sweeper only looked at
 *  `<settingsBase>.tmp.*`, so probes accumulated forever. We now sweep
 *  any `.doctor-mw-*` / `.doctor-probe-*` prefix here as well. */
function listProbeLeftovers(dir: string): string[] {
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const out: string[] = [];
    for (const n of names) {
        if (!n.startsWith(".doctor-mw-") && !n.startsWith(".doctor-probe-")) continue;
        out.push(join(dir, n));
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
