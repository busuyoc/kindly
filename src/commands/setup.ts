// `kindly setup <subcommand>` — create and manage shareable Setups.
//
// See docs/50-v0.3-setups.md for the data model and philosophy.

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exists } from "../fs/safeRead.ts";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveSetupsDir } from "../cli/env.ts";
import { dim, heading, info, ok, paint, stderrLine, warn } from "../cli/log.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../setup/canonical.ts";
import { parseManifest, type EmbeddedFile, type SetupManifest } from "../setup/schema.ts";
import { hasFindings, type ValidationReport } from "../schema/report.ts";
import {
    summarizePluginsByDir, totalBytes,
} from "../setup/files.ts";
import { listTemplates, templateKeyCount } from "../setup/templates.ts";
import type {
    SetupInspectResult,
} from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { changeHitsSensitive, isSensitiveKeyName, sensitiveDomain } from "../schema/classify.ts";
import {
    executeSetupImport,
    loadManifestFile,
    loadSetup,
    flattenManifestForApply,
    snapshotFatTargets,
    type LoadedSetup,
    type SetupImportOptions,
    type ImportResultWithExtras,
} from "../lib/importSetup.ts";
import {
    executeSetupExport,
    type SetupExportOptions,
    type ExportResultWithSchema,
} from "../lib/setupExport.ts";
import {
    executeSetupInspect,
    type SetupInspectOptions,
} from "../lib/setupInspect.ts";

export {
    executeSetupImport,
    type SetupImportOptions,
    type ImportResultWithExtras,
    executeSetupExport,
    type SetupExportOptions,
    executeSetupInspect,
    type SetupInspectOptions,
};

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
    "dry-run": {
        type: "boolean",
        default: false,
        description: "plan the export without writing — reports what would be written",
    },
} as const satisfies FlagSpecs;

export function renderSetupExport(
    result: ExportResultWithSchema,
    env: CliEnv,
    renderOpts: { allowUnknownKeys: boolean; strict: boolean },
): void {
    if (result.sourceMode === "template") {
        info(env, dim(env, `using template: ${result.templateId}`));
    } else if (result.sourcePath) {
        info(env, dim(env, `reading ${result.sourcePath}`));
    }

    if (result.schemaFindings) {
        emitSchemaFindings(env, result.schemaFindings, renderOpts);
    }

    if (result.mode === "dry-run") {
        heading(env, `setup ${result.id}  (dry-run)`);
        info(env, dim(env, `  would write:   ${result.outputPath}`));
        info(env, dim(env, `  bytes:         ${result.bytesWritten}`));
    } else {
        ok(env, `exported setup ${result.id} → ${result.outputPath}`);
    }
    const summary: string[] = [
        `${result.bytesWritten} bytes`,
        `${result.settingsCount} settings`,
        `${result.pluginsDisabledCount} plugin toggle(s)`,
    ];
    if (result.pluginFilesCount > 0) summary.push(`${result.pluginFilesCount} plugin file(s)`);
    if (result.patchesCount > 0)     summary.push(`${result.patchesCount} patch(es)`);
    info(env, dim(env, "  " + summary.join(", ")));
    info(env, dim(env, `  hash: ${result.hash}`));
    if (result.isFat) {
        info(env, dim(env, `  fat setup — ships ${result.fatLuaBytes} B of Lua`));
    }
    if (result.droppedSecrets.length > 0) {
        info(env, dim(env, `  filtered ${result.droppedSecrets.length} secret(s) (never in shared Setups)`));
    }
    if (result.droppedEphemerals.length > 0) {
        info(env, dim(env, `  filtered ${result.droppedEphemerals.length} ephemeral(s) (personal state, not shareable)`));
    }
    if (result.skippedKeys > 0) {
        info(env, dim(env, `  ${result.skippedKeys} --keys entr(ies) not found on device or filtered; skipped`));
    }
}

