// `kindly setup <subcommand>` — create and manage shareable Setups.
//
// See docs/50-v0.3-setups.md for the data model and philosophy.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile, type LuaTable, type LuaValue } from "../lua/writer.ts";
import { filterForYaml } from "../schema/classify.ts";
import { mergeYamlIntoLua, replaceYamlIntoLua } from "../schema/yaml.ts";
import { classifyKey } from "../schema/classify.ts";
import { computeChanges, computeReplaceChanges, type Change } from "../schema/diff.ts";
import { groupChanges } from "../taxonomy/group.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { createTarGz } from "../fs/archive.ts";
import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount, resolveSetupsDir } from "../cli/env.ts";
import { dim, heading, info, ok, paint, warn } from "../cli/log.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest, SetupSchemaError, type EmbeddedFile, type SetupManifest } from "../setup/schema.ts";
import { packSetup } from "../setup/pack.ts";
import { unpackSetup } from "../setup/unpack.ts";
import { checkCompat, formatCompatIssue } from "../setup/compat.ts";
import { detectDeviceFamily, readKoreaderVersion } from "../device/version.ts";
import { loadSchema } from "../schema/settings.ts";
import { validateSettings, formatValidationReport, hasFindings, type ValidationReport } from "../schema/report.ts";
import {
    affectedPatchTargets, affectedPluginTargets,
    collectPatches, collectPluginDirs,
    findInertToggles, installPatches, installPluginFiles,
    listInstalledPluginFolders,
    summarizePluginsByDir, totalBytes,
} from "../setup/files.ts";
import {
    getTemplate, listTemplates, templateKeyCount, type Template,
} from "../setup/templates.ts";
import type {
    SetupInspectResult, SetupExportResult, SetupImportResult,
} from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { appendHistoryEntry } from "../history/writer.ts";

// ---- `kindly setup export` -------------------------------------------------

