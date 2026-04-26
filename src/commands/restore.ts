// `kindly restore <archive>` — extract a snapshot over <mount>/koreader/.
//
// Safety:
//   - Takes a pre-restore snapshot of the CURRENT state first (unless
//     --no-safety-snapshot is passed). If the restore goes wrong, you can
//     re-extract that snapshot to roll back.
//   - `--dry-run` lists what would be extracted without writing anything.
//
// Overwrite semantics: tar replaces files file-by-file. Files present on
// device but not in the archive are LEFT UNTOUCHED (tar doesn't delete
// anything it doesn't know about — this is the sane default; if you want
// a clean slate, factory-reset first).

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import {
    ArchiveTooLargeError, assertSafeArchive, createTarGz, extractFileToMemory,
    extractTarGz, listTarGz, MalformedArchiveError, UnsafeArchivePathError,
} from "../fs/archive.ts";
import { resolve, join } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { exists, readText } from "../fs/safeRead.ts";
import { rotateBackups } from "../fs/backupRotation.ts";
import type { RestoreResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { emitJson } from "../cli/json.ts";
import { appendHistoryEntry } from "../history/writer.ts";
import { withLock } from "../fs/lockfile.ts";
import { computeMountFingerprint, isFingerprintEmpty } from "../device/fingerprint.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import type { GateWarning } from "../types/results.ts";
import { computeChanges } from "../schema/diff.ts";
import { runPhase, collectWarnings } from "../gates/orchestrator.ts";
import { CODE_EXEC_ADJACENT_REQUIRES_ACK } from "../gates/definitions/dual.ts";
import { CONTROL_BYTES_IN_VALUE, PATH_CONTENT_HEURISTIC } from "../gates/definitions/shape.ts";
import { SENSITIVE_REQUIRES_ACK } from "../gates/definitions/consent.ts";
import { DESTRUCTIVE_YAML_SHAPE } from "../gates/definitions/destruction.ts";
import { appendGateEvent, gateEventFromFiredGate } from "../history/gateLog.ts";

const FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "list what would be extracted without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "take a pre-restore snapshot of current device state (use --no-safety-snapshot to skip)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    label: {
        type: "string",
        description: "advisory name for this restore — shown in `kindly history`",
    },
    "accept-code-exec": {
        type: "boolean",
        default: false,
        description: "consent to KOReader interpolating archive-supplied values into shell / os.execute / os.remove calls (SSH_port family)",
    },
    "accept-sensitive": {
        type: "boolean",
        default: false,
        description: "blanket consent for SENSITIVE-class changes the archive introduces",
    },
    "accept-key": {
        type: "string",
        description: "per-key SENSITIVE consent (comma-separated dotted paths)",
    },
    "accept-destructive": {
        type: "boolean",
        default: false,
        description: "consent to mass-removal of USER keys (≥5) implied by the archive",
    },
} as const satisfies FlagSpecs;

const SAFETY_PATHS = [
    "settings.reader.lua",
    "settings.reader.lua.old",
    "defaults.custom.lua",
    "history.lua",
    "patches",
    "plugins",
];

export interface RestoreOptions {
    archive: string;
    dryRun?: boolean;
    safetySnapshot?: boolean;
    label?: string;
    /**
     * C1b: bypass CODE_EXEC_ADJACENT_REQUIRES_ACK at the restore boundary.
     * Consents to the archive's settings.reader.lua introducing values
     * KOReader interpolates into os.execute / os.remove / shell calls.
     */
    acceptCodeExec?: boolean;
    /** Bypass SENSITIVE_REQUIRES_ACK (blanket consent). */
    acceptSensitive?: boolean;
    /** Per-key SENSITIVE consent. */
    acceptKey?: Set<string>;
    /** Bypass DESTRUCTIVE_YAML_SHAPE. */
    acceptDestructive?: boolean;
}

export function executeRestore(opts: RestoreOptions, env: CliEnv): RestoreResult {
    return withLock(env, "restore", () => executeRestoreLocked(opts, env));
}