async function runSetupExport(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, EXPORT_FLAGS);

    const name = positional[0];
    if (!name) {
        throw new ArgError("usage: kindly setup export <name> [options]");
    }
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags["apply-mode"] !== undefined
        && flags["apply-mode"] !== "additive"
        && flags["apply-mode"] !== "replace") {
        throw new ArgError(
            `--apply-mode must be 'additive' or 'replace' (got ${JSON.stringify(flags["apply-mode"])})`
        );
    }

    const result = executeSetupExport({
        name,
        output: flags.output,
        keys: flags.keys,
        applyMode: flags["apply-mode"] as "additive" | "replace" | undefined,
        template: flags.template,
        description: flags.description,
        author: flags.author,
        tags: flags.tags,
        mount: flags.mount,
        force: flags.force,
        includePluginFiles: flags["include-plugin-files"],
        includePatches: flags["include-patches"],
        compatKoreaderMin: flags["compat-koreader-min"],
        compatKoreaderMax: flags["compat-koreader-max"],
        compatDevice: flags["compat-device"],
        strict: flags.strict,
        allowUnknownKeys: flags["allow-unknown-keys"],
        dryRun: flags["dry-run"],
    }, env);

    if (env.jsonMode) {
        // Strip rendering-only fields from the JSON payload.
        const { schemaFindings, sourcePath, fatLuaBytes, ...publicData } = result;
        void schemaFindings; void sourcePath; void fatLuaBytes;
        emitJson(env, "setup export", publicData);
    } else {
        renderSetupExport(result, env, {
            allowUnknownKeys: !!flags["allow-unknown-keys"],
            strict: !!flags.strict,
        });
    }
    return 0;
}

// W33 (91 §3.2): identity-claim fields in JSON must be wrapped so the
// `verified: false` flag is carried alongside the value. Content fields
// (name, description, version, created_at, tags) stay bare. Wrapper shape
// is stable across cardinality: scalars wrap their string, `supersedes`
// wraps its array. When W39 adds minisign verification, the boolean
// flips; consumers dispatch on field name, not on shape.
//
// Applies to both `setup inspect` and `setup import` JSON envelopes —
// the shape of identity-claim fields must match across commands so
// consumers have a single code path.
function wrapIdentityClaims<T extends {
    author?: string;
    sourceUrl?: string;
    authorKeyId?: string;
    supersedes?: string[];
}>(r: T): Omit<T, "author" | "sourceUrl" | "authorKeyId" | "supersedes"> & {
    author?: { value: string; verified: false };
    sourceUrl?: { value: string; verified: false };
    authorKeyId?: { value: string; verified: false };
    supersedes?: { value: string[]; verified: false };
} {
    const { author, sourceUrl, authorKeyId, supersedes, ...rest } = r;
    return {
        ...rest,
        ...(author !== undefined     ? { author:      { value: author,      verified: false as const } } : {}),
        ...(sourceUrl !== undefined  ? { sourceUrl:   { value: sourceUrl,   verified: false as const } } : {}),
        ...(authorKeyId !== undefined ? { authorKeyId: { value: authorKeyId, verified: false as const } } : {}),
        ...(supersedes !== undefined ? { supersedes:  { value: supersedes,  verified: false as const } } : {}),
    };
}

// ---- `kindly setup inspect <file>` -----------------------------------------

