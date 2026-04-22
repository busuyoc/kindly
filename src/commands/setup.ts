// `kindly setup <subcommand>` — create and manage shareable Setups.
//
// See docs/50-v0.3-setups.md for the data model and philosophy.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parse as yamlParse } from "yaml";

import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile, type LuaTable, type LuaValue } from "../lua/writer.ts";
import { filterForYaml } from "../schema/classify.ts";
import { mergeYamlIntoLua, replaceYamlIntoLua } from "../schema/yaml.ts";
import { classifyKey } from "../schema/classify.ts";
import { computeChanges, computeReplaceChanges } from "../schema/diff.ts";
import { safeWrite } from "../fs/safeWrite.ts";
import { createTarGz } from "../fs/archive.ts";
import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount, resolveSetupsDir } from "../cli/env.ts";
import { dim, heading, info, ok, paint, warn } from "../cli/log.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest, SetupSchemaError, type EmbeddedFile, type SetupManifest } from "../setup/schema.ts";
import { packSetup } from "../setup/pack.ts";
import { unpackSetup } from "../setup/unpack.ts";
import { checkCompat, formatCompatIssue } from "../setup/compat.ts";
import { detectDeviceFamily, readKoreaderVersion } from "../device/version.ts";
import { loadSchema } from "../schema/settings.ts";
import { validateSettings, formatValidationReport, hasFindings, type ValidationReport } from "../schema/report.ts";
import {
    affectedPatchTargets, affectedPluginTargets,
    collectPatches, collectPluginDirs,
    installPatches, installPluginFiles,
    summarizePluginsByDir, totalBytes,
} from "../setup/files.ts";
import {
    getTemplate, listTemplates, templateKeyCount, type Template,
} from "../setup/templates.ts";

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
        description: "'additive' (merge into existing) or 'replace' (wipe non-declared first; default: additive, or the template's mode when --template is set)",
    },
    template: {
        type: "string",
        description: "build the manifest from a curated template instead of reading the device (see `kindly setup templates`)",
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
    "include-plugin-files": {
        type: "boolean",
        default: false,
        description: "pack .koplugin/ directories into the Setup (fat setup)",
    },
    "include-patches": {
        type: "boolean",
        default: false,
        description: "pack patches/*.lua files into the Setup (fat setup)",
    },
    "compat-koreader-min": {
        type: "string",
        description: "minimum KOReader version this Setup is known to work on (e.g. 2024.03)",
    },
    "compat-koreader-max": {
        type: "string",
        description: "maximum KOReader version this Setup is known to work on",
    },
    "compat-device": {
        type: "string",
        description: "comma-separated device ids this Setup targets (e.g. kindle-pw5,kindle-oasis3)",
    },
    strict: {
        type: "boolean",
        default: false,
        description: "fail (exit 1) if the settings block contains unknown keys or type mismatches against the KOReader schema",
    },
    "allow-unknown-keys": {
        type: "boolean",
        default: false,
        description: "suppress warnings for setting keys not in the KOReader schema (type mismatches still warn)",
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

    // --apply-mode: explicit CLI > template default > "additive". Template
    // resolution happens below; we validate the raw flag here and pick the
    // effective value once both sources are known.
    if (flags["apply-mode"] !== undefined
        && flags["apply-mode"] !== "additive"
        && flags["apply-mode"] !== "replace") {
        throw new ArgError(
            `--apply-mode must be 'additive' or 'replace' (got ${JSON.stringify(flags["apply-mode"])})`
        );
    }

    // Resolve template first; it decides whether we need a mount for
    // settings at all (templates bypass the device read).
    const template: Template | undefined = flags.template
        ? (getTemplate(flags.template) ?? throwUnknownTemplate(flags.template))
        : undefined;

    const effectiveApplyMode: "additive" | "replace" =
        (flags["apply-mode"] as "additive" | "replace" | undefined)
        ?? template?.apply_mode
        ?? "additive";

    // Mount is needed whenever we read settings from the device (no
    // template) OR when augmenting a template with fat content
    // (--include-plugin-files / --include-patches scan the live device).
    const needsMount = !template || flags["include-plugin-files"] || flags["include-patches"];
    const mount = needsMount
        ? (flags.mount ? resolveMount({ ...env, mountOverride: flags.mount }) : resolveMount(env))
        : null;

    if (mount && !existsSync(mount.settingsPath) && !template) {
        throw new Error(
            `Kindle mount found at ${mount.root}, but ${mount.settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`
        );
    }

    // Source of settings + plugins.disabled.
    //
    //   template set         → template's settings / plugins.disabled; no
    //                          device read for settings (fat augment still
    //                          reads the device below).
    //   template NOT set     → existing flow: read device, filter, lift
    //                          plugins_disabled.
    //
    // Secret filtering runs in both branches — templates shouldn't contain
    // secrets, but `filterForYaml` is cheap defense-in-depth against a
    // buggy template definition.
    let sourceSettings: Record<string, LuaValue>;
    let droppedSecrets: string[] = [];
    let droppedEphemerals: string[] = [];
    if (template) {
        info(env, dim(env, `using template: ${template.id}`));
        const templateSettings = { ...(template.settings ?? {}) } as Record<string, LuaValue>;
        if (template.plugins?.disabled && template.plugins.disabled.length > 0) {
            const pd: Record<string, LuaValue> = {};
            for (const name of template.plugins.disabled) pd[name] = true;
            templateSettings.plugins_disabled = pd;
        }
        const filtered = filterForYaml(templateSettings, "minimal");
        sourceSettings = filtered.kept as Record<string, LuaValue>;
        droppedSecrets = filtered.droppedSecrets;
        droppedEphemerals = filtered.droppedEphemerals;
    } else {
        info(env, dim(env, `reading ${mount!.settingsPath}`));
        const raw = readFileSync(mount!.settingsPath, "utf8");
        const parsed = parseSettingsFile(raw) as Record<string, LuaValue>;
        const filtered = filterForYaml(parsed, "minimal");
        sourceSettings = filtered.kept as Record<string, LuaValue>;
        droppedSecrets = filtered.droppedSecrets;
        droppedEphemerals = filtered.droppedEphemerals;
    }

    // Cherry-pick if --keys was passed. Warn per missing key, don't fail.
    let settings: Record<string, LuaValue> = sourceSettings;
    const keysList = parseCsv(flags.keys);
    let skippedKeys = 0;
    if (keysList.length > 0) {
        const picked: Record<string, LuaValue> = {};
        for (const k of keysList) {
            if (k in sourceSettings) picked[k] = sourceSettings[k] as LuaValue;
            else skippedKeys++;
        }
        settings = picked;
    }

    // Lift KOReader's `plugins_disabled = { name = true, ... }` into
    // manifest.plugins.disabled. Better data shape for UI/diff; trivially
    // reversed on import.
    const { pluginsDisabled, settingsMinusPlugins } = liftPluginsDisabled(settings);

    // Schema validation. Runs against the final settings shape that lands
    // in the manifest. Unknown keys are almost always typos (nightmode vs
    // night_mode) or plugin-scoped keys the schema doesn't know. Default
    // is warn + proceed; --strict fails; --allow-unknown-keys suppresses
    // unknown-key warnings (type mismatches always warn).
    const exportReport = validateSettings(settingsMinusPlugins as Record<string, unknown>, loadSchema());
    if (emitSchemaFindings(env, exportReport, { strict: flags.strict, allowUnknownKeys: flags["allow-unknown-keys"] })) {
        return 1;
    }

    // Fat collection — scan plugin dirs / patches if flagged. Empty
    // results are fine: the manifest just stays lean. Templates can be
    // fat-augmented: we use the live device's plugin/patch directories
    // regardless of whether settings came from a template.
    const collectedPlugins = flags["include-plugin-files"]
        ? collectPluginDirs(mount!.pluginsDir)
        : { declared: [] as EmbeddedFile[], files: new Map<string, Buffer>() };
    const collectedPatches = flags["include-patches"]
        ? collectPatches(mount!.patchesDir)
        : { declared: [] as EmbeddedFile[], files: new Map<string, Buffer>() };

    // Build + validate the manifest in one shot. If this throws, the bug is
    // in our construction logic (validated inputs should always pass).
    const pluginsBlock = buildPluginsBlock(pluginsDisabled, collectedPlugins.declared);
    const compatBlock = buildCompatBlock(
        flags["compat-koreader-min"],
        flags["compat-koreader-max"],
        parseCsv(flags["compat-device"]),
    );
    // Description precedence: CLI --description > template description > none.
    const effectiveDescription = flags.description ?? template?.description;

    const manifest = parseManifest({
        kindly_setup: "v1",
        meta: {
            name,
            ...(flags.author ? { author: flags.author } : {}),
            ...(effectiveDescription ? { description: effectiveDescription } : {}),
            created_at: env.now().toISOString(),
            ...(parseCsv(flags.tags).length > 0 ? { tags: parseCsv(flags.tags) } : {}),
        },
        ...(compatBlock ? { compat: compatBlock } : {}),
        apply_mode: effectiveApplyMode,
        ...(Object.keys(settingsMinusPlugins).length > 0 ? { settings: settingsMinusPlugins } : {}),
        ...(pluginsBlock ? { plugins: pluginsBlock } : {}),
        ...(collectedPatches.declared.length > 0 ? { patches: collectedPatches.declared } : {}),
    });

    const id = shortId(manifest);
    const isFat = collectedPlugins.declared.length > 0 || collectedPatches.declared.length > 0;

    const outPath = flags.output
        ? resolve(env.cwd, flags.output)
        : defaultOutputPath(env, id, name, isFat);

    if (existsSync(outPath) && !flags.force) {
        throw new Error(
            `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`
        );
    }

    const outDir = dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    let bytesWritten: number;
    if (isFat) {
        // Merge plugin + patch files into one Map for packSetup.
        const allFiles = new Map<string, Buffer>();
        for (const [k, v] of collectedPlugins.files) allFiles.set(k, v);
        for (const [k, v] of collectedPatches.files) allFiles.set(k, v);
        const r = packSetup({ manifest, files: allFiles }, outPath);
        bytesWritten = r.bytesWritten;
    } else {
        const canonical = canonicalizeManifest(manifest);
        writeFileSync(outPath, canonical);
        bytesWritten = Buffer.byteLength(canonical);
    }

    ok(env, `exported setup ${id} → ${outPath}`);
    const summary: string[] = [
        `${bytesWritten} bytes`,
        `${Object.keys(settingsMinusPlugins).length} settings`,
        `${pluginsDisabled.length} plugin toggle(s)`,
    ];
    if (collectedPlugins.declared.length > 0) {
        summary.push(`${collectedPlugins.declared.length} plugin file(s)`);
    }
    if (collectedPatches.declared.length > 0) {
        summary.push(`${collectedPatches.declared.length} patch(es)`);
    }
    info(env, dim(env, "  " + summary.join(", ")));
    info(env, dim(env, `  hash: ${manifestHash(manifest)}`));
    if (isFat) {
        info(env, dim(env, `  fat setup — ships ${totalBytes([...collectedPlugins.declared, ...collectedPatches.declared])} B of Lua`));
    }

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

// Shape the plugins block correctly, omitting empty sub-keys. Zod's
// `.strict()` rejects empty arrays differently than missing fields for
// downstream canonicalization (sort order), so we emit only what's
// populated.
function buildPluginsBlock(
    disabled: readonly string[],
    files: readonly EmbeddedFile[],
): { disabled?: string[]; files?: EmbeddedFile[] } | undefined {
    const block: { disabled?: string[]; files?: EmbeddedFile[] } = {};
    if (disabled.length > 0) block.disabled = [...disabled];
    if (files.length > 0) block.files = [...files];
    return Object.keys(block).length > 0 ? block : undefined;
}

// Thrown when the user passes --template with an id that isn't in the
// registry. We list the known ids so a typo is trivially recoverable.
function throwUnknownTemplate(id: string): never {
    const available = listTemplates().map((t) => t.id).join(", ");
    throw new ArgError(
        `unknown template: ${JSON.stringify(id)}. available: ${available || "(none)"}`
    );
}

// Build a compat block from CLI flags, omitting empty fields. Returns
// undefined if the block would be empty — an empty `compat: {}` wouldn't
// round-trip cleanly through canonical YAML and conveys no information.
function buildCompatBlock(
    koMin: string | undefined,
    koMax: string | undefined,
    devices: readonly string[],
): { koreader_version_min?: string; koreader_version_max?: string; device?: string[] } | undefined {
    const block: { koreader_version_min?: string; koreader_version_max?: string; device?: string[] } = {};
    if (koMin && koMin.length > 0) block.koreader_version_min = koMin;
    if (koMax && koMax.length > 0) block.koreader_version_max = koMax;
    if (devices.length > 0) block.device = [...devices];
    return Object.keys(block).length > 0 ? block : undefined;
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

function defaultOutputPath(env: CliEnv, id: string, name: string, fat: boolean): string {
    const ext = fat ? ".kset" : ".kset.yaml";
    return join(resolveSetupsDir(env), `${id}-${slugify(name)}${ext}`);
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
    const { manifest, manifestBytes, isFat } = loadSetup(path);

    const rawText = manifestBytes.toString("utf8");
    const rawHash = hashBytes(manifestBytes);
    const canonicalBytes = canonicalizeManifest(manifest);
    const isCanonical = rawText === canonicalBytes;
    const id = shortId(rawHash);

    const settingsCount = manifest.settings ? Object.keys(manifest.settings).length : 0;
    const pluginsDisabled = manifest.plugins?.disabled?.length ?? 0;
    const pluginFiles = manifest.plugins?.files?.length ?? 0;
    const patches = manifest.patches?.length ?? 0;

    heading(env, `${manifest.meta.name}  (${id})`);
    env.stdout.write(`  hash:         ${rawHash}\n`);
    env.stdout.write(`  file:         ${path}\n`);
    env.stdout.write(`  format:       ${isFat ? "fat (.kset tar.gz)" : "lean (.kset.yaml)"}\n`);
    if (isFat) {
        env.stdout.write(`  bytes:        ${statSync(path).size}  (tarball)\n`);
        env.stdout.write(`  manifest:     ${manifestBytes.length} bytes\n`);
    } else {
        env.stdout.write(`  bytes:        ${manifestBytes.length}\n`);
    }
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

// ---- `kindly setup templates` ----------------------------------------------

async function runSetupTemplates(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    const templates = listTemplates();
    if (templates.length === 0) {
        info(env, dim(env, "no templates bundled in this build"));
        return 0;
    }

    type Row = { id: string; name: string; mode: string; keys: string; disabled: string };
    const rows: Row[] = templates.map((t) => ({
        id: t.id,
        name: t.display_name,
        mode: t.apply_mode,
        keys: String(templateKeyCount(t)),
        disabled: String(t.plugins?.disabled?.length ?? 0),
    }));

    const header = ["ID", "NAME", "MODE", "KEYS", "OFF"];
    const widths = [
        Math.max(header[0]!.length, ...rows.map((r) => r.id.length)),
        Math.max(header[1]!.length, ...rows.map((r) => r.name.length)),
        Math.max(header[2]!.length, ...rows.map((r) => r.mode.length)),
        Math.max(header[3]!.length, ...rows.map((r) => r.keys.length)),
        Math.max(header[4]!.length, ...rows.map((r) => r.disabled.length)),
    ];
    const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
    env.stdout.write(dim(env,
        `${pad(header[0]!, widths[0]!)}  ${pad(header[1]!, widths[1]!)}  ${pad(header[2]!, widths[2]!)}  ${pad(header[3]!, widths[3]!)}  ${header[4]!}`
    ) + "\n");
    for (const r of rows) {
        env.stdout.write(
            `${pad(r.id, widths[0]!)}  ${pad(r.name, widths[1]!)}  ${pad(r.mode, widths[2]!)}  ${pad(r.keys, widths[3]!)}  ${r.disabled}\n`
        );
    }
    // Description lines follow the table — don't crowd the row format.
    env.stdout.write("\n");
    for (const t of templates) {
        env.stdout.write(dim(env, `  ${t.id}: `) + t.description + "\n");
    }
    info(env, "");
    info(env, dim(env, `use: kindly setup export <name> --template <id>`));

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

// ---- `kindly setup import <file>` ------------------------------------------

const IMPORT_FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "show what would change without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "keep a pre-write copy of affected files (invert with --no-safety-snapshot)",
    },
    "accept-plugins": {
        type: "boolean",
        default: false,
        description: "install plugin directories shipped in the Setup (fat-only)",
    },
    "skip-plugins": {
        type: "boolean",
        default: false,
        description: "do not install shipped plugin directories (apply settings only)",
    },
    "accept-patches": {
        type: "boolean",
        default: false,
        description: "install patch files shipped in the Setup (fat-only)",
    },
    "skip-patches": {
        type: "boolean",
        default: false,
        description: "do not install shipped patch files (apply settings only)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
    force: {
        type: "boolean",
        default: false,
        description: "import even when the device fails the Setup's compat check",
    },
    strict: {
        type: "boolean",
        default: false,
        description: "fail (exit 1) if the manifest contains unknown settings keys or type mismatches against the KOReader schema",
    },
    "allow-unknown-keys": {
        type: "boolean",
        default: false,
        description: "suppress warnings for setting keys not in the KOReader schema (type mismatches still warn)",
    },
} as const satisfies FlagSpecs;

// Detect fat (.kset tar.gz) vs lean (.kset.yaml or .yaml) by extension.
// Loading a lean file through the fat path (tar extraction) would fail
// noisily; we'd rather give a direct error.
type LoadedSetup = {
    manifest: SetupManifest;
    manifestBytes: Buffer;       // for content-hash identity
    files: Map<string, Buffer>;  // empty for lean
    isFat: boolean;
};

function loadSetup(path: string): LoadedSetup {
    if (!existsSync(path)) {
        throw new Error(`setup file not found: ${path}`);
    }
    // .kset (no further extension) → tar.gz fat archive.
    // Anything else (.kset.yaml, .yaml) → raw canonical manifest.
    if (path.endsWith(".kset")) {
        const r = unpackSetup(path);
        return {
            manifest: r.manifest,
            manifestBytes: r.manifestBytes,
            files: r.files,
            isFat: true,
        };
    }
    const { raw, manifest } = loadManifestFile(path);
    return {
        manifest,
        manifestBytes: Buffer.from(raw, "utf8"),
        files: new Map(),
        isFat: false,
    };
}

// Flatten a validated Setup manifest into a dict shaped like kindly.yaml's
// top-level settings — ready to feed into mergeYamlIntoLua. Reverses the
// `plugins_disabled` lift that export performed: the manifest's
// plugins.disabled = ["SSH", "calibre"] becomes the on-device shape
// plugins_disabled = { SSH = true, calibre = true }.
function flattenManifestForApply(manifest: SetupManifest): Record<string, LuaValue> {
    const out: Record<string, LuaValue> = {};
    if (manifest.settings) {
        for (const [k, v] of Object.entries(manifest.settings)) {
            out[k] = v as LuaValue;
        }
    }
    if (manifest.plugins?.disabled && manifest.plugins.disabled.length > 0) {
        const pd: Record<string, LuaValue> = {};
        for (const name of manifest.plugins.disabled) pd[name] = true;
        out.plugins_disabled = pd;
    }
    return out;
}

// Emit schema-validation warnings per finding; return true iff --strict
// and there were findings we should block on. --allow-unknown-keys
// silences the unknown-key warnings (and the strict-block on them); type
// mismatches always warn and always count for strict.
function emitSchemaFindings(
    env: CliEnv,
    report: ValidationReport,
    opts: { strict: boolean; allowUnknownKeys: boolean },
): boolean {
    const showUnknowns = !opts.allowUnknownKeys;
    let blocking = false;
    if (showUnknowns && report.unknownKeys.length > 0) {
        warn(env, `schema: ${report.unknownKeys.length} unknown key(s) — likely typos or plugin-scoped:`);
        for (const u of report.unknownKeys) {
            env.stderr.write(`  - ${u.key}  (value is ${u.actualType})\n`);
        }
        if (opts.strict) blocking = true;
    }
    if (report.typeMismatches.length > 0) {
        warn(env, `schema: ${report.typeMismatches.length} type mismatch(es):`);
        for (const t of report.typeMismatches) {
            env.stderr.write(`  - ${t.key}: expected ${t.expectedType}, got ${t.actualType}\n`);
        }
        if (opts.strict) blocking = true;
    }
    if (blocking) {
        env.stderr.write(`\n--strict: aborting due to schema findings.\n`);
    }
    return blocking;
}

function fmtValue(v: unknown): string {
    if (typeof v === "string") return JSON.stringify(v);
    if (v === null) return "nil";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

async function runSetupImport(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, IMPORT_FLAGS);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup import <file> [options]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }

    if (flags["accept-plugins"] && flags["skip-plugins"]) {
        throw new ArgError("--accept-plugins and --skip-plugins are mutually exclusive");
    }
    if (flags["accept-patches"] && flags["skip-patches"]) {
        throw new ArgError("--accept-patches and --skip-patches are mutually exclusive");
    }

    const path = resolve(env.cwd, fileArg);
    const loaded = loadSetup(path);
    const { manifest, manifestBytes, files } = loaded;
    const id = shortId(hashBytes(manifestBytes));

    const shippedPlugins: readonly EmbeddedFile[] = manifest.plugins?.files ?? [];
    const shippedPatches: readonly EmbeddedFile[] = manifest.patches ?? [];

    heading(env, `importing ${manifest.meta.name}  (${id})`);
    info(env, dim(env, `  from:   ${path}`));
    if (manifest.meta.author)      info(env, dim(env, `  author: ${manifest.meta.author}`));
    if (manifest.meta.description) info(env, dim(env, `  ${manifest.meta.description}`));

    // Disclosure + gate for fat content. Print what the Setup ships
    // BEFORE any device touch or flag check — the user needs this info
    // to pick between --accept-X and --skip-X.
    if (shippedPlugins.length > 0 || shippedPatches.length > 0) {
        printFatDisclosure(env, shippedPlugins, shippedPatches);
    }
    if (shippedPlugins.length > 0 && !flags["accept-plugins"] && !flags["skip-plugins"]) {
        throw new Error(
            `this Setup ships ${shippedPlugins.length} plugin file(s) — Lua code that will execute on your Kindle. ` +
            `Pass --accept-plugins to install, or --skip-plugins to apply settings only.`
        );
    }
    if (shippedPatches.length > 0 && !flags["accept-patches"] && !flags["skip-patches"]) {
        throw new Error(
            `this Setup ships ${shippedPatches.length} patch file(s) — Lua code that will execute on your Kindle. ` +
            `Pass --accept-patches to install, or --skip-patches to apply settings only.`
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

    // Compat gate. The manifest's compat block gets verified against what
    // we can read off the device; blocking mismatches abort the import
    // unless --force converts them to warnings. Detection failures (e.g.
    // no git-rev) are soft — we surface them but proceed.
    if (manifest.compat) {
        const detected = {
            version: readKoreaderVersion(mount),
            family: detectDeviceFamily(mount),
        };
        const result = checkCompat(manifest.compat, detected);

        env.stdout.write(`  compat check:\n`);
        if (manifest.compat.koreader_version_min) {
            env.stdout.write(`    koreader >= ${manifest.compat.koreader_version_min}\n`);
        }
        if (manifest.compat.koreader_version_max) {
            env.stdout.write(`    koreader <= ${manifest.compat.koreader_version_max}\n`);
        }
        if (manifest.compat.device?.length) {
            env.stdout.write(`    device: ${manifest.compat.device.join(", ")}\n`);
        }
        env.stdout.write(`    detected: koreader=${detected.version?.raw ?? "unknown"}, device=${detected.family}\n`);

        for (const issue of result.unverifiable) {
            warn(env, formatCompatIssue(issue));
        }

        if (result.blocking.length > 0) {
            for (const issue of result.blocking) {
                if (flags.force) warn(env, formatCompatIssue(issue));
                else             env.stderr.write(`error: ${formatCompatIssue(issue)}\n`);
            }
            if (!flags.force) {
                env.stderr.write(`\nSetup is not compatible with this device. Pass --force to import anyway.\n`);
                return 1;
            }
            warn(env, "--force: proceeding despite compat mismatch.");
        }
    }

    // Schema validation on the manifest's settings block. Runs before any
    // device mutation; --strict aborts, default warns and proceeds. This
    // is the layer that catches typos like `nightmode` (would have been
    // flagged in the 2026-04-22 field test).
    if (manifest.settings) {
        const importReport = validateSettings(manifest.settings as Record<string, unknown>, loadSchema());
        if (emitSchemaFindings(env, importReport, { strict: flags.strict, allowUnknownKeys: flags["allow-unknown-keys"] })) {
            return 1;
        }
    }

    // Flatten + re-apply the secret denylist at the import boundary. A
    // valid-looking manifest could still try to write pinpadlock_pin_code;
    // we refuse to let that through regardless of what the manifest says.
    const manifestFlat = flattenManifestForApply(manifest);
    const { kept: safeFlat, droppedSecrets } = filterForYaml(manifestFlat, "full");

    const onDeviceSrc = readFileSync(mount.settingsPath, "utf8");
    const onDevice = parseSettingsFile(onDeviceSrc) as Record<string, LuaValue>;

    const isReplace = manifest.apply_mode === "replace";

    // In replace mode, preservedKeys tells the diff + merge which
    // top-level on-device keys survive regardless of the manifest.
    // Additive mode doesn't need this — nothing gets removed.
    const preservedKeys: Set<string> = new Set();
    if (isReplace) {
        for (const k of Object.keys(onDevice)) {
            const cls = classifyKey(k);
            if (cls === "SECRET" || cls === "EPHEMERAL") preservedKeys.add(k);
        }
    }

    const changes = isReplace
        ? computeReplaceChanges(onDevice, safeFlat, preservedKeys)
        : computeChanges(onDevice, safeFlat);

    // Determine fat install gates up-front; the "no settings changes"
    // shortcut must NOT fire if plugins/patches still need to land.
    const willInstallPlugins = flags["accept-plugins"] && shippedPlugins.length > 0;
    const willInstallPatches = flags["accept-patches"] && shippedPatches.length > 0;
    const writeSettings = changes.length > 0;

    if (!writeSettings && !willInstallPlugins && !willInstallPatches) {
        info(env, "no changes needed — device already matches this setup.");
        if (droppedSecrets.length > 0) {
            info(env, dim(env, `  (${droppedSecrets.length} secret-key(s) in manifest were refused by denylist)`));
        }
        return 0;
    }

    if (writeSettings) {
        if (isReplace) {
            heading(env, `${changes.length} change(s) to apply (replace mode):`);
            info(env, dim(env, `  replace mode: USER keys not declared in the manifest will be removed.`));
            info(env, dim(env, `  secrets and ephemerals are preserved regardless.`));
        } else {
            heading(env, `${changes.length} change(s) to apply:`);
        }
        for (const c of changes) {
            const p = c.path.join(".");
            if (c.kind === "added") {
                info(env, paint(env, "green", `  + ${p}`) + `  = ${fmtValue(c.next)}`);
            } else if (c.kind === "changed") {
                info(env, paint(env, "yellow", `  ~ ${p}`) + `  ${fmtValue(c.prev)} → ${fmtValue(c.next)}`);
            } else {
                info(env, paint(env, "red", `  - ${p}`) + `  (was ${fmtValue(c.prev)})`);
            }
        }
    } else {
        info(env, dim(env, "settings already match; proceeding to plugin/patch install."));
    }

    if (droppedSecrets.length > 0) {
        warn(env, `refused ${droppedSecrets.length} secret-named key(s) in manifest: ${droppedSecrets.join(", ")}`);
    }

    if (flags["dry-run"]) {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return 0;
    }

    // safeWrite (if needed) creates the timestamped backup dir. If we're
    // skipping the settings write, we mint our own stamp for the fat
    // snapshot so plugin/patch rollback has a home.
    let snapshotDir: string | null = null;
    if (writeSettings) {
        const merged = isReplace
            ? replaceYamlIntoLua(onDevice, safeFlat) as LuaTable
            : mergeYamlIntoLua(onDevice, safeFlat) as LuaTable;
        const newContent = dumpSettingsFile(merged, "./settings.reader.lua");

        const backupDir = join(env.cwd, ".kindly", "pre-import");
        const res = safeWrite(mount.settingsPath, newContent, {
            backupDir,
            verifyLua: true,
            skipBackup: !flags["safety-snapshot"],
        });

        ok(env, `imported to ${mount.settingsPath}`);
        if (res.backupPath) {
            snapshotDir = dirname(res.backupPath);
            info(env, dim(env, `  safety backup: ${res.backupPath}`));
        } else if (!flags["safety-snapshot"]) {
            info(env, dim(env, `  (safety backup skipped by --no-safety-snapshot; .old sibling preserved)`));
        }
    } else if (flags["safety-snapshot"] && (willInstallPlugins || willInstallPatches)) {
        const stamp = env.now().toISOString().replace(/[:.]/g, "-");
        snapshotDir = join(env.cwd, ".kindly", "pre-import", stamp);
        mkdirSync(snapshotDir, { recursive: true });
    }

    if (willInstallPlugins || willInstallPatches) {
        if (snapshotDir && flags["safety-snapshot"]) {
            snapshotFatTargets(mount.koreaderRoot, snapshotDir,
                willInstallPlugins ? affectedPluginTargets(mount.pluginsDir, shippedPlugins) : [],
                willInstallPatches ? affectedPatchTargets(mount.patchesDir, shippedPatches) : [],
            );
            info(env, dim(env, `  pre-install snapshot: ${join(snapshotDir, "plugins-patches.tar.gz")}`));
        }

        if (willInstallPlugins) {
            installPluginFiles(mount.pluginsDir, shippedPlugins, files);
            ok(env, `installed ${shippedPlugins.length} plugin file(s) → ${mount.pluginsDir}`);
        }
        if (willInstallPatches) {
            installPatches(mount.patchesDir, shippedPatches, files);
            ok(env, `installed ${shippedPatches.length} patch(es) → ${mount.patchesDir}`);
        }
    }
    if (flags["skip-plugins"] && shippedPlugins.length > 0) {
        info(env, dim(env, `  --skip-plugins: ${shippedPlugins.length} plugin file(s) NOT installed`));
    }
    if (flags["skip-patches"] && shippedPatches.length > 0) {
        info(env, dim(env, `  --skip-patches: ${shippedPatches.length} patch(es) NOT installed`));
    }

    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
    return 0;
}

// Archive the pre-install state of plugin dirs and patch files into
// <snapshotDir>/plugins-patches.tar.gz. Paths are stored relative to
// koreaderRoot so a bare `tar -xzf` into <koreaderRoot> restores them.
// If none of the targets exist on disk yet, we skip the archive — there's
// nothing to preserve.
function snapshotFatTargets(
    koreaderRoot: string,
    snapshotDir: string,
    pluginAbsPaths: readonly string[],
    patchAbsPaths: readonly string[],
): void {
    const all = [...pluginAbsPaths, ...patchAbsPaths];
    const existing = all.filter((p) => existsSync(p));
    if (existing.length === 0) return;

    // Make paths relative to koreaderRoot for tar.
    const rels = existing.map((abs) => {
        const prefix = koreaderRoot + "/";
        if (!abs.startsWith(prefix)) {
            throw new Error(`internal: snapshot target ${abs} is outside ${koreaderRoot}`);
        }
        return abs.slice(prefix.length);
    });

    createTarGz({
        cwd: koreaderRoot,
        paths: rels,
        outputPath: join(snapshotDir, "plugins-patches.tar.gz"),
    });
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function printFatDisclosure(
    env: CliEnv,
    plugins: readonly EmbeddedFile[],
    patches: readonly EmbeddedFile[],
): void {
    heading(env, "this Setup ships executable code:");
    if (plugins.length > 0) {
        info(env, `  plugins (${plugins.length} file(s), ${fmtBytes(totalBytes(plugins))}):`);
        for (const p of summarizePluginsByDir(plugins)) {
            info(env, `    ${p.dir}  (${p.fileCount} file(s), ${fmtBytes(p.bytes)})`);
        }
    }
    if (patches.length > 0) {
        info(env, `  patches (${patches.length} file(s), ${fmtBytes(totalBytes(patches))}):`);
        for (const p of patches) {
            info(env, `    ${p.path}  (${fmtBytes(p.bytes)})`);
        }
    }
    info(env, dim(env, `  Lua code in plugins and patches will execute on your Kindle.`));
    info(env, dim(env, `  Verify the author before accepting.`));
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
            case "export":    env.stdout.write(exportHelp + "\n");    return 0;
            case "inspect":   env.stdout.write(inspectHelp + "\n");   return 0;
            case "list":      env.stdout.write(listHelp + "\n");      return 0;
            case "hash":      env.stdout.write(hashHelp + "\n");      return 0;
            case "import":    env.stdout.write(importHelp + "\n");    return 0;
            case "templates": env.stdout.write(templatesHelp + "\n"); return 0;
            default: break; // fall through — unknown sub yields below
        }
    }

    switch (sub) {
        case "export":    return await runSetupExport(rest, env);
        case "inspect":   return await runSetupInspect(rest, env);
        case "list":      return await runSetupList(rest, env);
        case "hash":      return await runSetupHash(rest, env);
        case "import":    return await runSetupImport(rest, env);
        case "templates": return await runSetupTemplates(rest, env);
        default:
            throw new ArgError(`unknown setup subcommand: ${sub}`);
    }
}

export const setupHelp = `
kindly setup — create and manage shareable Setups.

usage: kindly setup <subcommand> [options]

Subcommands:
  export <name>   scan device → write a canonical Setup manifest
  import <file>   apply a Setup manifest to the mounted Kindle
  inspect <file>  print a manifest's summary (no device touch)
  list            list Setups in ~/.kindly/setups/
  templates       list curated templates (use with export --template)
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

const templatesHelp = `
kindly setup templates — list curated templates bundled in kindly.

usage: kindly setup templates

Prints one row per template (id, display name, apply mode, settings
count, plugin-toggle count), followed by a one-line description each.
Templates are starting points, not finished configurations — pass
\`--template <id>\` to \`kindly setup export\` to build a manifest from
one, then edit the resulting file as needed.

Templates don't read the device by default. Adding --include-plugin-files
or --include-patches to a template-driven export augments it with the
connected Kindle's plugin directories and patch files.

See docs/51-templates.md for per-template rationale.
`.trim();

const importHelp = `
kindly setup import <file> — merge a Setup manifest into the Kindle.

usage: kindly setup import <file> [options]

  --dry-run             show what would change without writing
  --no-safety-snapshot  skip the pre-write copy of affected files
                        (the .old sibling of settings.reader.lua is
                        still kept for KOReader's own fallback;
                        default: safety snapshot is ON)
  --accept-plugins      install plugin dirs shipped in the Setup (fat)
  --skip-plugins        apply settings only; leave plugins untouched
  --accept-patches      install patch files shipped in the Setup (fat)
  --skip-patches        apply settings only; leave patches untouched
  --mount <path>        path to a mounted Kindle (auto-detect by default)

Additive merge: keys in the manifest override; on-device keys not in the
manifest are left alone (this is how secrets and reading state survive).

Secret-named keys inside the manifest are ALWAYS filtered at the import
boundary — a hostile manifest can't write your PIN.

The manifest's apply_mode decides the merge strategy:
  additive  keys in the manifest override; on-device keys not in the
            manifest are preserved.
  replace   keys in the manifest override; on-device USER keys not in
            the manifest are REMOVED. Secrets and ephemerals are
            preserved regardless. Known nested secrets (kosync.userkey
            etc.) are carried over.

Fat setups ship executable Lua (plugin dirs and/or patch files). They
are gated by --accept-plugins / --accept-patches per category; without
either the accept or the skip flag, import refuses with a disclosure of
what would execute. Existing plugin dirs are wiped-and-replaced (the
safety snapshot keeps the original).

The compat block is printed but not verified in this release.
`.trim();

const exportHelp = `
kindly setup export <name> — scan device, filter, write a canonical Setup manifest.

usage: kindly setup export <name> [options]

  --output <path>            default: ~/.kindly/setups/<id>-<slug>.kset[.yaml]
  --keys <k1,k2,...>         cherry-pick specific settings keys (default: all)
  --template <id>            build from a curated template; skips device read
                             (see \`kindly setup templates\`)
  --apply-mode <mode>        additive | replace  (default: additive, or the
                             template's mode when --template is set)
  --description <text>       human-readable description
  --author <name>            author label (free text, not verified)
  --tags <t1,t2,...>         comma-separated tag list
  --include-plugin-files     pack <koreader>/plugins/*.koplugin/ (fat setup)
  --include-patches          pack <koreader>/patches/*.lua (fat setup)
  --compat-koreader-min <v>  minimum KOReader version (e.g. 2024.03)
  --compat-koreader-max <v>  maximum KOReader version
  --compat-device <d1,d2>    target device ids (e.g. kindle-pw5,kindle-oasis3)
  --mount <path>             path to a mounted Kindle (auto-detect by default)
  --force                    overwrite output if it exists

Secrets (PIN, passwords, device IDs, phone numbers) are ALWAYS filtered.
Ephemerals (lastfile, migration markers) are always filtered — shared
Setups represent a configuration, not your device's current state.

Lean setups (settings + plugin toggles only) ship as a single .kset.yaml
file. Fat setups (with --include-plugin-files or --include-patches) ship
as a .kset tar.gz containing manifest.yaml + declared files.

Compat flags record the author's claim about what KOReader version / device
the Setup targets. The values are displayed on import but NOT enforced in
this release (v0.4 adds enforcement). Leave unset for portable Setups.

--template builds the manifest from a curated key/value bundle rather than
the device. CLI flags (--apply-mode, --description, --tags, --author,
--compat-*, --keys) layer on top of the template; --keys narrows the
template's settings to a subset. Fat flags (--include-plugin-files,
--include-patches) are additive: they scan the live device even when the
manifest's settings come from a template.
`.trim();
