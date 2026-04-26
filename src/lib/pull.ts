// Library entry point for `pull` — read device settings, filter, write YAML.
// Pure: returns a typed result; never prints. Throws KindlyError on user-
// visible failures (missing settings, output collision, missing mount).
//
// Commands use this via src/commands/pull.ts (text/JSON rendering). serve
// reaches it transitively through the CLI dispatcher (W26 argv passthrough).

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";
import { detectInterruptedApply } from "../fs/interruptedApply.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { luaToYaml } from "../schema/yaml.ts";
import type { LuaTable } from "../lua/writer.ts";
import { type CliEnv, resolveMount } from "../cli/env.ts";
import type { PullResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

/** Phase-1 provenance header format (Step 13). Single line prepended to
 *  every pulled YAML. Phase 1 is record-only — the normalizedYaml
 *  producer will observe the header but does not change gate behavior.
 *  Phase 2 (future): auto-bypass apply gates when the header matches
 *  the current device state. */
function provenanceHeader(deviceSrc: string, nowIso: string): string {
    const hash = createHash("sha256").update(deviceSrc, "utf8").digest("hex");
    return `# kindly-provenance: sha256:${hash} ts:${nowIso}\n`;
}

export interface PullOptions {
    full?: boolean;
    output?: string;
    force?: boolean;
}

export function executePull(opts: PullOptions, env: CliEnv): PullResult {
    const mount = resolveMount(env);
    const settingsPath = mount.settingsPath;

    if (!exists(settingsPath, "derived-from-mount")) {
        const interrupted = detectInterruptedApply(settingsPath);
        if (interrupted) {
            throw new KindlyError(
                ErrorCodes.SETTINGS_INTERRUPTED_APPLY,
                `${settingsPath} is missing but ${interrupted.oldPath} survives — a previous kindly apply / setup import was interrupted between rename steps.`,
                [
                    {
                        text: "Recover by promoting .old back into place.",
                        command: "kindly doctor --repair",
                    },
                ],
            );
        }
        throw new KindlyError(
            ErrorCodes.SETTINGS_NOT_FOUND,
            `Kindle mount found at ${mount.root}, but ${settingsPath} doesn't exist. ` +
            `Is KOReader installed on this Kindle?`,
            [{ text: "Install KOReader on the Kindle, then retry." }],
        );
    }

    const src = readText(settingsPath, "derived-from-mount");
    const parsed = parseSettingsFile(src) as LuaTable;

    const mode: "minimal" | "full" = opts.full ? "full" : "minimal";
    const { yaml, filter } = luaToYaml(parsed, mode);

    const outPath = resolve(env.cwd, opts.output ?? "kindly.yaml");
    if (exists(outPath, "user-provided") && !opts.force) {
        throw new KindlyError(
            ErrorCodes.OUTPUT_EXISTS,
            `${outPath} already exists. Pass --force to overwrite, or --output <path> to write elsewhere.`,
            [
                { text: "Overwrite it.", command: "kindly pull --force" },
                { text: "Write to a different path.", command: "kindly pull --output <path>" },
            ],
        );
    }

    // Step 13 phase 1: prepend a provenance header. Records the hash of
    // the on-device source + timestamp, so a future apply can verify
    // this YAML corresponds to a snapshot we produced (vs. a file handed
    // over by a stranger). Phase 1 does NOT gate on the header — apply
    // still fires YAML_SHAPE_NORMAL / SENSITIVE gates uniformly. The
    // observation-only period lets us measure how often pulled-then-
    // applied flows carry the header before turning it into a trust
    // signal (phase 2 / future provenance auto-bypass).
    const header = provenanceHeader(src, env.now().toISOString());
    const output = header + yaml;

    writeFileSync(outPath, output);

    return {
        mode,
        settingsPath,
        outputPath: outPath,
        bytes: Buffer.byteLength(output),
        lines: output.split("\n").length,
        droppedSecrets: [...filter.droppedSecrets].sort(),
        droppedEphemerals: [...filter.droppedEphemerals].sort(),
    };
}