export function renderSetupInspect(result: SetupInspectResult, env: CliEnv): void {
    heading(env, `${result.name}  (${result.id})`);
    env.stdout.write(`  hash:         ${result.hash}\n`);
    env.stdout.write(`  file:         ${result.filePath}\n`);
    env.stdout.write(`  format:       ${result.isFat ? "fat (.kset tar.gz)" : "lean (.kset.yaml)"}\n`);
    if (result.isFat) {
        env.stdout.write(`  bytes:        ${result.fileSize}  (tarball)\n`);
        env.stdout.write(`  manifest:     ${result.manifestBytes} bytes\n`);
    } else {
        env.stdout.write(`  bytes:        ${result.manifestBytes}\n`);
    }
    env.stdout.write(`  apply_mode:   ${result.applyMode}\n`);
    env.stdout.write(`  created_at:   ${result.createdAt}\n`);
    // W33: identity-claim fields show with `(UNVERIFIED)` until W39
    // signature verification flips the trust label. See 91 §3.1.
    if (result.author)
        env.stdout.write(`  author:       ${result.author} ${dim(env, "(UNVERIFIED)")}\n`);
    if (result.sourceUrl)
        env.stdout.write(`  source:       ${result.sourceUrl} ${dim(env, "(UNVERIFIED)")}\n`);
    if (result.authorKeyId)
        env.stdout.write(`  author_key:   ${result.authorKeyId} ${dim(env, "(UNVERIFIED)")}\n`);
    if (result.version)
        env.stdout.write(`  version:      ${result.version}\n`);
    if (result.supersedes?.length) {
        env.stdout.write(`  supersedes:   ${dim(env, "(UNVERIFIED — no chain validation)")}\n`);
        for (const h of result.supersedes) {
            env.stdout.write(`                ${h}\n`);
        }
    }
    if (result.description) env.stdout.write(`  description:  ${result.description}\n`);
    if (result.tags.length) env.stdout.write(`  tags:         ${result.tags.join(", ")}\n`);
    if (result.compat) {
        env.stdout.write(`  compat:\n`);
        if (result.compat.koreaderVersionMin) env.stdout.write(`    koreader >= ${result.compat.koreaderVersionMin}\n`);
        if (result.compat.koreaderVersionMax) env.stdout.write(`    koreader <= ${result.compat.koreaderVersionMax}\n`);
        if (result.compat.device?.length)     env.stdout.write(`    device:    ${result.compat.device.join(", ")}\n`);
    }
    env.stdout.write(`  contents:\n`);
    env.stdout.write(`    settings:        ${result.settingsCount}\n`);
    env.stdout.write(`    plugins off:     ${result.pluginsDisabledCount}\n`);
    if (result.pluginFilesCount > 0) env.stdout.write(`    plugin files:    ${result.pluginFilesCount}  (fat setup)\n`);
    if (result.patchesCount > 0)     env.stdout.write(`    patches:         ${result.patchesCount}  (fat setup)\n`);

    if (!result.isCanonical) {
        warn(env, "file is not in canonical form — re-exporting would yield different bytes.");
        info(env, dim(env, `  (canonical hash would be ${result.canonicalHash})`));
    }

    if (result.security) {
        const { total, byDomain } = result.security;
        const domains = Object.keys(byDomain).sort();
        env.stdout.write(
            `  security:     ${total} SENSITIVE key(s) across ${domains.length} domain(s)\n`,
        );
        for (const d of domains) {
            env.stdout.write(`    [${d}] ${byDomain[d]!.join(", ")}\n`);
        }
    }

    if (result.replaceWarnings) {
        const { removedUserKeys, threshold, sampleKeys } = result.replaceWarnings;
        warn(env,
            `replace-mode Setup would remove ${removedUserKeys} top-level USER key(s) ` +
            `(threshold ${threshold}) — on apply, these device settings would be wiped.`,
        );
        info(env, dim(env, `  first: ${sampleKeys.join(", ")}${removedUserKeys > sampleKeys.length ? ", ..." : ""}`));
    }

    if (result.scanReport) renderScanReport(result.scanReport, env);

    if (result.preview) {
        const { preview } = result;
        const totalChanges = preview.changes.length;
        const catCount = Object.keys(preview.grouped).length;
        const sevCounts: Record<string, number> = {};
        for (const bucket of Object.values(preview.grouped)) {
            for (const e of bucket) sevCounts[e.severity] = (sevCounts[e.severity] ?? 0) + 1;
        }
        const sevSummary = ["trivial", "visual", "functional", "breaking"]
            .filter((s) => sevCounts[s])
            .map((s) => `${sevCounts[s]} ${s}`)
            .join(", ");
        env.stdout.write(`  preview (${preview.mode}):\n`);
        if (totalChanges === 0) {
            env.stdout.write(`    no changes — ${preview.mode === "vs-device"
                ? "device already matches this setup"
                : "setup has no settings to apply"}\n`);
        } else {
            env.stdout.write(`    ${totalChanges} change(s) across ${catCount} categor${catCount === 1 ? "y" : "ies"} (${sevSummary})\n`);
            for (const [cat, bucket] of Object.entries(preview.grouped)) {
                env.stdout.write(`    - ${cat}: ${bucket.length}\n`);
            }
        }
    }
}

const INSPECT_FLAGS = {
    "vs-device": {
        type: "boolean",
        description: "preview how the setup would change the currently-mounted device",
    },
    "vs-default": {
        type: "boolean",
        description: "preview what the setup would set on an empty/default config",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (only used with --vs-device; auto-detected otherwise)",
    },
} as const satisfies FlagSpecs;

