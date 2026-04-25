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
import { sensitiveDomain } from "../../schema/classify.ts";

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

/**
 * CODE_EXEC_ADJACENT_REQUIRES_ACK — C1a.
 *
 * Some settings keys are interpolated by KOReader into `os.execute`,
 * `os.remove`, or `string.format`-to-shell call sites on the device
 * side. Examples: `SSH_port` (dropbear -p <val>), `httpinspector_port`,
 * `cover_image_path` (os.remove). Changing these gives an attacker a
 * chosen-arg primitive against KOReader — distinct threat class from
 * the generic SENSITIVE data-flow consent.
 *
 * Fires at import, apply, and restore — at import, a fat Setup
 * declaring these keys triggers the gate; at apply, a plain
 * `kindly apply` with these keys in the YAML does the same (closes
 * Lead 7's apply-side gap for this specific key family); at restore,
 * an archive whose settings.reader.lua sets these keys is gated
 * before any extraction occurs (closes S601 for this key family).
 * Bypass is a dedicated `--accept-code-exec` flag; --accept-sensitive
 * does NOT bypass.
 *
 * The denylist is data-driven: `data/classify/settings.v1.json`
 * `code_exec_adjacent` array + `isCodeExecAdjacent()` helper.
 */
export const CODE_EXEC_ADJACENT_REQUIRES_ACK: GateDefinition = {
    id: "CODE_EXEC_ADJACENT_REQUIRES_ACK",
    category: "DUAL",
    appliesAt: ["import", "apply", "restore"],
    requires: ["codeExecAdjacentHits"],
    firesIn: "non-dry-run",
    bypassFlags: ["--accept-code-exec"],
    errorCode: "CODE_EXEC_REQUIRES_ACK",
    remediation: [
        { text: "Review the key(s) set by this change.", command: "kindly diff" },
        { text: "Pass --accept-code-exec to consent to KOReader interpolating these values into shell / os.remove / os.execute calls." },
    ],
    check: (ctx) => {
        const hits = ctx.producers.codeExecAdjacentHits as string[];
        if (hits.length === 0) return { kind: "pass" };
        const changes = (ctx.opts.changes as Change[] | undefined) ?? [];
        const list = hits
            .map((p) => `  [${sensitiveDomain(p)}] ${p}: ${formatSensitiveChange(changes, p)}`)
            .join("\n");
        return {
            kind: "block",
            message:
                `this change sets ${hits.length} key(s) whose values KOReader ` +
                "interpolates into os.execute / os.remove / shell calls:\n" +
                list,
        };
    },
};
