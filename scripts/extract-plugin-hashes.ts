#!/usr/bin/env bun
// Populate `known_hashes` on every entry of plugins.bundled.v1.json by
// hashing the corresponding plugin folder in a KOReader source tree.
// Also stamps `koreader_hash_version` on the catalog so the version-skew
// advisory has a value to compare against.
//
// Closes the W32 gap flagged in the v0.11.1 red-team session: catalog
// entries existed with `known_hashes` omitted, so every catalogued
// plugin resolved to UNVERIFIED — and --strict-imports tolerated that,
// making the import pipeline trust-by-name-only.
//
// Usage:
//   bun run scripts/extract-plugin-hashes.ts <koreader-source-root> [catalog-path]
//
// Defaults catalog-path to data/catalog/plugins.bundled.v1.json.
//
// `koreader_hash_version`: the script reads <root>/.git HEAD if available
// and records `git-<short>`. If the source isn't a git checkout, it
// stamps the directory mtime instead (best-effort, flagged clearly).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join, relative } from "node:path";

import { hashBytes } from "../src/setup/canonical.ts";
import type { PluginCatalog, KnownHashes } from "../src/catalog/reader.ts";

function walkFiles(dir: string, root = dir): string[] {
    const out: string[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walkFiles(abs, root));
        else if (ent.isFile()) out.push(relative(root, abs));
    }
    return out.sort();
}

function hashPluginFolder(folderAbs: string): KnownHashes {
    const hashes: KnownHashes = {};
    for (const rel of walkFiles(folderAbs)) {
        const bytes = readFileSync(join(folderAbs, rel));
        hashes[rel] = hashBytes(bytes);
    }
    return hashes;
}

function detectHashVersion(root: string): string {
    if (existsSync(join(root, ".git"))) {
        try {
            const sha = execSync("git rev-parse --short=10 HEAD", {
                cwd: root, encoding: "utf8",
            }).trim();
            return `git-${sha}`;
        } catch { /* fall through */ }
    }
    const mtime = statSync(root).mtime.toISOString().slice(0, 10);
    return `mtime-${mtime}`;
}

function main(argv: string[]): void {
    const [rootArg, catalogArg] = argv;
    if (!rootArg) {
        console.error("usage: bun run scripts/extract-plugin-hashes.ts <koreader-src> [catalog-path]");
        process.exit(2);
    }
    const root = rootArg;
    const catalogPath = catalogArg ?? "data/catalog/plugins.bundled.v1.json";
    const pluginsRoot = join(root, "plugins");
    if (!existsSync(pluginsRoot)) {
        console.error(`error: ${pluginsRoot} does not exist — is that a KOReader source tree?`);
        process.exit(2);
    }

    const raw = JSON.parse(readFileSync(catalogPath, "utf8")) as PluginCatalog;
    const hashVersion = detectHashVersion(root);

    let hashed = 0;
    let missing = 0;
    for (const entry of raw.plugins) {
        const folderAbs = join(pluginsRoot, entry.folder);
        if (!existsSync(folderAbs)) {
            console.warn(`missing folder for ${entry.name}: ${entry.folder}`);
            entry.known_hashes = null;
            missing++;
            continue;
        }
        entry.known_hashes = hashPluginFolder(folderAbs);
        hashed++;
    }

    raw.koreader_hash_version = hashVersion;
    raw.koreader_source = basename(root);

    writeFileSync(catalogPath, JSON.stringify(raw, null, 2) + "\n");
    console.log(`✓ hashed ${hashed} plugin(s), ${missing} missing from source tree`);
    console.log(`  koreader_hash_version: ${hashVersion}`);
    console.log(`  catalog: ${catalogPath}`);
}

main(process.argv.slice(2));
