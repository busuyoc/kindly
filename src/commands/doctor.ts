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
// Pure logic lives in src/lib/doctor.ts; this module is the CLI adapter.

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, info, paint } from "../cli/log.ts";
import type { DoctorResult } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executeDoctor } from "../lib/doctor.ts";

export { executeDoctor };

const FLAGS = {
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

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

export const doctorHelp = `
kindly doctor — check that kindly can read the device's settings.

usage: kindly doctor [--mount <path>]

Read-only. Reports mount detection, file presence, parseability, KOReader's
.old fallback, and lists on-device secret keys that kindly won't sync.
`.trim();
