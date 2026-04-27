// Library entry point for `setup import` — apply a .kset or .kset.yaml to
// the device. Pure: returns a typed result; never prints. Throws
// KindlyError for the FAT-ack gates, compat blocks, schema strictness, etc.
//
// Shared with `setup inspect` via `loadManifestFile` + `LoadedSetup`.

import { mkdirSync, mkdtempSync } from "node:fs";
import { exists, readText } from "../fs/safeRead.ts";
import { dirname, join, resolve } from "node:path";

import { parseYamlSafe } from "../fs/yamlSafe.ts";

import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile, type LuaTable, type LuaValue } from "../lua/writer.ts";
import {
    filterForYaml, classifyKey, changeHitsSensitive, sensitiveDomain,
    exfilClass, hygieneClass,
} from "../schema/classify.ts";
import { mergeYamlIntoLua, replaceYamlIntoLua } from "../schema/yaml.ts";
import {
    REPLACE_REMOVAL_WARN_THRESHOLD, computeChanges, computeReplaceChanges,
    topLevelRemovedKeys, type Change,
} from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { createTarGz, extractTarGz } from "../fs/archive.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { hashBytes, shortId } from "../setup/canonical.ts";
import { runPhase, collectWarnings, type GateEventLogger } from "../gates/orchestrator.ts";
import { appendGateEvent, gateEventFromFiredGate } from "../history/gateLog.ts";
import { MANIFEST_HASH_ASSERT, SIGNER_TRUSTED } from "../gates/definitions/identity.ts";
import {
    PLUGINS_REQUIRE_ACK,
    PATCHES_REQUIRE_ACK,
    SENSITIVE_REQUIRES_ACK,
    STRICT_SENSITIVE_CHANGES,
} from "../gates/definitions/consent.ts";
import { STRICT_REPLACE_REMOVAL_CAP } from "../gates/definitions/destruction.ts";
import { EXTRA_PLUGIN_PATHS_DUAL, CODE_EXEC_ADJACENT_REQUIRES_ACK } from "../gates/definitions/dual.ts";
import {
    STRICT_PLUGIN_HASH_CHECK,
    STRICT_SCANNER_FINDINGS,
} from "../gates/definitions/integrity.ts";
import { COMPAT_INCOMPATIBLE } from "../gates/definitions/compat.ts";
import {
    SCHEMA_VIOLATION,
    YAML_SHAPE_NORMAL,
    CONTROL_BYTES_IN_VALUE,
    PATH_CONTENT_HEURISTIC,
} from "../gates/definitions/shape.ts";
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
import type { GateWarning, ScanReport, SetupImportResult } from "../types/results.ts";
import { scanShippedLuaFiles } from "../catalog/scanPipeline.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { hashSnapshotDir } from "../history/snapshotHash.ts";
import { writeInProgressMarker, clearInProgressMarker } from "../history/inProgress.ts";
import { computeMountFingerprint, isFingerprintEmpty } from "../device/fingerprint.ts";
import { withLock } from "../fs/lockfile.ts";
import { createHash } from "node:crypto";

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
    /**
     * C1a: bypass CODE_EXEC_ADJACENT_REQUIRES_ACK. Consents to KOReader
     * interpolating attacker-supplied values into os.execute / os.remove
     * / shell calls via the keys listed in
     * `data/classify/settings.v1.json` `code_exec_adjacent` (SSH_port,
     * httpinspector_port, cover_image_path).
     */
    acceptCodeExec?: boolean;
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
     * W39 step 5: bypass for SIGNER_TRUSTED. Lets a signed Setup import
     * even when the signer's key isn't in the local trust roster (or the
     * roster is corrupt). Distinct from `force` (compat) and from
     * `acceptSensitive` (per-change consent) — this is the
     * "I know this publisher, just not on this machine" lane. Emits a
     * gate-event so the choice is auditable in `.kindly/gate-events.jsonl`.
     */
    acceptUntrustedSignature?: boolean;
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
    return withLock(env, "setup:import", () => executeSetupImportLocked(opts, env));
}

