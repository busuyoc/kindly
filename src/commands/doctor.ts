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
import { dim, info, ok, paint, warn } from "../cli/log.ts";
import type {
    DoctorResult, DoctorCheck, DoctorSeverity, DoctorRepairResult,
} from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { executeDoctor } from "../lib/doctor.ts";
import { executeDoctorRepair } from "../lib/doctorRepair.ts";

export { executeDoctor };

const FLAGS = {
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    repair: {
        type: "boolean",
        default: false,
        description:
            "recover from an interrupted apply (.old survives, main absent) " +
            "and sweep orphan settings.reader.lua.tmp.* files. Mutating.",
    },
    "dry-run": {
        type: "boolean",
        default: false,
        description: "with --repair, report what would change without writing",
    },
    "force-mount": {
        type: "boolean",
        default: false,
        description:
            "with --repair, proceed even if an in-progress marker's " +
            "fingerprint differs from the currently-attached Kindle",
    },
    "promote-tmp": {
        type: "boolean",
        default: false,
        description:
            "with --repair, opt in to promoting a hash-matching .tmp file " +
            "to settings.reader.lua. Off by default — both the marker and " +
            "the .tmp live in attacker-writable directories, so blind " +
            "promotion is a privesc primitive. Prefer re-running apply " +
            "(deterministic from the same YAML) over passing this flag.",
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

    if (flags.repair) {
        const result = executeDoctorRepair({
            dryRun: flags["dry-run"],
            forceMount: flags["force-mount"],
            promoteTmp: flags["promote-tmp"],
        }, env);
        if (env.jsonMode) emitJson(env, "doctor:repair", result);
        else renderDoctorRepair(result, env);
        return 0;
    }

    const result = executeDoctor(env);
    if (env.jsonMode) emitJson(env, "doctor", result);
    else renderDoctor(result, env);
    if (!result.ok) return 1;
    const hasWarnings = result.checks.some((c) => c.severity === "warning");
    return hasWarnings ? 4 : 0;
}

export function renderDoctorRepair(result: DoctorRepairResult, env: CliEnv): void {
    if (result.mode === "no-op") {
        info(env, "doctor --repair: nothing to recover.");
        return;
    }

    const verb = result.mode === "dry-run" ? "would " : "";

    switch (result.settingsRecovery) {
        case "promoted-tmp":
            ok(env, `${verb}promote a hash-matching .tmp to ${result.settingsPath}`);
            info(env, dim(env, "  the interrupted apply's intended bytes — completing the write."));
            break;
        case "restored-old":
            ok(env, `${verb}restore ${result.settingsPath}.old back to ${result.settingsPath}`);
            info(env, dim(env, "  the interrupted apply is undone — device returns to the prior state."));
            break;
        case "none":
            // No step-4 recovery, but we may still have swept tmps / cleared markers.
            break;
    }

    if (result.sweptTmps.length > 0) {
        ok(env, `${verb}remove ${result.sweptTmps.length} orphan .tmp file(s):`);
        for (const t of result.sweptTmps.slice(0, 8)) info(env, dim(env, `    ${t}`));
        if (result.sweptTmps.length > 8) {
            info(env, dim(env, `    ... and ${result.sweptTmps.length - 8} more`));
        }
    }
    if (result.clearedMarkers.length > 0) {
        ok(env, `${verb}clear ${result.clearedMarkers.length} in-progress marker(s)`);
    }

    if (result.mode === "dry-run") {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
    } else {
        warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
    }
}

export const doctorHelp = `
kindly doctor — check that kindly can read and trust the device's state.

usage: kindly doctor [--mount <path>]
       kindly doctor --repair [--dry-run] [--force-mount] [--promote-tmp]
                              [--mount <path>]

Read-only by default. Emits findings grouped by category (mount, settings,
schema, catalog, plugins, disk, secrets) — see 90-w34-doctor-output-spec.md.

Each finding carries one of four severities:
  ● fatal    kindly cannot operate (mount missing, settings unreadable)
  ✗ error    concrete integrity breach (tampered plugin code)
  ⚠ warning  drift / staleness / best-effort failure
  ✓ info     passing check, or advisory reporting

Exit codes:
  1 — at least one fatal or error finding
  4 — at least one warning (no fatal/error)
  0 — all info, no findings above info severity

Also lists on-device secret keys (passwords, PINs) that kindly won't sync,
so you can rescue them to a password manager before a factory reset.

--repair (mutating)
  Recover from a SIGKILL'd \`kindly apply\` / \`kindly setup import\`:
    - if settings.reader.lua is missing but .old survives, restore .old;
    - sweep orphan settings.reader.lua.tmp.<pid>.<rand> files in the
      koreader/ dir;
    - clear processed in-progress markers under .kindly/in-progress/.
  Refuses to act if any in-progress marker's mount fingerprint differs
  from the currently-attached Kindle (override with --force-mount).
  Pair with --dry-run to preview.

  --promote-tmp opts in to a riskier recovery: if a hash-matching .tmp
  is present, kindly promotes it to settings.reader.lua. The marker
  and .tmp both live in attacker-writable directories, so a forged
  pair would land arbitrary bytes onto the device. Off by default.
  Prefer re-running \`kindly apply <yaml>\` — same YAML reproduces the
  same intended bytes deterministically.
`.trim();
