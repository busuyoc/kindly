// Setup manifest schema — v1 of the shareable artifact.
//
// This file is the data contract for everything above it: the frontend
// (v0.7) renders these, compat checks (v0.4) validate them, distribution
// (v0.5) moves them around. Breaking changes bump the version from "v1";
// importers refuse unknown major versions with a specific error.
//
// Runtime validation uses Zod so malformed user/remote input produces a
// readable error instead of a silent crash deep in apply logic.
//
// See docs/50-v0.3-setups.md for rationale and field-by-field meaning.

import { z } from "zod";

// ---- Setting values (recursive) --------------------------------------------
//
// A setting value is anything KOReader's dump.lua emits: primitives,
// arrays (1-indexed Lua tables-as-arrays), and nested string-keyed tables.
// Deliberately permissive — we don't know every key KOReader might add,
// and we'd rather pass-through unknown shapes than reject them.

export type SettingValue =
    | string
    | number
    | boolean
    | null
    | SettingValue[]
    | { [key: string]: SettingValue };

export const SettingValueSchema: z.ZodType<SettingValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(SettingValueSchema),
        z.record(z.string(), SettingValueSchema),
    ])
);

// ---- Embedded files (plugin dirs, patch files) -----------------------------
//
// Fat Setups ship actual bytes. The manifest declares the path, the sha256
// of the file contents, and the byte length. The archive is pure transport:
// integrity is verified against these declared hashes, so the archive format
// itself does not affect Setup identity.

const SHA256_HEX = /^sha256:[a-f0-9]{64}$/;

// Path-safety predicate lives in src/fs/paths.ts — re-exported here so
// existing setup/*.ts imports keep working without a churn PR.
import { isSafeRelativePath } from "../fs/paths.ts";
export { isSafeRelativePath };

const SafeRelPathSchema = z
    .string()
    .min(1, "path must not be empty")
    .refine(isSafeRelativePath, {
        message: "path must be a relative POSIX path without '..' segments, absolute prefixes, or backslashes",
    });

export const EmbeddedFileSchema = z.object({
    path: SafeRelPathSchema,
    hash: z.string().regex(SHA256_HEX, "hash must be 'sha256:' + 64 lowercase hex chars"),
    bytes: z.number().int().nonnegative(),
    description: z.string().optional(),
}).strict();
export type EmbeddedFile = z.infer<typeof EmbeddedFileSchema>;

// Reject duplicate paths in a file list. On unpack, duplicates are
// ambiguous — the last one would silently overwrite the first. Catching at
// parse time means integrity checks (hash-per-file) can trust the list.
function uniqueByPath(files: readonly { path: string }[]): boolean {
    const seen = new Set<string>();
    for (const f of files) {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
    }
    return true;
}

const EmbeddedFileArraySchema = z
    .array(EmbeddedFileSchema)
    .refine(uniqueByPath, { message: "duplicate path in file list" });

// ---- Top-level blocks ------------------------------------------------------

export const MetaSchema = z.object({
    name: z.string().min(1, "meta.name is required"),
    author: z.string().optional(),
    description: z.string().optional(),
    // ISO 8601. We accept the common forms Zod's .iso.datetime validates:
    // "2026-04-21T12:00:00Z", with optional milliseconds, with Z or ±HH:MM.
    created_at: z.iso.datetime({ offset: true }),
    tags: z.array(z.string()).optional(),
    // W33 reserved fields — accepted, displayed with `(UNVERIFIED)`,
    // never trusted until W39 minisign verification ships. See
    // docs/91-reserved-meta-fields-spec.md §2 + §6.
    source_url: z.string().url().optional(),
    version: z.string().optional(),
    author_key_id: z.string().optional(),
    supersedes: z.array(
        z.string().regex(SHA256_HEX, "supersedes entry must be 'sha256:' + 64 lowercase hex chars")
    ).optional(),
}).strict();
export type Meta = z.infer<typeof MetaSchema>;

export const CompatSchema = z.object({
    // Version strings like "2024.03" — we don't validate format here; that's
    // v0.4's job once we start parsing KOReader's git-rev. Storing as string.
    koreader_version_min: z.string().nullable().optional(),
    koreader_version_max: z.string().nullable().optional(),
    // Free-form device identifiers: "kindle-pw5", "kindle-oasis3", "kobo-libra2".
    // No registry — author declares, importer displays.
    device: z.array(z.string()).optional(),
}).strict();
export type Compat = z.infer<typeof CompatSchema>;

export const PluginsSchema = z.object({
    // KOReader's plugins_disabled key, lifted here so the author can declare
    // "turn off coverbrowser for this setup" without shipping files.
    disabled: z.array(z.string()).optional(),
    // Optional shipped plugin directories. Only populated in fat Setups.
    files: EmbeddedFileArraySchema.optional(),
}).strict();
export type Plugins = z.infer<typeof PluginsSchema>;

// ---- The manifest itself ---------------------------------------------------

export const SetupManifestSchema = z.object({
    kindly_setup: z.literal("v1"),
    meta: MetaSchema,
    compat: CompatSchema.optional(),
    apply_mode: z.enum(["additive", "replace"]),
    settings: z.record(z.string(), SettingValueSchema).optional(),
    plugins: PluginsSchema.optional(),
    patches: EmbeddedFileArraySchema.optional(),
}).strict();

export type SetupManifest = z.infer<typeof SetupManifestSchema>;

// ---- Parsing / validation --------------------------------------------------

export class SetupSchemaError extends Error {
    constructor(message: string, public issues: readonly z.ZodIssue[]) {
        super(message);
        this.name = "SetupSchemaError";
    }
}

// Parse+validate an already-decoded JS value (e.g. from YAML.parse) into a
// SetupManifest. Throws SetupSchemaError with a human-readable summary on
// failure — never returns an unvalidated object.
export function parseManifest(raw: unknown): SetupManifest {
    const result = SetupManifestSchema.safeParse(raw);
    if (result.success) return result.data;

    const issues = result.error.issues;
    const summary = issues
        .slice(0, 5)
        .map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`)
        .join("; ");
    const more = issues.length > 5 ? ` (+${issues.length - 5} more)` : "";
    throw new SetupSchemaError(`invalid Setup manifest: ${summary}${more}`, issues);
}

// Non-throwing variant — returns either the parsed manifest or the issues,
// for callers that want to surface errors to a UI instead of throwing.
export function tryParseManifest(raw: unknown):
    | { ok: true; manifest: SetupManifest }
    | { ok: false; issues: readonly z.ZodIssue[] } {
    const result = SetupManifestSchema.safeParse(raw);
    return result.success
        ? { ok: true, manifest: result.data }
        : { ok: false, issues: result.error.issues };
}
