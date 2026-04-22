// `kindly pull` — read settings.reader.lua from the device, filter, write YAML.
//
// Behavior:
//   - Reads <mount>/koreader/settings.reader.lua
//   - Parses it, classifies keys (secret/ephemeral/user)
//   - Writes the kept subset to <output> (default kindly.yaml in cwd)
//   - Reports which keys were filtered, so the user knows what isn't captured
//
// Shape: executePull() does the work and returns PullResult; renderPull()
// prints; runPull() glues them via argv. The split is for W3 (--json) and
// future in-process consumers (GUI) — same work, different output.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSettingsFile } from "../lua/reader.ts";
import { luaToYaml } from "../schema/yaml.ts";
import type { LuaTable } from "../lua/writer.ts";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, ok, warn } from "../cli/log.ts";
import type { PullResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";

const FLAGS = {
    full: {
        type: "boolean",
        default: false,
        description: "include ephemerals (lastfile, migration markers, etc). Secrets are always filtered.",
    },
    output: {
        type: "string",
        default: "kindly.yaml",
        description: "output path for the YAML file",
    },
    force: {
        type: "boolean",
        default: false,
        description: "overwrite the output file if it exists",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

export interface PullOptions {
    full?: boolean;
    output?: string;
    force?: boolean;
}

// Do the pull. Returns what happened; callers render it however they like.
// Throws on user-visible errors (missing settings, output collision without
// --force, missing mount). The CLI dispatcher catches and prints.
export function executePull(opts: PullOptions, env: CliEnv): PullResult {
    const mount = resolveMount(env);
    const settingsPath = mount.settingsPath;

    if (!existsSync(settingsPath)) {
        throw new KindlyError(
            ErrorCodes.SETTINGS_NOT_FOUND,
            `Kindle mount found at ${mount.root}, but ${settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`,
            [{ text: "Install KOReader on the Kindle, then retry." }],
        );
    }

    const src = readFileSync(settingsPath, "utf8");
    const parsed = parseSettingsFile(src) as LuaTable;

    const mode: "minimal" | "full" = opts.full ? "full" : "minimal";
    const { yaml, filter } = luaToYaml(parsed, mode);

    const outPath = resolve(env.cwd, opts.output ?? "kindly.yaml");
    if (existsSync(outPath) && !opts.force) {
        throw new KindlyError(
            ErrorCodes.OUTPUT_EXISTS,
            `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`,
            [
                { text: "Overwrite it.", command: "kindly pull --force" },
                { text: "Write to a different path.", command: "kindly pull --output <path>" },
            ],
        );
    }

    writeFileSync(outPath, yaml);

    return {
        mode,
        settingsPath,
        outputPath: outPath,
        bytes: Buffer.byteLength(yaml),
        lines: yaml.split("\n").length,
        droppedSecrets: [...filter.droppedSecrets].sort(),
        droppedEphemerals: [...filter.droppedEphemerals].sort(),
    };
}

// Human-readable rendering. Mirrors the pre-v0.6 output exactly; the JSON
// renderer (W3) will be a sibling, not a replacement.
export function renderPull(result: PullResult, env: CliEnv): void {
    info(env, dim(env, `reading ${result.settingsPath}`));
    ok(env, `wrote ${result.outputPath}`);
    info(env, dim(env, `  ${result.lines} lines, ${result.bytes} bytes`));

    if (result.droppedSecrets.length > 0) {
        warn(env,
            `filtered ${result.droppedSecrets.length} secret key(s) — store these in a password manager, ` +
            `not in ${result.outputPath}:`
        );
        for (const k of result.droppedSecrets) {
            info(env, `    - ${k}`);
        }
    }
    if (result.droppedEphemerals.length > 0 && result.mode === "minimal") {
        info(env, dim(env,
            `  ${result.droppedEphemerals.length} ephemeral key(s) skipped (pass --full to include)`
        ));
    }
}

export async function runPull(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executePull({
        full: flags.full,
        output: flags.output,
        force: flags.force,
    }, env);
    if (env.jsonMode) emitJson(env, "pull", result);
    else renderPull(result, env);
    return 0;
}

export const pullHelp = `
kindly pull — read settings.reader.lua from the Kindle, write kindly.yaml.

usage: kindly pull [--full] [--output <path>] [--force] [--mount <path>]

  --full           include ephemerals. Secrets are ALWAYS filtered.
  --output <path>  where to write the YAML (default: kindly.yaml in cwd)
  --force          overwrite the output if it exists
  --mount <path>   path to a mounted Kindle (auto-detect by default)
`.trim();
