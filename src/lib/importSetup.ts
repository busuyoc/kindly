// Library entry point for `setup import` — apply a .kset or .kset.yaml to
// the device. Pure: returns a typed result; never prints. Throws
// KindlyError for the FAT-ack gates, compat blocks, schema strictness, etc.
//
// Shared with `setup inspect` via `loadManifestFile` + `LoadedSetup`.

import { mkdirSync } from "node:fs";
import { exists, readText } from "../fs/safeRead.ts";
import { dirname, join, resolve } from "node:path";

import { parseYamlSafe } from "../fs/yamlSafe.ts";

import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile, type LuaTable, type LuaValue } from "../lua/writer.ts";
import {
    filterForYaml, classifyKey, changeHitsSensitive, sensitiveDomain,
} from "../schema/classify.ts";
import { mergeYamlIntoLua, replaceYamlIntoLua } from "../schema/yaml.ts";
import {
    REPLACE_REMOVAL_WARN_THRESHOLD, computeChanges, computeReplaceChanges,
    topLevelRemovedKeys, type Change,
} from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { createTarGz } from "../fs/archive.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { hashBytes, shortId } from "../setup/canonical.ts";
import { buildBaseContext } from "../gates/context.ts";
import { runGates, throwFirstBlocking } from "../gates/orchestrator.ts";
import { MANIFEST_HASH_ASSERT } from "../gates/definitions/identity.ts";
import {
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    SENSITIVE_REQUIRES_ACK,
} from "../gates/definitions/consent.ts";
import { formatSensitiveChange as formatSensitiveChangeShared } from "../gates/sensitiveFormat.ts";
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
import type { ScanReport, SetupImportResult } from "../types/results.ts";
import { scanShippedLuaFiles } from "../catalog/scanPipeline.ts";
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
    if (!exists(path, "user-provided")) {
        throw new Error(`setup file not found: ${path}`);
    }
    const raw = readText(path, "user-provided");
    let parsed: unknown;
    try {
        parsed = parseYamlSafe(raw);
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
    if (!exists(path, "user-provided")) {
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
    const existing = all.filter((p) => exists(p, "derived-from-mount"));
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
     * W34e: compound CI-mode gate. When true, the import refuses outright
     * if any of the following hold: any SENSITIVE-class change, any
     * plugin file hash mismatch (tampered), or any uncatalogued plugin
     * shipped. Overrides (--accept-sensitive, --accept-key) are
     * rejected at the CLI layer when this is set. Designed for scripted
     * use — fail loudly rather than let a user click through.
     */
    strictImports?: boolean;
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

// Sensitive-change formatting helpers now live in src/gates/sensitiveFormat.ts
// and are imported above as `formatSensitiveChangeShared`. A thin alias keeps
// the in-file call sites (STRICT_SENSITIVE_CHANGES, EXTRA_PLUGIN_PATHS_DUAL,
// still inline until Step 9) reading as they did pre-refactor.
const formatSensitiveChange = formatSensitiveChangeShared;

// W34d: if this is a replace-mode Setup and the top-level removal count
// crosses the threshold, return a warning payload so renderers can surface
// a distinct banner ("this will wipe N of your settings"). Null otherwise.
// Only top-level removes count — nested removes inside a merged parent are
// normal structural churn, not a wipe.
function computeReplaceWarnings(
    applyMode: "additive" | "replace",
    changes: readonly Change[],
): SetupImportResult["replaceWarnings"] {
    if (applyMode !== "replace") return null;
    const removed = topLevelRemovedKeys(changes);
    if (removed.length <= REPLACE_REMOVAL_WARN_THRESHOLD) return null;
    return {
        removedUserKeys: removed.length,
        threshold: REPLACE_REMOVAL_WARN_THRESHOLD,
        sampleKeys: removed.slice(0, 20),
    };
}

// W32 (89 §4): build the plugin hash report for a fat Setup being imported.
// Subset mode: the Setup may legitimately ship a subset of a plugin's files
// (§5.4), so catalog-only files are NOT reported as MISSING.
// Version-skew advisory is computed from the catalog's
// `koreader_hash_version` vs the device's detected version.
// Catalog load failures fall back to a `null` report — hash verification is
// best-effort; we don't want a stale catalog JSON to break imports.
export function computePluginHashReport(
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

    // catalogVersion comes from the catalog-level field (89 §5.3 "one
    // hash set per catalog"). Null when the catalog predates W32.
    const catalogVersion = catalog.koreader_hash_version ?? null;

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

    const shippedPlugins: readonly EmbeddedFile[] = manifest.plugins?.files ?? [];
    const shippedPatches: readonly EmbeddedFile[] = manifest.patches ?? [];

    // Phase 1 gate run: IDENTITY + CONSENT-FAT. All inputs are available
    // right after loadSetup + manifest parse.
    //   MANIFEST_HASH_ASSERT (IDENTITY)   — Step 5
    //   PLUGINS_REQUIRE_ACK  (CONSENT)    — Step 6
    //   PATCHES_REQUIRE_ACK  (CONSENT)    — Step 6
    // Fail fast — if the file isn't what the user expected or ships code
    // they haven't consented to, nothing downstream matters.
    {
        const phase1Registry = [
            MANIFEST_HASH_ASSERT,
            PLUGINS_REQUIRE_ACK,
            PATCHES_REQUIRE_ACK,
        ];
        const phase1Ctx = buildBaseContext({
            boundary: "import",
            dryRun: opts.dryRun ?? false,
            strictImports: opts.strictImports ?? false,
            opts: {
                expectHash: opts.expectHash,
                manifestBytes,
                shippedPluginsCount: shippedPlugins.length,
                shippedPatchesCount: shippedPatches.length,
                acceptPlugins: !!opts.acceptPlugins,
                skipPlugins: !!opts.skipPlugins,
                acceptPatches: !!opts.acceptPatches,
                skipPatches: !!opts.skipPatches,
            },
        });
        const phase1Report = runGates("import", phase1Ctx, {
            dryRun: opts.dryRun ?? false,
            strictImports: opts.strictImports ?? false,
            registry: phase1Registry,
        });
        if (phase1Report.blocked) throwFirstBlocking(phase1Report, phase1Registry);
    }

    const mountEnv = opts.mount ? { ...env, mountOverride: opts.mount } : env;
    const mount = resolveMount(mountEnv);

    if (!exists(mount.settingsPath, "derived-from-mount")) {
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

    // W34e strict gate: refuse if any plugin fails to MATCH the catalog.
    // Runs even in --dry-run so CI can validate without touching device.
    // UNVERIFIED also blocks — otherwise an attacker can impersonate any
    // catalogued-but-unhashed plugin folder name and slip S2-style
    // lexically-obfuscated payloads past --strict-imports entirely.
    if (opts.strictImports && pluginHashReport) {
        const bad = pluginHashReport.verdicts.filter((v) => v.status !== "MATCH");
        if (bad.length > 0) {
            const list = bad
                .map((v) => v.status === "MALFORMED_STRUCTURE"
                    ? `  [MALFORMED_STRUCTURE] ${v.paths.length} path(s) outside <name>.koplugin/`
                    : `  [${v.status}] ${v.name}`)
                .join("\n");
            throw new KindlyError(
                ErrorCodes.STRICT_IMPORT_BLOCKED,
                `--strict-imports: ${bad.length} plugin integrity finding(s):\n${list}`,
                [{ text: "Regenerate the catalog against the device's KOReader version, or drop --strict-imports if the findings are expected." }],
            );
        }
    }

    // W36/W37: Lua static scanner over shipped plugins + patches. Runs
    // after the hash report so we can suppress findings on catalogued
    // files that MATCH (docs/93 §5.2). Scans whether or not the user
    // accepted plugins — --dry-run should show findings too.
    const willScan = shippedPlugins.length > 0 || shippedPatches.length > 0;
    const scanReport: ScanReport | null = willScan
        ? scanShippedLuaFiles({
            shippedPlugins,
            shippedPatches,
            files,
            hashReport: pluginHashReport,
        })
        : null;

    // W36/W37 strict gate: any unsuppressed scanner finding blocks under
    // --strict-imports. Reuses STRICT_IMPORT_BLOCKED — docs/93 §5.3.
    if (opts.strictImports && scanReport && scanReport.findings.length > 0) {
        const preview = scanReport.findings.slice(0, 5).map(
            (f) => `  [${f.category}] ${f.plugin}/${f.file}:${f.line}`,
        ).join("\n");
        const more = scanReport.findings.length > 5
            ? `\n  … and ${scanReport.findings.length - 5} more`
            : "";
        throw new KindlyError(
            ErrorCodes.STRICT_IMPORT_BLOCKED,
            `--strict-imports: ${scanReport.findings.length} Lua scanner finding(s) in shipped code:\n${preview}${more}`,
            [
                { text: "Review the findings.", command: "kindly setup inspect <file>" },
                { text: "If the shipped plugin is bundled and curated, the hash should match the catalog; regenerate the catalog if it drifted." },
                { text: "Drop --strict-imports if the findings are expected." },
            ],
        );
    }

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

    const onDeviceSrc = readText(mount.settingsPath, "derived-from-mount");
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

    // W34d + W34e strict gate: a replace-mode Setup that wipes more than
    // REPLACE_REMOVAL_WARN_THRESHOLD top-level USER keys is almost certainly
    // not what a CI pipeline intended to import. Refuse before the SENSITIVE
    // check so the error message points at the right thing.
    const replaceWarningPayload = computeReplaceWarnings(manifest.apply_mode, changes);
    if (opts.strictImports && replaceWarningPayload) {
        const sample = replaceWarningPayload.sampleKeys.join(", ");
        throw new KindlyError(
            ErrorCodes.STRICT_IMPORT_BLOCKED,
            `--strict-imports: replace-mode Setup would remove ${replaceWarningPayload.removedUserKeys} top-level USER key(s) ` +
            `(threshold ${replaceWarningPayload.threshold}). First few: ${sample}`,
            [{ text: "Verify the Setup's apply_mode and the device state are what you expect, or drop --strict-imports." }],
        );
    }

    // W34e strict mode: any SENSITIVE hit blocks, acceptance overrides
    // are ignored (and forbidden at the CLI layer). Runs in dry-run too —
    // CI uses --dry-run + --strict-imports as a "is this safe to import?"
    // preflight and must get a non-zero exit if the answer is no.
    if (opts.strictImports && sensitiveHits.length > 0) {
        const list = sensitiveHits
            .map((p) => `  [${sensitiveDomain(p)}] ${p}: ${formatSensitiveChange(changes, p)}`)
            .join("\n");
        throw new KindlyError(
            ErrorCodes.STRICT_IMPORT_BLOCKED,
            `--strict-imports: Setup modifies ${sensitiveHits.length} security-sensitive setting(s):\n${list}`,
            [{ text: "Use a hand-audited import (drop --strict-imports) to accept any of these." }],
        );
    }

    // Phase 4 gate run: CONSENT-SENSITIVE (Step 6).
    // STRICT_SENSITIVE_CHANGES above and EXTRA_PLUGIN_PATHS_DUAL below
    // remain inline until Step 9 — they have distinct trigger conditions
    // (strict-mode only; dual-flag semantics) that want their own gate
    // entries.
    {
        const phase4Registry = [SENSITIVE_REQUIRES_ACK];
        const phase4Ctx = buildBaseContext({
            boundary: "import",
            dryRun: opts.dryRun ?? false,
            strictImports: opts.strictImports ?? false,
            opts: {
                changes,
                acceptSensitive: !!opts.acceptSensitive,
                acceptKey: opts.acceptKey,
            },
        });
        const phase4Report = runGates("import", phase4Ctx, {
            dryRun: opts.dryRun ?? false,
            strictImports: opts.strictImports ?? false,
            registry: phase4Registry,
        });
        if (phase4Report.blocked) throwFirstBlocking(phase4Report, phase4Registry);
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
        replaceWarnings: replaceWarningPayload,
        scanReport,
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
            if (!exists(fatSnapshotPath, "derived-from-cwd")) fatSnapshotPath = null;
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

