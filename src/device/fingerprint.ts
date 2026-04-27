// Mount fingerprint — defends against S1390 (Kindle cross-contamination).
//
// Two physical Kindles can both mount at /Volumes/Kindle (macOS appends
// " 1" only to the second simultaneous mount; the path collapses back the
// moment the first unplugs). Without an identity check, `kindly rollback
// --to N` against a different device would happily restore device A's
// snapshot onto device B — silently overwriting B's current settings.
//
// The fingerprint is recorded on every mutating history entry and on
// every in-progress marker. `rollback --to N` recomputes the current
// mount's fingerprint and refuses if it differs from the entry's
// fingerprint, unless `--force-mount` is passed.
//
// We can't read the Kindle hardware serial portably from the filesystem
// — paths and formats vary by model, jailbreak status, and firmware
// generation. We use three high-signal anchors KOReader/Amazon both
// expose on disk:
//
//   - device_version   — first line of /system/version.txt. Encodes
//                        Kindle model + firmware. Stable across reboots,
//                        changes only on OTA.
//   - koreader_version — content of /koreader/git-rev. Stable across
//                        kindly invocations; changes when KOReader
//                        upgrades.
//   - anchor_mtime_iso — mtime of /koreader/git-rev. Filesystem-level
//                        timestamp captures "different physical device"
//                        even when version strings match (each device's
//                        FS records its own install timestamp).
//
// Two different physical Kindles will reliably differ on at least one
// field. Two invocations against the same Kindle within the same
// firmware/KOReader generation will match all three. KOReader upgrade
// between invocations changes koreader_version + anchor_mtime → false
// positive on rollback, recoverable via `--force-mount`.

import { join } from "node:path";
import { exists, readText, statFollow } from "../fs/safeRead.ts";
import type { KindleMount } from "./kindle.ts";

export interface MountFingerprint {
    device_version: string | null;
    koreader_version: string | null;
    anchor_mtime_iso: string | null;
}

export function computeMountFingerprint(mount: KindleMount): MountFingerprint {
    return {
        device_version: readDeviceVersion(mount),
        koreader_version: readKoreaderRev(mount),
        anchor_mtime_iso: readAnchorMtime(mount),
    };
}

function readDeviceVersion(mount: KindleMount): string | null {
    const p = join(mount.root, "system", "version.txt");
    if (!exists(p, "derived-from-mount")) return null;
    try {
        const first = readText(p, "derived-from-mount").split("\n")[0];
        return first ? first.trim() || null : null;
    } catch {
        return null;
    }
}

function readKoreaderRev(mount: KindleMount): string | null {
    const p = join(mount.koreaderRoot, "git-rev");
    if (!exists(p, "derived-from-mount")) return null;
    try {
        const v = readText(p, "derived-from-mount").trim();
        return v || null;
    } catch {
        return null;
    }
}

function readAnchorMtime(mount: KindleMount): string | null {
    const p = join(mount.koreaderRoot, "git-rev");
    if (!exists(p, "derived-from-mount")) return null;
    try {
        return statFollow(p, "derived-from-mount").mtime.toISOString();
    } catch {
        return null;
    }
}

export interface FingerprintComparison {
    /** True iff every recorded field on `recorded` matches `current`. Null
     *  fields on either side are treated as "no signal" and don't block. */
    match: boolean;
    /** Human-readable diff lines, e.g. `device_version: "Kindle 5.16" → "Kindle 5.18"`. */
    differences: string[];
}

/** Compare a recorded fingerprint (from history) against the current
 *  mount's fingerprint. A null on either side is treated as "no signal"
 *  for that field — degrades to today's behavior rather than blocking
 *  rollback against legitimately old history that predates fingerprinting. */
export function compareFingerprints(
    recorded: MountFingerprint | undefined,
    current: MountFingerprint,
): FingerprintComparison {
    if (!recorded) return { match: true, differences: [] };
    const diffs: string[] = [];
    pushIfDiffers(diffs, "device_version", recorded.device_version, current.device_version);
    pushIfDiffers(diffs, "koreader_version", recorded.koreader_version, current.koreader_version);
    pushIfDiffers(diffs, "anchor_mtime_iso", recorded.anchor_mtime_iso, current.anchor_mtime_iso);
    return { match: diffs.length === 0, differences: diffs };
}

function pushIfDiffers(
    diffs: string[],
    field: string,
    a: string | null,
    b: string | null,
): void {
    if (a === null || b === null) return; // no signal — don't block
    if (a !== b) diffs.push(`${field}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
}

/** True when no fingerprint field has any signal — used by callers that
 *  want to skip the recording step entirely (no fingerprint recorded =
 *  no future mismatch comparisons fire). */
export function isFingerprintEmpty(f: MountFingerprint): boolean {
    return f.device_version === null
        && f.koreader_version === null
        && f.anchor_mtime_iso === null;
}

/** True when every fingerprint field carries signal. Round-6 S2123:
 *  `compareFingerprints` treats any null on either side as "no signal"
 *  and is permissive for partial fingerprints. A forged marker carrying
 *  a single matching field with the rest null silently passes the gate
 *  even when the device differs. Callers (today: doctor --repair) gate
 *  on `isFingerprintFull(recorded) && isFingerprintFull(current)` so the
 *  cross-device check is only trusted when both sides have all three
 *  anchors; otherwise they require explicit override. */
export function isFingerprintFull(f: MountFingerprint): boolean {
    return f.device_version !== null
        && f.koreader_version !== null
        && f.anchor_mtime_iso !== null;
}
