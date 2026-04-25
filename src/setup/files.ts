// Scan/install helpers for fat Setups' plugin dirs and patch files.
//
// Export side: walk `<koreader>/plugins/*.koplugin/` and
// `<koreader>/patches/*.lua`, hash every file, emit (declared, files)
// pairs ready to feed into packSetup.
//
// Import side: given the same (declared, files) shape, write the plugin
// dirs and patch files into place under `<koreader>/plugins/` and
// `<koreader>/patches/`. Plugin dirs are wiped-and-replaced (the safety
// snapshot holds the original); patch files are overwritten.
//
// Hidden files (`.DS_Store`, `.git/`, etc.) are always skipped on export.
// Paths are POSIX, relative, and already schema-validated via
// isSafeRelativePath() on the manifest side.

import {
    mkdirSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { exists, readBytes } from "../fs/safeRead.ts";
import { hashBytes } from "./canonical.ts";
import { isSafeRelativePath, type EmbeddedFile } from "./schema.ts";

export type CollectedFiles = {
    declared: EmbeddedFile[];
    files: Map<string, Buffer>;
};

// Walk a plugin-dir root (`<koreader>/plugins/`) and collect every file
// under each *.koplugin/ subdirectory. Path keys are relative to the
// plugins root, e.g. "SSH.koplugin/main.lua".
export function collectPluginDirs(pluginsRoot: string): CollectedFiles {
    if (!exists(pluginsRoot, "derived-from-mount")) return { declared: [], files: new Map() };

    const declared: EmbeddedFile[] = [];
    const files = new Map<string, Buffer>();

    const entries = readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .filter((e) => e.name.endsWith(".koplugin"))
        .filter((e) => !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

    for (const pluginDir of entries) {
        walkCollect(join(pluginsRoot, pluginDir), pluginDir, declared, files);
    }
    return { declared, files };
}

// Walk a patches root (`<koreader>/patches/`) and collect every top-level
// `*.lua` file. KOReader looks for `N-name.lua` files; non-lua files are
// ignored. Subdirectories are not scanned (KOReader doesn't use them).
// List every `<name>.koplugin/` directory under the plugins root, returning
// the bare plugin name (suffix stripped). Used to validate plugin toggles
// at import time: a `plugins.disabled` entry that names a plugin not in
// this list is inert — KOReader has nothing to toggle.
export function listInstalledPluginFolders(pluginsRoot: string): string[] {
    if (!exists(pluginsRoot, "derived-from-mount")) return [];
    return readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.endsWith(".koplugin"))
        .filter((e) => !e.name.startsWith("."))
        .map((e) => e.name.slice(0, -".koplugin".length))
        .sort();
}

// Return the toggle names that don't correspond to an installed plugin
// folder. Order matches the input so callers can correlate with the
// original list.
export function findInertToggles(
    toggles: readonly string[],
    installedFolders: readonly string[],
): string[] {
    const set = new Set(installedFolders);
    return toggles.filter((name) => !set.has(name));
}

export function collectPatches(patchesRoot: string): CollectedFiles {
    if (!exists(patchesRoot, "derived-from-mount")) return { declared: [], files: new Map() };

    const declared: EmbeddedFile[] = [];
    const files = new Map<string, Buffer>();

    const entries = readdirSync(patchesRoot, { withFileTypes: true })
        .filter((e) => e.isFile())
        .filter((e) => e.name.endsWith(".lua"))
        .filter((e) => !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();

    for (const name of entries) {
        const abs = join(patchesRoot, name);
        const buf = readBytes(abs, "derived-from-mount");
        const rel = name;                 // flat: no nested dirs
        if (!isSafeRelativePath(rel)) continue;
        declared.push({
            path: rel,
            hash: hashBytes(buf),
            bytes: buf.length,
        });
        files.set(rel, buf);
    }
    return { declared, files };
}

function walkCollect(
    absDir: string,
    relPrefix: string,
    declared: EmbeddedFile[],
    files: Map<string, Buffer>,
): void {
    // S901 / Angle C: code-unit comparison, NOT localeCompare. Bun/JSC
    // hardcodes en-US; Node honors LC_ALL. Using localeCompare here makes
    // walkCollect output (and therefore canonical manifest hash) drift
    // across runtime/locale. Code-unit ordering is a pure function of the
    // string bytes — portable across every JS runtime and every locale.
    const entries = readdirSync(absDir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))   // skip .DS_Store, .git/, ...
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
        const abs = join(absDir, e.name);
        const rel = posix.join(relPrefix, e.name);
        if (e.isDirectory()) {
            walkCollect(abs, rel, declared, files);
        } else if (e.isFile()) {
            if (!isSafeRelativePath(rel)) continue;
            const buf = readBytes(abs, "derived-from-mount");
            declared.push({
                path: rel,
                hash: hashBytes(buf),
                bytes: buf.length,
            });
            files.set(rel, buf);
        }
        // Symlinks and specials are intentionally skipped.
    }
}

