// IDENTITY gates. One entry per registered gate in this category.
// See docs/infra/99-gates-refactor-plan.md §Step 5 for the
// proof-of-shape rationale (MANIFEST_HASH_ASSERT was chosen as the
// first migration precisely because it has zero producers and minimal
// opts surface).

import type { GateDefinition } from "../types.ts";
import type { ManifestIdentity } from "../producers/manifestIdentity.ts";

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
