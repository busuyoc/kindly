// Library entry point for `setup export` — build a shareable Setup manifest
// from the live device or a bundled template, optionally packing plugin and
// patch files into a fat `.kset` tarball.
// Pure: returns a typed result; never prints. Writes to disk only outside
// dry-run (that's the whole point of "export"); throws KindlyError on user-
// visible failures.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";
import { ArgError } from "../cli/args.ts";
import { type CliEnv, resolveMount, resolveSetupsDir } from "../cli/env.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { filterForYaml } from "../schema/classify.ts";
import { loadSchema } from "../schema/settings.ts";
import { validateSettings, formatValidationReport, type ValidationReport } from "../schema/report.ts";
import { canonicalizeManifest, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest, type EmbeddedFile } from "../setup/schema.ts";
import { packSetup } from "../setup/pack.ts";
import {
    collectPatches, collectPluginDirs, totalBytes,
} from "../setup/files.ts";
import { getTemplate, listTemplates, type Template } from "../setup/templates.ts";
import type { SetupExportResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { computeMountFingerprint, isFingerprintEmpty } from "../device/fingerprint.ts";

export interface SetupExportOptions {
    name: string;
    output?: string;
    keys?: string;
    applyMode?: "additive" | "replace";
    template?: string;
    description?: string;
    author?: string;
    tags?: string;
    mount?: string;
    force?: boolean;
    includePluginFiles?: boolean;
    includePatches?: boolean;
    compatKoreaderMin?: string;
    compatKoreaderMax?: string;
    compatDevice?: string;
    strict?: boolean;
    allowUnknownKeys?: boolean;
    dryRun?: boolean;
}

// schemaFindings travels on the result only when non-empty — renderer uses
// it to reproduce the warning text that emitSchemaFindings would have written.
export type ExportResultWithSchema = SetupExportResult & {
    schemaFindings?: ValidationReport;
    /** Present when no settings were read from the device (template mode). */
    sourcePath: string | null;
    /** Bytes of plugin + patch files, for the "fat setup — ships N B" line. */
    fatLuaBytes: number;
};

export function executeSetupExport(
    opts: SetupExportOptions,
    env: CliEnv,
): ExportResultWithSchema {
    const template: Template | undefined = opts.template
        ? (getTemplate(opts.template) ?? throwUnknownTemplate(opts.template))
        : undefined;

    const effectiveApplyMode: "additive" | "replace" =
        opts.applyMode
        ?? template?.apply_mode
        ?? "additive";

    const needsMount = !template || opts.includePluginFiles || opts.includePatches;
    const mountEnv = opts.mount ? { ...env, mountOverride: opts.mount } : env;
    const mount = needsMount ? resolveMount(mountEnv) : null;

    if (mount && !exists(mount.settingsPath, "derived-from-mount") && !template) {
        throw new KindlyError(
            ErrorCodes.SETTINGS_NOT_FOUND,
            `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`,
        );
    }

    let sourceSettings: Record<string, LuaValue>;
    let droppedSecrets: string[] = [];
    let droppedEphemerals: string[] = [];
    let sourcePath: string | null = null;
    if (template) {
        const templateSettings = { ...(template.settings ?? {}) } as Record<string, LuaValue>;
        if (template.plugins?.disabled && template.plugins.disabled.length > 0) {
            const pd: Record<string, LuaValue> = {};
            for (const name of template.plugins.disabled) pd[name] = true;
            templateSettings.plugins_disabled = pd;
        }
        const filtered = filterForYaml(templateSettings, "minimal");
        sourceSettings = filtered.kept as Record<string, LuaValue>;
        droppedSecrets = filtered.droppedSecrets;
        droppedEphemerals = filtered.droppedEphemerals;
    } else {
        sourcePath = mount!.settingsPath;
        const raw = readText(mount!.settingsPath, "derived-from-mount");
        const parsed = parseSettingsFile(raw) as Record<string, LuaValue>;
        const filtered = filterForYaml(parsed, "minimal");
        sourceSettings = filtered.kept as Record<string, LuaValue>;
        droppedSecrets = filtered.droppedSecrets;
        droppedEphemerals = filtered.droppedEphemerals;
    }

    let settings: Record<string, LuaValue> = sourceSettings;
    const keysList = parseCsv(opts.keys);
    let skippedKeys = 0;
    if (keysList.length > 0) {
        const picked: Record<string, LuaValue> = {};
        for (const k of keysList) {
            if (k in sourceSettings) picked[k] = sourceSettings[k] as LuaValue;
            else skippedKeys++;
        }
        settings = picked;
    }

    const { pluginsDisabled, settingsMinusPlugins } = liftPluginsDisabled(settings);

    const exportReport = validateSettings(
        settingsMinusPlugins as Record<string, unknown>,
        loadSchema(),
    );
    const hasUnknowns = exportReport.unknownKeys.length > 0;
    const hasMismatches = exportReport.typeMismatches.length > 0;
    const showUnknowns = !opts.allowUnknownKeys;
    void showUnknowns;
    const schemaBlocks = !!opts.strict
        && ((showUnknowns && hasUnknowns) || hasMismatches);

    if (schemaBlocks) {
        const msg = formatValidationReport(exportReport);
        throw new KindlyError(
            ErrorCodes.SCHEMA_VIOLATION,
            `${msg}\n--strict: aborting due to schema findings.`,
            [
                { text: "Review the listed keys — likely typos or plugin-scoped unknowns." },
                { text: "Re-run without --strict, or pass --allow-unknown-keys if you're sure." },
            ],
        );
    }

    const collectedPlugins = opts.includePluginFiles
        ? collectPluginDirs(mount!.pluginsDir)
        : { declared: [] as EmbeddedFile[], files: new Map<string, Buffer>() };
    const collectedPatches = opts.includePatches
        ? collectPatches(mount!.patchesDir)
        : { declared: [] as EmbeddedFile[], files: new Map<string, Buffer>() };

    const pluginsBlock = buildPluginsBlock(pluginsDisabled, collectedPlugins.declared);
    const compatBlock = buildCompatBlock(
        opts.compatKoreaderMin,
        opts.compatKoreaderMax,
        parseCsv(opts.compatDevice),
    );
    const effectiveDescription = opts.description ?? template?.description;

    const manifest = parseManifest({
        kindly_setup: "v1",
        meta: {
            name: opts.name,
            ...(opts.author ? { author: opts.author } : {}),
            ...(effectiveDescription ? { description: effectiveDescription } : {}),
            created_at: env.now().toISOString(),
            ...(parseCsv(opts.tags).length > 0 ? { tags: parseCsv(opts.tags) } : {}),
        },
        ...(compatBlock ? { compat: compatBlock } : {}),
        apply_mode: effectiveApplyMode,
        ...(Object.keys(settingsMinusPlugins).length > 0 ? { settings: settingsMinusPlugins } : {}),
        ...(pluginsBlock ? { plugins: pluginsBlock } : {}),
        ...(collectedPatches.declared.length > 0 ? { patches: collectedPatches.declared } : {}),
    });

    const id = shortId(manifest);
    const fullHash = manifestHash(manifest);
    const isFat = collectedPlugins.declared.length > 0 || collectedPatches.declared.length > 0;
    const fatLuaBytes = totalBytes([...collectedPlugins.declared, ...collectedPatches.declared]);

    const outPath = opts.output
        ? resolve(env.cwd, opts.output)
        : defaultOutputPath(env, id, opts.name, isFat);

    const mode: SetupExportResult["mode"] = opts.dryRun ? "dry-run" : "exported";

    let bytesWritten = 0;
    if (!opts.dryRun) {
        if (exists(outPath, "user-provided") && !opts.force) {
            throw new KindlyError(
                ErrorCodes.OUTPUT_EXISTS,
                `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`,
                [{ text: "Use --force to overwrite, or --output to redirect." }],
            );
        }
        const outDir = dirname(outPath);
        if (!exists(outDir, "user-provided")) mkdirSync(outDir, { recursive: true });
        if (isFat) {
            const allFiles = new Map<string, Buffer>();
            for (const [k, v] of collectedPlugins.files) allFiles.set(k, v);
            for (const [k, v] of collectedPatches.files) allFiles.set(k, v);
            const r = packSetup({ manifest, files: allFiles }, outPath);
            bytesWritten = r.bytesWritten;
        } else {
            const canonical = canonicalizeManifest(manifest);
            writeFileSync(outPath, canonical);
            bytesWritten = Buffer.byteLength(canonical);
        }
        const fp = mount ? computeMountFingerprint(mount) : null;
        appendHistoryEntry(env, "setup:export", {
            output_path: outPath,
            setup_id: id,
        }, fp && !isFingerprintEmpty(fp) ? { mount: fp } : undefined);
    } else if (!isFat) {
        // Dry-run byte count is still informative for lean exports.
        bytesWritten = Buffer.byteLength(canonicalizeManifest(manifest));
    }

    const settingsCount = Object.keys(settingsMinusPlugins).length;
    const result: ExportResultWithSchema = {
        mode,
        outputPath: outPath,
        bytesWritten,
        id,
        hash: fullHash,
        name: opts.name,
        isFat,
        applyMode: effectiveApplyMode,
        settingsCount,
        pluginsDisabledCount: pluginsDisabled.length,
        pluginFilesCount: collectedPlugins.declared.length,
        patchesCount: collectedPatches.declared.length,
        sourceMode: template ? "template" : "device",
        ...(template ? { templateId: template.id } : {}),
        droppedSecrets,
        droppedEphemerals,
        skippedKeys,
        sourcePath,
        fatLuaBytes,
        ...(hasUnknowns || hasMismatches ? { schemaFindings: exportReport } : {}),
    };
    return result;
}

// Shape the plugins block correctly, omitting empty sub-keys. Zod's
// `.strict()` rejects empty arrays differently than missing fields for
// downstream canonicalization (sort order), so we emit only what's populated.
function buildPluginsBlock(
    disabled: readonly string[],
    files: readonly EmbeddedFile[],
): { disabled?: string[]; files?: EmbeddedFile[] } | undefined {
    const block: { disabled?: string[]; files?: EmbeddedFile[] } = {};
    if (disabled.length > 0) block.disabled = [...disabled];
    if (files.length > 0) block.files = [...files];
    return Object.keys(block).length > 0 ? block : undefined;
}

function throwUnknownTemplate(id: string): never {
    const available = listTemplates().map((t) => t.id).join(", ");
    throw new ArgError(
        `unknown template: ${JSON.stringify(id)}. available: ${available || "(none)"}`
    );
}

function buildCompatBlock(
    koMin: string | undefined,
    koMax: string | undefined,
    devices: readonly string[],
): { koreader_version_min?: string; koreader_version_max?: string; device?: string[] } | undefined {
    const block: { koreader_version_min?: string; koreader_version_max?: string; device?: string[] } = {};
    if (koMin && koMin.length > 0) block.koreader_version_min = koMin;
    if (koMax && koMax.length > 0) block.koreader_version_max = koMax;
    if (devices.length > 0) block.device = [...devices];
    return Object.keys(block).length > 0 ? block : undefined;
}

function parseCsv(s: string | undefined): string[] {
    if (!s) return [];
    return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

// `plugins_disabled = { SSH = true, calibre = true }` → ["SSH", "calibre"].
// Values other than literal `true` are ignored; the manifest only encodes
// "this plugin is off," not tri-state. On import this reverses into the
// same on-device shape.
function liftPluginsDisabled(settings: Record<string, LuaValue>): {
    pluginsDisabled: string[];
    settingsMinusPlugins: Record<string, LuaValue>;
} {
    const pd = settings.plugins_disabled;
    if (pd == null || typeof pd !== "object" || Array.isArray(pd)) {
        return { pluginsDisabled: [], settingsMinusPlugins: settings };
    }
    const rest = { ...settings };
    delete rest.plugins_disabled;
    const disabled = Object.entries(pd as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .sort();
    return { pluginsDisabled: disabled, settingsMinusPlugins: rest };
}

function slugify(s: string): string {
    const slug = s.toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug || "setup";
}

function defaultOutputPath(env: CliEnv, id: string, name: string, fat: boolean): string {
    const ext = fat ? ".kset" : ".kset.yaml";
    return join(resolveSetupsDir(env), `${id}-${slugify(name)}${ext}`);
}
