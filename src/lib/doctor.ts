// Library entry point for `doctor` — read-only sanity checks on the device.
// Pure: returns a typed result; never prints. Never throws — every failure
// is a finding in `checks` so consumers (JSON, GUI) see a consistent shape.
//
// Severity model follows 90 §2. Legacy check ids (`mount`,
// `settings_present`, `settings_parseable`, `old_parseable`) are
// grandfathered per 90 §7 "never rename an id".

import {
    mkdtempSync, readdirSync, rmSync, statfsSync,
} from "node:fs";
import { join } from "node:path";
import { exists, readText, statFollow } from "../fs/safeRead.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
import { parseSettingsFile, LuaParseError } from "../lua/reader.ts";
import { classifyKey, isSecretPath } from "../schema/classify.ts";
import type { LuaValue } from "../lua/writer.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { DoctorResult, DoctorCheck, DoctorSeverity } from "../types/results.ts";
import { loadPluginCatalog } from "../catalog/reader.ts";
import {
    fileRole, groupArchivePluginFiles, verifyPluginAgainstCatalog,
} from "../catalog/verify.ts";
import { collectPluginDirs } from "../setup/files.ts";
import { loadSchema, type Schema } from "../schema/settings.ts";
import { readKoreaderVersion } from "../device/version.ts";
import type { KindleMount } from "../device/kindle.ts";
import { inProgressDir } from "../history/inProgress.ts";

/** 90 §5.1, §5.3 — a check flips to warning once its source is this
 *  many days old. Scalar, not a spec number, but the spec names
 *  90 days explicitly for both schema and catalog. */
const STALE_DAYS = 90;

export interface DoctorOptions {
    /** Testability hook — override the plugin catalog path. Production
     *  leaves this undefined so `loadPluginCatalog` reads the committed
     *  `data/catalog/plugins.bundled.v1.json`. Not exposed on the CLI. */
    catalogPath?: string;
    /** Testability hook — override the schema path. */
    schemaPath?: string;
}

const SEVERITY_RANK: Record<DoctorSeverity, number> = {
    fatal: 0, error: 1, warning: 2, info: 3,
};

/** Back-compat `ok` field — v0.5 consumers read this instead of severity. */
function okFromSeverity(s: DoctorSeverity): boolean {
    return s === "warning" || s === "info";
}

