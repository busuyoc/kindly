// Library entry point for `doctor` — read-only sanity checks on the device.
// Pure: returns a typed result; never prints. Never throws — every failure
// is a { ok: false } check so consumers (JSON, GUI) see a consistent shape.

import { existsSync, readFileSync } from "node:fs";
import { parseSettingsFile, LuaParseError } from "../lua/reader.ts";
import { classifyKey, isSecretPath } from "../schema/classify.ts";
import type { LuaValue } from "../lua/writer.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { DoctorResult, DoctorCheck } from "../types/results.ts";

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
