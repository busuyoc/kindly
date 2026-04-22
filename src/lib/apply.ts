// Library entry point for `apply` — merge YAML into device settings.
// Pure: returns a typed result; never prints. Throws KindlyError on user-
// visible failures (missing YAML, missing mount).
//
// Non-destructive: keys present on device but not in YAML are preserved.
// This is the core safety property — a half-populated YAML doesn't wipe
// your zlibrary password.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile } from "../lua/writer.ts";
import type { LuaTable, LuaValue } from "../lua/writer.ts";
import { mergeYamlIntoLua, yamlToLua } from "../schema/yaml.ts";
import { computeChanges } from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { ApplyResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { appendHistoryEntry } from "../history/writer.ts";

export interface ApplyOptions {
    file?: string;
    dryRun?: boolean;
    backupDir?: string;
    label?: string;
}

export function executeApply(opts: ApplyOptions, env: CliEnv): ApplyResult {
    const yamlPath = resolve(env.cwd, opts.file ?? "kindly.yaml");
    if (!existsSync(yamlPath)) {
        throw new KindlyError(
            ErrorCodes.YAML_NOT_FOUND,
            `${yamlPath} not found. Run \`kindly pull\` first?`,
            [{ text: "Capture the device's current config.", command: "kindly pull" }],
        );
    }

    const mount = resolveMount(env);
    const onDeviceSrc = readFileSync(mount.settingsPath, "utf8");
    const onDevice = parseSettingsFile(onDeviceSrc) as Record<string, LuaValue>;
    const fromYaml = yamlToLua(readFileSync(yamlPath, "utf8")) as Record<string, LuaValue>;

    const changes = computeChanges(onDevice, fromYaml);

    if (changes.length === 0) {
        return {
            mode: "no-op",
            yamlPath,
            settingsPath: mount.settingsPath,
            changes,
            backupPath: null,
            oldPath: null,
            bytesWritten: 0,
        };
    }

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            yamlPath,
            settingsPath: mount.settingsPath,
            changes,
            backupPath: null,
            oldPath: null,
            bytesWritten: 0,
        };
    }

    const merged = mergeYamlIntoLua(onDevice, fromYaml) as LuaTable;
    // Mirror KOReader's "./settings.reader.lua" header — cwd when koreader
    // runs is /mnt/us/koreader/, making the path relative. We match exactly.
    const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

    const backupDir = opts.backupDir
        ? resolve(env.cwd, opts.backupDir)
        : join(env.cwd, ".kindly", "backups");

    const res = safeWrite(mount.settingsPath, newContent, { backupDir, verifyLua: true });

    appendHistoryEntry(env, "apply", {
        settings_delta_n: changes.length,
        ...(res.backupPath ? { backup_path: res.backupPath } : {}),
    }, opts.label ? { label: opts.label } : undefined);

    return {
        mode: "applied",
        yamlPath,
        settingsPath: mount.settingsPath,
        changes,
        backupPath: res.backupPath,
        oldPath: res.oldPath,
        bytesWritten: res.bytesWritten,
    };
}