function executeSetupImportLocked(
    opts: SetupImportOptions,
    env: CliEnv,
): ImportResultWithExtras {
    const path = resolve(env.cwd, opts.file);
    const loaded = loadSetup(path);
    const { manifest, manifestBytes, files } = loaded;
    const id = shortId(hashBytes(manifestBytes));

    const shippedPlugins: readonly EmbeddedFile[] = manifest.plugins?.files ?? [];
    const shippedPatches: readonly EmbeddedFile[] = manifest.patches ?? [];

    // Gate observability logger — emits a .kindly/gate-events.jsonl line
    // for each bypass/block/warn. Shared across all four phases.
    const gateLogger: GateEventLogger = (fired) => {
        const event = gateEventFromFiredGate(fired);
        if (event) appendGateEvent(env, event);
    };

    // S605: warn-tier firings collected across every phase. Surfaced to
    // the renderer + JSON envelope via SetupImportResult.warnings.
    const warnings: GateWarning[] = [];

    // Phase 1 — IDENTITY + SHAPE + CONSENT-FAT. Fail fast pre-mount.
    //   MANIFEST_HASH_ASSERT     Step 5
    //   YAML_SHAPE_NORMAL (S89)  Step 11 — rejects SECRET-class keys or
    //                            wipe-shaped values in the manifest's
    //                            settings section before any merge can
    //                            silently destroy on-device secrets.
    //   PLUGINS/PATCHES_REQUIRE_ACK  Step 6
    warnings.push(...collectWarnings(runPhase({
        logger: gateLogger,
        boundary: "import",
        registry: [
            SIGNER_TRUSTED,
            MANIFEST_HASH_ASSERT,
            YAML_SHAPE_NORMAL,
            CONTROL_BYTES_IN_VALUE,
            PATH_CONTENT_HEURISTIC,
            PLUGINS_REQUIRE_ACK,
            PATCHES_REQUIRE_ACK,
        ],
        dryRun: opts.dryRun ?? false,
        strictImports: opts.strictImports ?? false,
        opts: {
            expectHash: opts.expectHash,
            manifestBytes,
            // S960: feed the FLATTENED manifest (settings + lifted
            // plugins_disabled) so CONTROL_BYTES_IN_VALUE sees control
            // bytes in plugin names — `plugins_disabled` is classified
            // sensitive-service, and the names land as keys under that
            // path which the producer scans at descent. Passing only
            // manifest.settings would let manifest.plugins.disabled
            // smuggle ESC/OSC into KOReader's plugin manager UI.
            yamlSettings: flattenManifestForApply(manifest) as Record<string, unknown>,
            shippedPluginsCount: shippedPlugins.length,
            shippedPatchesCount: shippedPatches.length,
            acceptPlugins: !!opts.acceptPlugins,
            skipPlugins: !!opts.skipPlugins,
            acceptPatches: !!opts.acceptPatches,
            skipPatches: !!opts.skipPatches,
            // SIGNER_TRUSTED inputs.
            archivePath: path,
            homeOverride: env.homeOverride,
            acceptUntrustedSignature: !!opts.acceptUntrustedSignature,
        },
    })));

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

    // STRICT_PLUGIN_HASH_CHECK moved to the phase-2 gate run below (Step 7).

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

    // Phase 2 — INTEGRITY (strict-mode plugin-hash + scanner gates).
    warnings.push(...collectWarnings(runPhase({
        logger: gateLogger,
        boundary: "import",
        registry: [STRICT_PLUGIN_HASH_CHECK, STRICT_SCANNER_FINDINGS],
        dryRun: opts.dryRun ?? false,
        strictImports: opts.strictImports ?? false,
        opts: { pluginHashReport, scanReport },
    })));

    // Compute compat + schema results inline — they populate both the gate
    // inputs (Phase 3 below) AND the SetupImportResult render fields.
    const detectedForCompat = { version: detectedVersion, family: detectedFamily };
    const compatResultRaw = manifest.compat
        ? checkCompat(manifest.compat, detectedForCompat)
        : null;
    const schemaReportRaw = manifest.settings
        ? validateSettings(manifest.settings as Record<string, unknown>, loadSchema())
        : null;

    // Phase 3 — COMPAT + SHAPE (compat check + schema strictness).
    warnings.push(...collectWarnings(runPhase({
        logger: gateLogger,
        boundary: "import",
        registry: [COMPAT_INCOMPATIBLE, SCHEMA_VIOLATION],
        dryRun: opts.dryRun ?? false,
        strictImports: opts.strictImports ?? false,
        opts: {
            compatResult: compatResultRaw,
            schemaFindings: schemaReportRaw,
            force: !!opts.force,
            strict: !!opts.strict,
            allowUnknownKeys: !!opts.allowUnknownKeys,
        },
    })));

    // Compat summary for the result envelope.
    let compatSummary: SetupImportResult["compat"] = null;
    if (manifest.compat && compatResultRaw) {
        const blocking = compatResultRaw.blocking.map(formatCompatIssue);
        const unverifiable = compatResultRaw.unverifiable.map(formatCompatIssue);
        compatSummary = {
            declared: {
                ...(manifest.compat.koreader_version_min ? { koreaderVersionMin: manifest.compat.koreader_version_min } : {}),
                ...(manifest.compat.koreader_version_max ? { koreaderVersionMax: manifest.compat.koreader_version_max } : {}),
                ...(manifest.compat.device?.length ? { device: [...manifest.compat.device] } : {}),
            },
            detected: {
                koreaderVersion: detectedForCompat.version?.raw ?? null,
                deviceFamily: detectedForCompat.family,
            },
            unverifiable,
            blocking,
            forced: compatResultRaw.blocking.length > 0 && !!opts.force,
        };
    }

    // Schema findings for the result envelope (surfaced only when non-empty).
    let schemaFindings: ValidationReport | undefined;
    if (schemaReportRaw
        && (schemaReportRaw.unknownKeys.length > 0
            || schemaReportRaw.typeMismatches.length > 0)) {
        schemaFindings = schemaReportRaw;
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
            // Preserve by raw axes — not the classifyKey projection — so a
            // key that is BOTH ephemeral AND sensitive-* (e.g. lastfile,
            // hygiene=ephemeral + change=sensitive-fs) still gets preserved
            // on its hygiene axis. The projection collapses to SENSITIVE and
            // would drop ephemeral preservation, which is wrong: hygiene
            // and change are orthogonal.
            if (exfilClass(k) === "secret" || hygieneClass(k) === "ephemeral") {
                preservedKeys.add(k);
            }
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

    // W34d computed once; feeds both the DESTRUCTION gate (Phase 4) and
    // the SetupImportResult.replaceWarnings render field.
    const replaceWarningPayload = computeReplaceWarnings(manifest.apply_mode, changes);

    // Phase 4 — DESTRUCTION + CONSENT + DUAL. Block-order matches
    // pre-refactor: strict-replace → strict-sensitive → consumer-ack → dual.
    warnings.push(...collectWarnings(runPhase({
        logger: gateLogger,
        boundary: "import",
        registry: [
            STRICT_REPLACE_REMOVAL_CAP,
            STRICT_SENSITIVE_CHANGES,
            SENSITIVE_REQUIRES_ACK,
            EXTRA_PLUGIN_PATHS_DUAL,
            CODE_EXEC_ADJACENT_REQUIRES_ACK,
        ],
        dryRun: opts.dryRun ?? false,
        strictImports: opts.strictImports ?? false,
        opts: {
            changes,
            replaceWarnings: replaceWarningPayload,
            acceptSensitive: !!opts.acceptSensitive,
            acceptKey: opts.acceptKey,
            acceptPlugins: !!opts.acceptPlugins,
            acceptCodeExec: !!opts.acceptCodeExec,
        },
    })));

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
        warnings,
    };

    if (!writeSettings && !willInstallPlugins && !willInstallPatches) {
        return baseResult;  // mode: "no-op"
    }

    if (opts.dryRun) {
        return { ...baseResult, mode: "dry-run" };
    }

    let snapshotDir: string | null = null;
    let backupPath: string | null = null;
    let importMarkerPath: string | null = null;
    const fp = computeMountFingerprint(mount);
    if (writeSettings) {
        const merged = isReplace
            ? replaceYamlIntoLua(onDevice, safeFlat) as LuaTable
            : mergeYamlIntoLua(onDevice, safeFlat) as LuaTable;
        const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

        const backupDir = join(env.cwd, ".kindly", "pre-import");
        // C10: crash marker for the safeWrite + history-append window.
        importMarkerPath = writeInProgressMarker(env, {
            cmd: "setup:import",
            started_at: env.now().toISOString(),
            pid: process.pid,
            settings_path: mount.settingsPath,
            intended_sha256: createHash("sha256").update(newContent).digest("hex"),
            setup_id: baseResult.id,
            ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
        });
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
        // Round 3 disk-hygiene F1: ensure the stamp directory is freshly
        // created with an unguessable random suffix so a pre-staged
        // symlink at <cwd>/.kindly/pre-import/<predicted-stamp>/ cannot
        // adopt safety bytes (PIN/passwords) into an attacker-chosen
        // location. mkdtempSync atomically creates a unique dir.
        const stamp = env.now().toISOString().replace(/[:.]/g, "-");
        const preImportRoot = join(env.cwd, ".kindly", "pre-import");
        mkdirSync(preImportRoot, { recursive: true });
        snapshotDir = mkdtempSync(join(preImportRoot, stamp + "-"));
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

        // M1 / Lead 18 caller (2026-04-26): installPluginFiles wipes a
        // top-level dir before writing. If a per-file fsync fails midway
        // (FAT32 cluster exhaustion, USB unplug, EIO), the wipe is
        // permanent and the user sees a half-installed plugin directory
        // with no rollback. Wrap installs and auto-restore from the FAT
        // snapshot we just took, then re-throw so the caller sees the
        // original error and the history entry below records the failed
        // attempt rather than silently absorbing it.
        try {
            if (willInstallPlugins) {
                installPluginFiles(mount.pluginsDir, shippedPlugins, files);
                installedPluginFiles = shippedPlugins.length;
            }
            if (willInstallPatches) {
                installPatches(mount.patchesDir, shippedPatches, files);
                installedPatches = shippedPatches.length;
            }
        } catch (installErr) {
            const reason = installErr instanceof Error ? installErr.message : String(installErr);
            if (fatSnapshotPath && exists(fatSnapshotPath, "derived-from-cwd")) {
                try {
                    extractTarGz({ archivePath: fatSnapshotPath, destRoot: mount.koreaderRoot });
                } catch {
                    // Restore failure is its own incident; we still want
                    // the original install error to surface, so swallow
                    // here and let the user see the primary cause.
                }
            }
            let failureSnapshotHash: string | null = null;
            if (snapshotDir) {
                try {
                    failureSnapshotHash = hashSnapshotDir(snapshotDir);
                } catch {
                    // Defense in depth — proceed with logging the
                    // install failure even if the safety snapshot can't
                    // be hashed (e.g. it never materialized).
                }
            }
            try {
                appendHistoryEntry(env, "setup:import", {
                    // S1320 (Round 4): the failure path previously omitted
                    // settings_delta_n even when safeWrite already
                    // committed N keys to disk before the install threw.
                    // Audit-of-record undercounted partial mutations:
                    // `kindly history show` couldn't tell "wrote N keys
                    // then failed" from "wrote 0 keys then failed". The
                    // success path emits this field already; mirror it
                    // here so failure rows are equally informative.
                    settings_delta_n: baseResult.changes.length,
                    plugins_delta: {
                        installed_files: 0,
                        installed_patches: 0,
                        skipped_files: baseResult.skippedPluginFiles,
                        skipped_patches: baseResult.skippedPatches,
                    },
                    ...(backupPath ? { backup_path: backupPath } : {}),
                    ...(snapshotDir ? { pre_import_path: snapshotDir } : {}),
                    ...(failureSnapshotHash ? { snapshot_sha256: failureSnapshotHash } : {}),
                    setup_id: baseResult.id,
                    failed_reason: reason.slice(0, 240),
                }, {
                    ...(opts.label ? { label: opts.label } : {}),
                    ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
                });
            } catch {
                // Failure to log is also its own incident; don't mask
                // the install error.
            }
            if (importMarkerPath) clearInProgressMarker(importMarkerPath);
            throw installErr;
        }
    }

    let successSnapshotHash: string | null = null;
    if (snapshotDir) {
        try {
            successSnapshotHash = hashSnapshotDir(snapshotDir);
        } catch {
            // Defense in depth — see the failure path above.
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
        ...(successSnapshotHash ? { snapshot_sha256: successSnapshotHash } : {}),
        setup_id: baseResult.id,
    }, {
        ...(opts.label ? { label: opts.label } : {}),
        ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
    });

    if (importMarkerPath) clearInProgressMarker(importMarkerPath);

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

