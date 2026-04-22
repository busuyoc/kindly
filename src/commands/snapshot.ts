// `kindly snapshot` — tarball of user-state under <mount>/koreader/.
//
// Captures the things kindly.yaml can't:
//   - settings.reader.lua (and .old)        — declarative YAML covers most
//   - defaults.custom.lua                    — user overrides for defaults.lua
//   - history.lua                            — reading history (PII!)
//   - patches/                               — user-written Lua patches
//   - plugins/                               — all plugins, including those
//                                              shipped with KOReader (we
//                                              don't distinguish; see A2 in
//                                              docs/40-v0.2-snapshot.md)
//
// Output is NOT safe to commit to git — it contains the plaintext secrets
// from settings.reader.lua. The CLI warns about this.

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, info, ok, warn } from "../cli/log.ts";
import { createTarGz } from "../fs/archive.ts";
import { resolve } from "node:path";
import type { SnapshotResult } from "../types/results.ts";
import { emitJson } from "../cli/json.ts";
import { appendHistoryEntry } from "../history/writer.ts";

const FLAGS = {
    output: {
        type: "string",
        description: "archive output path (default: ./kindly-snapshot-<iso>.tar.gz)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

// Paths relative to <mount>/koreader/. See docs/40-v0.2-snapshot.md §A1.
const SNAPSHOT_PATHS = [
    "settings.reader.lua",
    "settings.reader.lua.old",
    "defaults.custom.lua",
    "history.lua",
    "patches",
    "plugins",
];

export interface SnapshotOptions {
    output?: string;
}

export function executeSnapshot(opts: SnapshotOptions, env: CliEnv): SnapshotResult {
    const mount = resolveMount(env);
    const outputPath = opts.output
        ? resolve(env.cwd, opts.output)
        : resolve(env.cwd, `kindly-snapshot-${isoStamp(env.now())}.tar.gz`);

    const res = createTarGz({
        cwd: mount.koreaderRoot,
        paths: SNAPSHOT_PATHS,
        outputPath,
    });

    appendHistoryEntry(env, "snapshot", { archive_path: res.archivePath });

    return {
        archivePath: res.archivePath,
        bytesWritten: res.bytesWritten,
        includedPaths: res.includedPaths,
        skippedPaths: res.skippedPaths,
    };
}

export function renderSnapshot(result: SnapshotResult, env: CliEnv): void {
    ok(env, `wrote ${result.archivePath}`);
    info(env, dim(env, `  ${formatBytes(result.bytesWritten)}, ${result.includedPaths.length} root path(s)`));
    for (const p of result.includedPaths) info(env, `    ${p}`);

    if (result.skippedPaths.length > 0) {
        info(env, dim(env, `  not present on device (skipped): ${result.skippedPaths.join(", ")}`));
    }

    warn(env, "this archive contains plaintext secrets — do NOT commit to git.");
    info(env, dim(env, "  (secrets live in settings.reader.lua: PIN, zlibrary password, device_id, etc.)"));
}

export async function runSnapshot(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };

    const result = executeSnapshot({ output: flags.output }, env);
    if (env.jsonMode) emitJson(env, "snapshot", result);
    else renderSnapshot(result, env);
    return 0;
}

function isoStamp(d: Date): string {
    return d.toISOString().replace(/[:.]/g, "-");
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const snapshotHelp = `
kindly snapshot — tar the user-state directories from the Kindle.

usage: kindly snapshot [--output <path>] [--mount <path>]

Captures: settings.reader.lua (+.old), defaults.custom.lua, history.lua,
patches/, plugins/ — the things kindly.yaml doesn't track.

  --output <path>  archive path (default: ./kindly-snapshot-<iso>.tar.gz)
  --mount <path>   path to a mounted Kindle (auto-detect by default)

Output contains plaintext secrets — do NOT commit to git. Store in a
password-manager-grade location (or at least outside a public repo).
`.trim();
