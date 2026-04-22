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
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, paint } from "../cli/log.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { yamlToLua } from "../schema/yaml.ts";
import type { LuaValue } from "../lua/writer.ts";
import { computeChanges, type Change } from "../schema/diff.ts";
import type { DiffResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";

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
} as const satisfies FlagSpecs;

export interface DiffOptions {
    file?: string;
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

    const changes = computeChanges(onDevice, fromYaml);

    const yamlKeys = new Set(Object.keys(fromYaml));
    const untrackedKeys = Object.keys(onDevice)
        .filter((k) => !yamlKeys.has(k))
        .sort();

    return {
        yamlPath,
        settingsPath: mount.settingsPath,
        changes,
        untrackedKeys,
    };
}

export function renderDiff(result: DiffResult, env: CliEnv): void {
    if (result.changes.length === 0) {
        info(env, "no differences — device matches YAML for all keys in YAML.");
    } else {
        heading(env, `${result.changes.length} change(s) would be applied:`);
        for (const c of result.changes) {
            renderChange(env, c);
        }
    }

    // Don't be quiet about keys the device has that YAML doesn't — users
    // often mistake this for a bug.
    if (result.untrackedKeys.length > 0) {
        info(env, "");
        info(env, dim(env,
            `(${result.untrackedKeys.length} on-device key(s) not tracked by this YAML — apply will leave them unchanged.)`
        ));
    }
}

export async function runDiff(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeDiff({ file: flags.file }, env);
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

usage: kindly diff [--file <path>] [--mount <path>]

  --file <path>   YAML to diff against (default: kindly.yaml)
  --mount <path>  path to a mounted Kindle (auto-detected by default)

Exit code: 0 if no changes, 1 if changes present.
`.trim();
