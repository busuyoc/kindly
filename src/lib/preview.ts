// Library entry point for `preview` — render a YAML config as a PNG via
// the KOReader-in-Docker harness. Pure: returns a typed result; never
// prints. Throws KindlyError on user-visible failures.
//
// Pipeline:
//   1. Parse YAML (yamlToLua).
//   2. If a device mount is reachable, parse on-device settings as a
//      baseline and merge YAML over it; otherwise render the YAML alone.
//   3. Dump the merged Lua to a tmpdir KO_HOME/settings.reader.lua.
//   4. spawnSync `docker run --rm --network=none -e KO_HOME=... \
//                  -e KINDLY_SCREENSHOT=... -v <tmp>:/work/ko_home \
//                  -v <out>:/work/out <image> --mode=preview`.
//   5. Move /tmp/out/preview.png → opts.output.
//   6. Clean up tmpdir.
//
// Read-only on the device (mount, if used, is parsed never written).
// Sandboxed in Docker with --network=none — the merged YAML can be
// arbitrary, including hostile, and the blast radius is the throwaway
// KO_HOME inside the container.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exists, readText } from "../fs/safeRead.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import { dumpSettingsFile } from "../lua/writer.ts";
import type { LuaTable, LuaValue } from "../lua/writer.ts";
import { mergeYamlIntoLua, yamlToLua } from "../schema/yaml.ts";
import { detectKindleMount, isKindleMount, kindleMountAt } from "../device/kindle.ts";
import type { CliEnv } from "../cli/env.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import type { PreviewResult } from "../types/results.ts";

export interface PreviewOptions {
    /** YAML file to render (default: kindly.yaml). */
    file?: string;
    /** PNG output path. Required. */
    output: string;
    /** Seconds inside the container before the screenshot patch fires. */
    delaySeconds?: number;
    /** Mount path override; if undefined we still autodetect. Pass an
     *  empty string to skip device-baseline merging entirely (render the
     *  YAML against KOReader's own defaults). */
    mount?: string | "";
}

const HARNESS_IMAGE = "kindly-koreader:dev";
const DEFAULT_DELAY = 2;

export async function executePreview(opts: PreviewOptions, env: CliEnv): Promise<PreviewResult> {
    const yamlPath = resolve(env.cwd, opts.file ?? "kindly.yaml");
    if (!exists(yamlPath, "user-provided")) {
        throw new KindlyError(
            ErrorCodes.YAML_NOT_FOUND,
            `YAML not found: ${yamlPath}`,
            [{ text: "Pass --file <path> or run `kindly init` to create a starter." }],
        );
    }

    const outputPath = resolve(env.cwd, opts.output);

    if (!dockerAvailable()) {
        throw new KindlyError(
            ErrorCodes.HARNESS_DOCKER_MISSING,
            "preview requires a running Docker daemon — `docker info` failed.",
            [
                { text: "Install and start Docker Desktop (macOS/Windows) or the docker engine (Linux)." },
                { text: "Verify the daemon is reachable.", command: "docker info" },
            ],
        );
    }

    const fromYaml = yamlToLua(readText(yamlPath, "user-provided")) as Record<string, LuaValue>;

    let merged: LuaTable;
    let usedDeviceBaseline = false;

    if (opts.mount !== "") {
        const mount = resolveOptionalMount(opts.mount, env);
        if (mount && exists(mount.settingsPath, "derived-from-mount")) {
            const onDevice = parseSettingsFile(
                readText(mount.settingsPath, "derived-from-mount"),
            ) as Record<string, LuaValue>;
            merged = mergeYamlIntoLua(onDevice, fromYaml) as LuaTable;
            usedDeviceBaseline = true;
        } else {
            merged = fromYaml as LuaTable;
        }
    } else {
        merged = fromYaml as LuaTable;
    }

    const koHome = mkdtempSync(join(tmpdir(), "kindly-preview-koh-"));
    const outDir = mkdtempSync(join(tmpdir(), "kindly-preview-out-"));
    try {
        const dumped = dumpSettingsFile(merged, "./settings.reader.lua");
        Bun.write(join(koHome, "settings.reader.lua"), dumped);

        const containerOut = "/work/out/preview.png";
        const r = spawnSync(
            "docker",
            [
                "run", "--rm",
                "--network=none",
                "-e", "KO_HOME=/work/ko_home",
                "-e", `KINDLY_SCREENSHOT=${containerOut}`,
                "-e", `KINDLY_SCREENSHOT_DELAY=${opts.delaySeconds ?? DEFAULT_DELAY}`,
                "-v", `${koHome}:/work/ko_home`,
                "-v", `${outDir}:/work/out`,
                HARNESS_IMAGE,
                "--mode=preview",
            ],
            { encoding: "utf8" },
        );

        if (r.status !== 0) {
            const tail = (r.stderr ?? "").split("\n").slice(-10).join("\n");
            throw new KindlyError(
                ErrorCodes.HARNESS_RUN_FAILED,
                `preview harness exited ${r.status ?? "?"}.`,
                [
                    { text: "Build the harness image first.", command: "harness/koreader/build.sh" },
                    { text: `Last container stderr (truncated):\n${tail}` },
                ],
            );
        }

        const tmpPng = join(outDir, "preview.png");
        if (!exists(tmpPng, "internal")) {
            throw new KindlyError(
                ErrorCodes.HARNESS_RUN_FAILED,
                "preview harness exited 0 but no PNG was produced.",
                [{ text: "Re-run with --delay raised." }],
            );
        }

        mkdirSync(dirname(outputPath), { recursive: true });
        copyFileSync(tmpPng, outputPath);

        return { yamlPath, outputPath, usedDeviceBaseline };
    } finally {
        rmSync(koHome, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
    }
}

function dockerAvailable(): boolean {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function resolveOptionalMount(override: string | undefined, env: CliEnv) {
    const cand = override ?? env.mountOverride;
    if (cand) {
        return isKindleMount(cand) ? kindleMountAt(cand) : null;
    }
    return detectKindleMount();
}
