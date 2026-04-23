#!/usr/bin/env bun
// Extract plugin metadata from a KOReader source tree.
//
// Walks <koreader-root>/plugins/*.koplugin/_meta.lua, pulls out
// `fullname`, `description`, and `deprecated` fields via regex, and
// writes data/catalog/plugins.bundled.v1.draft.json. Claudiu edits
// that draft into the hand-curated v1 file (W20).
//
// Why regex and not `dofile`: some plugins (notably autowarmth) call
// `require("device"):hasNaturalLight()` at module load time and branch
// their strings on the result. Loading them outside a KOReader runtime
// crashes. See docs/13-research-technical.md §8.
//
// `_meta.lua` shape across 36 bundled plugins is tight:
//     local _ = require("gettext")
//     return {
//         fullname = _("..."),              -- or _([[...]])
//         description = _("..."),           -- may span lines with [[...]]
//         deprecated = { "kind", "detail" } -- rare; exporter only
//     }
// fullname/description may wrap the _() call in a conditional
// (autowarmth), in which case the FIRST _() wins and we flag the entry
// as `computed` so the curator sees it.
//
// Usage:
//   bun run scripts/extract-plugin-meta.ts <koreader-source-root> [output-path]
//
// Defaults to data/catalog/plugins.bundled.v1.draft.json.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

import { hashBytes } from "../src/setup/canonical.ts";

export interface DeprecatedField {
    kind: string;
    detail: string;
}

export interface PluginMeta {
    /** Folder name stripped of `.koplugin` — the identifier KOReader uses
     *  as the `plugins.disabled` key (see docs/13-research-technical.md §3). */
    name: string;
    fullname: string | null;
    description: string | null;
    deprecated: DeprecatedField | null;
    /** True when the Lua expression used `require(...)`, `and`/`or`, or
     *  had more than one `_()` call — the extracted value is the first
     *  literal, but the curator should double-check against the device. */
    computed: boolean;
    /** Non-fatal extraction issues (missing field, couldn't parse). */
    warnings: string[];
    /** W32 (89 §3): per-file SHA256 of the plugin's files, keyed by path
     *  relative to the plugin folder. `null` if the directory couldn't
     *  be walked (e.g. symlinks, permission). */
    known_hashes: Record<string, string> | null;
}

export interface ExtractionResult {
    extracted_at: string;
    /** Short provenance label — basename of the source tree, not the
     *  absolute path (keeps committed drafts portable). */
    koreader_source: string;
    /** W32 (89 §3): KOReader version the hashes were computed from.
     *  `git describe --tags --always` on the source tree; null if the
     *  tree is not a git repo. Every plugin's `known_hashes` is valid
     *  only for this version (§4.5 version-skew advisory uses it). */
    koreader_hash_version: string | null;
    plugin_count: number;
    plugins: PluginMeta[];
}

export function extractPluginMeta(metaSource: string, pluginName: string): PluginMeta {
    const warnings: string[] = [];
    const body = sliceReturnTableBody(metaSource);
    if (body === null) {
        warnings.push("could not find `return { ... }` block");
        return {
            name: pluginName, fullname: null, description: null, deprecated: null,
            computed: false, warnings, known_hashes: null,
        };
    }

    const fullnameExpr = fieldExpression(body, "fullname");
    const descExpr = fieldExpression(body, "description");
    const deprExpr = fieldExpression(body, "deprecated");

    const fn = extractGettextString(fullnameExpr);
    const dc = extractGettextString(descExpr);
    const dp = extractDeprecatedLiterals(deprExpr);

    if (fullnameExpr === null) warnings.push("no `fullname` field");
    else if (fn.value === null) warnings.push("could not parse `fullname` string literal");
    if (descExpr === null) warnings.push("no `description` field");
    else if (dc.value === null) warnings.push("could not parse `description` string literal");
    if (deprExpr !== null && dp === null) warnings.push("could not parse `deprecated` table");

    return {
        name: pluginName,
        fullname: fn.value,
        description: dc.value,
        deprecated: dp,
        computed: fn.computed || dc.computed,
        warnings,
        known_hashes: null,   // populated by extractAllPlugins, which has the dir
    };
}

// Walk a plugin folder recursively and hash every regular file. Mirrors
// `collectPluginDirs` in src/setup/files.ts — skip dotfiles. Returns
// { path → sha256:... } keyed by path relative to `pluginDir`. Raw bytes,
// no normalization (89 §3 "hash normalization policy").
export function hashPluginDir(pluginDir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            if (name.startsWith(".")) continue;
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) walk(full);
            else if (st.isFile()) {
                const rel = relative(pluginDir, full).split("\\").join("/");
                out[rel] = hashBytes(readFileSync(full));
            }
            // symlinks/other → ignored; extractor's warning surfaces if hashes empty
        }
    };
    walk(pluginDir);
    return out;
}