// Install plugin files onto disk under `<koreader>/plugins/`. Each
// declared top-level plugin dir is removed first — we don't overlay
// onto a prior version because stale files can break the new plugin.
// The safety snapshot holds the original.
export function installPluginFiles(
    pluginsRoot: string,
    declared: readonly EmbeddedFile[],
    files: ReadonlyMap<string, Buffer>,
): void {
    if (declared.length === 0) return;

    // Collect the top-level plugin dirs we're about to write (first
    // path segment).
    const topLevelDirs = new Set<string>();
    for (const d of declared) {
        const seg = d.path.split("/")[0]!;
        topLevelDirs.add(seg);
    }

    if (!exists(pluginsRoot, "derived-from-mount")) mkdirSync(pluginsRoot, { recursive: true });

    // Wipe existing.
    for (const name of topLevelDirs) {
        const target = join(pluginsRoot, name);
        if (exists(target, "derived-from-mount")) rmSync(target, { recursive: true, force: true });
    }

    // Lay down new.
    for (const d of declared) {
        if (!isSafeRelativePath(d.path)) {
            throw new Error(`refusing to install unsafe path: ${d.path}`);
        }
        const bytes = files.get(d.path);
        if (!bytes) {
            throw new Error(`missing bytes for declared file: ${d.path}`);
        }
        const abs = join(pluginsRoot, d.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
    }
}

// Install patch files under `<koreader>/patches/`. Overwrites existing
// files of the same name (safety snapshot has the original).
export function installPatches(
    patchesRoot: string,
    declared: readonly EmbeddedFile[],
    files: ReadonlyMap<string, Buffer>,
): void {
    if (declared.length === 0) return;
    if (!exists(patchesRoot, "derived-from-mount")) mkdirSync(patchesRoot, { recursive: true });

    for (const d of declared) {
        if (!isSafeRelativePath(d.path)) {
            throw new Error(`refusing to install unsafe path: ${d.path}`);
        }
        const bytes = files.get(d.path);
        if (!bytes) {
            throw new Error(`missing bytes for declared file: ${d.path}`);
        }
        const abs = join(patchesRoot, d.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
    }
}

// Compute the on-device paths a fat install would touch. Used by the
// caller to build a safety snapshot (tar these up before overwriting).
// Paths that don't currently exist are included — absence is itself a
// state worth capturing if we're about to create them.
export function affectedPluginTargets(
    pluginsRoot: string,
    declared: readonly EmbeddedFile[],
): string[] {
    const top = new Set<string>();
    for (const d of declared) top.add(d.path.split("/")[0]!);
    return Array.from(top).sort().map((name) => join(pluginsRoot, name));
}

export function affectedPatchTargets(
    patchesRoot: string,
    declared: readonly EmbeddedFile[],
): string[] {
    return declared.map((d) => join(patchesRoot, d.path)).sort();
}

// Total byte count — for disclosure messages ("ships 12.4 KB of code").
export function totalBytes(declared: readonly EmbeddedFile[]): number {
    let n = 0;
    for (const d of declared) n += d.bytes;
    return n;
}

// Group declared plugin files by top-level koplugin dir for display
// purposes: [{dir: "SSH.koplugin", fileCount, bytes}, ...]
export function summarizePluginsByDir(
    declared: readonly EmbeddedFile[],
): { dir: string; fileCount: number; bytes: number }[] {
    const byDir = new Map<string, { fileCount: number; bytes: number }>();
    for (const d of declared) {
        const top = d.path.split("/")[0]!;
        const cur = byDir.get(top) ?? { fileCount: 0, bytes: 0 };
        cur.fileCount++;
        cur.bytes += d.bytes;
        byDir.set(top, cur);
    }
    return Array.from(byDir.entries())
        .map(([dir, { fileCount, bytes }]) => ({ dir, fileCount, bytes }))
        .sort((a, b) => a.dir.localeCompare(b.dir));
}
