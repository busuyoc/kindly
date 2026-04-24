// DUAL gates. Gates whose trigger is "a SENSITIVE change in a specific
// threat class" but whose consent flag is a different axis than the
// SENSITIVE consent. The canonical example — and currently the only
// entry — is extra_plugin_paths: it's a SENSITIVE-network-ish change,
// but the RIGHT user consent is --accept-plugins (code-exec semantics),
// not --accept-sensitive (data-flow semantics).
//
// These gates are the main reason "one gate per trust decision" matters
// more than "one gate per data shape" — the producers-plus-gates model
// lets a single data artifact (sensitiveHits) feed multiple distinct
// gates with distinct consent flags. See docs/88 §4.3.

import type { GateDefinition } from "../types.ts";
import type { Change } from "../../schema/diff.ts";
import { formatSensitiveChange } from "../sensitiveFormat.ts";

/**
 * EXTRA_PLUGIN_PATHS_DUAL — W31a.
 *
 * Setting `extra_plugin_paths` tells KOReader to load plugins (Lua code)
 * from the listed directories. Even after the user has cleared the
 * generic SENSITIVE_REQUIRES_ACK gate via --accept-sensitive or
 * --accept-key=extra_plugin_paths (data-flow consent), this key still
 * needs --accept-plugins consent (code-exec consent): the user is
 * asking for code to execute on their Kindle from a path they may not
 * fully control.
 *
 * Two flags, two distinct mental models — don't collapse them into one.
 */
export const EXTRA_PLUGIN_PATHS_DUAL: GateDefinition = {
    id: "EXTRA_PLUGIN_PATHS_DUAL",
    category: "DUAL",
    appliesAt: ["import"],
    requires: ["sensitiveHits"],
    firesIn: "non-dry-run",
    bypassFlags: ["--accept-plugins"],
    errorCode: "FAT_REQUIRES_ACK",
    remediation: [
        { text: "Inspect the path the Setup sets.", command: "kindly setup inspect <file>" },
        { text: "Pass --accept-plugins to consent to plugin code execution." },
    ],
    check: (ctx) => {
        const hits = ctx.producers.sensitiveHits as string[];
        if (!hits.includes("extra_plugin_paths")) return { kind: "pass" };
        const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
        const newPath = formatSensitiveChange(changes, "extra_plugin_paths");
        return {
            kind: "block",
            message:
                `this Setup sets extra_plugin_paths — KOReader will load ` +
                "Lua plugins from the listed directories. Any Lua code in " +
                "those paths will execute on your Kindle with full device " +
                `access.\n  extra_plugin_paths: ${newPath}`,
        };
    },
};
