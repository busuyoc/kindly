// Producer: signerTrust.
//
// W39 step 5. Materializes the trust state of the Setup archive's signer
// for the SIGNER_TRUSTED gate. Three layers, in order:
//
//   1. Is there a sidecar at all? If not, the Setup is unsigned —
//      nothing for the gate to decide.
//   2. If signed: does the crypto verify? On failure we throw
//      SETUP_SIGNATURE_INVALID directly — that's a "file is broken"
//      precondition, not a policy decision the user can override.
//   3. If crypto OK: is the signer in the local trust roster?
//      Returned as "trusted" / "untrusted" / "roster-error". The
//      SIGNER_TRUSTED gate decides what to do (fail-closed on
//      "roster-error" so a corrupt keyring doesn't silently let
//      anyone through).
//
// Inputs (ctx.opts):
//   - archivePath:  string   absolute path to the .kset on disk
//   - homeOverride: string?  forwarded from CliEnv for tests
//
// Output is consumed by SIGNER_TRUSTED in definitions/identity.ts.

import { existsSync } from "node:fs";

import { ErrorCodes, KindlyError } from "../../types/errors.ts";
import { findKey, KeyringError, loadKeyring } from "../../setup/keyring.ts";
import { findBuiltinKey, loadBuiltinKeyring } from "../../setup/builtinKeyring.ts";
import { SigningError, verifySetupArchive } from "../../setup/signing.ts";
import type { GateContext, Producer } from "../types.ts";

// trustSource is a pure side-channel for `setup verify --json` and the
// grouped `setup trust list` output — the gate decision (trusted vs
// untrusted vs error) is unchanged across sources, so identity.ts:
// SIGNER_TRUSTED needs no edit. Local wins when the same key_id is in
// both rosters: a user who explicitly typed `setup trust add` for a key
// that later landed in the built-in registry should still see "local"
// — preserves audit clarity and keeps `setup trust remove` meaningful.
export type SignerTrust =
    | { kind: "unsigned" }
    | {
        kind: "signed";
        signerKeyId: string;
        rosterStatus: "trusted" | "untrusted" | "roster-error";
        trustSource?: "local" | "builtin";
        label?: string;
        rosterError?: string;
    };

export const signerTrust: Producer<SignerTrust> = (ctx: GateContext) => {
    const archivePath = ctx.opts.archivePath as string | undefined;
    if (!archivePath) {
        throw new Error(
            "signerTrust producer: ctx.opts.archivePath is required " +
            "(populate it in the import context builder before runGates)",
        );
    }

    // Lean Setups (.kset.yaml) are never signed in v0.13. Fat archives
    // may have a sidecar at <archive>.sig. Either way, no sidecar →
    // nothing for the gate to decide.
    const sidecarPath = `${archivePath}.sig`;
    if (!existsSync(sidecarPath)) {
        return { kind: "unsigned" };
    }

    // Crypto verify. SigningError is "this file/sidecar is broken" —
    // not a trust policy choice the user can wave through. Map straight
    // to SETUP_SIGNATURE_INVALID with the same shape the verify command
    // produces. (SETUP_SIGNATURE_INVALID is intentionally NOT in
    // POLICY_BLOCK_CODES, so throwing it from a producer is fine under
    // tests/arch/gatesOnly.test.ts.)
    let verified;
    try {
        verified = verifySetupArchive(archivePath);
    } catch (e) {
        if (e instanceof SigningError) {
            throw new KindlyError(
                ErrorCodes.SETUP_SIGNATURE_INVALID,
                e.message,
                [
                    { text: "the sidecar is broken or doesn't match this archive — re-fetch from a trusted source." },
                    { text: "inspect with: ", command: `kindly setup verify ${archivePath}` },
                ],
            );
        }
        throw e;
    }

    // Built-in keyring (curated, committed-in-source). Loaded first
    // because a hash mismatch / size violation here is a "your install
    // is tampered" hard fail that should propagate as a KindlyError
    // before we even consult the local roster — the user can't sidestep
    // a tampered install via their personal trust list.
    const builtinKeyring = loadBuiltinKeyring();

    // Local roster lookup. A corrupt roster file means we cannot answer
    // the trust question — record that as a distinct status so the gate
    // can fail closed (rather than silently treating it as "untrusted"
    // or "trusted"). Built-in lookup still happens after, so a user
    // whose ~/.kindly/trusted-keys.json is broken can STILL import a
    // Setup signed by a built-in publisher — the local-roster error
    // doesn't poison built-in trust.
    const homeOverride = ctx.opts.homeOverride as string | undefined;
    let localEntry: ReturnType<typeof findKey> = null;
    let rosterError: string | null = null;
    try {
        const roster = loadKeyring({ homeOverride });
        localEntry = findKey(roster, verified.signerKeyId);
    } catch (e) {
        if (e instanceof KeyringError) {
            rosterError = e.message;
        } else {
            throw e;
        }
    }

    if (localEntry !== null) {
        return {
            kind: "signed",
            signerKeyId: verified.signerKeyId,
            rosterStatus: "trusted",
            trustSource: "local",
            ...(localEntry.label !== undefined ? { label: localEntry.label } : {}),
        };
    }

    const builtinEntry = findBuiltinKey(builtinKeyring, verified.signerKeyId);
    if (builtinEntry !== null) {
        // Decorate the label so `setup verify` output makes the source
        // visible to the user without them needing to read the JSON
        // envelope. "kindly-builtin: alice" vs raw "alice" tells them
        // "this trust came from kindly itself, not from a key I added."
        return {
            kind: "signed",
            signerKeyId: verified.signerKeyId,
            rosterStatus: "trusted",
            trustSource: "builtin",
            label: `kindly-builtin: ${builtinEntry.label}`,
        };
    }

    if (rosterError !== null) {
        return {
            kind: "signed",
            signerKeyId: verified.signerKeyId,
            rosterStatus: "roster-error",
            rosterError,
        };
    }

    return {
        kind: "signed",
        signerKeyId: verified.signerKeyId,
        rosterStatus: "untrusted",
    };
};
