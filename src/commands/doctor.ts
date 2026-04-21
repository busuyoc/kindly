// `kindly doctor` — sanity-check the on-device state. Read-only.
//
// Each check returns a line like "✓ KOReader found at /Volumes/Kindle/koreader"
// or "✗ settings.reader.lua missing — is KOReader installed?". Exit 0 on all
// pass, 1 if any fail.
//
// Checks (in order):
//   - Kindle mount detected
//   - koreader/ directory present
//   - settings.reader.lua readable
//   - settings.reader.lua parseable (no mid-file corruption)
//   - .old sibling exists and is parseable (KOReader's own fallback)
//   - list of secret keys present on-device (so user knows what they need
//     to rescue to a password manager before a factory reset)

import { existsSync, readFileSync } from "node:fs";
import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, paint } from "../cli/log.ts";
import { parseSettingsFile, LuaParseError } from "../lua/reader.ts";
import { classifyKey, isSecretPath } from "../schema/classify.ts";
import type { LuaValue } from "../lua/writer.ts";

const FLAGS = {
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

type Check = {
    ok: boolean;
    label: string;
    detail?: string;
};

export async function runDoctor(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const checks: Check[] = [];
    let mount;
    try {
        mount = resolveMount(env);
        checks.push({ ok: true, label: `Kindle mount: ${mount.root}` });
    } catch (e) {
        checks.push({ ok: false, label: "Kindle mount", detail: (e as Error).message });
        renderChecks(env, checks);
        return 1;
    }

    const settingsPath = mount.settingsPath;
    if (!existsSync(settingsPath)) {
        checks.push({
            ok: false,
            label: "settings.reader.lua present",
            detail: `${settingsPath} not found — is KOReader installed?`,
        });
        renderChecks(env, checks);
        return 1;
    }
    checks.push({ ok: true, label: `settings.reader.lua: ${settingsPath}` });

    // Parse the main file.
    let parsed: Record<string, LuaValue>;
    try {
        parsed = parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, LuaValue>;
        const keyCount = Object.keys(parsed).length;
        checks.push({ ok: true, label: `settings.reader.lua parseable (${keyCount} keys)` });
    } catch (e) {
        const detail = e instanceof LuaParseError ? e.message : (e as Error).message;
        checks.push({ ok: false, label: "settings.reader.lua parseable", detail });
        renderChecks(env, checks);
        return 1;
    }

    // Check .old sibling — it's KOReader's own recovery point and is only
    // informational for us, but a corrupt .old means KOReader has nothing
    // to fall back to if a crash hits mid-write.
    const oldPath = settingsPath + ".old";
    if (existsSync(oldPath)) {
        try {
            parseSettingsFile(readFileSync(oldPath, "utf8"));
            checks.push({ ok: true, label: "settings.reader.lua.old parseable (KOReader fallback)" });
        } catch (e) {
            checks.push({
                ok: false,
                label: "settings.reader.lua.old parseable",
                detail: `KOReader's fallback copy is corrupt: ${(e as Error).message}`,
            });
        }
    } else {
        checks.push({
            ok: true,
            label: "settings.reader.lua.old",
            detail: "absent (fine — KOReader creates it on first flush)",
        });
    }

    // List secrets present on-device so the user knows what they need to
    // preserve elsewhere. This is the whole point of doctor vs a silent
    // "kindly pull" — transparency about what kindly isn't tracking.
    const secretsPresent = findSecrets(parsed);
    renderChecks(env, checks);
    info(env, "");

    if (secretsPresent.length > 0) {
        info(env, paint(env, "yellow",
            `! ${secretsPresent.length} secret key(s) on device — kindly won't track these:`));
        for (const k of secretsPresent) info(env, `    ${k}`);
        info(env, dim(env,
            "  Restore these via your password manager after a factory reset."));
    } else {
        info(env, paint(env, "green", "✓ no secret keys detected on device."));
    }

    const anyFailed = checks.some((c) => !c.ok);
    return anyFailed ? 1 : 0;
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

function renderChecks(env: CliEnv, checks: Check[]): void {
    for (const c of checks) {
        const mark = c.ok ? paint(env, "green", "✓") : paint(env, "red", "✗");
        let line = `${mark} ${c.label}`;
        if (c.detail) line += "  " + dim(env, c.detail);
        info(env, line);
    }
}

export const doctorHelp = `
kindly doctor — check that kindly can read the device's settings.

usage: kindly doctor [--mount <path>]

Read-only. Reports mount detection, file presence, parseability, KOReader's
.old fallback, and lists on-device secret keys that kindly won't sync.
`.trim();
