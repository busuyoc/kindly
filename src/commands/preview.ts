// `kindly preview` — render a YAML config as a PNG via the harness.
//
// Read-only on the device. Writes a single PNG to --output.
//
// Pure logic lives in src/lib/preview.ts; this module is the CLI adapter
// (flag parsing, text rendering, JSON envelope wrapping).

import { parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, info, ok } from "../cli/log.ts";
import { emitJson } from "../cli/json.ts";
import { executePreview, type PreviewOptions } from "../lib/preview.ts";
import { ArgError } from "../cli/args.ts";

const FLAGS = {
    file: {
        type: "string",
        default: "kindly.yaml",
        description: "YAML to render (default: kindly.yaml)",
    },
    output: {
        type: "string",
        description: "PNG output path (required)",
    },
    mount: {
        type: "string",
        description: "device baseline mount; pass empty (`--mount=`) to skip",
    },
    delay: {
        type: "string",
        description: "seconds before screenshot (default: 2)",
    },
} as const satisfies FlagSpecs;

export async function runPreview(argv: readonly string[], env: CliEnv): Promise<number> {
    const { flags } = parseArgs(argv, FLAGS);

    if (!flags.output) {
        throw new ArgError("preview requires --output <path>");
    }
    // S348/S610-class: `--file=` (empty value) silently overrode the default
    // and resolved to cwd, yielding an EISDIR deep inside the lib. Reject at
    // the CLI seam with a clear message instead. (`--mount=` is intentionally
    // empty-allowed: documented opt-out from device baseline. `--delay=`
    // empty falls through to the default and is fine.)
    if (flags.file === "") {
        throw new ArgError("--file expects a non-empty path");
    }

    const opts: PreviewOptions = {
        file: flags.file,
        output: flags.output,
        ...(flags.delay ? { delaySeconds: parseNum(flags.delay, "delay") } : {}),
        ...(flags.mount !== undefined ? { mount: flags.mount } : {}),
    };

    const result = await executePreview(opts, env);
    if (env.jsonMode) emitJson(env, "preview", result);
    else {
        ok(env, `wrote ${result.outputPath}`);
        info(env, dim(env,
            result.usedDeviceBaseline
                ? `(rendered against device baseline + ${result.yamlPath})`
                : `(rendered against KOReader defaults + ${result.yamlPath})`,
        ));
    }
    return 0;
}

function parseNum(raw: string, name: string): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        throw new ArgError(`--${name} must be a non-negative number, got: ${raw}`);
    }
    return n;
}

export const previewHelp = `
kindly preview — render a kindly.yaml as a Kindle-screen PNG via the
KOReader-in-Docker harness.

usage: kindly preview --output <path> [--file <yaml>] [--mount <path>]
                      [--delay <s>]

  --output <path>          PNG output path (required)
  --file <path>            YAML to render (default: kindly.yaml)
  --mount <path>           use this device's settings.reader.lua as the
                           baseline; pass --mount= (empty) to render the
                           YAML against KOReader's own defaults instead
  --delay <seconds>        seconds inside the container before snapshot
                           (default: 2)

Requires Docker. Build the image once with \`harness/koreader/build.sh\`.
`.trim();
