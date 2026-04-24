// `kindly plugin <subcommand>` — browse the curated plugin catalog (W21/W22).
//
// Subcommands:
//   list      cross-reference the catalog with device state, one line per plugin
//   describe  print one plugin's full catalog entry
//
// Device state is optional: if no Kindle is mounted (or --mount is invalid),
// `list` and `describe` still run in "offline" mode and omit the
// enabled_on_device column. That keeps browsing the catalog a zero-cost
// operation for users who aren't about to touch their device.

import { resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { resolveMount } from "../cli/env.ts";
import { emitJson } from "../cli/json.ts";
import { dim, heading, info, paint } from "../cli/log.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import type { PluginDescribeResult, PluginListResult } from "../types/results.ts";
import {
    findPlugin,
    joinCatalogWithState,
    loadPluginCatalog,
    readDisabledSet,
    type CurationOpinion,
    type PluginCatalog,
    type PluginWithState,
} from "../catalog/reader.ts";

// ---- shared device-state resolution ---------------------------------------

/** Best-effort read of `plugins_disabled` from the device. Never throws —
 *  returns `null` when no device / unmountable / unreadable / malformed. */
function readDeviceDisabledOrNull(env: CliEnv): Set<string> | null {
    try {
        const mount = resolveMount(env);
        if (!exists(mount.settingsPath, "derived-from-mount")) return null;
        const parsed = parseSettingsFile(readText(mount.settingsPath, "derived-from-mount")) as Record<string, LuaValue>;
        return readDisabledSet(parsed);
    } catch {
        return null;
    }
}

function loadCatalogPath(env: CliEnv): { catalog: PluginCatalog; path: string } {
    const path = resolve(env.cwd, "data/catalog/plugins.bundled.v1.json");
    // The resolve() here lets tests drop a fixture under their tmpdir/cwd;
    // when that file is absent, fall through to the default (repo artifact).
    if (exists(path, "derived-from-cwd")) {
        return { catalog: loadPluginCatalog(path), path };
    }
    // Default (installed binary / normal run): resolve relative to the module.
    const defaultCatalog = loadPluginCatalog();
    // Reconstruct the absolute path for display. loadPluginCatalog caches on
    // default path; we just report the same constant here.
    const defaultPath = resolve(
        import.meta.dir,
        "..",
        "..",
        "data/catalog/plugins.bundled.v1.json",
    );
    return { catalog: defaultCatalog, path: defaultPath };
}

// ---- `kindly plugin list` -------------------------------------------------

const LIST_FLAGS = {
    category: {
        type: "string",
        description: "filter to a single category (reading, ui, sync, dev, accessibility, system)",
    },
    opinion: {
        type: "string",
        description: "filter to a curation_opinion (recommended, debloat, niche)",
    },
} as const satisfies FlagSpecs;

export interface PluginListOptions {
    category?: string;
    opinion?: CurationOpinion;
}

export function executePluginList(opts: PluginListOptions, env: CliEnv): PluginListResult {
    const { catalog, path: catalogPath } = loadCatalogPath(env);
    const disabled = readDeviceDisabledOrNull(env);
    let plugins: PluginWithState[] = joinCatalogWithState(catalog, disabled);

    if (opts.category) {
        plugins = plugins.filter((p) => p.category === opts.category);
    }
    if (opts.opinion) {
        plugins = plugins.filter((p) => p.curation_opinion === opts.opinion);
    }

    const counts = {
        total: plugins.length,
        recommended: plugins.filter((p) => p.curation_opinion === "recommended").length,
        debloat: plugins.filter((p) => p.curation_opinion === "debloat").length,
        niche: plugins.filter((p) => p.curation_opinion === "niche").length,
        enabled_on_device: plugins.filter((p) => p.enabled_on_device === true).length,
        disabled_on_device: plugins.filter((p) => p.enabled_on_device === false).length,
    };

    return {
        catalogVersion: catalog.catalog_version,
        koreaderSource: catalog.koreader_source,
        catalogPath,
        plugins,
        ...(opts.category ? { filteredByCategory: opts.category } : {}),
        ...(opts.opinion ? { filteredByOpinion: opts.opinion } : {}),
        deviceStateAvailable: disabled !== null,
        counts,
    };
}

export function renderPluginList(result: PluginListResult, env: CliEnv): void {
    if (result.plugins.length === 0) {
        const filters = [
            result.filteredByCategory ? `category=${result.filteredByCategory}` : null,
            result.filteredByOpinion ? `opinion=${result.filteredByOpinion}` : null,
        ].filter(Boolean).join(", ");
        info(env, filters ? `no plugins match (${filters})` : "catalog is empty");
        return;
    }

    heading(env, "plugin catalog");
    info(env, dim(env, `  ${result.catalogVersion} · from ${result.koreaderSource} · ${result.catalogPath}`));
    if (!result.deviceStateAvailable) {
        info(env, dim(env, "  (no device mounted — showing catalog only)"));
    }
    info(env, "");

    // Columns: OPINION  STATE  NAME (label)  ← kept tight so 80-col fits.
    for (const p of result.plugins) {
        const op = opinionBadge(p.curation_opinion, env);
        const st = stateBadge(p.enabled_on_device, env);
        const label = `${p.name.padEnd(20)} ${dim(env, p.fullname)}`;
        info(env, `  ${op}  ${st}  ${label}`);
    }

    info(env, "");
    const bits = [
        `${result.counts.total} shown`,
        `${result.counts.recommended} recommended`,
        `${result.counts.debloat} debloat`,
        `${result.counts.niche} niche`,
    ];
    if (result.deviceStateAvailable) {
        bits.push(`${result.counts.enabled_on_device} enabled on device`);
    }
    info(env, dim(env, `  ${bits.join(" · ")}`));
}

function opinionBadge(op: CurationOpinion, env: CliEnv): string {
    switch (op) {
        case "recommended": return paint(env, "green", "★ rec   ");
        case "debloat":     return paint(env, "red", "✗ debloat");
        case "niche":       return paint(env, "yellow", "· niche ");
    }
}

function stateBadge(enabled: boolean | null, env: CliEnv): string {
    if (enabled === null) return dim(env, "        ");
    return enabled ? paint(env, "green", "on      ") : dim(env, "off     ");
}

export async function runPluginList(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, LIST_FLAGS);
    if (positional.length > 0) {
        throw new ArgError(`unexpected positional argument(s): ${positional.join(" ")}`);
    }

    const category = flags.category;
    const opinion = flags.opinion;
    if (opinion !== undefined && !["recommended", "debloat", "niche"].includes(opinion)) {
        throw new ArgError(`--opinion must be one of: recommended, debloat, niche (got "${opinion}")`);
    }

    const result = executePluginList(
        {
            ...(category ? { category } : {}),
            ...(opinion ? { opinion: opinion as CurationOpinion } : {}),
        },
        env,
    );

    if (env.jsonMode) {
        emitJson(env, "plugin:list", result);
    } else {
        renderPluginList(result, env);
    }
    return 0;
}

