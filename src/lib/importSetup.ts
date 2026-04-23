// Library entry point for `setup import` — apply a .kset or .kset.yaml to
// the device. Pure: returns a typed result; never prints. Throws
// KindlyError for the FAT-ack gates, compat blocks, schema strictness, etc.
//
// Shared with `setup inspect` via `loadManifestFile` + `LoadedSetup`.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile, type LuaTable, type LuaValue } from "../lua/writer.ts";
import {
    filterForYaml, classifyKey, changeHitsSensitive, sensitiveDomain,
} from "../schema/classify.ts";
import { mergeYamlIntoLua, replaceYamlIntoLua } from "../schema/yaml.ts";
import { computeChanges, computeReplaceChanges, type Change } from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { createTarGz } from "../fs/archive.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { hashBytes, shortId } from "../setup/canonical.ts";
import { parseManifest, SetupSchemaError, type EmbeddedFile, type SetupManifest } from "../setup/schema.ts";
import { unpackSetup } from "../setup/unpack.ts";
import { checkCompat, formatCompatIssue } from "../setup/compat.ts";
import { detectDeviceFamily, readKoreaderVersion } from "../device/version.ts";
import { loadPluginCatalog } from "../catalog/reader.ts";
import {
    groupArchivePluginFiles, verifyPluginAgainstCatalog,
    type PluginHashReport, type PluginVerdict,
} from "../catalog/verify.ts";
import { loadSchema } from "../schema/settings.ts";
import { validateSettings, formatValidationReport, type ValidationReport } from "../schema/report.ts";
import {
    affectedPatchTargets, affectedPluginTargets,
    findInertToggles, installPatches, installPluginFiles,
    listInstalledPluginFolders,
} from "../setup/files.ts";
import type { SetupImportResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { appendHistoryEntry } from "../history/writer.ts";

// Detect fat (.kset tar.gz) vs lean (.kset.yaml or .yaml) by extension.
// Loading a lean file through the fat path (tar extraction) would fail
// noisily; we'd rather give a direct error.
export type LoadedSetup = {
    manifest: SetupManifest;
    manifestBytes: Buffer;       // for content-hash identity
    files: Map<string, Buffer>;  // empty for lean
    isFat: boolean;
};

// Load a .kset.yaml file from disk, validate it, and return both the raw
// bytes (for hashing / canonical checks) and the validated manifest.
// Throws a user-readable error on missing file, bad YAML, or schema failure.
export function loadManifestFile(path: string): { raw: string; manifest: SetupManifest } {
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

export function loadSetup(path: string): LoadedSetup {
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
export function flattenManifestForApply(manifest: SetupManifest): Record<string, LuaValue> {
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

// Archive every plugin/patch target that already exists on device into
// <snapshotDir>/plugins-patches.tar.gz. Paths are stored relative to
// koreaderRoot so a bare `tar -xzf` into <koreaderRoot> restores them.
// If none of the targets exist on disk yet, we skip the archive — there's
// nothing to preserve.
export function snapshotFatTargets(
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
    label?: string;
    /**
     * Assert the manifest's content hash matches before applying. Must be
     * pre-normalized to `sha256:<64 hex>` by the caller (CLI layer owns
     * format validation — see docs/92-expect-hash-spec.md §3).
     */
    expectHash?: string;
    /**
     * W31 (88 §3.1): accept all SENSITIVE-class changes in this import.
     * Without it (and without per-key overrides in `acceptKey`), a SENSITIVE
     * change throws SENSITIVE_REQUIRES_ACK.
     */
    acceptSensitive?: boolean;
    /**
     * W31 (88 §3.1): per-key override. Entries are dotted key strings
     * (top-level or nested path). CLI layer validates them against
     * SENSITIVE_KEYS / SENSITIVE_PATHS before constructing this set.
     */
    acceptKey?: Set<string>;
    /**
     * Testability hook — override the plugin catalog path for hash
     * verification. Production leaves this undefined so `loadPluginCatalog`
     * reads the committed `data/catalog/plugins.bundled.v1.json`. Not
     * exposed on the CLI.
     */
    catalogPath?: string;
}

export type ImportResultWithExtras = SetupImportResult & {
    /** meta.author, for render intro line. */
    author?: string;
    /** meta.description, for render intro line. */
    description?: string;
    /** W33 reserved meta fields (91 §6). Used by the inspect/import preview
     *  text renderer to surface identity claims with `(UNVERIFIED)` until
     *  W39 signature verification lands. */
    sourceUrl?: string;
    version?: string;
    authorKeyId?: string;
    supersedes?: string[];
    /** Needed to format --skip-plugins / --skip-patches render lines. */
    shippedPluginCount: number;
    shippedPatchCount: number;
    /** Findings from the schema validator (non-strict warnings). */
    schemaFindings?: ValidationReport;
};

// Descend into a LuaValue by a dotted-path tail. Returns undefined if any
// segment can't be traversed (scalar, array, map, or missing key).
function descendLua(value: LuaValue | undefined, tail: readonly string[]): LuaValue | undefined {
    let v: LuaValue | undefined = value;
    for (const k of tail) {
        if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Map) {
            return undefined;
        }
        v = (v as Record<string, LuaValue>)[k];
    }
    return v;
}

// Render a LuaValue for the SENSITIVE warning list. Scalars go verbatim
// (JSON-encoded for strings); arrays/objects collapse to a shape hint per
// 88 §3.3.
function fmtSensitiveValue(v: LuaValue | undefined): string {
    if (v === undefined) return "(absent)";
    if (v === null) return "nil";
    if (Array.isArray(v)) return `<array of ${v.length} item(s)>`;
    if (v instanceof Map) return `<table with ${v.size} key(s)>`;
    if (typeof v === "object") {
        return `<object with ${Object.keys(v).length} key(s)>`;
    }
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

// Locate the change that carries a SENSITIVE hit path and format the
// prev/next for the warning line. Returns "(added) → X" / "Y → (removed)" /
// "Y → X" depending on the carrier change's kind.
function formatSensitiveChange(changes: readonly Change[], hitPath: string): string {
    const segments = hitPath.split(".");
    for (const c of changes) {
        if (segments.length < c.path.length) continue;
        let matches = true;
        for (let i = 0; i < c.path.length; i++) {
            if (c.path[i] !== segments[i]) { matches = false; break; }
        }
        if (!matches) continue;
        const tail = segments.slice(c.path.length);
        if (c.kind === "added") {
            const next = descendLua(c.next, tail);
            return `(added) → ${fmtSensitiveValue(next)}`;
        }
        if (c.kind === "removed") {
            const prev = descendLua(c.prev, tail);
            return `${fmtSensitiveValue(prev)} → (removed)`;
        }
        const prev = descendLua(c.prev, tail);
        const next = descendLua(c.next, tail);
        // A "changed" parent may leave the SENSITIVE descendant unchanged or
        // newly present/absent; fmtSensitiveValue handles undefined.
        return `${fmtSensitiveValue(prev)} → ${fmtSensitiveValue(next)}`;
    }
    return "(change)";
}

// W32 (89 §4): build the plugin hash report for a fat Setup being imported.
// Subset mode: the Setup may legitimately ship a subset of a plugin's files
// (§5.4), so catalog-only files are NOT reported as MISSING.
// Version-skew advisory is computed from the catalog's
// `koreader_hash_version` vs the device's detected version.
// Catalog load failures fall back to a `null` report — hash verification is
// best-effort; we don't want a stale catalog JSON to break imports.
function computePluginHashReport(
    shippedPlugins: readonly EmbeddedFile[],
    fileBytes: Map<string, Buffer>,
    deviceVersion: string | null,
    catalogPath?: string,
): PluginHashReport | null {
    let catalog;
    try { catalog = loadPluginCatalog(catalogPath); }
    catch { return null; }

    const grouped = groupArchivePluginFiles(
        shippedPlugins,
        // Buffer ⊂ Uint8Array; the verifier only needs a byte view.
        fileBytes as Map<string, Uint8Array>,
    );

    const verdicts: PluginVerdict[] = [];
    if (grouped.malformed.length > 0) {
        verdicts.push({ status: "MALFORMED_STRUCTURE", paths: grouped.malformed });
    }
    for (const [name, files] of grouped.plugins) {
        verdicts.push(verifyPluginAgainstCatalog(name, files, catalog, "subset"));
    }

    // catalogVersion: first non-null koreader_hash_version from the plugins
    // we looked at. Different entries could theoretically carry different
    // versions, but the curated catalog is produced from one source tree
    // at a time, so picking the first is fine.
    let catalogVersion: string | null = null;
    for (const v of verdicts) {
        if (v.status === "MALFORMED_STRUCTURE") continue;
        const e = catalog.plugins.find((p) => p.name === v.name);
        if (e?.koreader_hash_version) { catalogVersion = e.koreader_hash_version; break; }
    }

    return {
        verdicts,
        catalogVersion,
        deviceVersion,
        versionMatch: catalogVersion !== null && catalogVersion === deviceVersion,
    };
}

export function executeSetupImport(
    opts: SetupImportOptions,
    env: CliEnv,
): ImportResultWithExtras {
    const path = resolve(env.cwd, opts.file);
    const loaded = loadSetup(path);
    const { manifest, manifestBytes, files } = loaded;
    const id = shortId(hashBytes(manifestBytes));

    // W34a: hash assertion — first gate after load. opts.expectHash is
    // already `sha256:<64hex>` (CLI layer normalized & validated the format).
    // Fail fast before prompting the user about plugins / sensitive keys —
    // if the file isn't the one they expected, nothing downstream matters.
    if (opts.expectHash) {
        const actual = hashBytes(manifestBytes);
        if (actual !== opts.expectHash) {
            throw new KindlyError(
                ErrorCodes.MANIFEST_HASH_MISMATCH,
                `expected ${opts.expectHash} but Setup hashes to ${actual}`,
                [
                    { text: "Verify you received the file you expected." },
                    { text: "Re-download from the original source." },
                ],
            );
        }
    }

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

    // W32: plugin hash verification — step 5 in the canonical import pipeline
    // (89 §4.1). Runs only when the manifest ships plugins AND the user has
    // accepted them (otherwise there's no install to protect). --skip-plugins
    // short-circuits: nothing to verify.
    // Version-skew advisory compares the catalog's `koreader_hash_version`
    // against the device's KOReader version. Read both up-front so the
    // compat check below can reuse the device version.
    const detectedVersion = readKoreaderVersion(mount);
    const detectedFamily = detectDeviceFamily(mount);
    const pluginHashReport: PluginHashReport | null = (
        shippedPlugins.length > 0 && opts.acceptPlugins
            ? computePluginHashReport(
                shippedPlugins, files, detectedVersion?.raw ?? null,
                opts.catalogPath,
            )
            : null
    );

    let compatSummary: SetupImportResult["compat"] = null;
    if (manifest.compat) {
        const detected = { version: detectedVersion, family: detectedFamily };
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
            // formatValidationReport is 1-arg; `showUnknowns` is a
            // render-layer concern and doesn't affect the error text.
            void showUnknowns;
            const msg = formatValidationReport(report);
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
    const { kept: safeFlatRaw, droppedSecrets: refusedSecrets } =
        filterForYaml(manifestFlat, "full");
    // filterForYaml returns Record<string, unknown>; values originate from
    // the manifest (already LuaValue-compatible) — narrow for downstream.
    const safeFlat = safeFlatRaw as Record<string, LuaValue>;

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

    // W31: SENSITIVE gate — step 10 of 88 §3.0 pipeline. Collect hits first
    // (dry-run preview needs them for [SENSITIVE] markers). Then, only if NOT
    // dry-run, enforce acceptance. Content warning per 88 §3.5 — --dry-run
    // skips the throw but keeps the hit list.
    const sensitiveHitSet = new Set<string>();
    for (const c of changes) {
        for (const p of changeHitsSensitive(c)) sensitiveHitSet.add(p);
    }
    const sensitiveHits = [...sensitiveHitSet].sort();

    if (!opts.dryRun && sensitiveHits.length > 0) {
        const accepted = opts.acceptKey ?? new Set<string>();
        const blocking = opts.acceptSensitive
            ? []
            : sensitiveHits.filter((p) => !accepted.has(p));
        if (blocking.length > 0) {
            const list = blocking
                .map((p) => `  [${sensitiveDomain(p)}] ${p}: ${formatSensitiveChange(changes, p)}`)
                .join("\n");
            throw new KindlyError(
                ErrorCodes.SENSITIVE_REQUIRES_ACK,
                `this Setup modifies ${blocking.length} security-sensitive setting(s):\n${list}`,
                [
                    { text: "Review with: kindly setup inspect <file>" },
                    { text: "Accept all changes.", command: "kindly setup import <file> --accept-sensitive" },
                    { text: "Accept specific keys.", command: "kindly setup import <file> --accept-key=<key,key,...>" },
                ],
            );
        }
    }

    // W31a: extra_plugin_paths dual gate (88 §4.3). Even after
    // --accept-sensitive (or --accept-key=extra_plugin_paths) clears the
    // SENSITIVE check, this key needs the SAME --accept-plugins consent the
    // fat-files path requires — a settings-only redirect of KOReader's
    // plugin loader still ends in "Lua code from a path you don't fully
    // control runs on your device." Two flags, two distinct mental models.
    if (!opts.dryRun && !opts.acceptPlugins
        && sensitiveHits.includes("extra_plugin_paths")) {
        const newPath = formatSensitiveChange(changes, "extra_plugin_paths");
        throw new KindlyError(
            ErrorCodes.FAT_REQUIRES_ACK,
            `this Setup sets extra_plugin_paths — KOReader will load Lua plugins from the listed directories. ` +
            `Any Lua code in those paths will execute on your Kindle with full device access.\n` +
            `  extra_plugin_paths: ${newPath}`,
            [
                { text: "Inspect the path the Setup sets.", command: "kindly setup inspect <file>" },
                { text: "Pass --accept-plugins to consent to plugin code execution." },
            ],
        );
    }

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
        sensitiveHits,
        backupPath: null,
        snapshotDir: null,
        fatSnapshotPath: null,
        pluginHashReport,
        compat: compatSummary,
        ...(manifest.meta.author ? { author: manifest.meta.author } : {}),
        ...(manifest.meta.description ? { description: manifest.meta.description } : {}),
        ...(manifest.meta.source_url ? { sourceUrl: manifest.meta.source_url } : {}),
        ...(manifest.meta.version ? { version: manifest.meta.version } : {}),
        ...(manifest.meta.author_key_id ? { authorKeyId: manifest.meta.author_key_id } : {}),
        ...(manifest.meta.supersedes?.length
            ? { supersedes: [...manifest.meta.supersedes] } : {}),
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
    }, opts.label ? { label: opts.label } : undefined);

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

