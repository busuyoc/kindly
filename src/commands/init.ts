// `kindly init <preset>` — write a starter YAML. Doesn't touch the device.
//
// v0.1 has one preset: "minimal". Presets live in src/presets/ so adding
// a new one is one file + one dispatch case.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { exists } from "../fs/safeRead.ts";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv } from "../cli/env.ts";
import { info, ok } from "../cli/log.ts";
import { MINIMAL_PRESET } from "../presets/minimal.ts";
import { luaToYaml } from "../schema/yaml.ts";
import type { LuaTable } from "../lua/writer.ts";

const FLAGS = {
    output: {
        type: "string",
        default: "kindly.yaml",
        description: "output path",
    },
    force: {
        type: "boolean",
        default: false,
        description: "overwrite if output exists",
    },
} as const satisfies FlagSpecs;

const PRESETS: Record<string, Record<string, unknown>> = {
    minimal: MINIMAL_PRESET,
};

export async function runInit(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const presetName = positional[0];
    if (!presetName) {
        throw new Error(`usage: kindly init <preset>. Available: ${Object.keys(PRESETS).join(", ")}`);
    }
    const preset = PRESETS[presetName];
    if (!preset) {
        throw new Error(`unknown preset: ${presetName}. Available: ${Object.keys(PRESETS).join(", ")}`);
    }

    const outPath = resolve(env.cwd, flags.output!);
    if (exists(outPath, "user-provided") && !flags.force) {
        throw new Error(`${outPath} already exists. Pass --force to overwrite.`);
    }

    // Use our own luaToYaml so the file shape matches what pull produces.
    // "full" mode — preset keys are explicit, we don't need filtering.
    const { yaml } = luaToYaml(preset as LuaTable, "full");
    writeFileSync(outPath, yaml);

    ok(env, `wrote ${outPath} (${presetName} preset)`);
    info(env, `  next: run \`kindly diff\` to see what would change, then \`kindly apply\`.`);
    return 0;
}

export const initHelp = `
kindly init <preset> — write a starter kindly.yaml.

usage: kindly init <preset> [--output <path>] [--force]

Available presets:
  minimal        a small set of sensible defaults (UI, reader, plugins)

  --output <path>  output path (default: kindly.yaml)
  --force          overwrite if output exists
`.trim();