// ---- `kindly plugin describe <name>` -------------------------------------

const DESCRIBE_FLAGS = {} as const satisfies FlagSpecs;

export function executePluginDescribe(name: string, env: CliEnv): PluginDescribeResult {
    const { catalog, path: catalogPath } = loadCatalogPath(env);
    const plugin = findPlugin(catalog, name);
    if (!plugin) {
        const available = catalog.plugins.map((p) => p.name).sort().join(", ");
        throw new KindlyError(
            ErrorCodes.PLUGIN_NOT_FOUND,
            `plugin "${name}" not in catalog (v${catalog.catalog_version}).`,
            [
                { text: `Run \`kindly plugin list\` to see all ${catalog.plugins.length} plugins.` },
                { text: `Available: ${available}` },
            ],
        );
    }

    const disabled = readDeviceDisabledOrNull(env);
    return {
        plugin,
        deviceStateAvailable: disabled !== null,
        enabledOnDevice: disabled === null ? null : !disabled.has(plugin.name),
        catalogPath,
    };
}

export function renderPluginDescribe(result: PluginDescribeResult, env: CliEnv): void {
    const p = result.plugin;
    heading(env, `${p.fullname}  ${dim(env, `(${p.name})`)}`);
    info(env, "");
    info(env, `  ${p.description}`);
    info(env, "");

    const stateLine = result.deviceStateAvailable
        ? (result.enabledOnDevice
            ? paint(env, "green", "enabled on device")
            : paint(env, "yellow", "disabled on device"))
        : dim(env, "(no device — catalog only)");
    info(env, `  ${dim(env, "state:")}       ${stateLine}`);
    info(env, `  ${dim(env, "opinion:")}     ${p.curation_opinion}`);
    info(env, `  ${dim(env, "category:")}    ${p.category}`);
    info(env, `  ${dim(env, "ship default:")} ${p.ship_default_on} — ${p.ship_default_rationale}`);
    info(env, `  ${dim(env, "folder:")}      plugins/${p.folder}`);
    if (p.deprecated) {
        info(env, `  ${dim(env, "deprecated:")}  ${p.deprecated.kind} (${p.deprecated.detail})`);
    }

    if (p.kindle_notes.length > 0) {
        info(env, "");
        heading(env, "Kindle notes");
        info(env, `  ${p.kindle_notes}`);
    }

    info(env, "");
    heading(env, "What the community says");
    info(env, `  ${p.community_sentiment}`);

    if (p.references.length > 0) {
        info(env, "");
        heading(env, "References");
        for (const ref of p.references) info(env, `  - ${ref}`);
    }

    if (p.warnings.length > 0) {
        info(env, "");
        info(env, dim(env, `  extractor warnings: ${p.warnings.join("; ")}`));
    }
}

