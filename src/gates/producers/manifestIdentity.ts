// Producer: manifestIdentity.
//
// Computes the canonical content hash and short id for the loaded Setup
// manifest. Depends only on ctx.opts.manifestBytes (raw bytes exactly as
// they appeared in the .kset / .kset.yaml file); bytes-on-disk are the
// identity invariant, not post-parse state.
//
// Consumed by:
//   - MANIFEST_HASH_ASSERT (Step 5) — verifies --expect-hash match
//   - (future) MANIFEST_SIGNATURE_VERIFY (W39) — signature over bytes
//
// Cached via orchestrator's materializeProducers: identical bytes in
// the same run → one hash computation.

import { hashBytes, shortId } from "../../setup/canonical.ts";
import type { GateContext, Producer } from "../types.ts";

export interface ManifestIdentity {
    /** Full hash string as returned by `hashBytes` (e.g. "sha256:<hex>"). */
    hash: string;
    /** Short 12-hex id. */
    id: string;
    /** The raw bytes that produced the hash. */
    bytes: Buffer;
}

export const manifestIdentity: Producer<ManifestIdentity> = (ctx: GateContext) => {
    const bytes = ctx.opts.manifestBytes as Buffer | undefined;
    if (!bytes) {
        throw new Error(
            "manifestIdentity producer: ctx.opts.manifestBytes is required " +
            "(populate it in the import context builder before runGates)",
        );
    }
    const hash = hashBytes(bytes);
    const id = shortId(hash);
    return { hash, id, bytes };
};
