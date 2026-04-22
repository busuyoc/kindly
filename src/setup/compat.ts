// Compat enforcement — pure decision layer.
//
// Given a manifest's compat block and what we detected on the device,
// decide whether the import should proceed. This is the IOU from v0.3:
// stored compat becomes enforced compat. No I/O here — `detected` is
// populated by src/device/version.ts in the caller.
//
// Policy: mismatches block by default. `--force` at the CLI layer converts
// the block into a warning. Missing compat block → no check. Detection
// failure (null version / unknown family) → we cannot assert mismatch, so
// we fall through with an "unverifiable" note, not a block.

import type { Compat } from "./schema.ts";
import type { DeviceFamily } from "../device/version.ts";
import {
    compareKoreaderVersion, parseKoreaderVersion,
    type KoreaderVersion,
} from "../device/version.ts";

export type Detected = {
    version: KoreaderVersion | null;
    family: DeviceFamily;
};

// One line per failed check. Kind lets callers group/color; message is
// user-facing.
export type CompatIssue =
    | { kind: "koreader_too_old";   required: string; detected: string; }
    | { kind: "koreader_too_new";   required: string; detected: string; }
    | { kind: "koreader_unknown";   required: string; }  // manifest demands a version but we couldn't read one
    | { kind: "device_mismatch";    required: readonly string[]; detected: string; }
    | { kind: "device_unknown";     required: readonly string[]; }
    | { kind: "version_unparseable"; field: "koreader_version_min" | "koreader_version_max"; value: string; };

export type CompatResult = {
    // Hard failures: import should refuse unless --force.
    blocking: CompatIssue[];
    // Soft notes: proceed, but tell the user why we couldn't verify.
    unverifiable: CompatIssue[];
};

export function checkCompat(compat: Compat | undefined, detected: Detected): CompatResult {
    const blocking: CompatIssue[] = [];
    const unverifiable: CompatIssue[] = [];

    if (!compat) return { blocking, unverifiable };

    // -- koreader version gate --------------------------------------------
    const minStr = compat.koreader_version_min ?? undefined;
    const maxStr = compat.koreader_version_max ?? undefined;

    const minParsed = minStr !== undefined ? parseKoreaderVersion(minStr) : undefined;
    const maxParsed = maxStr !== undefined ? parseKoreaderVersion(maxStr) : undefined;

    if (minStr !== undefined && minParsed === null) {
        // Manifest declared a min that we cannot parse — treat as soft
        // failure. Don't block (user wrote it, they probably meant well);
        // don't silently accept either.
        unverifiable.push({ kind: "version_unparseable", field: "koreader_version_min", value: minStr });
    }
    if (maxStr !== undefined && maxParsed === null) {
        unverifiable.push({ kind: "version_unparseable", field: "koreader_version_max", value: maxStr });
    }

    if ((minParsed || maxParsed) && detected.version === null) {
        // Manifest has a version constraint but we couldn't read git-rev.
        // We cannot prove a mismatch → unverifiable, proceed.
        const required = [
            minParsed && `>= ${minStr}`,
            maxParsed && `<= ${maxStr}`,
        ].filter(Boolean).join(", ");
        unverifiable.push({ kind: "koreader_unknown", required });
    } else if (detected.version) {
        if (minParsed && compareKoreaderVersion(detected.version, minParsed) < 0) {
            blocking.push({
                kind: "koreader_too_old",
                required: minStr!,
                detected: detected.version.raw,
            });
        }
        if (maxParsed && compareKoreaderVersion(detected.version, maxParsed) > 0) {
            blocking.push({
                kind: "koreader_too_new",
                required: maxStr!,
                detected: detected.version.raw,
            });
        }
    }

    // -- device family gate ------------------------------------------------
    if (compat.device && compat.device.length > 0) {
        if (detected.family === "unknown") {
            unverifiable.push({ kind: "device_unknown", required: compat.device });
        } else {
            // Family-level match: manifest entry matches if it equals the
            // detected family OR starts with `<family>-` (so "kindle-pw5"
            // on a manifest still counts as a kindle-family allow).
            const ok = compat.device.some(
                (d) => d === detected.family || d.startsWith(`${detected.family}-`),
            );
            if (!ok) {
                blocking.push({
                    kind: "device_mismatch",
                    required: compat.device,
                    detected: detected.family,
                });
            }
        }
    }

    return { blocking, unverifiable };
}

// Render a human-readable line for each issue. Used by the CLI to build
// error / warning blocks. One issue = one line.
export function formatCompatIssue(issue: CompatIssue): string {
    switch (issue.kind) {
        case "koreader_too_old":
            return `KOReader version ${issue.detected} is older than required >= ${issue.required}`;
        case "koreader_too_new":
            return `KOReader version ${issue.detected} is newer than required <= ${issue.required}`;
        case "koreader_unknown":
            return `Setup requires KOReader ${issue.required}; could not read git-rev to verify`;
        case "device_mismatch":
            return `Setup requires device in [${issue.required.join(", ")}]; this device is ${issue.detected}`;
        case "device_unknown":
            return `Setup requires device in [${issue.required.join(", ")}]; could not detect device family to verify`;
        case "version_unparseable":
            return `Manifest ${issue.field} is not a parseable KOReader version: ${JSON.stringify(issue.value)}`;
    }
}
