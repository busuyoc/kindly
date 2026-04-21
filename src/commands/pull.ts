// `kindly pull` — read settings.reader.lua from the device, filter, write YAML.
//
// Behavior:
//   - Reads <mount>/koreader/settings.reader.lua
//   - Parses it, classifies keys (secret/ephemeral/user)
//   - Writes the kept subset to <output> (default kindly.yaml in cwd)
//   - Reports which keys were filtered, so the user knows what isn't captured

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSettingsFile } from "../lua/reader.ts";
import { luaToYaml } from "../schema/yaml.ts";
import type { LuaTable } from "../lua/writer.ts";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, ok, warn } from "../cli/log.ts";

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

export async function runPull(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const mount = resolveMount(env);
    const settingsPath = mount.settingsPath;

    if (!existsSync(settingsPath)) {
        throw new Error(
            `Kindle mount found at ${mount.root}, but ${settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`
        );
    }

    info(env, dim(env, `reading ${settingsPath}`));
    const src = readFileSync(settingsPath, "utf8");
    const parsed = parseSettingsFile(src) as LuaTable;

    const mode = flags.full ? "full" : "minimal";
    const { yaml, filter } = luaToYaml(parsed, mode);

    const outPath = resolve(env.cwd, flags.output);
    if (existsSync(outPath) && !flags.force) {
        throw new Error(
            `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`
        );
    }

    writeFileSync(outPath, yaml);
    ok(env, `wrote ${outPath}`);
    info(env, dim(env, `  ${yaml.split("\n").length} lines, ${Buffer.byteLength(yaml)} bytes`));

    if (filter.droppedSecrets.length > 0) {
        warn(env,
            `filtered ${filter.droppedSecrets.length} secret key(s) — store these in a password manager, ` +
            `not in ${flags.output}:`
        );
        for (const k of filter.droppedSecrets) {
            info(env, `    - ${k}`);
        }
    }
    if (filter.droppedEphemerals.length > 0 && mode === "minimal") {
        info(env, dim(env,
            `  ${filter.droppedEphemerals.length} ephemeral key(s) skipped (pass --full to include)`
        ));
    }

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
