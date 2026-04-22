// Typed result shapes for CLI commands.
//
// Every command builds one of these before printing. The CLI text renderer
// reads from the result; a future JSON renderer (W3) reads from the same
// result; a future in-process GUI (v1.0) calls the same execute* functions
// and gets the same result without shelling out.
//
// Principle: execute*() does the work and returns data; render*() turns data
// into output. The two are separate so the shape stays the product contract,
// not a side-effect of whatever the CLI felt like printing that day.

import type { Change } from "../schema/diff.ts";
import type { Severity } from "../taxonomy/mapper.ts";
import type { LuaValue } from "../lua/writer.ts";

export interface DiffGroupEntry {
    /** Joined dotted path, e.g. "footer.align" or "avoid_flashing_ui". */
    key: string;
    /** Curated human label from the taxonomy (falls back to humanized key). */
    label: string;
    /** Value on device; undefined for "added". */
    before: LuaValue | undefined;
    /** Value from YAML; undefined for "removed". */
    after: LuaValue | undefined;
    severity: Severity;
    /** Short human summary of the change ("enabled", "18 → 22 (+22%)"). */
    hint?: string;
    kind: "added" | "changed" | "removed";
}

export interface PullResult {
    /** "minimal" strips ephemerals; "full" keeps them. Secrets always dropped. */
    mode: "minimal" | "full";
    /** Absolute path read from (<mount>/koreader/settings.reader.lua). */
    settingsPath: string;
    /** Absolute path written to (default <cwd>/kindly.yaml). */
    outputPath: string;
    /** Byte length of the written YAML. */
    bytes: number;
    /** Line count of the written YAML. */
    lines: number;
    /** Top-level keys filtered as secrets (and dotted paths for nested). Sorted. */
    droppedSecrets: string[];
    /** Top-level keys filtered as ephemerals. Empty in "full" mode. Sorted. */
    droppedEphemerals: string[];
}

export interface DiffResult {
    /** Absolute path of the YAML compared against. */
    yamlPath: string;
    /** Absolute path of the on-device settings.reader.lua. */
    settingsPath: string;
    /** Changes that `apply` would make, in deterministic order. */
    changes: Change[];
    /** Same changes bucketed by taxonomy category, each entry enriched with
     *  label + severity + hint. Category keys appear in taxonomy-declared
     *  order; empty categories are omitted. Derivable from `changes` + the
     *  taxonomy, but pre-grouped here so JSON consumers (and the GUI) don't
     *  need to re-apply the mapper. */
    grouped: Record<string, DiffGroupEntry[]>;
    /** Top-level on-device keys NOT present in the YAML. apply leaves them alone. */
    untrackedKeys: string[];
}

export interface ApplyResult {
    /** "no-op": device already matches YAML, nothing written.
     *  "dry-run": --dry-run passed, diff shown, nothing written.
     *  "applied": safe-write completed and verified. */
    mode: "no-op" | "dry-run" | "applied";
    /** Absolute path of the YAML read from. */
    yamlPath: string;
    /** Absolute path of the on-device settings.reader.lua. */
    settingsPath: string;
    /** Changes that were (or would be) applied, in deterministic order. */
    changes: Change[];
    /** Pre-write snapshot path inside .kindly/backups. Null on no-op/dry-run. */
    backupPath: string | null;
    /** Path of the .old sibling KOReader will fall back to. Null on no-op/dry-run. */
    oldPath: string | null;
    /** Bytes of the written content. 0 on no-op/dry-run. */
    bytesWritten: number;
}

export interface DoctorCheck {
    /** Short identifier — stable across versions so scripts can key off it. */
    id: string;
    /** Human label for the check. */
    label: string;
    /** Pass/fail. Any false → overall failure. */
    ok: boolean;
    /** Extra context (file paths, error messages, counts). Optional. */
    detail?: string;
}

export interface DoctorResult {
    /** Every check run, in order. */
    checks: DoctorCheck[];
    /** Secret keys present on-device that kindly won't sync. Sorted, dotted
     *  for nested (e.g. "cre.0.password"). Useful as a checklist pre-reset. */
    secretsPresent: string[];
    /** True iff all checks passed. */
    ok: boolean;
}

export interface SnapshotResult {
    /** Absolute path to the .tar.gz written. */
    archivePath: string;
    /** Archive size on disk. */
    bytesWritten: number;
    /** Root paths that were found on device and included (relative to koreader/). */
    includedPaths: string[];
    /** Root paths requested but not present on device (skipped silently). */
    skippedPaths: string[];
}

export interface RestoreResult {
    /** "dry-run": list-only, nothing written. "restored": extraction completed. */
    mode: "dry-run" | "restored";
    /** Input archive path. */
    archivePath: string;
    /** Directory extracted into (<mount>/koreader/). */
    destRoot: string;
    /** All entries in the archive (paths as stored in the tar). */
    entries: string[];
    /** Number of file entries actually extracted (0 on dry-run). */
    fileCount: number;
    /** Pre-restore safety snapshot path, if one was created. Null when the
     *  user passed --no-safety-snapshot or the snapshot attempt failed. */
    safetySnapshotPath: string | null;
}