function executeRestoreLocked(opts: RestoreOptions, env: CliEnv): RestoreResult {
    const archivePath = resolve(env.cwd, opts.archive);
    if (!exists(archivePath, "user-provided")) {
        throw new KindlyError(
            ErrorCodes.ARCHIVE_NOT_FOUND,
            `archive not found: ${archivePath}`,
            [{ text: "Pass a path to an existing .tar.gz produced by `kindly snapshot`." }],
        );
    }

    const mount = resolveMount(env);

    // Safety pre-scan: fail before taking a safety snapshot, before
    // reading the full entry list, before anything. A malicious archive
    // shouldn't cause ANY filesystem work on our side.
    try {
        assertSafeArchive(archivePath);
    } catch (e) {
        if (e instanceof UnsafeArchivePathError) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_UNSAFE_PATH,
                e.message,
                [{ text: "Archive was built outside kindly or tampered with; do not restore it. Produce a fresh snapshot with `kindly snapshot`." }],
            );
        }
        if (e instanceof ArchiveTooLargeError) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_TOO_LARGE,
                e.message,
                [{ text: "Archive exceeds kindly's compression-bomb guard. Verify its provenance before restoring." }],
            );
        }
        if (e instanceof MalformedArchiveError) {
            throw new KindlyError(
                ErrorCodes.ARCHIVE_MALFORMED,
                e.message,
                [{ text: "Archive does not match kindly's gzipped-tar format, or contains hardlink/symlink entries kindly refuses to extract. Produce a fresh snapshot with `kindly snapshot`." }],
            );
        }
        throw e;
    }
    const entries = listTarGz(archivePath);

    // C1b: run classify-aware gates against the archive's would-be writes
    // BEFORE safety-snapshot or extraction. Any code-exec-adjacent key the
    // archive's settings.reader.lua sets (SSH_port, httpinspector_port,
    // cover_image_path) requires --accept-code-exec consent. Other gate
    // families (SENSITIVE, EXTRA_PLUGIN_PATHS) follow in C1c.
    const warnings = runRestoreGates(archivePath, entries, mount.settingsPath, opts, env);

    if (opts.dryRun) {
        return {
            mode: "dry-run",
            archivePath,
            destRoot: mount.koreaderRoot,
            entries,
            fileCount: 0,
            safetySnapshotPath: null,
            warnings,
        };
    }

    // Pre-restore safety snapshot. Rollback = extract this back over the
    // koreader dir if something goes wrong.
    //
    // Round 3 disk-hygiene F1 sibling: the pre-restore archive used to
    // live at `.kindly/pre-restore/<isoStamp>.tar.gz` — a clock-derived
    // path. An attacker with .kindly/ write access could pre-stage a
    // symlink at the predicted stamp; createTarGz would then follow it
    // and clobber a target outside the snapshot dir. Two-layer fix:
    // mkdtempSync below creates an unguessable parent directory, AND
    // archive.ts:createTarGz lstats outputPath and refuses to write
    // when it resolves to a symlink.
    let safetySnapshotPath: string | null = null;
    if (opts.safetySnapshot !== false) {
        const preRestoreRoot = resolve(env.cwd, ".kindly", "pre-restore");
        mkdirSync(preRestoreRoot, { recursive: true });
        const stamp = isoStamp(env.now());
        const archiveDir = mkdtempSync(join(preRestoreRoot, stamp + "-"));
        const safetyPath = join(archiveDir, "snapshot.tar.gz");
        try {
            const saf = createTarGz({
                cwd: mount.koreaderRoot,
                paths: SAFETY_PATHS,
                outputPath: safetyPath,
            });
            safetySnapshotPath = saf.archivePath;
        } catch {
            // If the device is empty (fresh install with no settings file),
            // no safety snapshot is possible — leave safetySnapshotPath null,
            // the renderer surfaces that case with a warning.
        }
    }

    const res = extractTarGz({ archivePath, destRoot: mount.koreaderRoot });

    const fp = computeMountFingerprint(mount);
    appendHistoryEntry(env, "restore", {
        archive_path: archivePath,
        ...(safetySnapshotPath ? { pre_restore_path: safetySnapshotPath } : {}),
    }, {
        ...(opts.label ? { label: opts.label } : {}),
        ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
    });

    // Round 3 disk-hygiene F2: rotate pre-restore archives the same way
    // apply rotates .kindly/backups/. Default keep-N (20) matches the
    // existing convention. Skipped when --no-safety-snapshot is set
    // (no archive was created).
    if (safetySnapshotPath) {
        rotateBackups(resolve(env.cwd, ".kindly", "pre-restore"));
    }

    return {
        mode: "restored",
        archivePath,
        destRoot: res.destRoot,
        entries,
        fileCount: res.fileCount,
        safetySnapshotPath,
        warnings,
    };
}

