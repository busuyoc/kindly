// `kindly apply` — merge YAML into the device's settings.reader.lua.
//
// Flow:
//   1. Parse on-device settings
//   2. Parse YAML
//   3. Compute diff — if empty, exit 0 without writing
//   4. If --dry-run, print the diff and exit
//   5. Otherwise, merge YAML-over-device, safe-write, confirm
//
// Non-destructive: keys present on device but not in YAML are preserved.
// This is the core safety property — a half-populated YAML doesn't wipe
// your zlibrary password.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, paint, warn } from "../cli/log.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile } from "../lua/writer.ts";
import type { LuaTable, LuaValue } from "../lua/writer.ts";
import { mergeYamlIntoLua, yamlToLua } from "../schema/yaml.ts";
import { computeChanges } from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";

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
} as const satisfies FlagSpecs;

export async function runApply(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const yamlPath = resolve(env.cwd, flags.file!);
    if (!existsSync(yamlPath)) {
        throw new Error(`${yamlPath} not found. Run \`kindly pull\` first?`);
    }

    const mount = resolveMount(env);
    const onDeviceSrc = readFileSync(mount.settingsPath, "utf8");
    const onDevice = parseSettingsFile(onDeviceSrc) as Record<string, LuaValue>;
    const fromYaml = yamlToLua(readFileSync(yamlPath, "utf8")) as Record<string, LuaValue>;

    const changes = computeChanges(onDevice, fromYaml);
    if (changes.length === 0) {
        info(env, "no changes — device already matches YAML.");
        return 0;
    }

    heading(env, `${changes.length} change(s) to apply:`);
    for (const c of changes) {
        const p = c.path.join(".");
        if (c.kind === "added") {
            info(env, paint(env, "green", `  + ${p}`) + `  = ${fmt(c.next)}`);
        } else {
            info(env, paint(env, "yellow", `  ~ ${p}`) + `  ${fmt(c.prev)} → ${fmt(c.next)}`);
        }
    }

    if (flags["dry-run"]) {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return 0;
    }

    const merged = mergeYamlIntoLua(onDevice, fromYaml) as LuaTable;
    // Mirror KOReader's "./settings.reader.lua" header — cwd when koreader
    // runs is /mnt/us/koreader/, making the path relative. We match exactly.
    const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

    const backupDir = flags["backup-dir"]
        ? resolve(env.cwd, flags["backup-dir"])
        : join(env.cwd, ".kindly", "backups");

    const res = safeWrite(mount.settingsPath, newContent, { backupDir, verifyLua: true });

    ok(env, `applied to ${mount.settingsPath}`);
    if (res.backupPath) {
        info(env, dim(env, `  snapshot: ${res.backupPath}`));
    }
    if (res.oldPath) {
        info(env, dim(env, `  .old sibling preserved for KOReader's fallback`));
    }
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
    return 0;
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

  --file <path>        YAML to apply (default: kindly.yaml)
  --dry-run            show changes without writing
  --mount <path>       path to a mounted Kindle (auto-detect by default)
  --backup-dir <path>  where to archive pre-write snapshots
                       (default: <cwd>/.kindly/backups)

Apply is non-destructive: on-device keys not present in YAML are preserved
(this is how secrets and ephemerals survive round-tripping through YAML).
`.trim();