export interface SetupInspectResult {
    /** Absolute path read from. */
    filePath: string;
    /** Setup id (short hash of manifest bytes). */
    id: string;
    /** Full SHA-256 of the raw manifest bytes. */
    hash: string;
    /** Name field from manifest.meta. */
    name: string;
    /** true if this is a .kset (fat tar.gz), false for .kset.yaml (lean). */
    isFat: boolean;
    /** Size of the file on disk in bytes. */
    fileSize: number;
    /** Size of the manifest bytes (equals fileSize for lean setups). */
    manifestBytes: number;
    /** Apply mode from the manifest. */
    applyMode: "additive" | "replace";
    createdAt: string;
    author?: string;
    description?: string;
    tags: string[];
    compat?: {
        koreaderVersionMin?: string;
        koreaderVersionMax?: string;
        device?: string[];
    };
    /** Count of top-level settings keys in the manifest. */
    settingsCount: number;
    /** Count of plugins.disabled entries. */
    pluginsDisabledCount: number;
    /** Count of plugins.files entries (fat). */
    pluginFilesCount: number;
    /** Count of patches entries (fat). */
    patchesCount: number;
    /** True iff the raw bytes match canonical form. If false,
     *  canonicalHash is what a re-export would produce. */
    isCanonical: boolean;
    canonicalHash?: string;
    /** Settings-preview against a baseline. Present only when --vs-device or
     *  --vs-default was passed. `vs-device` diffs the manifest settings
     *  against the live device; `vs-default` diffs against an empty config
     *  (so every manifest key appears as "added" — useful for answering
     *  "what does this setup do to a fresh device?"). */
    preview?: {
        mode: "vs-device" | "vs-default";
        /** Baseline path when mode === "vs-device". */
        settingsPath?: string;
        changes: Change[];
        grouped: Record<string, DiffGroupEntry[]>;
    };
}

export interface SetupExportResult {
    /** "dry-run": planned only, nothing written. "exported": file written. */
    mode: "dry-run" | "exported";
    /** Absolute path the manifest was (or would be) written to. */
    outputPath: string;
    /** Bytes of the written file. 0 on dry-run. */
    bytesWritten: number;
    /** Short id (12 hex) derived from manifestHash. */
    id: string;
    /** Full sha256 of the canonical manifest. */
    hash: string;
    /** meta.name. */
    name: string;
    /** True iff a fat .kset (plugin files or patches embedded). */
    isFat: boolean;
    applyMode: "additive" | "replace";
    /** Top-level settings keys in the manifest (excludes plugins_disabled). */
    settingsCount: number;
    /** Count of plugin toggles in manifest.plugins.disabled. */
    pluginsDisabledCount: number;
    /** Count of embedded plugin files (fat only). */
    pluginFilesCount: number;
    /** Count of embedded patch files (fat only). */
    patchesCount: number;
    /** "device": settings came from a live device read.
     *  "template": settings came from a bundled template. */
    sourceMode: "device" | "template";
    /** Template id when sourceMode === "template". */
    templateId?: string;
    /** Secret keys filtered from source. Sorted. */
    droppedSecrets: string[];
    /** Ephemeral keys filtered from source. Sorted. */
    droppedEphemerals: string[];
    /** --keys entries requested but not present in source (warned, not fatal). */
    skippedKeys: number;
}

export interface SetupImportResult {
    /** "no-op": device already matches manifest + no fat install needed.
     *  "dry-run": --dry-run passed, nothing written.
     *  "imported": writes completed (may include fat install). */
    mode: "no-op" | "dry-run" | "imported";
    /** Absolute path the manifest was read from. */
    setupFile: string;
    /** Short id (12 hex) of the manifest. */
    id: string;
    /** meta.name. */
    name: string;
    applyMode: "additive" | "replace";
    /** Absolute path of the settings.reader.lua on device. */
    settingsPath: string;
    /** Settings changes that were (or would be) applied. */
    changes: Change[];
    /** Plugin files installed. 0 on dry-run or when --skip-plugins. */
    installedPluginFiles: number;
    /** Patches installed. 0 on dry-run or when --skip-patches. */
    installedPatches: number;
    /** Plugin files shipped by the manifest but skipped via --skip-plugins. */
    skippedPluginFiles: number;
    /** Patches shipped but skipped via --skip-patches. */
    skippedPatches: number;
    /** Toggles in manifest.plugins.disabled that have no matching folder on
     *  device — stored but inert. Sorted. */
    inertPluginToggles: string[];
    /** Secret-named keys in the manifest that were refused by the denylist. */
    refusedSecrets: string[];
    /** Settings backup path inside .kindly/pre-import/<stamp>/. Null on
     *  no-op/dry-run or when --no-safety-snapshot. */
    backupPath: string | null;
    /** Pre-import stamped dir (holds settings backup + fat snapshot). Null
     *  when there's nothing to snapshot. */
    snapshotDir: string | null;
    /** Pre-install tar.gz for plugin/patch rollback. Null when no fat install. */
    fatSnapshotPath: string | null;
    /** Compat-check summary. Null when manifest had no compat block. */
    compat: {
        declared: {
            koreaderVersionMin?: string;
            koreaderVersionMax?: string;
            device?: string[];
        };
        detected: {
            koreaderVersion: string | null;
            deviceFamily: string;
        };
        unverifiable: string[];
        blocking: string[];
        forced: boolean;
    } | null;
}

export interface RollbackResult {
    /** "dry-run": preview only. "rolled-back": writes completed. */
    mode: "dry-run" | "rolled-back";
    /** The snapshot directory being restored from. */
    snapshotDir: string;
    /** Whether settings.reader.lua was restored. */
    settingsRestored: boolean;
    /** Whether plugins/patches fat snapshot was restored. */
    fatRestored: boolean;
    /** Entries inside the fat snapshot, if present. */
    fatEntries: string[];
    /** Number of file entries extracted from the fat snapshot. */
    fatFileCount: number;
    /** Pre-rollback safety-snapshot directory, if one was created. */
    preRollbackDir: string | null;
}