const EXPORT_FLAGS = {
    output: {
        type: "string",
        description: "where to write the .kset.yaml (default: ~/.kindly/setups/<id>-<slug>.kset.yaml)",
    },
    keys: {
        type: "string",
        description: "comma-separated settings keys to include (default: all non-secret non-ephemeral)",
    },
    "apply-mode": {
        type: "string",
        description: "'additive' (merge into existing) or 'replace' (wipe non-declared first; default: additive, or the template's mode when --template is set)",
    },
    template: {
        type: "string",
        description: "build the manifest from a curated template instead of reading the device (see `kindly setup templates`)",
    },
    description: {
        type: "string",
        description: "human-readable description of what this Setup does",
    },
    author: {
        type: "string",
        description: "author label (free text, not verified)",
    },
    tags: {
        type: "string",
        description: "comma-separated tag list",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    force: {
        type: "boolean",
        default: false,
        description: "overwrite output if it already exists",
    },
    "include-plugin-files": {
        type: "boolean",
        default: false,
        description: "pack .koplugin/ directories into the Setup (fat setup)",
    },
    "include-patches": {
        type: "boolean",
        default: false,
        description: "pack patches/*.lua files into the Setup (fat setup)",
    },
    "compat-koreader-min": {
        type: "string",
        description: "minimum KOReader version this Setup is known to work on (e.g. 2024.03)",
    },
    "compat-koreader-max": {
        type: "string",
        description: "maximum KOReader version this Setup is known to work on",
    },
    "compat-device": {
        type: "string",
        description: "comma-separated device ids this Setup targets (e.g. kindle-pw5,kindle-oasis3)",
    },
    strict: {
        type: "boolean",
        default: false,
        description: "fail (exit 1) if the settings block contains unknown keys or type mismatches against the KOReader schema",
    },
    "allow-unknown-keys": {
        type: "boolean",
        default: false,
        description: "suppress warnings for setting keys not in the KOReader schema (type mismatches still warn)",
    },
    "dry-run": {
        type: "boolean",
        default: false,
        description: "plan the export without writing — reports what would be written",
    },
} as const satisfies FlagSpecs;

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
type ExportResultWithSchema = SetupExportResult & {
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

    if (mount && !existsSync(mount.settingsPath) && !template) {
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
        const raw = readFileSync(mount!.settingsPath, "utf8");
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
    const schemaBlocks = !!opts.strict
        && ((showUnknowns && hasUnknowns) || hasMismatches);

    if (schemaBlocks) {
        const msg = formatValidationReport(exportReport, { showUnknowns });
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
        if (existsSync(outPath) && !opts.force) {
            throw new KindlyError(
                ErrorCodes.OUTPUT_EXISTS,
                `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`,
                [{ text: "Use --force to overwrite, or --output to redirect." }],
            );
        }
        const outDir = dirname(outPath);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
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
        appendHistoryEntry(env, "setup:export", {
            output_path: outPath,
            setup_id: id,
        });
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

export function renderSetupExport(
    result: ExportResultWithSchema,
    env: CliEnv,
    renderOpts: { allowUnknownKeys: boolean; strict: boolean },
): void {
    if (result.sourceMode === "template") {
        info(env, dim(env, `using template: ${result.templateId}`));
    } else if (result.sourcePath) {
        info(env, dim(env, `reading ${result.sourcePath}`));
    }

    if (result.schemaFindings) {
        emitSchemaFindings(env, result.schemaFindings, renderOpts);
    }

    if (result.mode === "dry-run") {
        heading(env, `setup ${result.id}  (dry-run)`);
        info(env, dim(env, `  would write:   ${result.outputPath}`));
        info(env, dim(env, `  bytes:         ${result.bytesWritten}`));
    } else {
        ok(env, `exported setup ${result.id} → ${result.outputPath}`);
    }
    const summary: string[] = [
        `${result.bytesWritten} bytes`,
        `${result.settingsCount} settings`,
        `${result.pluginsDisabledCount} plugin toggle(s)`,
    ];
    if (result.pluginFilesCount > 0) summary.push(`${result.pluginFilesCount} plugin file(s)`);
    if (result.patchesCount > 0)     summary.push(`${result.patchesCount} patch(es)`);
    info(env, dim(env, "  " + summary.join(", ")));
    info(env, dim(env, `  hash: ${result.hash}`));
    if (result.isFat) {
        info(env, dim(env, `  fat setup — ships ${result.fatLuaBytes} B of Lua`));
    }
    if (result.droppedSecrets.length > 0) {
        info(env, dim(env, `  filtered ${result.droppedSecrets.length} secret(s) (never in shared Setups)`));
    }
    if (result.droppedEphemerals.length > 0) {
        info(env, dim(env, `  filtered ${result.droppedEphemerals.length} ephemeral(s) (personal state, not shareable)`));
    }
    if (result.skippedKeys > 0) {
        info(env, dim(env, `  ${result.skippedKeys} --keys entr(ies) not found on device or filtered; skipped`));
    }
}

async function runSetupExport(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, EXPORT_FLAGS);

    const name = positional[0];
    if (!name) {
        throw new ArgError("usage: kindly setup export <name> [options]");
    }
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags["apply-mode"] !== undefined
        && flags["apply-mode"] !== "additive"
        && flags["apply-mode"] !== "replace") {
        throw new ArgError(
            `--apply-mode must be 'additive' or 'replace' (got ${JSON.stringify(flags["apply-mode"])})`
        );
    }

    const result = executeSetupExport({
        name,
        output: flags.output,
        keys: flags.keys,
        applyMode: flags["apply-mode"] as "additive" | "replace" | undefined,
        template: flags.template,
        description: flags.description,
        author: flags.author,
        tags: flags.tags,
        mount: flags.mount,
        force: flags.force,
        includePluginFiles: flags["include-plugin-files"],
        includePatches: flags["include-patches"],
        compatKoreaderMin: flags["compat-koreader-min"],
        compatKoreaderMax: flags["compat-koreader-max"],
        compatDevice: flags["compat-device"],
        strict: flags.strict,
        allowUnknownKeys: flags["allow-unknown-keys"],
        dryRun: flags["dry-run"],
    }, env);

    if (env.jsonMode) {
        // Strip rendering-only fields from the JSON payload.
        const { schemaFindings, sourcePath, fatLuaBytes, ...publicData } = result;
        void schemaFindings; void sourcePath; void fatLuaBytes;
        emitJson(env, "setup export", publicData);
    } else {
        renderSetupExport(result, env, {
            allowUnknownKeys: !!flags["allow-unknown-keys"],
            strict: !!flags.strict,
        });
    }
    return 0;
}

// Shape the plugins block correctly, omitting empty sub-keys. Zod's
// `.strict()` rejects empty arrays differently than missing fields for
// downstream canonicalization (sort order), so we emit only what's
// populated.
function buildPluginsBlock(
    disabled: readonly string[],
    files: readonly EmbeddedFile[],
): { disabled?: string[]; files?: EmbeddedFile[] } | undefined {
    const block: { disabled?: string[]; files?: EmbeddedFile[] } = {};
    if (disabled.length > 0) block.disabled = [...disabled];
    if (files.length > 0) block.files = [...files];
    return Object.keys(block).length > 0 ? block : undefined;
}

// Thrown when the user passes --template with an id that isn't in the
// registry. We list the known ids so a typo is trivially recoverable.
function throwUnknownTemplate(id: string): never {
    const available = listTemplates().map((t) => t.id).join(", ");
    throw new ArgError(
        `unknown template: ${JSON.stringify(id)}. available: ${available || "(none)"}`
    );
}

// Build a compat block from CLI flags, omitting empty fields. Returns
// undefined if the block would be empty — an empty `compat: {}` wouldn't
// round-trip cleanly through canonical YAML and conveys no information.
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

// ---- helpers ---------------------------------------------------------------

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

// Load a .kset.yaml file from disk, validate it, and return both the raw
// bytes (for hashing / canonical checks) and the validated manifest.
// Throws a user-readable error on missing file, bad YAML, or schema failure.
function loadManifestFile(path: string): { raw: string; manifest: SetupManifest } {
    if (!existsSync(path)) {
        throw new Error(`setup file not found: ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
        parsed = yamlParse(raw);
    } catch (e) {
        throw new Error(`${path} is not valid YAML: ${(e as Error).message}`);
    }
    try {
        const manifest = parseManifest(parsed);
        return { raw, manifest };
    } catch (e) {
        if (e instanceof SetupSchemaError) {
            throw new Error(`${path} is not a valid Setup manifest:\n${e.message}`);
        }
        throw e;
    }
}

// ---- `kindly setup inspect <file>` -----------------------------------------

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
    };
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

export function renderSetupInspect(result: SetupInspectResult, env: CliEnv): void {
    heading(env, `${result.name}  (${result.id})`);
    env.stdout.write(`  hash:         ${result.hash}\n`);
    env.stdout.write(`  file:         ${result.filePath}\n`);
    env.stdout.write(`  format:       ${result.isFat ? "fat (.kset tar.gz)" : "lean (.kset.yaml)"}\n`);
    if (result.isFat) {
        env.stdout.write(`  bytes:        ${result.fileSize}  (tarball)\n`);
        env.stdout.write(`  manifest:     ${result.manifestBytes} bytes\n`);
    } else {
        env.stdout.write(`  bytes:        ${result.manifestBytes}\n`);
    }
    env.stdout.write(`  apply_mode:   ${result.applyMode}\n`);
    env.stdout.write(`  created_at:   ${result.createdAt}\n`);
    if (result.author)      env.stdout.write(`  author:       ${result.author}\n`);
    if (result.description) env.stdout.write(`  description:  ${result.description}\n`);
    if (result.tags.length) env.stdout.write(`  tags:         ${result.tags.join(", ")}\n`);
    if (result.compat) {
        env.stdout.write(`  compat:\n`);
        if (result.compat.koreaderVersionMin) env.stdout.write(`    koreader >= ${result.compat.koreaderVersionMin}\n`);
        if (result.compat.koreaderVersionMax) env.stdout.write(`    koreader <= ${result.compat.koreaderVersionMax}\n`);
        if (result.compat.device?.length)     env.stdout.write(`    device:    ${result.compat.device.join(", ")}\n`);
    }
    env.stdout.write(`  contents:\n`);
    env.stdout.write(`    settings:        ${result.settingsCount}\n`);
    env.stdout.write(`    plugins off:     ${result.pluginsDisabledCount}\n`);
    if (result.pluginFilesCount > 0) env.stdout.write(`    plugin files:    ${result.pluginFilesCount}  (fat setup)\n`);
    if (result.patchesCount > 0)     env.stdout.write(`    patches:         ${result.patchesCount}  (fat setup)\n`);

    if (!result.isCanonical) {
        warn(env, "file is not in canonical form — re-exporting would yield different bytes.");
        info(env, dim(env, `  (canonical hash would be ${result.canonicalHash})`));
    }

    if (result.preview) {
        const { preview } = result;
        const totalChanges = preview.changes.length;
        const catCount = Object.keys(preview.grouped).length;
        const sevCounts: Record<string, number> = {};
        for (const bucket of Object.values(preview.grouped)) {
            for (const e of bucket) sevCounts[e.severity] = (sevCounts[e.severity] ?? 0) + 1;
        }
        const sevSummary = ["trivial", "visual", "functional", "breaking"]
            .filter((s) => sevCounts[s])
            .map((s) => `${sevCounts[s]} ${s}`)
            .join(", ");
        env.stdout.write(`  preview (${preview.mode}):\n`);
        if (totalChanges === 0) {
            env.stdout.write(`    no changes — ${preview.mode === "vs-device"
                ? "device already matches this setup"
                : "setup has no settings to apply"}\n`);
        } else {
            env.stdout.write(`    ${totalChanges} change(s) across ${catCount} categor${catCount === 1 ? "y" : "ies"} (${sevSummary})\n`);
            for (const [cat, bucket] of Object.entries(preview.grouped)) {
                env.stdout.write(`    - ${cat}: ${bucket.length}\n`);
            }
        }
    }
}

const INSPECT_FLAGS = {
    "vs-device": {
        type: "boolean",
        description: "preview how the setup would change the currently-mounted device",
    },
    "vs-default": {
        type: "boolean",
        description: "preview what the setup would set on an empty/default config",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (only used with --vs-device; auto-detected otherwise)",
    },
} as const satisfies FlagSpecs;

async function runSetupInspect(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional, flags } = parseArgs(argv, INSPECT_FLAGS);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup inspect <file> [--vs-device | --vs-default]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags["vs-device"] && flags["vs-default"]) {
        throw new ArgError("--vs-device and --vs-default are mutually exclusive");
    }

    const preview: "vs-device" | "vs-default" | undefined =
        flags["vs-device"] ? "vs-device" :
        flags["vs-default"] ? "vs-default" : undefined;
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeSetupInspect(fileArg, env, { preview });
    if (env.jsonMode) emitJson(env, "setup inspect", result);
    else renderSetupInspect(result, env);
    return 0;
}

// ---- `kindly setup list` ---------------------------------------------------

async function runSetupList(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    const dir = resolveSetupsDir(env);
    if (!existsSync(dir)) {
        info(env, dim(env, `no setups found (${dir} does not exist yet)`));
        return 0;
    }

    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".kset.yaml"))
        .map((f) => join(dir, f))
        .sort();

    if (files.length === 0) {
        info(env, dim(env, `no setups found in ${dir}`));
        return 0;
    }

    type Row = { id: string; name: string; created: string; bytes: number; mode: string; path: string };
    const rows: Row[] = [];
    const errors: { path: string; message: string }[] = [];
    for (const f of files) {
        try {
            const { raw, manifest } = loadManifestFile(f);
            rows.push({
                id: shortId(hashBytes(raw)),
                name: manifest.meta.name,
                created: manifest.meta.created_at,
                bytes: Buffer.byteLength(raw),
                mode: manifest.apply_mode,
                path: f,
            });
        } catch (e) {
            errors.push({ path: f, message: (e as Error).message });
        }
    }

    const header = ["ID", "NAME", "MODE", "CREATED", "BYTES"];
    const widths = [
        Math.max(header[0]!.length, ...rows.map((r) => r.id.length)),
        Math.max(header[1]!.length, ...rows.map((r) => r.name.length)),
        Math.max(header[2]!.length, ...rows.map((r) => r.mode.length)),
        Math.max(header[3]!.length, ...rows.map((r) => r.created.length)),
        Math.max(header[4]!.length, ...rows.map((r) => String(r.bytes).length)),
    ];
    const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
    env.stdout.write(dim(env,
        `${pad(header[0]!, widths[0]!)}  ${pad(header[1]!, widths[1]!)}  ${pad(header[2]!, widths[2]!)}  ${pad(header[3]!, widths[3]!)}  ${header[4]!}`
    ) + "\n");
    for (const r of rows) {
        env.stdout.write(
            `${pad(r.id, widths[0]!)}  ${pad(r.name, widths[1]!)}  ${pad(r.mode, widths[2]!)}  ${pad(r.created, widths[3]!)}  ${r.bytes}\n`
        );
    }

    for (const e of errors) {
        warn(env, `skipped ${e.path}: ${e.message.split("\n")[0]}`);
    }

    return 0;
}

// ---- `kindly setup templates` ----------------------------------------------

async function runSetupTemplates(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    const templates = listTemplates();
    if (templates.length === 0) {
        info(env, dim(env, "no templates bundled in this build"));
        return 0;
    }

    type Row = { id: string; name: string; mode: string; keys: string; disabled: string };
    const rows: Row[] = templates.map((t) => ({
        id: t.id,
        name: t.display_name,
        mode: t.apply_mode,
        keys: String(templateKeyCount(t)),
        disabled: String(t.plugins?.disabled?.length ?? 0),
    }));

    const header = ["ID", "NAME", "MODE", "KEYS", "OFF"];
    const widths = [
        Math.max(header[0]!.length, ...rows.map((r) => r.id.length)),
        Math.max(header[1]!.length, ...rows.map((r) => r.name.length)),
        Math.max(header[2]!.length, ...rows.map((r) => r.mode.length)),
        Math.max(header[3]!.length, ...rows.map((r) => r.keys.length)),
        Math.max(header[4]!.length, ...rows.map((r) => r.disabled.length)),
    ];
    const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
    env.stdout.write(dim(env,
        `${pad(header[0]!, widths[0]!)}  ${pad(header[1]!, widths[1]!)}  ${pad(header[2]!, widths[2]!)}  ${pad(header[3]!, widths[3]!)}  ${header[4]!}`
    ) + "\n");
    for (const r of rows) {
        env.stdout.write(
            `${pad(r.id, widths[0]!)}  ${pad(r.name, widths[1]!)}  ${pad(r.mode, widths[2]!)}  ${pad(r.keys, widths[3]!)}  ${r.disabled}\n`
        );
    }
    // Description lines follow the table — don't crowd the row format.
    env.stdout.write("\n");
    for (const t of templates) {
        env.stdout.write(dim(env, `  ${t.id}: `) + t.description + "\n");
    }
    info(env, "");
    info(env, dim(env, `use: kindly setup export <name> --template <id>`));

    return 0;
}

// ---- `kindly setup hash <file>` --------------------------------------------

async function runSetupHash(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup hash <file>");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    const path = resolve(env.cwd, fileArg);
    const { raw, manifest } = loadManifestFile(path);

    const h = hashBytes(raw);
    env.stdout.write(h + "\n");

    const canonicalBytes = canonicalizeManifest(manifest);
    if (raw !== canonicalBytes) {
        warn(env, "file is not in canonical form — hash of raw bytes shown above.");
        info(env, dim(env, `  canonical-form hash would be: ${manifestHash(manifest)}`));
    }
    return 0;
}

// ---- `kindly setup import <file>` ------------------------------------------

const IMPORT_FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "show what would change without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "keep a pre-write copy of affected files (invert with --no-safety-snapshot)",
    },
    "accept-plugins": {
        type: "boolean",
        default: false,
        description: "install plugin directories shipped in the Setup (fat-only)",
    },
    "skip-plugins": {
        type: "boolean",
        default: false,
        description: "do not install shipped plugin directories (apply settings only)",
    },
    "accept-patches": {
        type: "boolean",
        default: false,
        description: "install patch files shipped in the Setup (fat-only)",
    },
    "skip-patches": {
        type: "boolean",
        default: false,
        description: "do not install shipped patch files (apply settings only)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    force: {
        type: "boolean",
        default: false,
        description: "import even when the device fails the Setup's compat check",
    },
    strict: {
        type: "boolean",
        default: false,
        description: "fail (exit 1) if the manifest contains unknown settings keys or type mismatches against the KOReader schema",
    },
    "allow-unknown-keys": {
        type: "boolean",
        default: false,
        description: "suppress warnings for setting keys not in the KOReader schema (type mismatches still warn)",
    },
} as const satisfies FlagSpecs;

// Detect fat (.kset tar.gz) vs lean (.kset.yaml or .yaml) by extension.
// Loading a lean file through the fat path (tar extraction) would fail
// noisily; we'd rather give a direct error.
type LoadedSetup = {
    manifest: SetupManifest;
    manifestBytes: Buffer;       // for content-hash identity
    files: Map<string, Buffer>;  // empty for lean
    isFat: boolean;
};

function loadSetup(path: string): LoadedSetup {
    if (!existsSync(path)) {
        throw new Error(`setup file not found: ${path}`);
    }
    // .kset (no further extension) → tar.gz fat archive.
    // Anything else (.kset.yaml, .yaml) → raw canonical manifest.
    if (path.endsWith(".kset")) {
        const r = unpackSetup(path);
        return {
            manifest: r.manifest,
            manifestBytes: r.manifestBytes,
            files: r.files,
            isFat: true,
        };
    }
    const { raw, manifest } = loadManifestFile(path);
    return {
        manifest,
        manifestBytes: Buffer.from(raw, "utf8"),
        files: new Map(),
        isFat: false,
    };
}

// Flatten a validated Setup manifest into a dict shaped like kindly.yaml's
// top-level settings — ready to feed into mergeYamlIntoLua. Reverses the
// `plugins_disabled` lift that export performed: the manifest's
// plugins.disabled = ["SSH", "calibre"] becomes the on-device shape
// plugins_disabled = { SSH = true, calibre = true }.
function flattenManifestForApply(manifest: SetupManifest): Record<string, LuaValue> {
    const out: Record<string, LuaValue> = {};
    if (manifest.settings) {
        for (const [k, v] of Object.entries(manifest.settings)) {
            out[k] = v as LuaValue;
        }
    }
    if (manifest.plugins?.disabled && manifest.plugins.disabled.length > 0) {
        const pd: Record<string, LuaValue> = {};
        for (const name of manifest.plugins.disabled) pd[name] = true;
        out.plugins_disabled = pd;
    }
    return out;
}

// Emit schema-validation warnings per finding; return true iff --strict
// and there were findings we should block on. --allow-unknown-keys
// silences the unknown-key warnings (and the strict-block on them); type
// mismatches always warn and always count for strict.
function emitSchemaFindings(
    env: CliEnv,
    report: ValidationReport,
    opts: { strict: boolean; allowUnknownKeys: boolean },
): boolean {
    const showUnknowns = !opts.allowUnknownKeys;
    let blocking = false;
    if (showUnknowns && report.unknownKeys.length > 0) {
        warn(env, `schema: ${report.unknownKeys.length} unknown key(s) — likely typos or plugin-scoped:`);
        for (const u of report.unknownKeys) {
            env.stderr.write(`  - ${u.key}  (value is ${u.actualType})\n`);
        }
        if (opts.strict) blocking = true;
    }
    if (report.typeMismatches.length > 0) {
        warn(env, `schema: ${report.typeMismatches.length} type mismatch(es):`);
        for (const t of report.typeMismatches) {
            env.stderr.write(`  - ${t.key}: expected ${t.expectedType}, got ${t.actualType}\n`);
        }
        if (opts.strict) blocking = true;
    }
    if (blocking) {
        env.stderr.write(`\n--strict: aborting due to schema findings.\n`);
    }
    return blocking;
}

function fmtValue(v: unknown): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === null) return "nil";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

export interface SetupImportOptions {
    file: string;
    mount?: string;
    force?: boolean;
    strict?: boolean;
    allowUnknownKeys?: boolean;
    dryRun?: boolean;
    safetySnapshot?: boolean;
    acceptPlugins?: boolean;
    skipPlugins?: boolean;
    acceptPatches?: boolean;
    skipPatches?: boolean;
}

type ImportResultWithExtras = SetupImportResult & {
    /** meta.author, for render intro line. */
    author?: string;
    /** meta.description, for render intro line. */
    description?: string;
    /** Needed to format --skip-plugins / --skip-patches render lines. */
    shippedPluginCount: number;
    shippedPatchCount: number;
    /** Findings from the schema validator (non-strict warnings). */
    schemaFindings?: ValidationReport;
};

export function executeSetupImport(
    opts: SetupImportOptions,
    env: CliEnv,
): ImportResultWithExtras {
    const path = resolve(env.cwd, opts.file);
    const loaded = loadSetup(path);
    const { manifest, manifestBytes, files } = loaded;
    const id = shortId(hashBytes(manifestBytes));

    const shippedPlugins: readonly EmbeddedFile[] = manifest.plugins?.files ?? [];
    const shippedPatches: readonly EmbeddedFile[] = manifest.patches ?? [];

    if (shippedPlugins.length > 0 && !opts.acceptPlugins && !opts.skipPlugins) {
        throw new KindlyError(
            ErrorCodes.FAT_REQUIRES_ACK,
            `this Setup ships ${shippedPlugins.length} plugin file(s) — Lua code that will execute on your Kindle. ` +
            `Pass --accept-plugins to install, or --skip-plugins to apply settings only.`,
            [
                { text: "Review the shipped files before accepting.", command: "kindly setup inspect <file>" },
            ],
        );
    }
    if (shippedPatches.length > 0 && !opts.acceptPatches && !opts.skipPatches) {
        throw new KindlyError(
            ErrorCodes.FAT_REQUIRES_ACK,
            `this Setup ships ${shippedPatches.length} patch file(s) — Lua code that will execute on your Kindle. ` +
            `Pass --accept-patches to install, or --skip-patches to apply settings only.`,
            [],
        );
    }

    const mountEnv = opts.mount ? { ...env, mountOverride: opts.mount } : env;
    const mount = resolveMount(mountEnv);

    if (!existsSync(mount.settingsPath)) {
        throw new KindlyError(
            ErrorCodes.SETTINGS_NOT_FOUND,
            `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`,
        );
    }

    let compatSummary: SetupImportResult["compat"] = null;
    if (manifest.compat) {
        const detected = {
            version: readKoreaderVersion(mount),
            family: detectDeviceFamily(mount),
        };
        const cr = checkCompat(manifest.compat, detected);

        const blocking = cr.blocking.map(formatCompatIssue);
        const unverifiable = cr.unverifiable.map(formatCompatIssue);

        if (cr.blocking.length > 0 && !opts.force) {
            throw new KindlyError(
                ErrorCodes.COMPAT_INCOMPATIBLE,
                `Setup is not compatible with this device:\n  ${blocking.join("\n  ")}`,
                [{ text: "Pass --force to import anyway.", command: "kindly setup import <file> --force" }],
            );
        }

        compatSummary = {
            declared: {
                ...(manifest.compat.koreader_version_min ? { koreaderVersionMin: manifest.compat.koreader_version_min } : {}),
                ...(manifest.compat.koreader_version_max ? { koreaderVersionMax: manifest.compat.koreader_version_max } : {}),
                ...(manifest.compat.device?.length ? { device: [...manifest.compat.device] } : {}),
            },
            detected: {
                koreaderVersion: detected.version?.raw ?? null,
                deviceFamily: detected.family,
            },
            unverifiable,
            blocking,
            forced: cr.blocking.length > 0 && !!opts.force,
        };
    }

    let schemaFindings: ValidationReport | undefined;
    if (manifest.settings) {
        const report = validateSettings(manifest.settings as Record<string, unknown>, loadSchema());
        const hasUnknowns = report.unknownKeys.length > 0;
        const hasMismatches = report.typeMismatches.length > 0;
        const showUnknowns = !opts.allowUnknownKeys;
        const schemaBlocks = !!opts.strict
            && ((showUnknowns && hasUnknowns) || hasMismatches);
        if (schemaBlocks) {
            const msg = formatValidationReport(report, { showUnknowns });
            throw new KindlyError(
                ErrorCodes.SCHEMA_VIOLATION,
                `${msg}\n--strict: aborting due to schema findings.`,
                [
                    { text: "Review the listed keys — likely typos or plugin-scoped unknowns." },
                    { text: "Re-run without --strict, or pass --allow-unknown-keys if you're sure." },
                ],
            );
        }
        if (hasUnknowns || hasMismatches) schemaFindings = report;
    }

    const toggledNames: string[] = [...(manifest.plugins?.disabled ?? [])];
    let inertPluginToggles: string[] = [];
    if (toggledNames.length > 0) {
        const installed = listInstalledPluginFolders(mount.pluginsDir);
        inertPluginToggles = [...findInertToggles(toggledNames, installed)].sort();
    }

    const manifestFlat = flattenManifestForApply(manifest);
    const { kept: safeFlat, droppedSecrets: refusedSecrets } =
        filterForYaml(manifestFlat, "full");

    const onDeviceSrc = readFileSync(mount.settingsPath, "utf8");
    const onDevice = parseSettingsFile(onDeviceSrc) as Record<string, LuaValue>;

    const isReplace = manifest.apply_mode === "replace";
    const preservedKeys: Set<string> = new Set();
    if (isReplace) {
        for (const k of Object.keys(onDevice)) {
            const cls = classifyKey(k);
            if (cls === "SECRET" || cls === "EPHEMERAL") preservedKeys.add(k);
        }
    }

    const changes = isReplace
        ? computeReplaceChanges(onDevice, safeFlat, preservedKeys)
        : computeChanges(onDevice, safeFlat);

    const willInstallPlugins = !!opts.acceptPlugins && shippedPlugins.length > 0;
    const willInstallPatches = !!opts.acceptPatches && shippedPatches.length > 0;
    const writeSettings = changes.length > 0;

    const baseResult: ImportResultWithExtras = {
        mode: "no-op",
        setupFile: path,
        id,
        name: manifest.meta.name,
        applyMode: manifest.apply_mode,
        settingsPath: mount.settingsPath,
        changes,
        installedPluginFiles: 0,
        installedPatches: 0,
        skippedPluginFiles: opts.skipPlugins ? shippedPlugins.length : 0,
        skippedPatches: opts.skipPatches ? shippedPatches.length : 0,
        inertPluginToggles,
        refusedSecrets,
        backupPath: null,
        snapshotDir: null,
        fatSnapshotPath: null,
        compat: compatSummary,
        ...(manifest.meta.author ? { author: manifest.meta.author } : {}),
        ...(manifest.meta.description ? { description: manifest.meta.description } : {}),
        shippedPluginCount: shippedPlugins.length,
        shippedPatchCount: shippedPatches.length,
        ...(schemaFindings ? { schemaFindings } : {}),
    };

    if (!writeSettings && !willInstallPlugins && !willInstallPatches) {
        return baseResult;  // mode: "no-op"
    }

    if (opts.dryRun) {
        return { ...baseResult, mode: "dry-run" };
    }

    let snapshotDir: string | null = null;
    let backupPath: string | null = null;
    if (writeSettings) {
        const merged = isReplace
            ? replaceYamlIntoLua(onDevice, safeFlat) as LuaTable
            : mergeYamlIntoLua(onDevice, safeFlat) as LuaTable;
        const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

        const backupDir = join(env.cwd, ".kindly", "pre-import");
        const res = safeWrite(mount.settingsPath, newContent, {
            backupDir,
            verifyLua: true,
            skipBackup: opts.safetySnapshot === false,
        });
        if (res.backupPath) {
            backupPath = res.backupPath;
            snapshotDir = dirname(res.backupPath);
        }
    } else if (opts.safetySnapshot !== false && (willInstallPlugins || willInstallPatches)) {
        const stamp = env.now().toISOString().replace(/[:.]/g, "-");
        snapshotDir = join(env.cwd, ".kindly", "pre-import", stamp);
        mkdirSync(snapshotDir, { recursive: true });
    }

    let fatSnapshotPath: string | null = null;
    let installedPluginFiles = 0;
    let installedPatches = 0;
    if (willInstallPlugins || willInstallPatches) {
        if (snapshotDir && opts.safetySnapshot !== false) {
            snapshotFatTargets(mount.koreaderRoot, snapshotDir,
                willInstallPlugins ? affectedPluginTargets(mount.pluginsDir, shippedPlugins) : [],
                willInstallPatches ? affectedPatchTargets(mount.patchesDir, shippedPatches) : [],
            );
            fatSnapshotPath = join(snapshotDir, "plugins-patches.tar.gz");
            if (!existsSync(fatSnapshotPath)) fatSnapshotPath = null;
        }

        if (willInstallPlugins) {
            installPluginFiles(mount.pluginsDir, shippedPlugins, files);
            installedPluginFiles = shippedPlugins.length;
        }
        if (willInstallPatches) {
            installPatches(mount.patchesDir, shippedPatches, files);
            installedPatches = shippedPatches.length;
        }
    }

    appendHistoryEntry(env, "setup:import", {
        settings_delta_n: baseResult.changes.length,
        plugins_delta: {
            installed_files: installedPluginFiles,
            installed_patches: installedPatches,
            skipped_files: baseResult.skippedPluginFiles,
            skipped_patches: baseResult.skippedPatches,
            disabled_count: manifest.plugins?.disabled?.length ?? 0,
        },
        ...(backupPath ? { backup_path: backupPath } : {}),
        ...(snapshotDir ? { pre_import_path: snapshotDir } : {}),
        setup_id: baseResult.id,
    });

    return {
        ...baseResult,
        mode: "imported",
        installedPluginFiles,
        installedPatches,
        backupPath,
        snapshotDir,
        fatSnapshotPath,
    };
}

// Emitted as a preview block before `executeSetupImport` runs so that text-
// mode users see the heading + fat disclosure BEFORE any gate failure.
// Non-mutating; safe to call on every invocation.
function renderSetupImportIntro(
    manifest: SetupManifest,
    id: string,
    setupFile: string,
    shippedPlugins: readonly EmbeddedFile[],
    shippedPatches: readonly EmbeddedFile[],
    env: CliEnv,
): void {
    heading(env, `importing ${manifest.meta.name}  (${id})`);
    info(env, dim(env, `  from:   ${setupFile}`));
    if (manifest.meta.author)      info(env, dim(env, `  author: ${manifest.meta.author}`));
    if (manifest.meta.description) info(env, dim(env, `  ${manifest.meta.description}`));
    if (shippedPlugins.length > 0 || shippedPatches.length > 0) {
        printFatDisclosure(env, shippedPlugins, shippedPatches);
    }
}

export function renderSetupImport(
    result: ImportResultWithExtras,
    env: CliEnv,
    renderOpts: { allowUnknownKeys: boolean; strict: boolean; force: boolean },
): void {
    if (result.compat) {
        env.stdout.write(`  compat check:\n`);
        if (result.compat.declared.koreaderVersionMin) {
            env.stdout.write(`    koreader >= ${result.compat.declared.koreaderVersionMin}\n`);
        }
        if (result.compat.declared.koreaderVersionMax) {
            env.stdout.write(`    koreader <= ${result.compat.declared.koreaderVersionMax}\n`);
        }
        if (result.compat.declared.device?.length) {
            env.stdout.write(`    device: ${result.compat.declared.device.join(", ")}\n`);
        }
        env.stdout.write(`    detected: koreader=${result.compat.detected.koreaderVersion ?? "unknown"}, device=${result.compat.detected.deviceFamily}\n`);
        for (const line of result.compat.unverifiable) warn(env, line);
        if (result.compat.forced) {
            for (const line of result.compat.blocking) warn(env, line);
            warn(env, "--force: proceeding despite compat mismatch.");
        }
    }

    if (result.schemaFindings) {
        emitSchemaFindings(env, result.schemaFindings, renderOpts);
    }

    if (result.inertPluginToggles.length > 0) {
        warn(env, `${result.inertPluginToggles.length} plugin toggle(s) reference plugins not installed on this device — stored but inert:`);
        for (const name of result.inertPluginToggles) {
            env.stderr.write(`  - ${name}  (no ${name}.koplugin/ on device)\n`);
        }
    }

    const writeSettings = result.changes.length > 0;
    const isReplace = result.applyMode === "replace";
    const willInstallPlugins = result.installedPluginFiles > 0
        || (result.mode !== "imported" && result.shippedPluginCount > 0 && result.skippedPluginFiles === 0);
    const willInstallPatches = result.installedPatches > 0
        || (result.mode !== "imported" && result.shippedPatchCount > 0 && result.skippedPatches === 0);

    if (result.mode === "no-op") {
        info(env, "no changes needed — device already matches this setup.");
        if (result.refusedSecrets.length > 0) {
            info(env, dim(env, `  (${result.refusedSecrets.length} secret-key(s) in manifest were refused by denylist)`));
        }
        return;
    }

    if (writeSettings) {
        if (isReplace) {
            heading(env, `${result.changes.length} change(s) to apply (replace mode):`);
            info(env, dim(env, `  replace mode: USER keys not declared in the manifest will be removed.`));
            info(env, dim(env, `  secrets and ephemerals are preserved regardless.`));
        } else {
            heading(env, `${result.changes.length} change(s) to apply:`);
        }
        for (const c of result.changes) {
            const p = c.path.join(".");
            if (c.kind === "added") {
                info(env, paint(env, "green", `  + ${p}`) + `  = ${fmtValue(c.next)}`);
            } else if (c.kind === "changed") {
                info(env, paint(env, "yellow", `  ~ ${p}`) + `  ${fmtValue(c.prev)} → ${fmtValue(c.next)}`);
            } else {
                info(env, paint(env, "red", `  - ${p}`) + `  (was ${fmtValue(c.prev)})`);
            }
        }
    } else if (willInstallPlugins || willInstallPatches) {
        info(env, dim(env, "settings already match; proceeding to plugin/patch install."));
    }

    if (result.refusedSecrets.length > 0) {
        warn(env, `refused ${result.refusedSecrets.length} secret-named key(s) in manifest: ${result.refusedSecrets.join(", ")}`);
    }

    if (result.mode === "dry-run") {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    // mode === "imported"
    if (writeSettings) {
        ok(env, `imported to ${result.settingsPath}`);
        if (result.backupPath) {
            info(env, dim(env, `  safety backup: ${result.backupPath}`));
        } else {
            info(env, dim(env, `  (safety backup skipped by --no-safety-snapshot; .old sibling preserved)`));
        }
    }

    if (result.fatSnapshotPath) {
        info(env, dim(env, `  pre-install snapshot: ${result.fatSnapshotPath}`));
    }
    if (result.installedPluginFiles > 0) {
        ok(env, `installed ${result.installedPluginFiles} plugin file(s) → <mount>/koreader/plugins`);
    }
    if (result.installedPatches > 0) {
        ok(env, `installed ${result.installedPatches} patch(es) → <mount>/koreader/patches`);
    }
    if (result.skippedPluginFiles > 0) {
        info(env, dim(env, `  --skip-plugins: ${result.skippedPluginFiles} plugin file(s) NOT installed`));
    }
    if (result.skippedPatches > 0) {
        info(env, dim(env, `  --skip-patches: ${result.skippedPatches} patch(es) NOT installed`));
    }

    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
}

async function runSetupImport(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, IMPORT_FLAGS);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup import <file> [options]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    if (flags["accept-plugins"] && flags["skip-plugins"]) {
        throw new ArgError("--accept-plugins and --skip-plugins are mutually exclusive");
    }
    if (flags["accept-patches"] && flags["skip-patches"]) {
        throw new ArgError("--accept-patches and --skip-patches are mutually exclusive");
    }

    // Pre-emit the intro + fat-disclosure in text mode so the user sees
    // what's being imported BEFORE any gate throws. No-op in JSON mode.
    const path = resolve(env.cwd, fileArg);
    if (!env.jsonMode) {
        const loaded = loadSetup(path);
        const id = shortId(hashBytes(loaded.manifestBytes));
        renderSetupImportIntro(
            loaded.manifest, id, path,
            loaded.manifest.plugins?.files ?? [],
            loaded.manifest.patches ?? [],
            env,
        );
    }

    const result = executeSetupImport({
        file: fileArg,
        mount: flags.mount,
        force: flags.force,
        strict: flags.strict,
        allowUnknownKeys: flags["allow-unknown-keys"],
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
        acceptPlugins: flags["accept-plugins"],
        skipPlugins: flags["skip-plugins"],
        acceptPatches: flags["accept-patches"],
        skipPatches: flags["skip-patches"],
    }, env);

    if (env.jsonMode) {
        const { schemaFindings, shippedPluginCount, shippedPatchCount,
                author, description, ...publicData } = result;
        void schemaFindings; void shippedPluginCount; void shippedPatchCount;
        // author/description are useful in JSON too — add them back explicitly
        // as declared fields (they're on the manifest, consumers will want them).
        const withMeta = {
            ...publicData,
            ...(author ? { author } : {}),
            ...(description ? { description } : {}),
        };
        emitJson(env, "setup import", withMeta);
    } else {
        renderSetupImport(result, env, {
            allowUnknownKeys: !!flags["allow-unknown-keys"],
            strict: !!flags.strict,
            force: !!flags.force,
        });
    }
    return 0;
}

// Archive the pre-install state of plugin dirs and patch files into
// <snapshotDir>/plugins-patches.tar.gz. Paths are stored relative to
// koreaderRoot so a bare `tar -xzf` into <koreaderRoot> restores them.
// If none of the targets exist on disk yet, we skip the archive — there's
// nothing to preserve.
function snapshotFatTargets(
    koreaderRoot: string,
    snapshotDir: string,
    pluginAbsPaths: readonly string[],
    patchAbsPaths: readonly string[],
): void {
    const all = [...pluginAbsPaths, ...patchAbsPaths];
    const existing = all.filter((p) => existsSync(p));
    if (existing.length === 0) return;

    // Make paths relative to koreaderRoot for tar.
    const rels = existing.map((abs) => {
        const prefix = koreaderRoot + "/";
        if (!abs.startsWith(prefix)) {
            throw new Error(`internal: snapshot target ${abs} is outside ${koreaderRoot}`);
        }
        return abs.slice(prefix.length);
    });

    createTarGz({
        cwd: koreaderRoot,
        paths: rels,
        outputPath: join(snapshotDir, "plugins-patches.tar.gz"),
    });
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printFatDisclosure(
    env: CliEnv,
    plugins: readonly EmbeddedFile[],
    patches: readonly EmbeddedFile[],
): void {
    heading(env, "this Setup ships executable code:");
    if (plugins.length > 0) {
        info(env, `  plugins (${plugins.length} file(s), ${fmtBytes(totalBytes(plugins))}):`);
        for (const p of summarizePluginsByDir(plugins)) {
            info(env, `    ${p.dir}  (${p.fileCount} file(s), ${fmtBytes(p.bytes)})`);
        }
    }
    if (patches.length > 0) {
        info(env, `  patches (${patches.length} file(s), ${fmtBytes(totalBytes(patches))}):`);
        for (const p of patches) {
            info(env, `    ${p.path}  (${fmtBytes(p.bytes)})`);
        }
    }
    info(env, dim(env, `  Lua code in plugins and patches will execute on your Kindle.`));
    info(env, dim(env, `  Verify the author before accepting.`));
}

// ---- dispatcher ------------------------------------------------------------

export async function runSetup(argv: readonly string[], env: CliEnv): Promise<number> {
    const [sub, ...rest] = argv;

    // `kindly setup` (no sub) or `kindly setup --help` → top-level setup help.
    if (!sub || sub === "--help" || sub === "-h") {
        env.stdout.write(setupHelp + "\n");
        return 0;
    }

    // `kindly setup <sub> --help` → subcommand help.
    if (rest[0] === "--help" || rest[0] === "-h") {
        switch (sub) {
            case "export":    env.stdout.write(exportHelp + "\n");    return 0;
            case "inspect":   env.stdout.write(inspectHelp + "\n");   return 0;
            case "list":      env.stdout.write(listHelp + "\n");      return 0;
            case "hash":      env.stdout.write(hashHelp + "\n");      return 0;
            case "import":    env.stdout.write(importHelp + "\n");    return 0;
            case "templates": env.stdout.write(templatesHelp + "\n"); return 0;
            default: break; // fall through — unknown sub yields below
        }
    }

    switch (sub) {
        case "export":    return await runSetupExport(rest, env);
        case "inspect":   return await runSetupInspect(rest, env);
        case "list":      return await runSetupList(rest, env);
        case "hash":      return await runSetupHash(rest, env);
        case "import":    return await runSetupImport(rest, env);
        case "templates": return await runSetupTemplates(rest, env);
        default:
            throw new ArgError(`unknown setup subcommand: ${sub}`);
    }
}

export const setupHelp = `
kindly setup — create and manage shareable Setups.

usage: kindly setup <subcommand> [options]

Subcommands:
  export <name>   scan device → write a canonical Setup manifest
  import <file>   apply a Setup manifest to the mounted Kindle
  inspect <file>  print a manifest's summary (no device touch)
  list            list Setups in ~/.kindly/setups/
  templates       list curated templates (use with export --template)
  hash <file>     print a Setup file's content hash

Run \`kindly setup <sub> --help\` for per-subcommand flags.

A Setup is a curated, metadata-rich, content-hashed manifest that
describes a named configuration — distinct from kindly.yaml (personal
working copy). See docs/50-v0.3-setups.md.
`.trim();

const inspectHelp = `
kindly setup inspect <file> — print a Setup manifest's summary.

usage: kindly setup inspect <file> [--vs-device | --vs-default] [--mount <path>]

Reads and validates a .kset.yaml file; prints id, hash, metadata, and
content counts. Warns if the file is not in canonical form. With
--vs-device (requires a mount) or --vs-default (against empty config),
also computes a grouped-by-category preview of the settings changes.
`.trim();

const listHelp = `
kindly setup list — list Setups in ~/.kindly/setups/.

usage: kindly setup list

Scans the local setups directory and prints a one-row-per-file table
(id, name, apply mode, created_at, bytes). Invalid files are skipped
with a warning.
`.trim();

const hashHelp = `
kindly setup hash <file> — print a Setup file's content hash.

usage: kindly setup hash <file>

Hashes the raw bytes of the file — the bytes ARE the identity. If the
file isn't in canonical form, a warning also shows what the canonical
hash would be. Use for pinning or verifying shared Setups.
`.trim();

const templatesHelp = `
kindly setup templates — list curated templates bundled in kindly.

usage: kindly setup templates

Prints one row per template (id, display name, apply mode, settings
count, plugin-toggle count), followed by a one-line description each.
Templates are starting points, not finished configurations — pass
\`--template <id>\` to \`kindly setup export\` to build a manifest from
one, then edit the resulting file as needed.

Templates don't read the device by default. Adding --include-plugin-files
or --include-patches to a template-driven export augments it with the
connected Kindle's plugin directories and patch files.

See docs/51-templates.md for per-template rationale.
`.trim();

const importHelp = `
kindly setup import <file> — merge a Setup manifest into the Kindle.

usage: kindly setup import <file> [options]

  --dry-run             show what would change without writing
  --no-safety-snapshot  skip the pre-write copy of affected files
                        (the .old sibling of settings.reader.lua is
                        still kept for KOReader's own fallback;
                        default: safety snapshot is ON)
  --accept-plugins      install plugin dirs shipped in the Setup (fat)
  --skip-plugins        apply settings only; leave plugins untouched
  --accept-patches      install patch files shipped in the Setup (fat)
  --skip-patches        apply settings only; leave patches untouched
  --mount <path>        path to a mounted Kindle (auto-detect by default)

Additive merge: keys in the manifest override; on-device keys not in the
manifest are left alone (this is how secrets and reading state survive).

Secret-named keys inside the manifest are ALWAYS filtered at the import
boundary — a hostile manifest can't write your PIN.

The manifest's apply_mode decides the merge strategy:
  additive  keys in the manifest override; on-device keys not in the
            manifest are preserved.
  replace   keys in the manifest override; on-device USER keys not in
            the manifest are REMOVED. Secrets and ephemerals are
            preserved regardless. Known nested secrets (kosync.userkey
            etc.) are carried over.

Fat setups ship executable Lua (plugin dirs and/or patch files). They
are gated by --accept-plugins / --accept-patches per category; without
either the accept or the skip flag, import refuses with a disclosure of
what would execute. Existing plugin dirs are wiped-and-replaced (the
safety snapshot keeps the original).

The compat block is printed but not verified in this release.
`.trim();

const exportHelp = `
kindly setup export <name> — scan device, filter, write a canonical Setup manifest.

usage: kindly setup export <name> [options]

  --output <path>            default: ~/.kindly/setups/<id>-<slug>.kset[.yaml]
  --keys <k1,k2,...>         cherry-pick specific settings keys (default: all)
  --template <id>            build from a curated template; skips device read
                             (see \`kindly setup templates\`)
  --apply-mode <mode>        additive | replace  (default: additive, or the
                             template's mode when --template is set)
  --description <text>       human-readable description
  --author <name>            author label (free text, not verified)
  --tags <t1,t2,...>         comma-separated tag list
  --include-plugin-files     pack <koreader>/plugins/*.koplugin/ (fat setup)
  --include-patches          pack <koreader>/patches/*.lua (fat setup)
  --compat-koreader-min <v>  minimum KOReader version (e.g. 2024.03)
  --compat-koreader-max <v>  maximum KOReader version
  --compat-device <d1,d2>    target device ids (e.g. kindle-pw5,kindle-oasis3)
  --mount <path>             path to a mounted Kindle (auto-detect by default)
  --force                    overwrite output if it exists

Secrets (PIN, passwords, device IDs, phone numbers) are ALWAYS filtered.
Ephemerals (lastfile, migration markers) are always filtered — shared
Setups represent a configuration, not your device's current state.

Lean setups (settings + plugin toggles only) ship as a single .kset.yaml
file. Fat setups (with --include-plugin-files or --include-patches) ship
as a .kset tar.gz containing manifest.yaml + declared files.

Compat flags record the author's claim about what KOReader version / device
the Setup targets. The values are displayed on import but NOT enforced in
this release (v0.4 adds enforcement). Leave unset for portable Setups.

--template builds the manifest from a curated key/value bundle rather than
the device. CLI flags (--apply-mode, --description, --tags, --author,
--compat-*, --keys) layer on top of the template; --keys narrows the
template's settings to a subset. Fat flags (--include-plugin-files,
--include-patches) are additive: they scan the live device even when the
manifest's settings come from a template.
`.trim();
