// IDENTITY gates. One entry per registered gate in this category.
// See docs/infra/99-gates-refactor-plan.md §Step 5 for the
// proof-of-shape rationale (MANIFEST_HASH_ASSERT was chosen as the
// first migration precisely because it has zero producers and minimal
// opts surface).

import type { GateDefinition } from "../types.ts";
import type { ManifestIdentity } from "../producers/manifestIdentity.ts";
import {
    compareFingerprints,
    isFingerprintEmpty,
    type MountFingerprint,
} from "../../device/fingerprint.ts";

/**
 * MANIFEST_HASH_ASSERT — W34a.
 *
 * When `opts.expectHash` is set (the user passed `--expect-hash`),
 * refuse to proceed unless the loaded manifest's canonical content hash
 * matches. Closes A7 (MITM / tampered-in-transit setups) without any
 * infrastructure — the user commits to an out-of-band-verified hash
 * and kindly enforces it.
 *
 * No bypass. If the file you received isn't what you expected, nothing
 * about the import flow should proceed; re-verify out-of-band.
 */
export const MANIFEST_HASH_ASSERT: GateDefinition = {
    id: "MANIFEST_HASH_ASSERT",
    category: "IDENTITY",
    appliesAt: ["import"],
    requires: ["manifestIdentity"],
    firesIn: "always",
    bypassFlags: [],
    errorCode: "MANIFEST_HASH_MISMATCH",
    remediation: [
        { text: "Verify you received the file you expected." },
        { text: "Re-download from the original source." },
    ],
    check: (ctx) => {
        const expectHash = ctx.opts.expectHash as string | undefined;
        if (!expectHash) return { kind: "pass" };
        const identity = ctx.producers.manifestIdentity as ManifestIdentity;
        if (identity.hash !== expectHash) {
            return {
                kind: "block",
                message:
                    `expected ${expectHash} but Setup hashes to ${identity.hash}`,
            };
        }
        return { kind: "pass" };
    },
};

/**
 * MOUNT_FINGERPRINT_MATCHES — C10a / S1390.
 *
 * `kindly rollback --to N` resolves a snapshot via the history entry
 * at index N. The recorded entry carries the mount fingerprint of the
 * physical Kindle the original mutation hit (see device/fingerprint.ts).
 * If the currently-attached Kindle's fingerprint differs, refuse:
 * blindly restoring snapshot bytes from device A onto device B
 * silently overwrites B's settings.
 *
 * Treats null fields on either side as "no signal" — pre-C10a entries
 * have no recorded fingerprint at all (gate passes) and a Kindle that
 * doesn't expose any of the three anchors degrades to today's
 * unfingerprinted behavior. The gate fires only when at least one
 * field on both sides has signal AND they differ.
 *
 * Bypass: --force-mount. Intended for the legitimate case where
 * KOReader was upgraded between original mutation and rollback (the
 * koreader_version + anchor_mtime change but the Kindle is the same
 * physical device).
 */
export const MOUNT_FINGERPRINT_MATCHES: GateDefinition = {
    id: "MOUNT_FINGERPRINT_MATCHES",
    category: "IDENTITY",
    appliesAt: ["rollback"],
    requires: [],
    firesIn: "non-dry-run",
    bypassFlags: ["--force-mount"],
    errorCode: "MOUNT_FINGERPRINT_MISMATCH",
    remediation: [
        { text: "Connect the original Kindle and re-run." },
        { text: "If you upgraded KOReader between the original mutation and now, override with --force-mount." },
    ],
    check: (ctx) => {
        const recorded = ctx.opts.recordedMount as MountFingerprint | undefined;
        const current = ctx.opts.currentMount as MountFingerprint | undefined;
        if (!recorded || isFingerprintEmpty(recorded) || !current) {
            return { kind: "pass" };
        }
        const cmp = compareFingerprints(recorded, current);
        if (cmp.match) return { kind: "pass" };
        return {
            kind: "block",
            message:
                "the currently-attached Kindle does not match the one this " +
                `snapshot was taken from:\n  ${cmp.differences.join("\n  ")}`,
        };
    },
};