export async function runPluginDescribe(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, DESCRIBE_FLAGS);
    if (positional.length === 0) {
        throw new ArgError("missing plugin name. Usage: kindly plugin describe <name>");
    }
    if (positional.length > 1) {
        throw new ArgError(`expected one plugin name, got ${positional.length}`);
    }

    const result = executePluginDescribe(positional[0]!, env);
    if (env.jsonMode) {
        emitJson(env, "plugin:describe", result);
    } else {
        renderPluginDescribe(result, env);
    }
    return 0;
}

// ---- dispatcher ----------------------------------------------------------

export async function runPlugin(argv: readonly string[], env: CliEnv): Promise<number> {
    const [sub, ...rest] = argv;

    if (!sub || sub === "--help" || sub === "-h") {
        env.stdout.write(pluginHelp + "\n");
        return 0;
    }

    if (rest[0] === "--help" || rest[0] === "-h") {
        switch (sub) {
            case "list":     env.stdout.write(pluginListHelp + "\n");     return 0;
            case "describe": env.stdout.write(pluginDescribeHelp + "\n"); return 0;
            default: break;
        }
    }

    switch (sub) {
        case "list":     return await runPluginList(rest, env);
        case "describe": return await runPluginDescribe(rest, env);
        default:
            throw new ArgError(`unknown plugin subcommand: ${sub}`);
    }
}

export const pluginHelp = `
kindly plugin — browse the curated KOReader bundled-plugin catalog.

usage: kindly plugin <subcommand> [options]

Subcommands:
  list               cross-reference catalog with device state
  describe <name>    print one plugin's full catalog entry

Run \`kindly plugin <sub> --help\` for per-subcommand flags.
`.trim();

export const pluginListHelp = `
kindly plugin list — list all bundled plugins with curation + device state.

usage: kindly plugin list [--category <name>] [--opinion <kind>]

Flags:
  --category <name>  only show plugins in that category
                     (reading, ui, sync, dev, accessibility, system)
  --opinion <kind>   only show plugins with that curation opinion
                     (recommended, debloat, niche)

Add the global --json flag to emit a typed PluginListResult envelope.

Device state is read best-effort from the mounted Kindle. If no device is
found, the list still renders — just without the enabled/disabled column.
`.trim();

export const pluginDescribeHelp = `
kindly plugin describe <name> — print one plugin's full catalog entry.

usage: kindly plugin describe <name>

The <name> matches the folder under \`plugins/\` minus \`.koplugin\`
(case-sensitive — \`SSH\`, not \`ssh\`). Run \`kindly plugin list\` to see
the full set.

Add the global --json flag to emit a typed PluginDescribeResult envelope.
`.trim();