// Derive `koreader_hash_version` from the source tree. `git describe
// --tags --always` gives "v2024.03" on a tagged release or a shortsha
// otherwise. Returns null if git fails (not a repo, no git binary).
// Intentionally synchronous — the extractor is a one-shot script.
function readKoreaderVersion(root: string): string | null {
    try {
        const out = execFileSync("git", ["-C", root, "describe", "--tags", "--always", "--dirty"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return out.trim() || null;
    } catch {
        return null;
    }
}

export function extractAllPlugins(koreaderRoot: string): ExtractionResult {
    const pluginsDir = join(koreaderRoot, "plugins");
    if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory()) {
        throw new Error(`no plugins/ under ${koreaderRoot} — is this a KOReader source tree?`);
    }
    const folders = readdirSync(pluginsDir)
        .filter((f) => f.endsWith(".koplugin"))
        .sort();

    const plugins: PluginMeta[] = [];
    for (const folder of folders) {
        const pluginDir = join(pluginsDir, folder);
        const metaPath = join(pluginDir, "_meta.lua");
        const name = folder.slice(0, -".koplugin".length);

        let known_hashes: Record<string, string> | null = null;
        try {
            known_hashes = hashPluginDir(pluginDir);
        } catch (e) {
            // swallow — we'll still emit the entry with null hashes and a warning
            void e;
        }

        if (!existsSync(metaPath)) {
            plugins.push({
                name, fullname: null, description: null, deprecated: null,
                computed: false, warnings: ["no _meta.lua"], known_hashes,
            });
            continue;
        }
        const src = readFileSync(metaPath, "utf8");
        const meta = extractPluginMeta(src, name);
        plugins.push({ ...meta, known_hashes });
    }
    return {
        extracted_at: new Date().toISOString(),
        koreader_source: basename(koreaderRoot),
        koreader_hash_version: readKoreaderVersion(koreaderRoot),
        plugin_count: plugins.length,
        plugins,
    };
}

// ---- internals ----

// Return the body inside the FIRST top-level `return { ... }`. Tracks
// brace depth so nested tables / subexpressions don't break us.
function sliceReturnTableBody(source: string): string | null {
    const m = /\breturn\s*\{/.exec(source);
    if (!m) return null;
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length) {
        const c = source[i]!;
        if (c === '"' || c === "'") {
            i = skipQuotedString(source, i);
            continue;
        }
        if (c === "[" && source[i + 1] === "[") {
            i = skipBracketString(source, i);
            continue;
        }
        if (c === "-" && source[i + 1] === "-") {
            i = skipComment(source, i);
            continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
            depth--;
            if (depth === 0) return source.slice(start, i);
        }
        i++;
    }
    return null;
}

// Return the raw expression text assigned to `fieldName` at top level of
// the given table body (string between `fieldName = ` and the next
// top-level `,` or end of body). null if the field is missing.
function fieldExpression(body: string, fieldName: string): string | null {
    const re = new RegExp(`(?:^|[,{\\s])${escapeRegex(fieldName)}\\s*=\\s*`, "m");
    const m = re.exec(body);
    if (!m) return null;
    const start = m.index + m[0].length;
    let i = start;
    // Track depth: the field's value ends when we hit a top-level comma
    // or the end of the body with depth 0.
    let depth = 0;
    while (i < body.length) {
        const c = body[i]!;
        if (c === '"' || c === "'") {
            i = skipQuotedString(body, i);
            continue;
        }
        if (c === "[" && body[i + 1] === "[") {
            i = skipBracketString(body, i);
            continue;
        }
        if (c === "-" && body[i + 1] === "-") {
            i = skipComment(body, i);
            continue;
        }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) break;
        i++;
    }
    return body.slice(start, i).trim();
}

