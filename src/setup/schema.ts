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

import { sanitizeForTerminal } from "../cli/sanitize.ts";

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

// S964 (Angle X): reserved-key denylist for settings keys.
//
// `__proto__` is stripped naturally — yaml@2 emits null-prototype objects
// and Zod's record parser drops it during enumeration — but `constructor`
// and `prototype` are regular own properties that survive every layer up
// to mergeYamlIntoLua and writer.ts, where they become literal Lua keys.
// On apply, KOReader reads them back via `for k, v in pairs(t)` and
// metatable shadowing becomes possible. The yaml.ts plainToLua chokepoint
// catches these for `kindly apply`, but `setup import` flattens the
// validated manifest directly into the apply pipeline without going
// through plainToLua — close that hole at the schema seam.
const RESERVED_SETTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SettingKeySchema = z.string().refine(
    (k) => !RESERVED_SETTING_KEYS.has(k),
    { message: "key is reserved (__proto__, constructor, prototype not allowed)" },
);

export const SettingValueSchema: z.ZodType<SettingValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(SettingValueSchema),
        z.record(SettingKeySchema, SettingValueSchema),
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

// S2200: reject case-folded path collisions for cross-platform .kset
// portability. FAT32 (Kindle's filesystem) is case-insensitive, so a
// manifest with both `Plugins.koplugin/main.lua` and
// `plugins.koplugin/main.lua` would silently collapse on-device — the
// second `installPluginFiles` write clobbers the first while the wipe-
// set in `setup/files.ts` treats them as two separate buckets. The
// underlying threat is publisher-controlled bytes either way (no
// privilege gain), but it's a hygiene gap that lets a manifest hide one
// of the colliding files from `setup describe`'s pretty output while
// it still lands. Reject at parse for portable archives.
function uniqueByCaseFoldedPath(files: readonly { path: string }[]): boolean {
    const seen = new Set<string>();
    for (const f of files) {
        const folded = f.path.toLowerCase();
        if (seen.has(folded)) return false;
        seen.add(folded);
    }
    return true;
}

const EmbeddedFileArraySchema = z
    .array(EmbeddedFileSchema)
    .refine(uniqueByPath, { message: "duplicate path in file list" })
    .refine(uniqueByCaseFoldedPath, {
        message: "case-folded duplicate path (FAT32 portability)",
    });

// ---- Top-level blocks ------------------------------------------------------

export const MetaSchema = z.object({
    name: z.string().min(1, "meta.name is required"),
    author: z.string().optional(),
    description: z.string().optional(),
    // ISO 8601. We accept the common forms Zod's .iso.datetime validates:
    // "2026-04-21T12:00:00Z", with optional milliseconds, with Z or ±HH:MM.
    created_at: z.iso.datetime({ offset: true }),
    tags: z.array(z.string()).optional(),
    // W33 reserved fields — displayed with `(UNVERIFIED)` until a
    // sidecar signature checks out under the user's local trust roster.
    // See docs/91-reserved-meta-fields-spec.md §2 + §6.
    //
    // S961 (Angle X): scheme allowlist. `z.url()` accepts any RFC3986
    // URL — including `javascript:`, `data:`, `file:`, `vbscript:` —
    // which become click-through hazards when the v0.13 GUI consumes
    // this for a "view source" button. Restrict to schemes that make
    // sense for "where did this Setup come from": http(s) for repos
    // and download pages, mailto for author contact, git+https for
    // package-style references.
    source_url: z.string().url().refine(
        (v) => /^(https?:|mailto:|git\+https:)/i.test(v),
        { message: "source_url scheme must be http, https, mailto, or git+https" },
    ).optional(),
    version: z.string().optional(),
    // W39 closes S963: shape must match `sidecar.signer_key_id` so a
    // verifier can compare directly. SHA256_HEX is the keyIdFromPublicKey
    // output (sha256 of raw 32B Ed25519 pubkey, lowercase hex).
    author_key_id: z.string().regex(
        SHA256_HEX,
        "author_key_id must be 'sha256:' + 64 lowercase hex chars (matches sidecar.signer_key_id)",
    ).optional(),
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
    settings: z.record(SettingKeySchema, SettingValueSchema).optional(),
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

    // S962 (Angle X): `issue.path` segments are author-controlled — for
    // `settings.<key>` validation issues, the segment is the literal key
    // bytes (`settings.kosync.username`), and an attacker key like
    // `\x1b]0;pwn\x07kosync` would inject OSC bytes into the thrown
    // Error.message. Renderers sanitize stdout/stderr, but `e.message`
    // direct reads (test harnesses, GUI serve IPC error envelopes,
    // future log forwarders) bypass the renderer. Strip at construction.
    const issues = result.error.issues;
    const summary = issues
        .slice(0, 5)
        .map((i) => {
            const path = i.path.length
                ? i.path.map((seg) => sanitizeForTerminal(String(seg))).join(".")
                : "<root>";
            return `${path}: ${sanitizeForTerminal(i.message)}`;
        })
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
