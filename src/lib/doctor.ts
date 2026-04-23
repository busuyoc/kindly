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

const SEVERITY_RANK: Record<DoctorSeverity, number> = {
    fatal: 0, error: 1, warning: 2, info: 3,
};

/** Back-compat `ok` field — v0.5 consumers read this instead of severity. */
function okFromSeverity(s: DoctorSeverity): boolean {
    return s === "warning" || s === "info";
}

export function executeDoctor(env: CliEnv): DoctorResult {
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

    return finalize(checks, findSecrets(parsed));
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
