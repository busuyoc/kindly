// `kindly apply` — merge YAML into the device's settings.reader.lua.
//
// Flow:
//   1. Parse on-device settings
//   2. Parse YAML
//   3. Compute diff — if empty, return mode="no-op" without writing
//   4. If --dry-run, return mode="dry-run" with the diff
//   5. Otherwise merge YAML-over-device, safe-write, verify, return "applied"
//
// Pure logic lives in src/lib/apply.ts; this module is the CLI adapter
// (flag parsing, text rendering, JSON envelope wrapping).

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, heading, info, ok, paint, warn } from "../cli/log.ts";
import type { Change } from "../schema/diff.ts";
import type { ApplyResult } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executeApply, type ApplyOptions } from "../lib/apply.ts";

export { executeApply, type ApplyOptions };

const FLAGS = {
    file: {
        type: "string",
        default: "kindly.yaml",
        description: "YAML file to apply",
    },
    "dry-run": {
        type: "boolean",
        default: false,
        description: "show what would change without writing",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    "backup-dir": {
        type: "string",
        description: "where to archive pre-write snapshots (default: <cwd>/.kindly/backups)",
    },
    label: {
        type: "string",
        description: "advisory name for this change — shown in `kindly history`",
    },
    "accept-code-exec": {
        type: "boolean",
        default: false,
        description:
            "consent to KOReader interpolating YAML values into os.execute / " +
            "os.remove / shell calls (SSH_port, httpinspector_port, cover_image_path)",
    },
} as const satisfies FlagSpecs;

export function renderApply(result: ApplyResult, env: CliEnv): void {
    if (result.mode === "no-op") {
        info(env, "no changes — device already matches YAML.");
        return;
    }

    heading(env, `${result.changes.length} change(s) to apply:`);
    for (const c of result.changes) {
        renderChange(env, c);
    }

    if (result.mode === "dry-run") {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    ok(env, `applied to ${result.settingsPath}`);
    if (result.backupPath) {
        info(env, dim(env, `  snapshot: ${result.backupPath}`));
    }
    if (result.oldPath) {
        info(env, dim(env, `  .old sibling preserved for KOReader's fallback`));
    }
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
}

export async function runApply(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeApply({
        file: flags.file,
        dryRun: flags["dry-run"],
        backupDir: flags["backup-dir"],
        label: flags.label,
        acceptCodeExec: flags["accept-code-exec"],
    }, env);

    if (env.jsonMode) emitJson(env, "apply", result);
    else renderApply(result, env);
    return 0;
}

function renderChange(env: CliEnv, c: Change): void {
    const p = c.path.join(".");
    if (c.kind === "added") {
        info(env, paint(env, "green", `  + ${p}`) + `  = ${fmt(c.next)}`);
    } else if (c.kind === "changed") {
        info(env, paint(env, "yellow", `  ~ ${p}`) + `  ${fmt(c.prev)} → ${fmt(c.next)}`);
    }
    // "removed" is elided: apply is non-destructive, so on-device-only keys
    // are not shown (would create noise without actionable signal).
}

function fmt(v: unknown): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === null) return "nil";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

export const applyHelp = `
kindly apply — merge kindly.yaml into the device's settings.reader.lua.

usage: kindly apply [--file <path>] [--dry-run] [--mount <path>] [--backup-dir <path>]
                    [--accept-code-exec]

  --file <path>        YAML to apply (default: kindly.yaml)
  --dry-run            show changes without writing
  --mount <path>       path to a mounted Kindle (auto-detect by default)
  --backup-dir <path>  where to archive pre-write snapshots
                       (default: <cwd>/.kindly/backups)
  --accept-code-exec   consent to KOReader interpolating YAML values into
                       os.execute / os.remove / shell calls (SSH_port,
                       httpinspector_port, cover_image_path)

Apply is non-destructive: on-device keys not present in YAML are preserved
(this is how secrets and ephemerals survive round-tripping through YAML).
`.trim();