export function executeDoctor(env: CliEnv, opts: DoctorOptions = {}): DoctorResult {
    const checks: DoctorCheck[] = [];

    let mount;
    try {
        mount = resolveMount(env);
        checks.push({
            id: "mount", category: "mount", severity: "info", ok: true,
            label: `Kindle mount: ${mount.root}`,
        });
    } catch (e) {
        checks.push({
            id: "mount", category: "mount", severity: "fatal", ok: false,
            label: "Kindle mount",
            detail: (e as Error).message,
        });
        return finalize(checks, []);
    }

    const settingsPath = mount.settingsPath;
    if (!exists(settingsPath, "derived-from-mount")) {
        const interrupted = detectInterruptedApply(settingsPath);
        if (interrupted) {
            // C10b: step-4 of safeWrite was interrupted. KOReader still
            // boots from .old; kindly read paths ENOENT until --repair
            // promotes .old back into place.
            checks.push({
                id: "settings_interrupted_apply", category: "settings",
                severity: "fatal", ok: false,
                label: "settings.reader.lua interrupted apply",
                detail:
                    `${settingsPath} is missing but ${interrupted.oldPath} survives — ` +
                    "a previous kindly apply / setup import was interrupted between " +
                    "rename steps. Run `kindly doctor --repair` to recover.",
            });
            return finalize(checks, []);
        }
        checks.push({
            id: "settings_present", category: "settings",
            severity: "fatal", ok: false,
            label: "settings.reader.lua present",
            detail: `${settingsPath} not found — is KOReader installed?`,
        });
        return finalize(checks, []);
    }
    checks.push({
        id: "settings_present", category: "settings",
        severity: "info", ok: true,
        label: `settings.reader.lua: ${settingsPath}`,
    });

    let parsed: Record<string, LuaValue>;
    try {
        parsed = parseSettingsFile(readText(settingsPath, "derived-from-mount")) as Record<string, LuaValue>;
        const keyCount = Object.keys(parsed).length;
        checks.push({
            id: "settings_parseable", category: "settings",
            severity: "info", ok: true,
            label: `settings.reader.lua parseable (${keyCount} keys)`,
        });
    } catch (e) {
        const detail = e instanceof LuaParseError ? e.message : (e as Error).message;
        checks.push({
            id: "settings_parseable", category: "settings",
            severity: "fatal", ok: false,
            label: "settings.reader.lua parseable",
            detail,
        });
        return finalize(checks, []);
    }

    // .old sibling — KOReader's own recovery point. Kindly still works if
    // it's corrupt, so the failure is `warning` not `fatal` (90 §2).
    const oldPath = settingsPath + ".old";
    if (exists(oldPath, "derived-from-mount")) {
        try {
            parseSettingsFile(readText(oldPath, "derived-from-mount"));
            checks.push({
                id: "old_parseable", category: "settings",
                severity: "info", ok: true,
                label: "settings.reader.lua.old parseable (KOReader fallback)",
            });
        } catch (e) {
            checks.push({
                id: "old_parseable", category: "settings",
                severity: "warning", ok: true,
                label: "settings.reader.lua.old parseable",
                detail: `KOReader's fallback copy is corrupt: ${(e as Error).message}`,
            });
        }
    } else {
        checks.push({
            id: "old_parseable", category: "settings",
            severity: "info", ok: true,
            label: "settings.reader.lua.old",
            detail: "absent (fine — KOReader creates it on first flush)",
        });
    }

    // C10: progress.* — surviving in-progress markers from a SIGKILL'd
    // apply / setup-import / rollback. Each marker means the device may
    // be consistent on disk but kindly's history.jsonl never recorded
    // the change.
    checks.push(...runProgressChecks(env));

    // W34c: schema.* freshness + uncurated keys (90 §5.1, §5.2).
    checks.push(...runSchemaChecks(env, parsed, opts.schemaPath));

    // W34c: catalog.* freshness + version-match (90 §5.3).
    checks.push(...runCatalogChecks(env, mount, opts.catalogPath));

    // W34b: plugins.* findings (90 §5.4, §5.5). Walk the on-device
    // plugins dir, verify against the catalog in "full" mode (doctor
    // wants missing files reported, unlike import's subset mode).
    checks.push(...runPluginHashChecks(mount.pluginsDir, opts.catalogPath));

    // W34d: disk.* + secrets.* housekeeping (90 §5.6, §5.7).
    checks.push(...runDiskChecks(env, mount));

    // Step 15: gates.* observability — report registered gates + recent
    // bypass cadence read from .kindly/gate-events.jsonl.
    checks.push(...runGatesChecks(env));
    const secretsPresent = findSecrets(parsed);
    checks.push({
        id: "secrets.present_count",
        category: "secrets",
        severity: "info",
        ok: true,
        label: secretsPresent.length > 0
            ? `${secretsPresent.length} secret(s) present on device`
            : "no secrets detected on device",
        data: { count: secretsPresent.length },
    });

    return finalize(checks, secretsPresent);
}

/** Days elapsed between `iso` and env.now(). Negative → 0 (clock skew). */
function daysSince(iso: string, now: Date): number {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return 0;
    const ms = now.getTime() - then.getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
}

/** W34c 90 §5.1 + §5.2. `parsed` is the device settings — needed for
 *  the uncurated-keys diff. Silent no-op if the schema can't be loaded. */