async function runSetupInspect(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional, flags } = parseArgs(argv, INSPECT_FLAGS);
    const fileArg = positional[0];
    if (!fileArg) throw new ArgError("usage: kindly setup inspect <file> [--vs-device | --vs-default]");
    if (positional.length > 1) {
        throw new ArgError(`unexpected extra argument: ${positional[1]}`);
    }
    if (flags["vs-device"] && flags["vs-default"]) {
        throw new ArgError("--vs-device and --vs-default are mutually exclusive");
    }

    const preview: "vs-device" | "vs-default" | undefined =
        flags["vs-device"] ? "vs-device" :
        flags["vs-default"] ? "vs-default" : undefined;
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeSetupInspect(fileArg, env, { preview });
    if (env.jsonMode) emitJson(env, "setup inspect", wrapIdentityClaims(result));
    else renderSetupInspect(result, env);
    return 0;
}

// ---- `kindly setup list` ---------------------------------------------------

async function runSetupList(argv: readonly string[], env: CliEnv): Promise<number> {
    const { positional } = parseArgs(argv, {} as const satisfies FlagSpecs);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    const dir = resolveSetupsDir(env);
    if (!exists(dir, "derived-from-cwd")) {
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
    label: {
        type: "string",
        description: "advisory name for this import — shown in `kindly history`",
    },
    "expect-hash": {
        type: "string",
        description: "refuse import if the manifest's content hash doesn't match (sha256:<hex> or bare hex)",
    },
    "accept-sensitive": {
        type: "boolean",
        default: false,
        description: "accept all SENSITIVE-class setting changes (network endpoints, SSH, debug, directory redirection)",
    },
    "accept-key": {
        type: "string",
        description: "accept SENSITIVE changes only for these comma-separated key names (e.g. SSH_port,debug)",
    },
    "strict-imports": {
        type: "boolean",
        default: false,
        description: "CI mode: refuse the import if any SENSITIVE key is changed, any plugin file is tampered, or any uncatalogued plugin is shipped. Incompatible with --accept-sensitive and --accept-key.",
    },
} as const satisfies FlagSpecs;

// Parse + validate --accept-key=<a,b,c>. Returns the dotted-key set.
// Unknown keys (not in SENSITIVE_KEYS/SENSITIVE_PATHS) are an ArgError per
// 88 §3.1 — silent acceptance of typos would defeat the per-key gate.
function parseAcceptKey(raw: string): Set<string> {
    const out = new Set<string>();
    const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (parts.length === 0) {
        throw new ArgError("--accept-key: expected at least one key name");
    }
    const unknown = parts.filter((k) => !isSensitiveKeyName(k));
    if (unknown.length > 0) {
        throw new ArgError(
            `--accept-key: unknown SENSITIVE key(s): ${unknown.join(", ")}. ` +
            `Expected one of the key names listed in docs/88-sensitive-keys-spec.md §2.`
        );
    }
    for (const k of parts) out.add(k);
    return out;
}

// Parse + validate a user-supplied --expect-hash value.
// Accepts `sha256:<64 hex>` or bare 64-hex; returns the canonical
// `sha256:<hex>` form. Bad input is an ArgError — format validation is a
// CLI concern (docs/92-expect-hash-spec.md §3), the lib trusts the string.
function normalizeExpectedHash(raw: string): string {
    const bare = raw.startsWith("sha256:") ? raw.slice(7) : raw;
    if (!/^[a-f0-9]{64}$/.test(bare)) {
        throw new ArgError(
            `--expect-hash: invalid hash ${JSON.stringify(raw)}. ` +
            `Expected sha256:<64 hex> or bare <64 hex>.`
        );
    }
    return `sha256:${bare}`;
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

// executeSetupImport + SetupImportOptions + ImportResultWithExtras live in
// src/lib/importSetup.ts (W27); re-exported at the top of this file so
// existing import paths keep working.

// Emitted as a preview block before `executeSetupImport` runs so that text-
// mode users see the heading + fat disclosure BEFORE any gate failure.
// Non-mutating; safe to call on every invocation.
function renderSetupImportIntro(
    manifest: SetupManifest,
    id: string,
    setupFile: string,
    shippedPlugins: readonly EmbeddedFile[],
    shippedPatches: readonly EmbeddedFile[],
    env: CliEnv,
): void {
    // W33 (91 §4): the intro intentionally does NOT show author / source /
    // description. Identity-claim fields render AFTER the SENSITIVE block
    // in renderSetupImport so a naive user reads what the Setup *does*
    // before reading who *claims* to have made it (N1 mitigation).
    heading(env, `importing ${manifest.meta.name}  (${id})`);
    info(env, dim(env, `  from:   ${setupFile}`));
    if (shippedPlugins.length > 0 || shippedPatches.length > 0) {
        printFatDisclosure(env, shippedPlugins, shippedPatches);
    }
}

// W33 (91 §3.1, §4): identity-claim block. Emitted by renderSetupImport
// AFTER the SENSITIVE summary block. Every author-controlled identity field
// carries `(UNVERIFIED)` until W39 minisign verification flips it.
function renderImportAuthorBlock(result: ImportResultWithExtras, env: CliEnv): void {
    const hasAny = !!(
        result.author || result.sourceUrl || result.authorKeyId
        || result.version || result.supersedes?.length
        || result.description
    );
    if (!hasAny) return;
    if (result.author)
        info(env, `  author:       ${result.author} ${dim(env, "(UNVERIFIED)")}`);
    if (result.sourceUrl)
        info(env, `  source:       ${result.sourceUrl} ${dim(env, "(UNVERIFIED)")}`);
    if (result.authorKeyId)
        info(env, `  author_key:   ${result.authorKeyId} ${dim(env, "(UNVERIFIED)")}`);
    if (result.version)
        info(env, `  version:      ${result.version}`);
    if (result.supersedes?.length) {
        info(env, `  supersedes:   ${dim(env, "(UNVERIFIED — no chain validation)")}`);
        for (const h of result.supersedes) {
            info(env, `                ${h}`);
        }
    }
    if (result.description)
        info(env, `  description:  ${result.description}`);
}

// W32 (89 §7): plugin hash verification block. Surfaces MISMATCH /
// UNCATALOGUED / UNVERIFIED / MALFORMED_STRUCTURE verdicts from the
// catalog comparison. MATCH verdicts are silent (no news = good news).
// Data-loss escalation (§5.6): when a MISMATCH exists AND the user passed
// --no-safety-snapshot, `installPluginFiles` will wipe the existing
// plugin dir without a safety copy — we spell that out at the decision
// point.
function renderPluginHashReport(
    result: ImportResultWithExtras,
    env: CliEnv,
    safetySnapshot: boolean,
): void {
    const report = result.pluginHashReport;
    if (!report) return;
    const interesting = report.verdicts.filter((v) => v.status !== "MATCH");
    if (interesting.length === 0) return;

    warn(env, "Plugin hash verification:");
    const catalogV = report.catalogVersion;
    for (const v of interesting) {
        if (v.status === "MISMATCH") {
            stderrLine(env, `  ${v.name}.koplugin: MISMATCH`);
            for (const f of v.files) {
                if (f.status === "modified") {
                    stderrLine(env, `    modified: ${f.file}`);
                    stderrLine(env, `      expected: ${f.expected}${catalogV ? ` (catalog, KOReader ${catalogV})` : ""}`);
                    stderrLine(env, `      actual:   ${f.actual} (Setup archive)`);
                } else if (f.status === "extra") {
                    stderrLine(env, `    extra: ${f.file} (not in catalog)`);
                } else {
                    stderrLine(env, `    missing: ${f.file} (catalog expected ${f.expected})`);
                }
            }
        } else if (v.status === "UNCATALOGUED") {
            stderrLine(env, `  ${v.name}.koplugin: UNCATALOGUED (not in bundled catalog — cannot verify)`);
        } else if (v.status === "UNVERIFIED") {
            stderrLine(env, `  ${v.name}.koplugin: UNVERIFIED (catalog predates W32 hash collection)`);
        } else {
            // MALFORMED_STRUCTURE
            stderrLine(env, `  MALFORMED_STRUCTURE: file paths not under <name>.koplugin/:`);
            for (const p of v.paths) stderrLine(env, `    - ${p}`);
        }
    }

    if (report.catalogVersion && report.deviceVersion
        && !report.versionMatch) {
        stderrLine(env,
            `\n  Note: catalog hashes are from KOReader ${report.catalogVersion}; ` +
            `device runs ${report.deviceVersion}. Mismatches may reflect upstream ` +
            `changes, not tampering.`,
        );
    }

    const hasMismatch = interesting.some((v) => v.status === "MISMATCH");
    if (hasMismatch && !safetySnapshot) {
        warn(env,
            "Proceeding with --no-safety-snapshot: original plugin files will be " +
            "permanently deleted. There will be NO rollback copy.",
        );
    } else if (hasMismatch) {
        info(env, dim(env,
            "  Proceeding will replace existing plugin files; originals are in the safety snapshot.",
        ));
    }
}

// W36/W37 (docs/93 §8): print a scanner-findings block. Findings on files
// whose hash matched the catalog were already suppressed by scanPipeline —
// what's printed here is novel or tampered code. One line per finding with
// category tag, file:line, and a short snippet for context.
function renderScanReport(report: NonNullable<SetupInspectResult["scanReport"]>, env: CliEnv): void {
    if (report.findings.length === 0) {
        if (report.suppressedByCatalog > 0) {
            info(env, dim(env,
                `  scanner: ${report.filesScanned} file(s) scanned, ${report.suppressedByCatalog} suppressed by catalog — no novel findings`,
            ));
        }
        return;
    }
    const uniqueFiles = new Set(
        report.findings.map((f) => `${f.plugin}/${f.file}`),
    );
    warn(env,
        `scanner findings: ${report.findings.length} across ${uniqueFiles.size} file(s)`,
    );
    if (report.suppressedByCatalog > 0) {
        info(env, dim(env, `  (${report.suppressedByCatalog} file(s) suppressed by catalog hash match)`));
    }
    for (const f of report.findings) {
        const tag = paint(env, "red", `[${f.category}]`);
        const loc = `${f.plugin}/${f.file}:${f.line}`;
        stderrLine(env, `    ${tag}  ${loc}`);
        if (f.snippet) stderrLine(env, dim(env, `      -- ${f.snippet}`));
    }
}

// W33 (91 §4) + 88 §3.5: in dry-run we summarize the SENSITIVE hits as a
// distinct block at the top of the preview. The gate didn't throw (dry-run
// skips it), so the block stands in for the would-have-been error message.
// On a real import that reaches this renderer, the user already consented;
// the block recaps what they accepted.
function renderSensitiveSummary(result: ImportResultWithExtras, env: CliEnv): void {
    if (result.sensitiveHits.length === 0) return;
    const n = result.sensitiveHits.length;
    info(env, paint(env, "yellow", `⚠ This Setup modifies ${n} security-sensitive setting(s):`));
    for (const path of result.sensitiveHits) {
        // sensitiveDomain handles unknown paths defensively; the hit list
        // came from the classifier so all entries are known.
        const carrier = result.changes.find(
            (c) => path.split(".").slice(0, c.path.length).join(".") === c.path.join("."),
        );
        const valueHint = carrier
            ? (carrier.kind === "added"   ? `(added)`
              : carrier.kind === "removed" ? `(removed)`
              : `(changed)`)
            : "";
        info(env, `  [${sensitiveDomain(path)}] ${path} ${dim(env, valueHint)}`);
    }
    info(env, "");
}

export function renderSetupImport(
    result: ImportResultWithExtras,
    env: CliEnv,
    renderOpts: { allowUnknownKeys: boolean; strict: boolean; force: boolean; safetySnapshot: boolean },
): void {
    // W33 (91 §4) — order is load-bearing: SENSITIVE summary first so a user
    // reads what the Setup *does* before reading who *claims* to have authored
    // it (N1 anti-anchor-trust mitigation).
    renderSensitiveSummary(result, env);
    renderImportAuthorBlock(result, env);
    // W32 (89 §7): plugin hash verification — what's being installed, and
    // whether it matches the curated catalog. Emitted before compat/schema
    // so the decision surface is consolidated near the top.
    renderPluginHashReport(result, env, renderOpts.safetySnapshot);
    if (result.scanReport) renderScanReport(result.scanReport, env);

    if (result.compat) {
        env.stdout.write(`  compat check:\n`);
        if (result.compat.declared.koreaderVersionMin) {
            env.stdout.write(`    koreader >= ${result.compat.declared.koreaderVersionMin}\n`);
        }
        if (result.compat.declared.koreaderVersionMax) {
            env.stdout.write(`    koreader <= ${result.compat.declared.koreaderVersionMax}\n`);
        }
        if (result.compat.declared.device?.length) {
            env.stdout.write(`    device: ${result.compat.declared.device.join(", ")}\n`);
        }
        env.stdout.write(`    detected: koreader=${result.compat.detected.koreaderVersion ?? "unknown"}, device=${result.compat.detected.deviceFamily}\n`);
        for (const line of result.compat.unverifiable) warn(env, line);
        if (result.compat.forced) {
            for (const line of result.compat.blocking) warn(env, line);
            warn(env, "--force: proceeding despite compat mismatch.");
        }
    }

    if (result.schemaFindings) {
        emitSchemaFindings(env, result.schemaFindings, renderOpts);
    }

    if (result.inertPluginToggles.length > 0) {
        warn(env, `${result.inertPluginToggles.length} plugin toggle(s) reference plugins not installed on this device — stored but inert:`);
        for (const name of result.inertPluginToggles) {
            env.stderr.write(`  - ${name}  (no ${name}.koplugin/ on device)\n`);
        }
    }

    const writeSettings = result.changes.length > 0;
    const isReplace = result.applyMode === "replace";
    const willInstallPlugins = result.installedPluginFiles > 0
        || (result.mode !== "imported" && result.shippedPluginCount > 0 && result.skippedPluginFiles === 0);
    const willInstallPatches = result.installedPatches > 0
        || (result.mode !== "imported" && result.shippedPatchCount > 0 && result.skippedPatches === 0);

    if (result.mode === "no-op") {
        info(env, "no changes needed — device already matches this setup.");
        if (result.refusedSecrets.length > 0) {
            info(env, dim(env, `  (${result.refusedSecrets.length} secret-key(s) in manifest were refused by denylist)`));
        }
        return;
    }

    if (writeSettings) {
        if (isReplace) {
            heading(env, `${result.changes.length} change(s) to apply (replace mode):`);
            info(env, dim(env, `  replace mode: USER keys not declared in the manifest will be removed.`));
            info(env, dim(env, `  secrets and ephemerals are preserved regardless.`));
            if (result.replaceWarnings) {
                const { removedUserKeys, threshold, sampleKeys } = result.replaceWarnings;
                warn(env,
                    `this Setup would remove ${removedUserKeys} top-level USER key(s) ` +
                    `(threshold ${threshold}) — verify apply_mode is what you intended.`,
                );
                info(env, dim(env, `  first: ${sampleKeys.join(", ")}${removedUserKeys > sampleKeys.length ? ", ..." : ""}`));
            }
        } else {
            heading(env, `${result.changes.length} change(s) to apply:`);
        }
        for (const c of result.changes) {
            const p = c.path.join(".");
            const marker = changeHitsSensitive(c).length > 0 ? "[SENSITIVE] " : "";
            if (c.kind === "added") {
                info(env, paint(env, "green", `  + ${marker}${p}`) + `  = ${fmtValue(c.next)}`);
            } else if (c.kind === "changed") {
                info(env, paint(env, "yellow", `  ~ ${marker}${p}`) + `  ${fmtValue(c.prev)} → ${fmtValue(c.next)}`);
            } else {
                info(env, paint(env, "red", `  - ${marker}${p}`) + `  (was ${fmtValue(c.prev)})`);
            }
        }
    } else if (willInstallPlugins || willInstallPatches) {
        info(env, dim(env, "settings already match; proceeding to plugin/patch install."));
    }

    if (result.refusedSecrets.length > 0) {
        warn(env, `refused ${result.refusedSecrets.length} secret-named key(s) in manifest: ${result.refusedSecrets.join(", ")}`);
    }

    if (result.mode === "dry-run") {
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return;
    }

    // mode === "imported"
    if (writeSettings) {
        ok(env, `imported to ${result.settingsPath}`);
        if (result.backupPath) {
            info(env, dim(env, `  safety backup: ${result.backupPath}`));
        } else {
            info(env, dim(env, `  (safety backup skipped by --no-safety-snapshot; .old sibling preserved)`));
        }
    }

    if (result.fatSnapshotPath) {
        info(env, dim(env, `  pre-install snapshot: ${result.fatSnapshotPath}`));
    }
    if (result.installedPluginFiles > 0) {
        ok(env, `installed ${result.installedPluginFiles} plugin file(s) → <mount>/koreader/plugins`);
    }
    if (result.installedPatches > 0) {
        ok(env, `installed ${result.installedPatches} patch(es) → <mount>/koreader/patches`);
    }
    if (result.skippedPluginFiles > 0) {
        info(env, dim(env, `  --skip-plugins: ${result.skippedPluginFiles} plugin file(s) NOT installed`));
    }
    if (result.skippedPatches > 0) {
        info(env, dim(env, `  --skip-patches: ${result.skippedPatches} patch(es) NOT installed`));
    }

    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
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
    if (flags["strict-imports"]) {
        if (flags["accept-sensitive"]) {
            throw new ArgError("--strict-imports and --accept-sensitive are mutually exclusive");
        }
        if (flags["accept-key"] !== undefined) {
            throw new ArgError("--strict-imports and --accept-key are mutually exclusive");
        }
    }

    const expectHash = flags["expect-hash"] !== undefined
        ? normalizeExpectedHash(flags["expect-hash"])
        : undefined;

    const acceptKey = flags["accept-key"] !== undefined
        ? parseAcceptKey(flags["accept-key"])
        : undefined;

    // Pre-emit the intro + fat-disclosure in text mode so the user sees
    // what's being imported BEFORE any gate throws. No-op in JSON mode.
    const path = resolve(env.cwd, fileArg);
    if (!env.jsonMode) {
        const loaded = loadSetup(path);
        const id = shortId(hashBytes(loaded.manifestBytes));
        renderSetupImportIntro(
            loaded.manifest, id, path,
            loaded.manifest.plugins?.files ?? [],
            loaded.manifest.patches ?? [],
            env,
        );
    }

    const result = executeSetupImport({
        file: fileArg,
        mount: flags.mount,
        force: flags.force,
        strict: flags.strict,
        allowUnknownKeys: flags["allow-unknown-keys"],
        dryRun: flags["dry-run"],
        safetySnapshot: flags["safety-snapshot"],
        acceptPlugins: flags["accept-plugins"],
        skipPlugins: flags["skip-plugins"],
        acceptPatches: flags["accept-patches"],
        skipPatches: flags["skip-patches"],
        label: flags.label,
        ...(expectHash ? { expectHash } : {}),
        acceptSensitive: flags["accept-sensitive"],
        ...(acceptKey ? { acceptKey } : {}),
        strictImports: flags["strict-imports"],
    }, env);

    if (env.jsonMode) {
        const { schemaFindings, shippedPluginCount, shippedPatchCount,
                ...publicData } = result;
        void schemaFindings; void shippedPluginCount; void shippedPatchCount;
        // W33 (91 §3.2): identity-claim fields (author, sourceUrl,
        // authorKeyId, supersedes) get wrapped `{ value, verified: false }`.
        // Content fields (description, version) stay bare.
        emitJson(env, "setup import", wrapIdentityClaims(publicData));
    } else {
        renderSetupImport(result, env, {
            allowUnknownKeys: !!flags["allow-unknown-keys"],
            strict: !!flags.strict,
            force: !!flags.force,
            safetySnapshot: flags["safety-snapshot"] !== false,
        });
    }
    const hasWarnings = !!(
        result.sensitiveHits.length > 0
        || (result.pluginHashReport?.verdicts.some((v) => v.status !== "MATCH"))
        || (result.scanReport?.findings.length)
        || result.schemaFindings
        || result.replaceWarnings
    );
    return hasWarnings ? 4 : 0;
}

// Archive the pre-install state of plugin dirs and patch files into
// <snapshotDir>/plugins-patches.tar.gz. Paths are stored relative to
// koreaderRoot so a bare `tar -xzf` into <koreaderRoot> restores them.
// If none of the targets exist on disk yet, we skip the archive — there's
// nothing to preserve.
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

usage: kindly setup inspect <file> [--vs-device | --vs-default] [--mount <path>]

Reads and validates a .kset.yaml file; prints id, hash, metadata, and
content counts. Warns if the file is not in canonical form. With
--vs-device (requires a mount) or --vs-default (against empty config),
also computes a grouped-by-category preview of the settings changes.
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
  --expect-hash <h>     refuse import if the manifest's content hash doesn't
                        match. Accepts sha256:<64 hex> or bare 64 hex. Check
                        the hash out-of-band before passing this flag; compare
                        against \`kindly setup hash <file>\`.
  --accept-sensitive    accept all SENSITIVE-class setting changes (network
                        endpoints, SSH, debug, directory redirection). Without
                        this (or --accept-key), a SENSITIVE change fails the
                        import with a listing of the affected keys.
  --accept-key <k,...>  accept SENSITIVE changes only for these comma-separated
                        key names (e.g. SSH_port,debug,kosync.custom_server).
                        Unknown keys are rejected.

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
