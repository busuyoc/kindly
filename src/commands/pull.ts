// `kindly pull` — read settings.reader.lua from the device, filter, write YAML.
//
// Behavior:
//   - Reads <mount>/koreader/settings.reader.lua
//   - Parses it, classifies keys (secret/ephemeral/user)
//   - Writes the kept subset to <output> (default kindly.yaml in cwd)
//   - Reports which keys were filtered, so the user knows what isn't captured
//
// Pure logic lives in src/lib/pull.ts; this module is the CLI adapter
// (flag parsing, text rendering, JSON envelope wrapping).

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, info, ok, warn } from "../cli/log.ts";
import type { PullResult } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executePull, type PullOptions } from "../lib/pull.ts";

export { executePull, type PullOptions };

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
    "auto-repair": {
        type: "boolean",
        default: false,
        description: "auto-run `doctor --repair` if a previous apply was interrupted (default: prompt on TTY, throw otherwise)",
    },
} as const satisfies FlagSpecs;

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
        autoRepair: flags["auto-repair"],
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
  --auto-repair    auto-recover from an interrupted previous apply.
                   Default: prompt on TTY, throw structured error otherwise.
`.trim();
