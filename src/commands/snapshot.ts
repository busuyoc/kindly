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
import { join, resolve } from "node:path";

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

export async function runSnapshot(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);
    if (flags.mount) env = { ...env, mountOverride: flags.mount };
    const mount = resolveMount(env);

    const outputPath = flags.output
        ? resolve(env.cwd, flags.output)
        : resolve(env.cwd, `kindly-snapshot-${isoStamp(env.now())}.tar.gz`);

    info(env, dim(env, `archiving ${mount.koreaderRoot}`));
    const res = createTarGz({
        cwd: mount.koreaderRoot,
        paths: SNAPSHOT_PATHS,
        outputPath,
    });

    ok(env, `wrote ${res.archivePath}`);
    info(env, dim(env, `  ${formatBytes(res.bytesWritten)}, ${res.includedPaths.length} root path(s)`));
    for (const p of res.includedPaths) info(env, `    ${p}`);

    if (res.skippedPaths.length > 0) {
        info(env, dim(env, `  not present on device (skipped): ${res.skippedPaths.join(", ")}`));
    }

    warn(env, "this archive contains plaintext secrets — do NOT commit to git.");
    info(env, dim(env, "  (secrets live in settings.reader.lua: PIN, zlibrary password, device_id, etc.)"));

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
