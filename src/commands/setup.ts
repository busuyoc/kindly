// `kindly setup <subcommand>` — create and manage shareable Setups.
//
// v0.3 ships: export (this file). inspect / list / hash / import land in
// later steps; the dispatcher here stays small so adding them is a
// one-case-in-the-switch change.
//
// See docs/50-v0.3-setups.md for the data model and philosophy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { filterForYaml } from "../schema/classify.ts";
import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, ok } from "../cli/log.ts";
import { canonicalizeManifest, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest } from "../setup/schema.ts";

// ---- `kindly setup export` -------------------------------------------------

const EXPORT_FLAGS = {
    output: {
        type: "string",
        description: "where to write the .kset.yaml (default: ~/.kindly/setups/<id>-<slug>.kset.yaml)",
    },
    keys: {
        type: "string",
        description: "comma-separated settings keys to include (default: all non-secret non-ephemeral)",
    },
    "apply-mode": {
        type: "string",
        default: "additive",
        description: "'additive' (merge into existing) or 'replace' (wipe non-declared first)",
    },
    description: {
        type: "string",
        description: "human-readable description of what this Setup does",
    },
    author: {
        type: "string",
        description: "author label (free text, not verified)",
    },
    tags: {
        type: "string",
        description: "comma-separated tag list",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    force: {
        type: "boolean",
        default: false,
        description: "overwrite output if it already exists",
    },
} as const satisfies FlagSpecs;

async function runSetupExport(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, EXPORT_FLAGS);

    const name = positional[0];
    if (!name) {
        throw new ArgError("usage: kindly setup export <name> [options]");
    }
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    if (flags["apply-mode"] !== "additive" && flags["apply-mode"] !== "replace") {
        throw new ArgError(
            `--apply-mode must be 'additive' or 'replace' (got ${JSON.stringify(flags["apply-mode"])})`
        );
    }

    if (flags.mount) env = { ...env, mountOverride: flags.mount };
    const mount = resolveMount(env);

    if (!existsSync(mount.settingsPath)) {
        throw new Error(
            `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`
        );
    }

    info(env, dim(env, `reading ${mount.settingsPath}`));
    const raw = readFileSync(mount.settingsPath, "utf8");
    const parsed = parseSettingsFile(raw) as Record<string, LuaValue>;

    // Always filter in minimal mode for exported Setups — ephemerals
    // (`lastfile`, migration markers) are personal state that wouldn't make
    // sense in a shared Setup. Secrets are ALWAYS filtered regardless.
    const { kept, droppedSecrets, droppedEphemerals } = filterForYaml(parsed, "minimal");

    // Cherry-pick if --keys was passed. Warn per missing key, don't fail.
    let settings: Record<string, LuaValue> = kept as Record<string, LuaValue>;
    const keysList = parseCsv(flags.keys);
    let skippedKeys = 0;
    if (keysList.length > 0) {
        const picked: Record<string, LuaValue> = {};
        for (const k of keysList) {
            if (k in kept) picked[k] = kept[k] as LuaValue;
            else skippedKeys++;
        }
        settings = picked;
    }

    // Lift KOReader's `plugins_disabled = { name = true, ... }` into
    // manifest.plugins.disabled. Better data shape for UI/diff; trivially
    // reversed on import.
    const { pluginsDisabled, settingsMinusPlugins } = liftPluginsDisabled(settings);

    // Build + validate the manifest in one shot. If this throws, the bug is
    // in our construction logic (validated inputs should always pass).
    const manifest = parseManifest({
        kindly_setup: "v1",
        meta: {
            name,
            ...(flags.author ? { author: flags.author } : {}),
            ...(flags.description ? { description: flags.description } : {}),
            created_at: env.now().toISOString(),
            ...(parseCsv(flags.tags).length > 0 ? { tags: parseCsv(flags.tags) } : {}),
        },
        apply_mode: flags["apply-mode"],
        ...(Object.keys(settingsMinusPlugins).length > 0 ? { settings: settingsMinusPlugins } : {}),
        ...(pluginsDisabled.length > 0 ? { plugins: { disabled: pluginsDisabled } } : {}),
    });

    const canonical = canonicalizeManifest(manifest);
    const id = shortId(manifest);

    const outPath = flags.output
        ? resolve(env.cwd, flags.output)
        : defaultOutputPath(id, name);

    if (existsSync(outPath) && !flags.force) {
        throw new Error(
            `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`
        );
    }

    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, canonical);

    ok(env, `exported setup ${id} → ${outPath}`);
    info(env, dim(env,
        `  ${Buffer.byteLength(canonical)} bytes, ` +
        `${Object.keys(settingsMinusPlugins).length} settings, ` +
        `${pluginsDisabled.length} plugin toggle(s)`
    ));
    info(env, dim(env, `  hash: ${manifestHash(manifest)}`));

    if (droppedSecrets.length > 0) {
        info(env, dim(env, `  filtered ${droppedSecrets.length} secret(s) (never in shared Setups)`));
    }
    if (droppedEphemerals.length > 0) {
        info(env, dim(env, `  filtered ${droppedEphemerals.length} ephemeral(s) (personal state, not shareable)`));
    }
    if (skippedKeys > 0) {
        info(env, dim(env, `  ${skippedKeys} --keys entr(ies) not found on device or filtered; skipped`));
    }

    return 0;
}