function runSchemaChecks(
    env: CliEnv,
    parsed: Record<string, LuaValue>,
    schemaPath?: string,
): DoctorCheck[] {
    let schema: Schema;
    try { schema = loadSchema(schemaPath); }
    catch { return []; }

    const out: DoctorCheck[] = [];
    const age = daysSince(schema.extracted_at, env.now?.() ?? new Date());
    const declared = String(schema.$schema_version);
    out.push({
        id: "schema.version",
        category: "schema",
        severity: age >= STALE_DAYS ? "warning" : "info",
        ok: true,
        label: age >= STALE_DAYS
            ? `schema ${declared} is ${age} days old`
            : `schema ${declared} (${age} days old)`,
        data: { declared, current: declared, age_days: age },
        ...(age >= STALE_DAYS ? {
            remediation: [{
                text: "Rebuild with scripts/extract-schema.ts if you're building kindly locally; otherwise upgrade the binary.",
                command: "bun run scripts/extract-schema.ts",
            }],
        } : {}),
    });

    // 90 §5.2: device keys not in the schema → warning with up to 5 samples.
    const unknowns: string[] = [];
    for (const k of Object.keys(parsed)) {
        if (!schema.keys[k]) unknowns.push(k);
    }
    unknowns.sort();
    const sample = unknowns.slice(0, 5);
    out.push({
        id: "schema.uncurated_keys",
        category: "schema",
        severity: unknowns.length > 0 ? "warning" : "info",
        ok: true,
        label: unknowns.length > 0
            ? `${unknowns.length} device key(s) not in schema`
            : "all device keys curated",
        ...(unknowns.length > 0 ? {
            detail: sample.join(", ") + (unknowns.length > sample.length ? ", …" : ""),
        } : {}),
        data: { count: unknowns.length, sample },
        ...(unknowns.length > 0 ? {
            remediation: [{
                text: "Run scripts/extract-schema.ts against current KOReader source. Review new keys — any network/path additions need SENSITIVE_KEYS updates (88 §2).",
                command: "bun run scripts/extract-schema.ts",
            }],
        } : {}),
    });

    for (const c of out) c.ok = okFromSeverity(c.severity);
    return out;
}

/** W34c 90 §5.3. Silent no-op when the catalog can't be loaded (mirrors
 *  plugins.* behaviour). */
function runCatalogChecks(
    env: CliEnv, mount: KindleMount, catalogPath?: string,
): DoctorCheck[] {
    let catalog;
    try { catalog = loadPluginCatalog(catalogPath); }
    catch { return []; }

    const out: DoctorCheck[] = [];
    const age = daysSince(catalog.curated_at, env.now?.() ?? new Date());
    const declared = catalog.catalog_version;
    out.push({
        id: "catalog.version",
        category: "catalog",
        severity: age >= STALE_DAYS ? "warning" : "info",
        ok: true,
        label: age >= STALE_DAYS
            ? `plugin catalog ${declared} is ${age} days old`
            : `plugin catalog ${declared} (${age} days old)`,
        data: { declared, current: declared, age_days: age },
        ...(age >= STALE_DAYS ? {
            remediation: [{
                text: "Regenerate from a current KOReader source tree.",
                command: "bun run scripts/extract-plugin-meta.ts",
            }],
        } : {}),
    });

    // catalog.matches_koreader_version: compare catalog's hash-source
    // version against the device's reported KOReader version.
    const deviceVer = readKoreaderVersion(mount);
    const catalogFor = catalog.koreader_hash_version ?? null;
    const deviceRaw = deviceVer?.raw ?? null;
    const exactMatch = catalogFor !== null && deviceRaw !== null
        && catalogFor === deviceRaw;
    const severity: DoctorSeverity = exactMatch ? "info" : "warning";
    out.push({
        id: "catalog.matches_koreader_version",
        category: "catalog",
        severity,
        ok: true,
        label: exactMatch
            ? `catalog matches KOReader version on device (${deviceRaw})`
            : deviceRaw === null
                ? "device KOReader version unreadable — plugin checks are advisory"
                : `catalog built for KOReader ${catalogFor ?? "unknown"}, device reports ${deviceRaw}`,
        data: { catalog_for: catalogFor, device_has: deviceRaw },
        ...(!exactMatch && deviceRaw !== null ? {
            remediation: [{
                text: "Hash mismatches below may be false positives. Regenerate the catalog against the device's KOReader version or verify by hand.",
            }],
        } : {}),
    });

    for (const c of out) c.ok = okFromSeverity(c.severity);
    return out;
}

/** Run plugin-hash checks against the on-device `plugins/` dir. Returns
 *  zero or more DoctorChecks: one `plugins.hashes_verified` summary
 *  (always, if catalog loaded), one `plugins.tampered` per modified
 *  file, and at most one `plugins.uncatalogued` listing plugin names
 *  not in the catalog. Returns [] silently when the catalog can't be
 *  loaded — this is doctor, not a hard dependency. */
