// `kindly doctor` — sanity-check the on-device state. Read-only.
//
// Each check returns a line like "✓ KOReader found at /Volumes/Kindle/koreader"
// or "✗ settings.reader.lua missing — is KOReader installed?". Exit 0 on all
// pass, 1 if any fail.
//
// Checks (in order):
//   - Kindle mount detected
//   - settings.reader.lua present + readable
//   - settings.reader.lua parseable (no mid-file corruption)
//   - .old sibling exists and is parseable (KOReader's own fallback)
//
// Plus a list of on-device secret keys the user needs to rescue to a
// password manager before a factory reset (doctor is transparent about
// what kindly isn't tracking).
//
// Shape: executeDoctor() runs the checks and returns DoctorResult;
// renderDoctor() prints; runDoctor() glues argv + exit code.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, paint } from "../cli/log.ts";
import { parseSettingsFile, LuaParseError } from "../lua/reader.ts";
import { classifyKey, isSecretPath } from "../schema/classify.ts";
import type { LuaValue } from "../lua/writer.ts";
import type { DoctorResult, DoctorCheck } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";

const FLAGS = {
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

// Run all checks. Never throws — every failure is represented as an
// { ok: false } check so consumers (JSON, GUI) see the same shape on
// every invocation.
export function executeDoctor(env: CliEnv): DoctorResult {
    const checks: DoctorCheck[] = [];

    let mount;
    try {
        mount = resolveMount(env);
        checks.push({ id: "mount", ok: true, label: `Kindle mount: ${mount.root}` });
    } catch (e) {
        checks.push({
            id: "mount",
            ok: false,
            label: "Kindle mount",
            detail: (e as Error).message,
        });
        return { checks, secretsPresent: [], ok: false };
    }

    const settingsPath = mount.settingsPath;
    if (!existsSync(settingsPath)) {
        checks.push({
            id: "settings_present",
            ok: false,
            label: "settings.reader.lua present",
            detail: `${settingsPath} not found — is KOReader installed?`,
        });
        return { checks, secretsPresent: [], ok: false };
    }
    checks.push({
        id: "settings_present",
        ok: true,
        label: `settings.reader.lua: ${settingsPath}`,
    });

    let parsed: Record<string, LuaValue>;
    try {
        parsed = parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, LuaValue>;
        const keyCount = Object.keys(parsed).length;
        checks.push({
            id: "settings_parseable",
            ok: true,
            label: `settings.reader.lua parseable (${keyCount} keys)`,
        });
    } catch (e) {
        const detail = e instanceof LuaParseError ? e.message : (e as Error).message;
        checks.push({
            id: "settings_parseable",
            ok: false,
            label: "settings.reader.lua parseable",
            detail,
        });
        return { checks, secretsPresent: [], ok: false };
    }

    // Check .old sibling — it's KOReader's own recovery point and is only
    // informational for us, but a corrupt .old means KOReader has nothing
    // to fall back to if a crash hits mid-write.
    const oldPath = settingsPath + ".old";
    if (existsSync(oldPath)) {
        try {
            parseSettingsFile(readFileSync(oldPath, "utf8"));
            checks.push({
                id: "old_parseable",
                ok: true,
                label: "settings.reader.lua.old parseable (KOReader fallback)",
            });
        } catch (e) {
            checks.push({
                id: "old_parseable",
                ok: false,
                label: "settings.reader.lua.old parseable",
                detail: `KOReader's fallback copy is corrupt: ${(e as Error).message}`,
            });
        }
    } else {
        checks.push({
            id: "old_parseable",
            ok: true,
            label: "settings.reader.lua.old",
            detail: "absent (fine — KOReader creates it on first flush)",
        });
    }

    const secretsPresent = findSecrets(parsed);
    const allOk = checks.every((c) => c.ok);
    return { checks, secretsPresent, ok: allOk };
}

export function renderDoctor(result: DoctorResult, env: CliEnv): void {
    for (const c of result.checks) {
        const mark = c.ok ? paint(env, "green", "✓") : paint(env, "red", "✗");
        let line = `${mark} ${c.label}`;
        if (c.detail) line += "  " + dim(env, c.detail);
        info(env, line);
    }

    // Only show the secrets section when the main checks got far enough
    // to have parsed the file. If the first check failed we bail early.
    if (result.checks.some((c) => c.id === "settings_parseable" && c.ok)) {
        info(env, "");
        if (result.secretsPresent.length > 0) {
            info(env, paint(env, "yellow",
                `! ${result.secretsPresent.length} secret key(s) on device — kindly won't track these:`));
            for (const k of result.secretsPresent) info(env, `    ${k}`);
            info(env, dim(env,
                "  Restore these via your password manager after a factory reset."));
        } else {
            info(env, paint(env, "green", "✓ no secret keys detected on device."));
        }
    }
}

export async function runDoctor(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeDoctor(env);
    if (env.jsonMode) emitJson(env, "doctor", result);
    else renderDoctor(result, env);
    return result.ok ? 0 : 1;
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

export const doctorHelp = `
kindly doctor — check that kindly can read the device's settings.

usage: kindly doctor [--mount <path>]

Read-only. Reports mount detection, file presence, parseability, KOReader's
.old fallback, and lists on-device secret keys that kindly won't sync.
`.trim();
