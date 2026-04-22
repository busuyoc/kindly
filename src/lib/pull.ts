// Library entry point for `pull` — read device settings, filter, write YAML.
// Pure: returns a typed result; never prints. Throws KindlyError on user-
// visible failures (missing settings, output collision, missing mount).
//
// Commands use this via src/commands/pull.ts (text/JSON rendering). serve
// reaches it transitively through the CLI dispatcher (W26 argv passthrough).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSettingsFile } from "../lua/reader.ts";
import { luaToYaml } from "../schema/yaml.ts";
import type { LuaTable } from "../lua/writer.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { PullResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

export interface PullOptions {
    full?: boolean;
    output?: string;
    force?: boolean;
}

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
