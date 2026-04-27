// Library entry point for `diff` — compare YAML against on-device settings.
// Pure: read-only, returns a typed result; never prints. Throws KindlyError
// on missing YAML / mount and ArgError on unknown --category.

import { resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
import { handleInterruptedApply } from "./recoverInterrupted.ts";
import { ArgError } from "../cli/args.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { yamlToLua } from "../schema/yaml.ts";
import type { LuaValue } from "../lua/writer.ts";
import { computeChanges } from "../schema/diff.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { DiffResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { groupChanges } from "../taxonomy/group.ts";
import { categoryOf, loadTaxonomy } from "../taxonomy/mapper.ts";

export interface DiffOptions {
    file?: string;
    /** Restrict output to this taxonomy category. Unknown names throw ArgError. */
    category?: string;
    /** R8: when true, auto-run doctor --repair if interrupted-apply
     *  state is detected. When undefined, prompt on TTY / throw on non-TTY. */
    autoRepair?: boolean;
}

export function executeDiff(opts: DiffOptions, env: CliEnv): DiffResult {
    const yamlPath = resolve(env.cwd, opts.file ?? "kindly.yaml");
    if (!exists(yamlPath, "user-provided")) {
        throw new KindlyError(
            ErrorCodes.YAML_NOT_FOUND,
            `${yamlPath} not found. Run \`kindly pull\` first?`,
            [{ text: "Capture the device's current config.", command: "kindly pull" }],
        );
    }

    const mount = resolveMount(env);
    if (!exists(mount.settingsPath, "derived-from-mount")) {
        const interrupted = detectInterruptedApply(mount.settingsPath);
        if (interrupted) {
            const decision = handleInterruptedApply(interrupted, env, {
                autoRepair: opts.autoRepair,
            });
            if (decision === "throw" || !exists(mount.settingsPath, "derived-from-mount")) {
                throw new KindlyError(
                    ErrorCodes.SETTINGS_INTERRUPTED_APPLY,
                    `${mount.settingsPath} is missing but ${interrupted.oldPath} survives — a previous kindly apply / setup import was interrupted between rename steps.`,
                    [
                        {
                            text: "Recover by promoting .old back into place.",
                            command: "kindly doctor --repair",
                        },
                        {
                            text: "Or pass --auto-repair to recover automatically.",
                        },
                    ],
                );
            }
            // Repair succeeded; fall through.
        } else {
            throw new KindlyError(
                ErrorCodes.SETTINGS_NOT_FOUND,
                `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist.`,
                [{ text: "Install KOReader on the Kindle, then retry." }],
            );
        }
    }
    const onDevice = parseSettingsFile(readText(mount.settingsPath, "derived-from-mount")) as Record<string, LuaValue>;
    const fromYaml = yamlToLua(readText(yamlPath, "user-provided")) as Record<string, LuaValue>;

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
