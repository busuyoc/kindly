// CONSENT gates. Three gates in this category at Step 6:
//
//   PLUGINS_REQUIRE_ACK       — fat Setup ships .koplugin files; user must
//                               ack via --accept-plugins or --skip-plugins
//   PATCHES_REQUIRE_ACK       — fat Setup ships user-patch files; user must
//                               ack via --accept-patches or --skip-patches
//   SENSITIVE_REQUIRES_ACK    — changes include network/SSH/code-exec/fs/
//                               service/debug keys; user must ack via
//                               --accept-sensitive or --accept-key=<list>
//
// The strict-mode variants (STRICT_SENSITIVE_CHANGES, etc.) that block
// under --strict-imports without the user-ack escape hatch are a
// separate category of entry, migrated in Step 9.

import { sensitiveDomain } from "../../schema/classify.ts";
import { formatSensitiveChange } from "../sensitiveFormat.ts";
import type { Change } from "../../schema/diff.ts";
import type { GateDefinition } from "../types.ts";

/**
 * PLUGINS_REQUIRE_ACK — fat .kset ships plugin files. Lua code that will
 * execute on the Kindle if installed. User explicitly consents via
 * --accept-plugins or explicitly rejects via --skip-plugins (apply
 * settings only, leave plugins uninstalled).
 */
export const PLUGINS_REQUIRE_ACK: GateDefinition = {
    id: "PLUGINS_REQUIRE_ACK",
    category: "CONSENT",
    appliesAt: ["import"],
    requires: [],
    firesIn: "always",
    bypassFlags: ["--accept-plugins", "--skip-plugins"],
    errorCode: "FAT_REQUIRES_ACK",
    remediation: [
        { text: "Review the shipped files before accepting.", command: "kindly setup inspect <file>" },
    ],
    check: (ctx) => {
        const count = (ctx.opts.shippedPluginsCount as number | undefined) ?? 0;
        if (count === 0) return { kind: "pass" };
        return {
            kind: "block",
            message:
                `this Setup ships ${count} plugin file(s) — ` +
                "Lua code that will execute on your Kindle. " +
                "Pass --accept-plugins to install, or --skip-plugins to apply settings only.",
        };
    },
};

/**
 * PATCHES_REQUIRE_ACK — fat .kset ships user-patch files. Same code-
 * exec threat class as plugins but patched into KOReader at load time
 * rather than loaded as a plugin.
 */
export const PATCHES_REQUIRE_ACK: GateDefinition = {
    id: "PATCHES_REQUIRE_ACK",
    category: "CONSENT",
    appliesAt: ["import"],
    requires: [],
    firesIn: "always",
    bypassFlags: ["--accept-patches", "--skip-patches"],
    errorCode: "FAT_REQUIRES_ACK",
    remediation: [],
    check: (ctx) => {
        const count = (ctx.opts.shippedPatchesCount as number | undefined) ?? 0;
        if (count === 0) return { kind: "pass" };
        return {
            kind: "block",
            message:
                `this Setup ships ${count} patch file(s) — ` +
                "Lua code that will execute on your Kindle. " +
                "Pass --accept-patches to install, or --skip-patches to apply settings only.",
        };
    },
};

/**
 * STRICT_SENSITIVE_CHANGES — W34e.
 *
 * Under --strict-imports, any SENSITIVE change blocks — no per-key
 * --accept-key escape, no --accept-sensitive waiver (enforcement is
 * at the CLI layer: the flags are mutually exclusive with --strict-imports).
 *
 * Fires in dry-run too so `--dry-run --strict-imports` preflights can
 * refuse the preview with a non-zero exit. Same message shape as the
 * consumer SENSITIVE_REQUIRES_ACK but different trigger + message prefix.
 */
export const STRICT_SENSITIVE_CHANGES: GateDefinition = {
    id: "STRICT_SENSITIVE_CHANGES",
    category: "CONSENT",
    appliesAt: ["import"],
    requires: ["sensitiveHits"],
    firesIn: "strict-imports-only",
    bypassFlags: [],
    errorCode: "STRICT_IMPORT_BLOCKED",
    remediation: [
        { text: "Use a hand-audited import (drop --strict-imports) to accept any of these." },
    ],
    check: (ctx) => {
        const hits = ctx.producers.sensitiveHits as string[];
        if (hits.length === 0) return { kind: "pass" };
        const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
        const list = hits
            .map((p) => `  [${sensitiveDomain(p)}] ${p}: ${formatSensitiveChange(changes, p)}`)
            .join("\n");
        return {
            kind: "block",
            message:
                `--strict-imports: Setup modifies ${hits.length} security-sensitive setting(s):\n${list}`,
        };
    },
};

/**
 * SENSITIVE_REQUIRES_ACK — a mutation introduces SENSITIVE-class keys
 * (network endpoints, SSH, code-exec, filesystem redirects, service
 * autostart, debug).
 *
 * Fires on every boundary that takes externally-authored bytes and
 * lands them on device: setup import, plain apply, and restore. Lead 7
 * (S600/S601) closure: previously hidden behind --untrusted-yaml at
 * apply / unguarded at restore — now always-on. The user's own kindly
 * pull → kindly apply round-trip yields zero hits (no diff means no
 * sensitive change), so the gate is invisible to the legitimate
 * trusted-author flow.
 *
 * Bypass is more nuanced than the PLUGINS/PATCHES gates:
 *   --accept-sensitive       → blanket ack; all hits pass
 *   --accept-key=<a,b,...>   → per-key ack; only listed hits are waived.
 *                               Remaining hits still block.
 *
 * The per-key accept list is handled inside check() (it's too rich for
 * the generic bypassFlags mechanism). --accept-sensitive goes through
 * the generic bypass path via bypassFlags.
 *
 * Dry-run skips this gate (firesIn: "non-dry-run") — preview mode shows
 * the [SENSITIVE] markers but doesn't block.
 */
export const SENSITIVE_REQUIRES_ACK: GateDefinition = {
    id: "SENSITIVE_REQUIRES_ACK",
    category: "CONSENT",
    appliesAt: ["import", "apply", "restore"],
    requires: ["sensitiveHits"],
    firesIn: "non-dry-run",
    bypassFlags: ["--accept-sensitive"],
    errorCode: "SENSITIVE_REQUIRES_ACK",
    remediation: [
        // Boundary-neutral: this gate fires at import, apply, and restore.
        // The --accept flags are spelled the same at every boundary, so we
        // keep the remediation generic instead of hardcoding `setup import`.
        { text: "Review the affected keys before accepting (kindly diff, or kindly setup inspect <file> for an import)." },
        { text: "Pass --accept-sensitive to ack all changes, or --accept-key=<key,key,...> to ack specific keys." },
    ],
    check: (ctx) => {
        const hits = ctx.producers.sensitiveHits as string[];
        if (hits.length === 0) return { kind: "pass" };

        // --accept-key=<list> handled here (too rich for bypassFlags).
        const accepted = (ctx.opts.acceptKey as Set<string> | undefined) ?? new Set<string>();
        const unaccepted = hits.filter((p) => !accepted.has(p));
        if (unaccepted.length === 0) return { kind: "pass" };

        const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
        const list = unaccepted
            .map((p) => `  [${sensitiveDomain(p)}] ${p}: ${formatSensitiveChange(changes, p)}`)
            .join("\n");
        return {
            kind: "block",
            message:
                `this Setup modifies ${unaccepted.length} security-sensitive setting(s):\n${list}`,
        };
    },
};
