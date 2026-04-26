// Library entry point for `apply` — merge YAML into device settings.
// Pure: returns a typed result; never prints. Throws KindlyError on user-
// visible failures (missing YAML, missing mount).
//
// Non-destructive: keys present on device but not in YAML are preserved.
// This is the core safety property — a half-populated YAML doesn't wipe
// your zlibrary password.

import { dirname, join, resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
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
import { hashSnapshotDir } from "../history/snapshotHash.ts";
import { writeInProgressMarker, clearInProgressMarker } from "../history/inProgress.ts";
import { computeMountFingerprint, isFingerprintEmpty } from "../device/fingerprint.ts";
import { withLock } from "../fs/lockfile.ts";
import { createHash } from "node:crypto";
import { runPhase, collectWarnings } from "../gates/orchestrator.ts";
import {
    YAML_SHAPE_NORMAL,
    CONTROL_BYTES_IN_VALUE,
    PATH_CONTENT_HEURISTIC,
    SCHEMA_FINDINGS_WARN,
} from "../gates/definitions/shape.ts";
import { CODE_EXEC_ADJACENT_REQUIRES_ACK } from "../gates/definitions/dual.ts";
import { SENSITIVE_REQUIRES_ACK } from "../gates/definitions/consent.ts";
import { DESTRUCTIVE_YAML_SHAPE } from "../gates/definitions/destruction.ts";
import { appendGateEvent, gateEventFromFiredGate } from "../history/gateLog.ts";
import { validateSettings } from "../schema/report.ts";
import { loadSchema } from "../schema/settings.ts";
import type { GateDefinition } from "../gates/types.ts";

export interface ApplyOptions {
    file?: string;
    dryRun?: boolean;
    backupDir?: string;
    label?: string;
    /**
     * Bypass CODE_EXEC_ADJACENT_REQUIRES_ACK. Consents to KOReader
     * interpolating YAML-supplied values into os.execute / os.remove /
     * shell calls (SSH_port, httpinspector_port, cover_image_path).
     */
    acceptCodeExec?: boolean;
    /** Bypass SENSITIVE_REQUIRES_ACK (blanket consent). */
    acceptSensitive?: boolean;
    /** Per-key SENSITIVE consent. */
    acceptKey?: Set<string>;
    /** Bypass DESTRUCTIVE_YAML_SHAPE. */
    acceptDestructive?: boolean;
}

export function executeApply(opts: ApplyOptions, env: CliEnv): ApplyResult {
    return withLock(env, "apply", () => executeApplyLocked(opts, env));
}

function executeApplyLocked(opts: ApplyOptions, env: CliEnv): ApplyResult {
    const yamlPath = resolve(env.cwd, opts.file ?? "kindly.yaml");
    if (!exists(yamlPath, "user-provided")) {
        throw new KindlyError(
            ErrorCodes.YAML_NOT_FOUND,
            `${yamlPath} not found. Run \`kindly pull\` first?`,
            [{ text: "Capture the device's current config.", command: "kindly pull" }],
        );
    }

    const mount = resolveMount(env);

    // C10b: surface step-4 interrupted state with the repair hint instead
    // of letting readText raise a raw ENOENT. Pull/diff/doctor do the same.
    if (!exists(mount.settingsPath, "derived-from-mount")) {
        const interrupted = detectInterruptedApply(mount.settingsPath);
        if (interrupted) {
            throw new KindlyError(
                ErrorCodes.SETTINGS_INTERRUPTED_APPLY,
                `${mount.settingsPath} is missing but ${interrupted.oldPath} survives — a previous kindly apply / setup import was interrupted between rename steps.`,
                [
                    {
                        text: "Recover by promoting .old back into place.",
                        command: "kindly doctor --repair",
                    },
                ],
            );
        }
        throw new KindlyError(
            ErrorCodes.SETTINGS_NOT_FOUND,
            `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`,
            [{ text: "Install KOReader on the Kindle, then retry." }],
        );
    }

    const onDeviceSrc = readText(mount.settingsPath, "derived-from-mount");
    const onDevice = parseSettingsFile(onDeviceSrc) as Record<string, LuaValue>;
    const fromYaml = yamlToLua(readText(yamlPath, "user-provided")) as Record<string, LuaValue>;

    // Compute the diff first — CODE_EXEC_ADJACENT_REQUIRES_ACK needs
    // `changes` in its context to identify which code-exec-adjacent keys
    // the YAML is touching.
    const changes = computeChanges(onDevice, fromYaml);

    // S603: schema validation runs on apply too. Findings flow to
    // SCHEMA_FINDINGS_WARN, which surfaces them as warn-tier (S605) so
    // typos in `kindly.yaml` no longer pass silently. importSetup runs
    // the same validator behind --strict; apply has no --strict surface,
    // hence warn instead of block.
    const schemaFindings = validateSettings(
        fromYaml as Record<string, unknown>,
        loadSchema(),
    );

    // Apply-side gate run. Seven gates fire on every apply:
    //
    //   YAML_SHAPE_NORMAL              — S89 fix: rejects null/[]-at-secret-
    //                                    parent shapes that would wipe
    //                                    on-device SECRETs through the
    //                                    shallow-merge. Fires always
    //                                    (incl. --dry-run); zero FP.
    //   CONTROL_BYTES_IN_VALUE         — Batch O fix: rejects ESC/CR/NUL
    //                                    in SENSITIVE/SECRET string values.
    //   PATH_CONTENT_HEURISTIC         — S602 (warn): flags `..` traversal
    //                                    or absolute-out-of-/mnt/us/ paths
    //                                    in sensitive-fs/code-exec values.
    //                                    Non-blocking advisory.
    //   SCHEMA_FINDINGS_WARN           — S603 (warn): unknown keys + type
    //                                    mismatches in YAML, surfaced on
    //                                    apply (importSetup blocks under
    //                                    --strict; apply has no --strict).
    //   CODE_EXEC_ADJACENT_REQUIRES_ACK — C1a: SSH_port / httpinspector_port
    //                                    / cover_image_path family.
    //                                    Bypass: --accept-code-exec.
    //   SENSITIVE_REQUIRES_ACK         — Lead 7 / S600 closure: any
    //                                    SENSITIVE-class change requires
    //                                    --accept-sensitive or
    //                                    --accept-key=<list>. firesIn:
    //                                    non-dry-run so --dry-run previews
    //                                    don't trip on the gate.
    //   DESTRUCTIVE_YAML_SHAPE         — Lead 7 / S606 closure: mass-
    //                                    removal cap (≥5 top-level USER
    //                                    removals). Bypass:
    //                                    --accept-destructive.
    //
    // SENSITIVE + DESTRUCTIVE were previously hidden behind --untrusted-
    // yaml; promoted to always-on in v0.12. The legitimate `kindly pull
    // → kindly apply` round-trip has no SENSITIVE diff (pull writes the
    // device's own bytes), so the gates are invisible to that flow.
    const registry: GateDefinition[] = [
        YAML_SHAPE_NORMAL,
        CONTROL_BYTES_IN_VALUE,
        PATH_CONTENT_HEURISTIC,
        SCHEMA_FINDINGS_WARN,
        CODE_EXEC_ADJACENT_REQUIRES_ACK,
        SENSITIVE_REQUIRES_ACK,
        DESTRUCTIVE_YAML_SHAPE,
    ];

    const gateReport = runPhase({
        boundary: "apply",
        registry,
        dryRun: opts.dryRun ?? false,
        strictImports: false,
        opts: {
            yamlSettings: fromYaml,
            changes,
            schemaFindings,
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
    const warnings = collectWarnings(gateReport);

    if (changes.length === 0) {
        return {
            mode: "no-op",
            yamlPath,
            settingsPath: mount.settingsPath,
            changes,
            backupPath: null,
            oldPath: null,
            bytesWritten: 0,
            warnings,
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
            warnings,
        };
    }

    const merged = mergeYamlIntoLua(onDevice, fromYaml) as LuaTable;
    // Mirror KOReader's "./settings.reader.lua" header — cwd when koreader
    // runs is /mnt/us/koreader/, making the path relative. We match exactly.
    const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

    const backupDir = opts.backupDir
        ? resolve(env.cwd, opts.backupDir)
        : join(env.cwd, ".kindly", "backups");

    // C10: crash-recovery marker. Surviving markers indicate either an
    // in-flight apply in another process, or an apply that died before
    // step-6 / before history was appended. doctor surfaces them.
    const fp = computeMountFingerprint(mount);
    const markerPath = writeInProgressMarker(env, {
        cmd: "apply",
        started_at: env.now().toISOString(),
        pid: process.pid,
        settings_path: mount.settingsPath,
        intended_sha256: createHash("sha256").update(newContent).digest("hex"),
        ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
    });

    const res = safeWrite(mount.settingsPath, newContent, { backupDir, verifyLua: true });

    // Round-3 snapshot integrity binding: hash the backup dir's contents
    // so `kindly rollback --to N` can detect tampering (a swapped
    // `settings.reader.lua` whose bytes parse fine but mutate a SECRET
    // or sensitive flag). Skipped when no backup was taken (the surface
    // doesn't exist without an on-disk dir to hash). dirname(backupPath)
    // gives the per-write archive root that safeWrite created via
    // mkdtempSync; that's the exact dir we hash.
    let snapshotHash: string | null = null;
    if (res.backupPath) {
        try {
            snapshotHash = hashSnapshotDir(dirname(res.backupPath));
        } catch {
            // Hashing is defense in depth, not a correctness invariant.
            // If readdir/stat raced something else (rotation pruning at
            // the same instant), proceed without the binding rather than
            // fail the apply that already succeeded.
        }
    }

    appendHistoryEntry(env, "apply", {
        settings_delta_n: changes.length,
        ...(res.backupPath ? { backup_path: res.backupPath } : {}),
        ...(snapshotHash ? { snapshot_sha256: snapshotHash } : {}),
    }, {
        ...(opts.label ? { label: opts.label } : {}),
        ...(isFingerprintEmpty(fp) ? {} : { mount: fp }),
    });

    clearInProgressMarker(markerPath);

    return {
        mode: "applied",
        yamlPath,
        settingsPath: mount.settingsPath,
        changes,
        backupPath: res.backupPath,
        oldPath: res.oldPath,
        bytesWritten: res.bytesWritten,
        warnings,
    };
}
