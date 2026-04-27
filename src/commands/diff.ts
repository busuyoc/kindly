// `kindly diff` — compare YAML against on-device settings. Read-only.
//
// Shows three categories:
//   + key            would-be-added (in YAML, not on device)
//   - key            would-be-removed (NOT shown — apply doesn't delete)
//   ~ key  old → new changed
//
// Plus an "unchanged on device, not in YAML" note so users know what won't
// be touched (this is the most common misunderstanding: kindly.yaml doesn't
// track everything on the device unless you run `pull --full`).
//
// Pure logic lives in src/lib/diff.ts; this module is the CLI adapter.

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, heading, info, paint } from "../cli/log.ts";
import type { Change } from "../schema/diff.ts";
import type { DiffResult } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executeDiff, type DiffOptions } from "../lib/diff.ts";

export { executeDiff, type DiffOptions };

const FLAGS = {
    file: {
        type: "string",
        default: "kindly.yaml",
        description: "YAML file to compare against",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    category: {
        type: "string",
        description: "narrow output to a single taxonomy category (e.g. fonts, display)",
    },
    "auto-repair": {
        type: "boolean",
        default: false,
        description: "auto-run `doctor --repair` if a previous apply was interrupted (default: prompt on TTY, throw otherwise)",
    },
} as const satisfies FlagSpecs;

export function renderDiff(result: DiffResult, env: CliEnv): void {
    const scope = result.filteredBy ? ` in ${result.filteredBy}` : "";
    if (result.changes.length === 0) {
        if (result.filteredBy) {
            info(env, `no differences in ${result.filteredBy} — device matches YAML for that category.`);
        } else {
            info(env, "no differences — device matches YAML for all keys in YAML.");
        }
    } else {
        heading(env, `${result.changes.length} change(s)${scope} would be applied:`);
        for (const c of result.changes) {
            renderChange(env, c);
        }
    }

    // Don't be quiet about keys the device has that YAML doesn't — users
    // often mistake this for a bug.
    if (result.untrackedKeys.length > 0) {
        info(env, "");
        info(env, dim(env,
            `(${result.untrackedKeys.length} on-device key(s)${scope} not tracked by this YAML — apply will leave them unchanged.)`
        ));
    }
}

export async function runDiff(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeDiff(
        {
            file: flags.file,
            ...(flags.category ? { category: flags.category } : {}),
            autoRepair: flags["auto-repair"],
        },
        env,
    );
    if (env.jsonMode) emitJson(env, "diff", result);
    else renderDiff(result, env);

    // Exits non-zero on changes, matching `git diff` style. Useful for
    // CI-style "is the device drifted?" checks.
    return result.changes.length === 0 ? 0 : 1;
}

function renderChange(env: CliEnv, c: Change): void {
    const joinedPath = c.path.join(".");
    if (c.kind === "added") {
        info(env, paint(env, "green", `  + ${joinedPath}`) + `  = ${fmt(c.next)}`);
    } else if (c.kind === "changed") {
        info(env,
            paint(env, "yellow", `  ~ ${joinedPath}`) +
            `  ${fmt(c.prev)} ${dim(env, "→")} ${fmt(c.next)}`
        );
    }
    // "removed" is elided: apply is non-destructive, so we don't show keys
    // that are on-device-only (they'd create noise without actionable signal).
}

function fmt(v: unknown): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === null) return "nil";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

export const diffHelp = `
kindly diff — show what apply would change on the device.

usage: kindly diff [--file <path>] [--mount <path>] [--category <name>]

  --file <path>      YAML to diff against (default: kindly.yaml)
  --mount <path>     path to a mounted Kindle (auto-detected by default)
  --category <name>  restrict output to a single taxonomy category
                     (e.g. fonts, display, status_bar, reading)
  --auto-repair      auto-recover from an interrupted previous apply
                     (default: prompt on TTY, throw otherwise)

Exit code: 0 if no changes, 1 if changes present.
`.trim();