export function renderRestore(result: RestoreResult, env: CliEnv): void {
    if (result.mode === "dry-run") {
        heading(env, `would extract ${result.entries.length} entries into ${result.destRoot}:`);
        for (const e of result.entries.slice(0, 50)) info(env, `  ${e}`);
        if (result.entries.length > 50) {
            info(env, dim(env, `  ... and ${result.entries.length - 50} more`));
        }
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    if (result.safetySnapshotPath) {
        info(env, dim(env, `safety snapshot: ${result.safetySnapshotPath}`));
    } else {
        // Either the user skipped it (--no-safety-snapshot) or creation failed
        // because the device had nothing to snapshot. Warning only matters in
        // the latter case, and we can't tell here — so a single neutral note.
        info(env, dim(env, "no safety snapshot taken."));
    }

    info(env, dim(env, `extracting ${result.entries.length} entries into ${result.destRoot}...`));
    ok(env, `restored ${result.fileCount} file(s) into ${result.destRoot}`);
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
}

export async function runRestore(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const archive = positional[0];
    if (!archive) {
        throw new ArgError("usage: kindly restore <archive.tar.gz> [--dry-run]");
    }
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const acceptKey = flags["accept-key"]
        ? new Set(flags["accept-key"].split(",").map((s) => s.trim()).filter(Boolean))
        : undefined;

    const result = executeRestore({
        archive,
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
        label: flags.label,
        acceptCodeExec: flags["accept-code-exec"],
        acceptSensitive: flags["accept-sensitive"],
        acceptKey,
        acceptDestructive: flags["accept-destructive"],
    }, env);

    if (env.jsonMode) emitJson(env, "restore", result);
    else renderRestore(result, env);
    return 0;
}

function runRestoreGates(
    archivePath: string,
    entries: string[],
    deviceSettingsPath: string,
    opts: RestoreOptions,
    env: CliEnv,
): GateWarning[] {
    if (!entries.includes("settings.reader.lua")) return [];

    const archiveSrc = extractFileToMemory(archivePath, "settings.reader.lua");
    if (archiveSrc === null) return [];

    // If either side fails to parse, skip the gate. The reader is strict
    // about KOReader's exact dump format; archives produced by tooling
    // outside that grammar (or already-corrupt device files) shouldn't
    // block a restore attempt here. KOReader itself will reject anything
    // it can't load when the user reboots.
    let fromArchive: Record<string, LuaValue>;
    try {
        fromArchive = parseSettingsFile(archiveSrc) as Record<string, LuaValue>;
    } catch {
        return [];
    }

    let onDevice: Record<string, LuaValue> = {};
    if (exists(deviceSettingsPath, "derived-from-mount")) {
        try {
            onDevice = parseSettingsFile(
                readText(deviceSettingsPath, "derived-from-mount"),
            ) as Record<string, LuaValue>;
        } catch {
            // Device file unparseable → treat as empty so the gate flags
            // any code-exec-adjacent key the archive introduces.
        }
    }

    // Restore is replace-semantics on settings.reader.lua: tar overwrites
    // the whole file, so any device key the archive omits is effectively
    // removed. computeChanges is additive-only — it never emits "removed"
    // — so we synthesize the removal entries here for the
    // DESTRUCTIVE_YAML_SHAPE gate to count. SENSITIVE_REQUIRES_ACK
    // intentionally also sees them: an archive that wipes a SENSITIVE
    // key the user has is a sensitive change.
    const changes = computeChanges(onDevice, fromArchive);
    for (const k of Object.keys(onDevice).sort()) {
        if (!(k in fromArchive)) {
            changes.push({ kind: "removed", path: [k], prev: onDevice[k]! });
        }
    }

    const report = runPhase({
        boundary: "restore",
        registry: [
            CODE_EXEC_ADJACENT_REQUIRES_ACK,
            CONTROL_BYTES_IN_VALUE,
            PATH_CONTENT_HEURISTIC,
            SENSITIVE_REQUIRES_ACK,
            DESTRUCTIVE_YAML_SHAPE,
        ],
        dryRun: opts.dryRun ?? false,
        strictImports: false,
        opts: {
            changes,
            yamlSettings: fromArchive,
            acceptCodeExec: !!opts.acceptCodeExec,
            acceptSensitive: !!opts.acceptSensitive,
            acceptKey: opts.acceptKey ?? new Set<string>(),
            acceptDestructive: !!opts.acceptDestructive,
        },
        logger: (fired) => {
            const event = gateEventFromFiredGate(fired);
            if (event) appendGateEvent(env, event);
        },
    });
    return collectWarnings(report);
}

function isoStamp(d: Date): string {
    return d.toISOString().replace(/[:.]/g, "-");
}

export const restoreHelp = `
kindly restore <archive> — extract a snapshot back into the Kindle.

usage: kindly restore <archive.tar.gz> [--dry-run] [--no-safety-snapshot]
                                       [--label <text>] [--mount <path>]
                                       [--accept-code-exec]
                                       [--accept-sensitive | --accept-key=<a,b>]
                                       [--accept-destructive]

  --dry-run              list entries without writing
  --no-safety-snapshot   skip the pre-restore snapshot of current state
  --label <text>         advisory name logged into kindly history
  --mount <path>         path to a mounted Kindle (auto-detect by default)
  --accept-code-exec     consent to KOReader interpolating archive values
                         into shell / os.execute / os.remove (SSH_port,
                         httpinspector_port, cover_image_path)
  --accept-sensitive     blanket consent for SENSITIVE-class changes
                         the archive introduces vs. current device state
  --accept-key=<a,b>     per-key SENSITIVE consent (comma-separated paths)
  --accept-destructive   consent to mass USER-key removal (≥5 top-level)

By default, takes a safety snapshot of the CURRENT device state first. If
restore goes wrong, re-extract that file to roll back. The safety snapshot
lives under <cwd>/.kindly/pre-restore/.

Restore overwrites file-by-file. Files on device not in the archive are
left untouched — use factory reset for a true clean slate.
`.trim();
