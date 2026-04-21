// `kindly restore <archive>` — extract a snapshot over <mount>/koreader/.
//
// Safety:
//   - Takes a pre-restore snapshot of the CURRENT state first (unless
//     --no-safety-snapshot is passed). If the restore goes wrong, you can
//     re-extract that snapshot to roll back.
//   - `--dry-run` lists what would be extracted without writing anything.
//
// Overwrite semantics: tar replaces files file-by-file. Files present on
// device but not in the archive are LEFT UNTOUCHED (tar doesn't delete
// anything it doesn't know about — this is the sane default; if you want
// a clean slate, factory-reset first).

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import { dim, heading, info, ok, warn } from "../cli/log.ts";
import { createTarGz, extractTarGz, listTarGz } from "../fs/archive.ts";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const FLAGS = {
    "dry-run": {
        type: "boolean",
        default: false,
        description: "list what would be extracted without writing",
    },
    "safety-snapshot": {
        type: "boolean",
        default: true,
        description: "take a pre-restore snapshot of current device state (use --no-safety-snapshot to skip)",
    },
    mount: {
        type: "string",
        description: "path to a mounted Kindle (auto-detected by default)",
    },
} as const satisfies FlagSpecs;

const SAFETY_PATHS = [
    "settings.reader.lua",
    "settings.reader.lua.old",
    "defaults.custom.lua",
    "history.lua",
    "patches",
    "plugins",
];

export async function runRestore(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags, positional } = parseArgs(argv, FLAGS);
    const archive = positional[0];
    if (!archive) {
        throw new Error("usage: kindly restore <archive.tar.gz> [--dry-run]");
    }
    const archivePath = resolve(env.cwd, archive);
    if (!existsSync(archivePath)) {
        throw new Error(`archive not found: ${archivePath}`);
    }

    if (flags.mount) env = { ...env, mountOverride: flags.mount };
    const mount = resolveMount(env);

    const entries = listTarGz(archivePath);

    if (flags["dry-run"]) {
        heading(env, `would extract ${entries.length} entries into ${mount.koreaderRoot}:`);
        for (const e of entries.slice(0, 50)) info(env, `  ${e}`);
        if (entries.length > 50) info(env, dim(env, `  ... and ${entries.length - 50} more`));
        info(env, "");
        info(env, dim(env, "(--dry-run — nothing written)"));
        return 0;
    }

    // Pre-restore safety snapshot. Rollback = extract this back over the
    // koreader dir if something goes wrong.
    if (flags["safety-snapshot"]) {
        const safetyPath = resolve(
            env.cwd,
            ".kindly",
            "pre-restore",
            `${isoStamp(env.now())}.tar.gz`
        );
        try {
            const saf = createTarGz({
                cwd: mount.koreaderRoot,
                paths: SAFETY_PATHS,
                outputPath: safetyPath,
            });
            info(env, dim(env, `safety snapshot: ${saf.archivePath} (${saf.includedPaths.length} root path(s))`));
        } catch (e) {
            // If the device is empty (fresh install with no settings file),
            // no safety snapshot is possible — just warn and continue.
            warn(env, `could not create safety snapshot: ${(e as Error).message}`);
            warn(env, "  proceeding anyway — nothing to roll back from if restore fails.");
        }
    }

    info(env, dim(env, `extracting ${entries.length} entries into ${mount.koreaderRoot}...`));
    const res = extractTarGz({ archivePath, destRoot: mount.koreaderRoot });

    ok(env, `restored ${res.fileCount} file(s) into ${res.destRoot}`);
    warn(env, "restart KOReader (or your Kindle) for changes to take effect.");
    return 0;
}

function isoStamp(d: Date): string {
    return d.toISOString().replace(/[:.]/g, "-");
}

export const restoreHelp = `
kindly restore <archive> — extract a snapshot back into the Kindle.

usage: kindly restore <archive.tar.gz> [--dry-run] [--no-safety-snapshot] [--mount <path>]

  --dry-run              list entries without writing
  --no-safety-snapshot   skip the pre-restore snapshot of current state
  --mount <path>         path to a mounted Kindle (auto-detect by default)

By default, takes a safety snapshot of the CURRENT device state first. If
restore goes wrong, re-extract that file to roll back. The safety snapshot
lives under <cwd>/.kindly/pre-restore/.

Restore overwrites file-by-file. Files on device not in the archive are
left untouched — use factory reset for a true clean slate.
`.trim();
