// `kindly doctor` — sanity-check the on-device state. Read-only.
//
// Findings carry a severity (fatal | error | warning | info) and a
// category; see 90-w34-doctor-output-spec.md for the full model. Exit
// policy: fatal or error → 1, warning/info alone → 0.
//
// Categories currently reported:
//   - mount:    device detection
//   - settings: settings.reader.lua present / parseable / .old fallback
//   - schema:   curated-schema freshness + device-key drift (90 §5.1-§5.2)
//   - catalog:  plugin-catalog freshness + KOReader-version match (§5.3)
//   - plugins:  W32 hash verification — tampered files and uncatalogued
//               plugins (§5.4-§5.5)
//   - disk:     .kindly/ writable, device free space, backups size (§5.6)
//   - secrets:  on-device secret inventory count (§5.7)
//
// The full sorted list of secret keys (for rescue into a password
// manager before a factory reset) stays in DoctorResult.secretsPresent
// and is rendered after the category groups.
//
// Pure logic lives in src/lib/doctor.ts; this module is the CLI adapter.

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, info, paint } from "../cli/log.ts";
import type { DoctorResult, DoctorCheck, DoctorSeverity } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executeDoctor } from "../lib/doctor.ts";

export { executeDoctor };

const FLAGS = {
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

function severityMark(env: CliEnv, s: DoctorSeverity): string {
    switch (s) {
        case "fatal":   return paint(env, "red",    "●");
        case "error":   return paint(env, "red",    "✗");
        case "warning": return paint(env, "yellow", "⚠");
        case "info":    return paint(env, "green",  "✓");
    }
}

export function renderDoctor(result: DoctorResult, env: CliEnv): void {
    // 90 §6.1: group by category, header only when ≥ 1 finding. Checks
    // already arrive in (severity desc, category asc, id asc) order.
    const byCategory = new Map<string, DoctorCheck[]>();
    for (const c of result.checks) {
        const arr = byCategory.get(c.category) ?? [];
        arr.push(c);
        byCategory.set(c.category, arr);
    }

    let first = true;
    for (const [cat, arr] of byCategory) {
        if (!first) info(env, "");
        first = false;
        info(env, cat);
        for (const c of arr) {
            let line = `  ${severityMark(env, c.severity)} ${c.label}`;
            if (c.detail) line += "  " + dim(env, c.detail);
            info(env, line);
            for (const r of c.remediation ?? []) {
                info(env, dim(env, `     ${r.text}`));
                if (r.command) info(env, dim(env, `     $ ${r.command}`));
            }
        }
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
kindly doctor — check that kindly can read and trust the device's state.

usage: kindly doctor [--mount <path>]

Read-only. Emits findings grouped by category (mount, settings, schema,
catalog, plugins, disk, secrets) — see 90-w34-doctor-output-spec.md.

Each finding carries one of four severities:
  ● fatal    kindly cannot operate (mount missing, settings unreadable)
  ✗ error    concrete integrity breach (tampered plugin code)
  ⚠ warning  drift / staleness / best-effort failure
  ✓ info     passing check, or advisory reporting

Exit 1 if any finding is fatal or error; exit 0 for warning or info only.

Also lists on-device secret keys (passwords, PINs) that kindly won't sync,
so you can rescue them to a password manager before a factory reset.
`.trim();