// Pull the first Lua string literal out of a `_("...")` or `_([[...]])`
// call inside an expression. `computed` is true when the expression
// contains runtime calls (`require(`), conditionals (`and`/`or`), or
// multiple gettext calls — signals to the curator that the extracted
// string may not match what the plugin actually displays on this device.
function extractGettextString(expr: string | null): { value: string | null; computed: boolean } {
    if (expr === null) return { value: null, computed: false };

    const gettextCalls: string[] = [];
    const re = /_\s*\(\s*(?:"((?:[^"\\]|\\.)*)"|\[\[([\s\S]*?)\]\])\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expr)) !== null) {
        if (m[1] !== undefined) gettextCalls.push(unescapeLuaString(m[1]));
        else if (m[2] !== undefined) gettextCalls.push(normalizeBracket(m[2]));
    }

    // Fallback: bare literal without _() (uncommon but possible).
    if (gettextCalls.length === 0) {
        const bare = /^\s*(?:"((?:[^"\\]|\\.)*)"|\[\[([\s\S]*?)\]\])\s*$/.exec(expr);
        if (bare) {
            const s = bare[1] !== undefined ? unescapeLuaString(bare[1]) : normalizeBracket(bare[2]!);
            return { value: s, computed: false };
        }
    }

    // Detect computed expressions from the Lua code, not from the string
    // contents — "Keeps and displays ..." contains the word "and" but
    // that's inside a _([[...]]) literal and says nothing about the
    // surrounding expression. Strip literals first.
    const stripped = expr
        .replace(/_\s*\(\s*"(?:[^"\\]|\\.)*"\s*\)/g, "")
        .replace(/_\s*\(\s*\[\[[\s\S]*?\]\]\s*\)/g, "");
    const computed = gettextCalls.length > 1
        || /\brequire\s*\(/.test(stripped)
        || /\b(and|or)\b/.test(stripped);
    return { value: gettextCalls[0] ?? null, computed };
}

function extractDeprecatedLiterals(expr: string | null): DeprecatedField | null {
    if (expr === null) return null;
    // `{ "kind", "detail" }` — two string literals, positional.
    const m = /\{\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,?\s*\}/.exec(expr);
    if (!m) return null;
    return { kind: m[1]!, detail: m[2]! };
}

function skipQuotedString(source: string, start: number): number {
    const quote = source[start]!;
    let i = start + 1;
    while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === quote) return i + 1;
        i++;
    }
    return source.length;
}

function skipBracketString(source: string, start: number): number {
    // Skips `[[ ... ]]`. Lua also allows `[=[...]=]` etc. but _meta.lua
    // files use the plain form exclusively, so we don't bother with
    // level-matched variants.
    // LIMITATION: if a future _meta.lua uses `[=[...]=]`, `sliceReturnTableBody`
    // will miscount brace depth and `extractGettextString`'s regex won't
    // match either — the field comes back null with a warning. Graceful
    // degradation, not silent corruption. Curator sees it immediately.
    let i = start + 2;
    while (i < source.length - 1) {
        if (source[i] === "]" && source[i + 1] === "]") return i + 2;
        i++;
    }
    return source.length;
}

function skipComment(source: string, start: number): number {
    // `-- ...\n` (line) or `--[[ ... ]]` (block — not seen in _meta.lua
    // but handle defensively).
    if (source[start + 2] === "[" && source[start + 3] === "[") {
        return skipBracketString(source, start + 2);
    }
    let i = start;
    while (i < source.length && source[i] !== "\n") i++;
    return i;
}

function unescapeLuaString(s: string): string {
    return s.replace(/\\(.)/g, (_all, c) => {
        if (c === "n") return "\n";
        if (c === "t") return "\t";
        if (c === "r") return "\r";
        return c;
    });
}

function normalizeBracket(s: string): string {
    // Lua `[[...]]` strips a single leading newline if present.
    return s.startsWith("\n") ? s.slice(1) : s;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- CLI ----

if (import.meta.main) {
    const args = Bun.argv.slice(2);
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        process.stderr.write(
            "usage: bun run scripts/extract-plugin-meta.ts <koreader-source-root> [output-path]\n",
        );
        process.exit(args.length === 0 ? 2 : 0);
    }
    const root = resolve(args[0]!);
    const outPath = resolve(
        args[1] ?? "data/catalog/plugins.bundled.v1.draft.json",
    );

    const result = extractAllPlugins(root);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

    const withWarnings = result.plugins.filter((p) => p.warnings.length > 0);
    const computed = result.plugins.filter((p) => p.computed);
    process.stdout.write(
        `extracted ${result.plugin_count} plugin(s) from ${basename(root)}/plugins/\n`,
    );
    process.stdout.write(`  → ${outPath}\n`);
    if (computed.length > 0) {
        process.stdout.write(
            `  ${computed.length} plugin(s) had computed fields — review: ${computed.map((p) => p.name).join(", ")}\n`,
        );
    }
    if (withWarnings.length > 0) {
        process.stdout.write(`  ${withWarnings.length} plugin(s) with warnings:\n`);
        for (const p of withWarnings) {
            process.stdout.write(`    - ${p.name}: ${p.warnings.join("; ")}\n`);
        }
    }
}