// ---- helpers ---------------------------------------------------------------

function parseCsv(s: string | undefined): string[] {
    if (!s) return [];
    return s.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
}

// `plugins_disabled = { SSH = true, calibre = true }` → ["SSH", "calibre"].
// Values other than literal `true` are ignored; the manifest only encodes
// "this plugin is off," not tri-state. On import this reverses into the
// same on-device shape.
function liftPluginsDisabled(settings: Record<string, LuaValue>): {
    pluginsDisabled: string[];
    settingsMinusPlugins: Record<string, LuaValue>;
} {
    const pd = settings.plugins_disabled;
    if (pd == null || typeof pd !== "object" || Array.isArray(pd)) {
        return { pluginsDisabled: [], settingsMinusPlugins: settings };
    }
    const rest = { ...settings };
    delete rest.plugins_disabled;
    const disabled = Object.entries(pd as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .sort();
    return { pluginsDisabled: disabled, settingsMinusPlugins: rest };
}

function slugify(s: string): string {
    const slug = s.toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return slug || "setup";
}

function defaultOutputPath(id: string, name: string): string {
    return join(homedir(), ".kindly", "setups", `${id}-${slugify(name)}.kset.yaml`);
}

// ---- dispatcher ------------------------------------------------------------

export async function runSetup(argv: readonly string[], env: CliEnv): Promise<number> {
    const [sub, ...rest] = argv;

    // `kindly setup` (no sub) or `kindly setup --help` → top-level setup help.
    if (!sub || sub === "--help" || sub === "-h") {
        env.stdout.write(setupHelp + "\n");
        return 0;
    }

    // `kindly setup <sub> --help` → subcommand help.
    if (rest[0] === "--help" || rest[0] === "-h") {
        switch (sub) {
            case "export": env.stdout.write(exportHelp + "\n"); return 0;
            default: break; // fall through — unknown sub yields below
        }
    }

    switch (sub) {
        case "export":
            return await runSetupExport(rest, env);
        default:
            throw new ArgError(`unknown setup subcommand: ${sub}`);
    }
}

export const setupHelp = `
kindly setup — create and manage shareable Setups.

usage: kindly setup <subcommand> [options]

Subcommands:
  export <name>   scan device → write a canonical Setup manifest

Run \`kindly setup <sub> --help\` for per-subcommand flags.

A Setup is a curated, metadata-rich, content-hashed manifest that
describes a named configuration — distinct from kindly.yaml (personal
working copy). See docs/50-v0.3-setups.md.
`.trim();

const exportHelp = `
kindly setup export <name> — scan device, filter, write a canonical Setup manifest.

usage: kindly setup export <name> [options]

  --output <path>       default: ~/.kindly/setups/<id>-<slug>.kset.yaml
  --keys <k1,k2,...>    cherry-pick specific settings keys (default: all)
  --apply-mode <mode>   additive (default) | replace
  --description <text>  human-readable description
  --author <name>       author label (free text, not verified)
  --tags <t1,t2,...>    comma-separated tag list
  --mount <path>        path to a mounted Kindle (auto-detect by default)
  --force               overwrite output if it exists

Secrets (PIN, passwords, device IDs, phone numbers) are ALWAYS filtered.
Ephemerals (lastfile, migration markers) are always filtered — shared
Setups represent a configuration, not your device's current state.
`.trim();
