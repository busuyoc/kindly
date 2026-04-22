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
// Shape: executeDiff() does the read + compute and returns DiffResult;
// renderDiff() prints; runDiff() glues them via argv and maps to exit code.
// Split enables JSON rendering (W3) and in-process consumers (GUI).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, paint } from "../cli/log.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { yamlToLua } from "../schema/yaml.ts";
import type { LuaValue } from "../lua/writer.ts";
import { computeChanges, type Change } from "../schema/diff.ts";
import type { DiffResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";
import { groupChanges } from "../taxonomy/group.ts";
import { categoryOf, loadTaxonomy } from "../taxonomy/mapper.ts";

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
} as const satisfies FlagSpecs;

export interface DiffOptions {
    file?: string;
    /** Restrict output to this taxonomy category. Unknown names throw ArgError. */
    category?: string;
}

// Compute the diff between YAML and the on-device settings. Returns data;
// does not print. Throws on missing YAML / mount.
export function executeDiff(opts: DiffOptions, env: CliEnv): DiffResult {
    const yamlPath = resolve(env.cwd, opts.file ?? "kindly.yaml");
    if (!existsSync(yamlPath)) {
        throw new KindlyError(
            ErrorCodes.YAML_NOT_FOUND,
            `${yamlPath} not found. Run \`kindly pull\` first?`,
            [{ text: "Capture the device's current config.", command: "kindly pull" }],
        );
    }

    const mount = resolveMount(env);
    const onDevice = parseSettingsFile(readFileSync(mount.settingsPath, "utf8")) as Record<string, LuaValue>;
    const fromYaml = yamlToLua(readFileSync(yamlPath, "utf8")) as Record<string, LuaValue>;

    const allChanges = computeChanges(onDevice, fromYaml);

    const yamlKeys = new Set(Object.keys(fromYaml));
    const allUntracked = Object.keys(onDevice)
        .filter((k) => !yamlKeys.has(k))
        .sort();

    // --category filter: restrict both changes and untrackedKeys to a single
    // taxonomy bucket. The category must exist in the taxonomy (typos throw
    // rather than silently returning an empty diff).
    const tax = loadTaxonomy();
    if (opts.category !== undefined && !tax.categories.includes(opts.category)) {
        throw new ArgError(
            `unknown category: "${opts.category}". Valid: ${tax.categories.join(", ")}`,
        );
    }

    const changes = opts.category === undefined
        ? allChanges
        : allChanges.filter((c) => categoryOf(tax, c.path[0]!) === opts.category);
    const untrackedKeys = opts.category === undefined
        ? allUntracked
        : allUntracked.filter((k) => categoryOf(tax, k) === opts.category);
    const grouped = groupChanges(changes, tax);

    return {
        yamlPath,
        settingsPath: mount.settingsPath,
        changes,
        grouped,
        untrackedKeys,
        ...(opts.category !== undefined ? { filteredBy: opts.category } : {}),
    };
}


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

Exit code: 0 if no changes, 1 if changes present.
`.trim();
