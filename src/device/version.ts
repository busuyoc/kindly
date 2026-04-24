// KOReader version + Kindle device-family detection.
//
// Read-only probes of the mounted device. Used by v0.4 compat enforcement
// (src/setup/compat.ts) and displayed by `kindly doctor`. All failures are
// non-fatal — "unknown" is always a valid answer.

import { join } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";

import type { KindleMount } from "./kindle.ts";

// Parsed KOReader version. KOReader tags look like `v2026.03` on release
// builds and `v2024.11-25-g1a2b3c4` on in-between builds (git describe).
// We compare on (year, month, patch); the -N-gSHA suffix is informational
// only. Missing patch coerces to 0 so `2024.11` and `2024.11.0` compare
// equal.
export type KoreaderVersion = {
    year: number;
    month: number;
    patch: number;
    raw: string;  // original string, preserved for display
};

// Strip leading "v" (tag prefix) and any "-N-gSHA" ahead suffix, then
// parse "YYYY.MM[.P]". Returns null if the result doesn't match shape.
export function parseKoreaderVersion(raw: string): KoreaderVersion | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    // Strip leading v/V; strip git-describe suffix after the first "-".
    let core = trimmed.startsWith("v") || trimmed.startsWith("V")
        ? trimmed.slice(1)
        : trimmed;
    const dash = core.indexOf("-");
    if (dash !== -1) core = core.slice(0, dash);

    const parts = core.split(".");
    if (parts.length < 2 || parts.length > 3) return null;

    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const patch = parts[2] !== undefined ? Number(parts[2]) : 0;

    if (!Number.isInteger(year) || year < 1970 || year > 9999) return null;
    if (!Number.isInteger(month) || month < 1 || month > 12) return null;
    if (!Number.isInteger(patch) || patch < 0) return null;

    return { year, month, patch, raw: trimmed };
}

export function compareKoreaderVersion(a: KoreaderVersion, b: KoreaderVersion): -1 | 0 | 1 {
    if (a.year !== b.year) return a.year < b.year ? -1 : 1;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
    return 0;
}

// Read and parse <mount>/koreader/git-rev. Null if file missing or
// unparseable; callers treat that as "unknown, proceed with warning".
export function readKoreaderVersion(mount: KindleMount): KoreaderVersion | null {
    const p = join(mount.koreaderRoot, "git-rev");
    if (!exists(p, "derived-from-mount")) return null;
    let raw: string;
    try {
        raw = readText(p, "derived-from-mount");
    } catch {
        return null;
    }
    return parseKoreaderVersion(raw);
}

export type DeviceFamily = "kindle" | "unknown";

// Inspect <mount>/system/version.txt — Amazon's stock version string, which
// begins with "Kindle" on every Kindle. Kobo uses a different layout (no
// /system dir), so this is sufficient for v0.4's family-level matching.
export function detectDeviceFamily(mount: KindleMount): DeviceFamily {
    const p = join(mount.root, "system", "version.txt");
    if (!exists(p, "derived-from-mount")) return "unknown";
    let raw: string;
    try {
        raw = readText(p, "derived-from-mount");
    } catch {
        return "unknown";
    }
    if (/^kindle\b/i.test(raw.trim())) return "kindle";
    return "unknown";
}