function runPluginHashChecks(
    pluginsDir: string, catalogPath?: string,
): DoctorCheck[] {
    let catalog;
    try { catalog = loadPluginCatalog(catalogPath); }
    catch { return []; }

    const { declared, files } = collectPluginDirs(pluginsDir);
    const grouped = groupArchivePluginFiles(declared, files);

    let verified = 0;
    const tamperedFindings: DoctorCheck[] = [];
    const uncataloguedPlugins: string[] = [];

    for (const [name, pluginFiles] of grouped.plugins) {
        const v = verifyPluginAgainstCatalog(
            name, pluginFiles as Map<string, Uint8Array>, catalog, "full",
        );
        if (v.status === "MATCH") {
            verified++;
        } else if (v.status === "UNCATALOGUED") {
            uncataloguedPlugins.push(name);
        } else if (v.status === "MISMATCH") {
            let onlyExtras = true;
            for (const f of v.files) {
                if (f.status === "modified") {
                    onlyExtras = false;
                    const role = fileRole(f.file);
                    tamperedFindings.push({
                        id: "plugins.tampered",
                        category: "plugins",
                        severity: role === "code" ? "error" : "warning",
                        ok: role !== "code",
                        label: `${name}.koplugin/${f.file}: ${role} tampered`,
                        detail: `expected ${f.expected}; actual ${f.actual}`,
                        data: {
                            plugin: name, file: f.file,
                            expected: f.expected, actual: f.actual,
                        },
                        remediation: [{
                            text: "Reinstall the plugin from the KOReader source tree, or remove the file if not needed.",
                        }],
                    });
                } else if (f.status === "extra") {
                    // Extra file in catalogued plugin → treat the plugin as
                    // having uncatalogued content (90 §5.5).
                    onlyExtras = onlyExtras && true;
                }
                // missing: advisory-only (89 §5.4), no finding.
            }
            const hasExtras = v.files.some((f) => f.status === "extra");
            if (onlyExtras && hasExtras) uncataloguedPlugins.push(name);
        }
        // UNVERIFIED / MALFORMED_STRUCTURE: silent (catalog predates W32
        // hashing for this plugin, or someone dropped loose files under
        // plugins/ — neither is actionable for doctor).
    }

    const summary: DoctorCheck = {
        id: "plugins.hashes_verified",
        category: "plugins",
        severity: tamperedFindings.length > 0 || uncataloguedPlugins.length > 0
            ? "warning" : "info",
        ok: true,
        label: `${verified} verified, ${tamperedFindings.length} tampered, ${uncataloguedPlugins.length} uncatalogued`,
        data: {
            verified,
            tampered: tamperedFindings.length,
            uncatalogued: uncataloguedPlugins.length,
        },
    };
    summary.ok = okFromSeverity(summary.severity);

    const findings: DoctorCheck[] = [summary, ...tamperedFindings];
    if (uncataloguedPlugins.length > 0) {
        // 90 §1: third-party / uncatalogued plugins produce `info`
        // severity, not `warning`. We don't want to nag every niche
        // community plugin.
        findings.push({
            id: "plugins.uncatalogued",
            category: "plugins",
            severity: "info",
            ok: true,
            label: `${uncataloguedPlugins.length} uncatalogued plugin(s) installed`,
            detail: uncataloguedPlugins.sort().join(", "),
            data: { plugins: uncataloguedPlugins.sort() },
        });
    }
    return findings;
}

/** C10: scan `.kindly/in-progress/` for markers left by a SIGKILL'd apply
 *  / setup-import / rollback. Each surviving marker means the device may
 *  be consistent on disk but history.jsonl is missing the entry — no
 *  audit trail and rollback can't see the change. One warning per marker
 *  so the user can correlate by pid/timestamp/cmd. */
