// Library entry point for `doctor` — read-only sanity checks on the device.
// Pure: returns a typed result; never prints. Never throws — every failure
// is a finding in `checks` so consumers (JSON, GUI) see a consistent shape.
//
// Severity model follows 90 §2. Legacy check ids (`mount`,
// `settings_present`, `settings_parseable`, `old_parseable`) are
// grandfathered per 90 §7 "never rename an id".

import { existsSync, readFileSync } from "node:fs";
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
    if (!existsSync(settingsPath)) {
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
        parsed = parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, LuaValue>;
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
    if (existsSync(oldPath)) {
        try {
            parseSettingsFile(readFileSync(oldPath, "utf8"));
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

    // W34c: schema.* freshness + uncurated keys (90 §5.1, §5.2).
    checks.push(...runSchemaChecks(env, parsed, opts.schemaPath));

    // W34c: catalog.* freshness + version-match (90 §5.3).
    checks.push(...runCatalogChecks(env, mount, opts.catalogPath));

    // W34b: plugins.* findings (90 §5.4, §5.5). Walk the on-device
    // plugins dir, verify against the catalog in "full" mode (doctor
    // wants missing files reported, unlike import's subset mode).
    checks.push(...runPluginHashChecks(mount.pluginsDir, opts.catalogPath));

    return finalize(checks, findSecrets(parsed));
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
