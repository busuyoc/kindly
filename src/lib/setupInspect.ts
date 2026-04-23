// Library entry point for `setup inspect` — read a .kset.yaml (lean) or
// .kset (fat tarball), validate, and return a structured summary including
// optional preview diff against the device or against an empty baseline.
// Pure: read-only, returns a typed result; never prints.

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../setup/canonical.ts";
import type { SetupManifest } from "../setup/schema.ts";
import { computeChanges, computeReplaceChanges, type Change } from "../schema/diff.ts";
import { collectSensitiveFromSettings, sensitiveDomain } from "../schema/classify.ts";
import { groupChanges } from "../taxonomy/group.ts";
import type { SetupInspectResult } from "../types/results.ts";
import { loadSetup } from "./importSetup.ts";

export interface SetupInspectOptions {
    /** When set, compute a settings-preview diff against the chosen baseline. */
    preview?: "vs-device" | "vs-default";
}

export function executeSetupInspect(
    fileArg: string,
    env: CliEnv,
    opts: SetupInspectOptions = {},
): SetupInspectResult {
    const path = resolve(env.cwd, fileArg);
    const { manifest, manifestBytes, isFat } = loadSetup(path);

    const rawText = manifestBytes.toString("utf8");
    const rawHash = hashBytes(manifestBytes);
    const canonicalBytes = canonicalizeManifest(manifest);
    const isCanonical = rawText === canonicalBytes;
    const id = shortId(rawHash);

    return {
        filePath: path,
        id,
        hash: rawHash,
        name: manifest.meta.name,
        isFat,
        fileSize: statSync(path).size,
        manifestBytes: manifestBytes.length,
        applyMode: manifest.apply_mode,
        createdAt: manifest.meta.created_at,
        ...(manifest.meta.author ? { author: manifest.meta.author } : {}),
        ...(manifest.meta.description ? { description: manifest.meta.description } : {}),
        tags: manifest.meta.tags ?? [],
        ...(manifest.meta.source_url ? { sourceUrl: manifest.meta.source_url } : {}),
        ...(manifest.meta.version ? { version: manifest.meta.version } : {}),
        ...(manifest.meta.author_key_id ? { authorKeyId: manifest.meta.author_key_id } : {}),
        ...(manifest.meta.supersedes?.length
            ? { supersedes: [...manifest.meta.supersedes] } : {}),
        ...(manifest.compat ? {
            compat: {
                ...(manifest.compat.koreader_version_min
                    ? { koreaderVersionMin: manifest.compat.koreader_version_min } : {}),
                ...(manifest.compat.koreader_version_max
                    ? { koreaderVersionMax: manifest.compat.koreader_version_max } : {}),
                ...(manifest.compat.device?.length
                    ? { device: [...manifest.compat.device] } : {}),
            },
        } : {}),
        settingsCount: manifest.settings ? Object.keys(manifest.settings).length : 0,
        pluginsDisabledCount: manifest.plugins?.disabled?.length ?? 0,
        pluginFilesCount: manifest.plugins?.files?.length ?? 0,
        patchesCount: manifest.patches?.length ?? 0,
        isCanonical,
        ...(isCanonical ? {} : { canonicalHash: manifestHash(manifest) }),
        ...(opts.preview ? { preview: computePreview(manifest, opts.preview, env) } : {}),
        ...securityBlock(manifest),
    };
}

// W34f: group SENSITIVE hits declared in the manifest by threat domain.
// Returns { security: ... } when any hits exist, {} otherwise — merges
// cleanly into the result spread.
function securityBlock(
    manifest: SetupManifest,
): { security?: NonNullable<SetupInspectResult["security"]> } {
    const settings = manifest.settings as Record<string, unknown> | undefined;
    if (!settings) return {};
    const hits = collectSensitiveFromSettings(settings);
    if (hits.length === 0) return {};
    const byDomain: Record<string, string[]> = {};
    for (const h of hits) {
        const d = sensitiveDomain(h);
        (byDomain[d] ??= []).push(h);
    }
    return { security: { total: hits.length, byDomain } };
}

// Compare manifest.settings against a baseline and return the grouped preview.
// "vs-device" reads the live settings.reader.lua; "vs-default" diffs against
// an empty config so every manifest key appears as "added" (answers
// "what does this setup do to a fresh device?").
function computePreview(
    manifest: SetupManifest,
    mode: "vs-device" | "vs-default",
    env: CliEnv,
): NonNullable<SetupInspectResult["preview"]> {
    const manifestSettings = (manifest.settings ?? {}) as Record<string, LuaValue>;

    let baseline: Record<string, LuaValue>;
    let settingsPath: string | undefined;
    if (mode === "vs-device") {
        const mount = resolveMount(env);
        baseline = parseSettingsFile(readFileSync(mount.settingsPath, "utf8")) as Record<string, LuaValue>;
        settingsPath = mount.settingsPath;
    } else {
        baseline = {};
    }

    const changes: Change[] = manifest.apply_mode === "replace"
        ? computeReplaceChanges(baseline, manifestSettings, new Set())
        : computeChanges(baseline, manifestSettings);

    return {
        mode,
        ...(settingsPath ? { settingsPath } : {}),
        changes,
        grouped: groupChanges(changes),
    };
}