function runProgressChecks(env: CliEnv): DoctorCheck[] {
    const dir = inProgressDir(env.cwd);
    if (!exists(dir, "derived-from-cwd")) return [];

    let entries: string[];
    try { entries = readdirSync(dir).filter((n) => n.endsWith(".json")); }
    catch { return []; }
    if (entries.length === 0) return [];

    const out: DoctorCheck[] = [];
    for (const name of entries.sort()) {
        const path = join(dir, name);
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(readText(path, "derived-from-cwd")) as Record<string, unknown>;
        } catch {
            // Malformed marker — surface anyway so the user knows to clean it up.
        }
        const cmd = typeof payload.cmd === "string" ? payload.cmd : "unknown";
        const pid = typeof payload.pid === "number" ? payload.pid : null;
        const startedAt = typeof payload.started_at === "string" ? payload.started_at : null;
        const ageDays = startedAt ? daysSince(startedAt, env.now?.() ?? new Date()) : null;
        out.push({
            id: "progress.crashed_apply",
            category: "progress",
            severity: "warning",
            ok: true,
            label: `crashed ${cmd} marker from pid ${pid ?? "?"}`
                + (ageDays !== null ? ` (${ageDays}d ago)` : ""),
            detail: `Surviving marker at ${path} — the operation died before history.jsonl recorded it. The device's settings.reader.lua may be the post-write content, but kindly has no audit entry for this change.`,
            data: { marker_path: path, ...payload },
            remediation: [
                { text: "Inspect the marker and the device's current settings.reader.lua to decide whether to keep, rollback, or re-apply." },
                { text: "Once resolved, delete the marker file to clear this warning.", command: `rm ${path}` },
            ],
        });
    }
    return out;
}

/** 90 §5.6 thresholds. 1 MiB = atomic write would fail; 50 MiB = a fat
 *  Setup import could fail. Not spec scalars, but named explicitly in §5.6. */
const DISK_FATAL_BYTES = 1 * 1024 * 1024;
const DISK_WARN_BYTES = 50 * 1024 * 1024;
const BACKUPS_WARN_BYTES = 100 * 1024 * 1024;
const BACKUPS_WARN_FILES = 100;

/** W34d 90 §5.6. Three findings covering writable `.kindly/`, device
 *  free space, and accumulated backup size on the host. All failures
 *  here are loud but scoped — doctor never mutates state (so a missing
 *  `.kindly/` is reported, not created). */
/** Threshold at which `gates.recent_bypasses` escalates to a warning.
 *  Bypasses under the threshold are surfaced as info. Tunable via
 *  observation — set low enough to catch routine misuse, high enough
 *  to avoid noise for power users who regularly pass --accept-sensitive
 *  during focused sessions. */
const GATE_BYPASS_WARN_THRESHOLD = 3;
const GATE_BYPASS_WINDOW_DAYS = 30;

function runGatesChecks(env: CliEnv): DoctorCheck[] {
    const out: DoctorCheck[] = [];

    // gates.registered — static inventory. Pulled from the gate registry
    // lazily to avoid loading the full gate graph eagerly at doctor time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { GATES } = require("../gates/registry.ts") as {
        GATES: ReadonlyArray<{ id: string; appliesAt: readonly ("import" | "apply")[] }>;
    };
    const importGates = GATES.filter((g) => g.appliesAt.includes("import")).map((g) => g.id);
    const applyGates = GATES.filter((g) => g.appliesAt.includes("apply")).map((g) => g.id);
    out.push({
        id: "gates.registered",
        category: "gates",
        severity: "info",
        ok: true,
        label: `${GATES.length} policy gate(s) registered (${importGates.length} import, ${applyGates.length} apply)`,
        data: {
            total: GATES.length,
            import: importGates,
            apply: applyGates,
        },
    });

    // gates.recent_bypasses — read the gate events log and count bypasses
    // within the last GATE_BYPASS_WINDOW_DAYS. Warning if above threshold.
    const gateLogFile = join(env.cwd, ".kindly", "gate-events.jsonl");
    let bypassCount = 0;
    let blockCount = 0;
    let malformed = 0;
    try {
        if (exists(gateLogFile, "derived-from-cwd")) {
            const raw = readText(gateLogFile, "derived-from-cwd");
            const cutoffMs = env.now().getTime() - GATE_BYPASS_WINDOW_DAYS * 86400_000;
            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                try {
                    const ev = JSON.parse(line) as { ts?: string; kind?: string };
                    const evMs = ev.ts ? new Date(ev.ts).getTime() : NaN;
                    if (Number.isNaN(evMs) || evMs < cutoffMs) continue;
                    if (ev.kind === "bypass") bypassCount++;
                    else if (ev.kind === "block") blockCount++;
                } catch {
                    malformed++;
                }
            }
        }
    } catch {
        // Unreadable log — don't fail doctor.
    }

    const bypassSeverity: DoctorSeverity =
        bypassCount > GATE_BYPASS_WARN_THRESHOLD ? "warning" : "info";
    out.push({
        id: "gates.recent_bypasses",
        category: "gates",
        severity: bypassSeverity,
        ok: true,
        label:
            bypassCount === 0
                ? `no policy bypasses in last ${GATE_BYPASS_WINDOW_DAYS}d`
                : `${bypassCount} policy bypass(es) in last ${GATE_BYPASS_WINDOW_DAYS}d`
                  + (bypassSeverity === "warning" ? " — review whether each was intentional" : ""),
        data: {
            bypass_count: bypassCount,
            block_count: blockCount,
            window_days: GATE_BYPASS_WINDOW_DAYS,
            threshold: GATE_BYPASS_WARN_THRESHOLD,
            malformed_lines: malformed,
        },
        ...(bypassSeverity === "warning"
            ? {
                remediation: [
                    { text: "Review .kindly/gate-events.jsonl — each bypass entry records which flag waived which gate." },
                    { text: "If the bypass cadence is expected (e.g. CI pipeline with --accept-sensitive), this warning is safe to ignore." },
                ],
            }
            : {}),
    });

    return out;
}

