// `kindly setup <subcommand>` — create and manage shareable Setups.
//
// v0.3 ships: export (this file). inspect / list / hash / import land in
// later steps; the dispatcher here stays small so adding them is a
// one-case-in-the-switch change.
//
// See docs/50-v0.3-setups.md for the data model and philosophy.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { filterForYaml } from "../schema/classify.ts";
import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount, resolveSetupsDir } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest, SetupSchemaError, type SetupManifest } from "../setup/schema.ts";

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
        : defaultOutputPath(env, id, name);

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

function defaultOutputPath(env: CliEnv, id: string, name: string): string {
    return join(resolveSetupsDir(env), `${id}-${slugify(name)}.kset.yaml`);
}

// Load a .kset.yaml file from disk, validate it, and return both the raw
// bytes (for hashing / canonical checks) and the validated manifest.
// Throws a user-readable error on missing file, bad YAML, or schema failure.
function loadManifestFile(path: string): { raw: string; manifest: SetupManifest } {
    if (!existsSync(path)) {
        throw new Error(`setup file not found: ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
        parsed = yamlParse(raw);
    } catch (e) {
        throw new Error(`${path} is not valid YAML: ${(e as Error).message}`);
    }
    try {
        const manifest = parseManifest(parsed);
        return { raw, manifest };
    } catch (e) {
        if (e instanceof SetupSchemaError) {
            throw new Error(`${path} is not a valid Setup manifest:\n${e.message}`);
        }
        throw e;
    }
}

// ---- `kindly setup inspect <file>` -----------------------------------------

async function runSetupInspect(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup inspect <file>");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    const path = resolve(env.cwd, fileArg);
    const { raw, manifest } = loadManifestFile(path);

    const rawHash = hashBytes(raw);
    const canonicalBytes = canonicalizeManifest(manifest);
    const isCanonical = raw === canonicalBytes;
    const id = shortId(rawHash);

    const settingsCount = manifest.settings ? Object.keys(manifest.settings).length : 0;
    const pluginsDisabled = manifest.plugins?.disabled?.length ?? 0;
    const pluginFiles = manifest.plugins?.files?.length ?? 0;
    const patches = manifest.patches?.length ?? 0;

    heading(env, `${manifest.meta.name}  (${id})`);
    env.stdout.write(`  hash:         ${rawHash}\n`);
    env.stdout.write(`  file:         ${path}\n`);
    env.stdout.write(`  bytes:        ${Buffer.byteLength(raw)}\n`);
    env.stdout.write(`  apply_mode:   ${manifest.apply_mode}\n`);
    env.stdout.write(`  created_at:   ${manifest.meta.created_at}\n`);
    if (manifest.meta.author)      env.stdout.write(`  author:       ${manifest.meta.author}\n`);
    if (manifest.meta.description) env.stdout.write(`  description:  ${manifest.meta.description}\n`);
    if (manifest.meta.tags?.length) env.stdout.write(`  tags:         ${manifest.meta.tags.join(", ")}\n`);
    if (manifest.compat) {
        env.stdout.write(`  compat:\n`);
        if (manifest.compat.koreader_version_min) env.stdout.write(`    koreader >= ${manifest.compat.koreader_version_min}\n`);
        if (manifest.compat.koreader_version_max) env.stdout.write(`    koreader <= ${manifest.compat.koreader_version_max}\n`);
        if (manifest.compat.device?.length)       env.stdout.write(`    device:    ${manifest.compat.device.join(", ")}\n`);
    }
    env.stdout.write(`  contents:\n`);
    env.stdout.write(`    settings:        ${settingsCount}\n`);
    env.stdout.write(`    plugins off:     ${pluginsDisabled}\n`);
    if (pluginFiles > 0) env.stdout.write(`    plugin files:    ${pluginFiles}  (fat setup)\n`);
    if (patches > 0)     env.stdout.write(`    patches:         ${patches}  (fat setup)\n`);

    if (!isCanonical) {
        warn(env, "file is not in canonical form — re-exporting would yield different bytes.");
        info(env, dim(env, `  (canonical hash would be ${manifestHash(manifest)})`));
    }

    return 0;
}

// ---- `kindly setup list` ---------------------------------------------------

async function runSetupList(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    const dir = resolveSetupsDir(env);
    if (!existsSync(dir)) {
        info(env, dim(env, `no setups found (${dir} does not exist yet)`));
        return 0;
    }

    const files = readdirSync(dir)
        .filter((f) => f.endsWith(".kset.yaml"))
        .map((f) => join(dir, f))
        .sort();

    if (files.length === 0) {
        info(env, dim(env, `no setups found in ${dir}`));
        return 0;
    }

    type Row = { id: string; name: string; created: string; bytes: number; mode: string; path: string };
    const rows: Row[] = [];
    const errors: { path: string; message: string }[] = [];
    for (const f of files) {
        try {
            const { raw, manifest } = loadManifestFile(f);
            rows.push({
                id: shortId(hashBytes(raw)),
                name: manifest.meta.name,
                created: manifest.meta.created_at,
                bytes: Buffer.byteLength(raw),
                mode: manifest.apply_mode,
                path: f,
            });
        } catch (e) {
            errors.push({ path: f, message: (e as Error).message });
        }
    }

    const header = ["ID", "NAME", "MODE", "CREATED", "BYTES"];
    const widths = [
        Math.max(header[0]!.length, ...rows.map((r) => r.id.length)),
        Math.max(header[1]!.length, ...rows.map((r) => r.name.length)),
        Math.max(header[2]!.length, ...rows.map((r) => r.mode.length)),
        Math.max(header[3]!.length, ...rows.map((r) => r.created.length)),
        Math.max(header[4]!.length, ...rows.map((r) => String(r.bytes).length)),
    ];
    const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
    env.stdout.write(dim(env,
        `${pad(header[0]!, widths[0]!)}  ${pad(header[1]!, widths[1]!)}  ${pad(header[2]!, widths[2]!)}  ${pad(header[3]!, widths[3]!)}  ${header[4]!}`
    ) + "\n");
    for (const r of rows) {
        env.stdout.write(
            `${pad(r.id, widths[0]!)}  ${pad(r.name, widths[1]!)}  ${pad(r.mode, widths[2]!)}  ${pad(r.created, widths[3]!)}  ${r.bytes}\n`
        );
    }

    for (const e of errors) {
        warn(env, `skipped ${e.path}: ${e.message.split("\n")[0]}`);
    }

    return 0;
}

// ---- `kindly setup hash <file>` --------------------------------------------

async function runSetupHash(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup hash <file>");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    const path = resolve(env.cwd, fileArg);
    const { raw, manifest } = loadManifestFile(path);

    const h = hashBytes(raw);
    env.stdout.write(h + "\n");

    const canonicalBytes = canonicalizeManifest(manifest);
    if (raw !== canonicalBytes) {
        warn(env, "file is not in canonical form — hash of raw bytes shown above.");
        info(env, dim(env, `  canonical-form hash would be: ${manifestHash(manifest)}`));
    }
    return 0;
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
            case "export":  env.stdout.write(exportHelp + "\n");  return 0;
            case "inspect": env.stdout.write(inspectHelp + "\n"); return 0;
            case "list":    env.stdout.write(listHelp + "\n");    return 0;
            case "hash":    env.stdout.write(hashHelp + "\n");    return 0;
            default: break; // fall through — unknown sub yields below
        }
    }

    switch (sub) {
        case "export":  return await runSetupExport(rest, env);
        case "inspect": return await runSetupInspect(rest, env);
        case "list":    return await runSetupList(rest, env);
        case "hash":    return await runSetupHash(rest, env);
        default:
            throw new ArgError(`unknown setup subcommand: ${sub}`);
    }
}

export const setupHelp = `
kindly setup — create and manage shareable Setups.

usage: kindly setup <subcommand> [options]

Subcommands:
  export <name>   scan device → write a canonical Setup manifest
  inspect <file>  print a manifest's summary (no device touch)
  list            list Setups in ~/.kindly/setups/
  hash <file>     print a Setup file's content hash

Run \`kindly setup <sub> --help\` for per-subcommand flags.

A Setup is a curated, metadata-rich, content-hashed manifest that
describes a named configuration — distinct from kindly.yaml (personal
working copy). See docs/50-v0.3-setups.md.
`.trim();

const inspectHelp = `
kindly setup inspect <file> — print a Setup manifest's summary.

usage: kindly setup inspect <file>

Reads and validates a .kset.yaml file; prints id, hash, metadata, and
content counts. Warns if the file is not in canonical form.
No device access.
`.trim();

const listHelp = `
kindly setup list — list Setups in ~/.kindly/setups/.

usage: kindly setup list

Scans the local setups directory and prints a one-row-per-file table
(id, name, apply mode, created_at, bytes). Invalid files are skipped
with a warning.
`.trim();

const hashHelp = `
kindly setup hash <file> — print a Setup file's content hash.

usage: kindly setup hash <file>

Hashes the raw bytes of the file — the bytes ARE the identity. If the
file isn't in canonical form, a warning also shows what the canonical
hash would be. Use for pinning or verifying shared Setups.
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