function runDiskChecks(env: CliEnv, mount: KindleMount): DoctorCheck[] {
    const out: DoctorCheck[] = [];
    const kindlyDir = join(env.cwd, ".kindly");

    // disk.kindly_writable: doctor is contractually read-only, so we
    // probe writability without creating `.kindly/` itself. If `.kindly`
    // exists, we mkdtempSync a sibling probe inside it (PID-collision
    // safe — closes S428) and immediately remove it. If `.kindly` does
    // NOT exist, we probe the cwd directly — the lazy `.kindly` creation
    // that other commands rely on will succeed iff cwd is writable.
    // This closes S426: doctor no longer mkdir's `.kindly/` as a side
    // effect of running.
    let writable = false;
    let writableDetail: string | undefined;
    const probeRoot = exists(kindlyDir, "derived-from-cwd") ? kindlyDir : env.cwd;
    try {
        const probe = mkdtempSync(join(probeRoot, ".doctor-probe-"));
        try { rmSync(probe, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
        writable = true;
    } catch (e) {
        writableDetail = `not writable: ${(e as Error).message}`;
    }
    out.push({
        id: "disk.kindly_writable",
        category: "disk",
        severity: writable ? "info" : "fatal",
        ok: writable,
        label: writable
            ? `.kindly/ writable at ${kindlyDir}`
            : `.kindly/ not writable at ${kindlyDir}`,
        ...(writableDetail ? { detail: writableDetail } : {}),
        data: { path: kindlyDir, writable },
        ...(writable ? {} : {
            remediation: [{
                text: "Ensure the current working directory is writable, or run kindly from a directory you own.",
            }],
        }),
    });

    // disk.free_space: device free space, not host. Apply writes to the
    // mount, so the relevant number is mount.root's filesystem. statfs
    // on any path resolves to its containing filesystem.
    let bytesFree: number | null = null;
    try {
        const st = statfsSync(mount.root);
        bytesFree = Number(st.bavail) * Number(st.bsize);
    } catch {
        // Unreadable free space — emit an info finding rather than fatal;
        // this doesn't block apply, atomic rename will surface EIO first.
    }
    if (bytesFree === null) {
        out.push({
            id: "disk.free_space",
            category: "disk",
            severity: "info",
            ok: true,
            label: "device free space unreadable",
            data: { bytes_free: null, bytes_needed_for_apply: null },
        });
    } else {
        const sev: DoctorSeverity =
            bytesFree < DISK_FATAL_BYTES ? "fatal"
            : bytesFree < DISK_WARN_BYTES ? "warning"
            : "info";
        out.push({
            id: "disk.free_space",
            category: "disk",
            severity: sev,
            ok: sev === "info" || sev === "warning",
            label: `device free space: ${formatBytes(bytesFree)}`,
            data: { bytes_free: bytesFree, bytes_needed_for_apply: null },
            ...(sev !== "info" ? {
                remediation: [{
                    text: "Free space on the device (delete old books or snapshots) before running apply.",
                }],
            } : {}),
        });
    }

    // disk.mount_writable (S1397): apply writes settings.reader.lua via
    // safeWrite's atomic rename pipeline; if the mount is read-only or
    // out of inodes, the failure surfaces deep in step-3 with EROFS or
    // ENOSPC and a half-written .tmp left behind. Catch it up front by
    // probing with mkdtempSync inside the koreader directory (a place
    // we'd write to anyway) and removing the probe immediately. Fatal
    // if the probe fails — apply will not succeed.
    let mountWritable = false;
    let mountWritableDetail: string | undefined;
    try {
        const probe = mkdtempSync(join(mount.koreaderRoot, ".doctor-mw-"));
        try { rmSync(probe, { recursive: true, force: true }); } catch { /* best-effort */ }
        mountWritable = true;
    } catch (e) {
        mountWritableDetail = (e as Error).message;
    }
    out.push({
        id: "disk.mount_writable",
        category: "disk",
        severity: mountWritable ? "info" : "fatal",
        ok: mountWritable,
        label: mountWritable
            ? `mount writable at ${mount.koreaderRoot}`
            : `mount NOT writable at ${mount.koreaderRoot}`,
        ...(mountWritableDetail ? { detail: mountWritableDetail } : {}),
        data: { path: mount.koreaderRoot, writable: mountWritable },
        ...(mountWritable ? {} : {
            remediation: [
                { text: "Re-mount the device read-write, or check that it isn't being held by another process." },
                { text: "On Kindle hardware, ensure the device is fully connected over USB and not in `Restart` mode." },
            ],
        }),
    });

    // disk.backups_size: additive .kindly/backups/ — F9 from 87. Loud
    // advisory until W34h rotation lands.
    const backupsDir = join(kindlyDir, "backups");
    let bytes = 0;
    let fileCount = 0;
    if (exists(backupsDir, "derived-from-cwd")) {
        for (const f of walkFiles(backupsDir)) {
            try {
                bytes += statFollow(f, "derived-from-cwd").size;
                fileCount++;
            } catch { /* skip unreadable */ }
        }
    }
    let oldestIso = "";
    if (exists(backupsDir, "derived-from-cwd")) {
        try {
            const entries = readdirSync(backupsDir).sort();
            oldestIso = entries[0] ?? "";
        } catch { /* ignore */ }
    }
    const backupsSev: DoctorSeverity =
        (bytes > BACKUPS_WARN_BYTES || fileCount > BACKUPS_WARN_FILES)
            ? "warning" : "info";
    out.push({
        id: "disk.backups_size",
        category: "disk",
        severity: backupsSev,
        ok: true,
        label: `.kindly/backups/: ${formatBytes(bytes)} across ${fileCount} file(s)`,
        data: { bytes, file_count: fileCount, oldest_iso: oldestIso },
        ...(backupsSev === "warning" ? {
            remediation: [{
                text: "No automatic rotation ships yet (W34h pending). Delete old snapshots under .kindly/backups/ to reclaim space.",
            }],
        } : {}),
    });

    for (const c of out) c.ok = okFromSeverity(c.severity);
    return out;
}

function* walkFiles(dir: string): Generator<string> {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walkFiles(p);
        else if (e.isFile()) yield p;
    }
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function finalize(checks: DoctorCheck[], secretsPresent: string[]): DoctorResult {
    // Back-compat: guarantee `ok` matches severity even if a caller
    // hand-built the check (no way to get out-of-sync by construction
    // here, but cheap to enforce).
    for (const c of checks) c.ok = okFromSeverity(c.severity);
    // 90 §4.2 ordering: (severity desc, category asc, id asc).
    checks.sort((a, b) => {
        const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (s !== 0) return s;
        const c = a.category.localeCompare(b.category);
        if (c !== 0) return c;
        return a.id.localeCompare(b.id);
    });
    const ok = !checks.some((c) => c.severity === "fatal" || c.severity === "error");
    return { checks, secretsPresent, ok };
}

function findSecrets(data: Record<string, LuaValue>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(data)) {
        if (classifyKey(k) === "SECRET") out.push(k);
        if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) {
            for (const ck of Object.keys(v as Record<string, unknown>)) {
                if (isSecretPath(k, ck)) out.push(`${k}.${ck}`);
            }
        }
    }
    return out.sort();
}
