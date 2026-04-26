#!/usr/bin/env bun
// Top-level dispatcher. Commands are pure functions that take argv + env and
// return an exit code; this file is the glue that maps `kindly <cmd>` to
// the right handler, renders errors, and exits the process.

import { ArgError } from "./cli/args.ts";
import { LuaParseError } from "./lua/reader.ts";
import { defaultEnv, type CliEnv } from "./cli/env.ts";
import { errLine } from "./cli/log.ts";
import { KindlyError, POLICY_BLOCK_CODES } from "./types/errors.ts";
import { emitJsonError } from "./cli/json.ts";
import { writeTraceEntry, hashArgv } from "./cli/trace.ts";

import { runPull, pullHelp } from "./commands/pull.ts";
import { runApply, applyHelp } from "./commands/apply.ts";
import { runDiff, diffHelp } from "./commands/diff.ts";
import { runInit, initHelp } from "./commands/init.ts";
import { runDoctor, doctorHelp } from "./commands/doctor.ts";
import { runSnapshot, snapshotHelp } from "./commands/snapshot.ts";
import { runRestore, restoreHelp } from "./commands/restore.ts";
import { runRollback, rollbackHelp } from "./commands/rollback.ts";
import { runHistory, historyHelp } from "./commands/history.ts";
import { runSetup, setupHelp } from "./commands/setup.ts";
import { runPlugin, pluginHelp } from "./commands/plugin.ts";
import { runServe, serveHelp } from "./cli/serve.ts";
import { runWatch, watchHelp } from "./commands/watch.ts";

import pkg from "../package.json" with { type: "json" };
const VERSION: string = pkg.version;

type Command = {
    run: (argv: readonly string[], env: CliEnv) => Promise<number>;
    help: string;
};

const COMMANDS: Record<string, Command> = {
    pull:     { run: runPull,     help: pullHelp },
    apply:    { run: runApply,    help: applyHelp },
    diff:     { run: runDiff,     help: diffHelp },
    init:     { run: runInit,     help: initHelp },
    doctor:   { run: runDoctor,   help: doctorHelp },
    snapshot: { run: runSnapshot, help: snapshotHelp },
    restore:  { run: runRestore,  help: restoreHelp },
    rollback: { run: runRollback, help: rollbackHelp },
    history:  { run: runHistory,  help: historyHelp },
    setup:    { run: runSetup,    help: setupHelp },
    plugin:   { run: runPlugin,   help: pluginHelp },
    serve:    { run: runServe,    help: serveHelp },
    watch:    { run: runWatch,    help: watchHelp },
};

const TOP_HELP = `
kindly — declarative backup & restore for KOReader settings.

usage: kindly <command> [options]

Device state:
  pull       read settings.reader.lua from the Kindle → kindly.yaml
  apply      merge kindly.yaml → settings.reader.lua (safe-write + verify)
  diff       show what apply would change

Bootstrap & health:
  init       write a starter kindly.yaml from a preset
  doctor     sanity-check the device

Safety net:
  snapshot   tarball user-state (plugins, patches, history) for factory-reset insurance
  restore    extract a snapshot back into the Kindle
  rollback   restore a per-import safety snapshot (.kindly/pre-import/<stamp>/)
  history    list mutations from .kindly/history.jsonl

Shareable Setups:
  setup      create, inspect, and apply curated Setup manifests
             (see \`kindly setup --help\` for subcommands)

Plugin catalog:
  plugin     browse the curated KOReader bundled-plugin catalog
             (see \`kindly plugin --help\` for subcommands)

Automation:
  serve      long-running JSON-IPC mode over stdin/stdout
             (see \`kindly serve --help\` for the protocol)
  watch      stream new history entries as JSON (tail -f for the GUI)
             (see \`kindly watch --help\` for the protocol)

Other:
  help <cmd>   print that command's help
  --version    print the kindly version and exit

Exit codes:
  0  success
  1  runtime error
  2  argument validation error
  3  blocked by policy (pass a flag to override)
  4  success with warnings

Run \`kindly <command> --help\` (or \`kindly help <command>\`) for per-command options.
`.trim();

export async function main(argv: readonly string[], env: CliEnv = defaultEnv()): Promise<number> {
    const startMs = Date.now();
    const code = await runMain(argv, env);
    // Trace every invocation (including --help, --version, unknown command)
    // so self-dogfooding counts reflect reality. Gated on env.trace; swallows
    // its own failures in writeTraceEntry.
    if (env.trace) {
        writeTraceEntry(env, {
            ts: env.now().toISOString(),
            cmd: argv[0] ?? "",
            argv_hash: hashArgv(argv),
            duration_ms: Date.now() - startMs,
            exit_code: code,
            warnings_n: 0,
        });
    }
    return code;
}

async function runMain(argv: readonly string[], env: CliEnv): Promise<number> {
    const [cmdName, ...rest] = argv;

    // `--version` / `-v`: print version and exit. Intentional early exit
    // before anything else so it works in any context (no mount, no args).
    if (cmdName === "--version" || cmdName === "-v") {
        env.stdout.write(`kindly ${VERSION}\n`);
        return 0;
    }

    // Bare invocation → top-level help.
    if (!cmdName || cmdName === "--help" || cmdName === "-h") {
        env.stdout.write(TOP_HELP + "\n");
        return 0;
    }

    // Git-style `kindly help <cmd>` → show that command's help.
    // Bare `kindly help` keeps the legacy behavior of the top-level overview.
    if (cmdName === "help") {
        const target = rest[0];
        if (!target) {
            env.stdout.write(TOP_HELP + "\n");
            return 0;
        }
        const targetCmd = COMMANDS[target];
        if (!targetCmd) {
            errLine(env, `unknown command: ${target}`);
            env.stderr.write("\n" + TOP_HELP + "\n");
            return 2;
        }
        env.stdout.write(targetCmd.help + "\n");
        return 0;
    }

    const cmd = COMMANDS[cmdName];
    if (!cmd) {
        errLine(env, `unknown command: ${cmdName}`);
        env.stderr.write("\n" + TOP_HELP + "\n");
        return 2;
    }

    // Per-command --help short-circuit. Only intercept if --help is the
    // FIRST argument after the command — otherwise subcommand dispatchers
    // (like `kindly setup export --help`) would never see their own help.
    if (rest[0] === "--help" || rest[0] === "-h") {
        env.stdout.write(cmd.help + "\n");
        return 0;
    }

    // Universal --json flag: detected + stripped here so individual commands
    // don't each have to declare it. When set, the command emits a JSON
    // envelope to stdout instead of human text, and errors go to stderr as
    // structured envelopes (not plain text + hint lines).
    const jsonIdx = rest.indexOf("--json");
    const jsonMode = jsonIdx >= 0;
    const cmdArgv = jsonMode
        ? [...rest.slice(0, jsonIdx), ...rest.slice(jsonIdx + 1)]
        : rest;
    if (jsonMode) env = { ...env, jsonMode: true };

    try {
        return await cmd.run(cmdArgv, env);
    } catch (e) {
        // In JSON mode, every error — including ArgError and LuaParseError —
        // is a structured envelope on stderr. Consumers parse stderr to
        // branch on code; no mixed text+JSON output.
        if (jsonMode) {
            emitJsonError(env, cmdName, e);
            if (e instanceof ArgError) return 2;
            if (e instanceof KindlyError && POLICY_BLOCK_CODES.has(e.code)) return 3;
            return 1;
        }

        // ArgError and LuaParseError are both KindlyError subclasses, but
        // they have custom rendering (help text / parse-prefix). Catch them
        // first so the generic KindlyError block doesn't double-render.
        if (e instanceof ArgError) {
            errLine(env, e.message);
            env.stderr.write("\n" + cmd.help + "\n");
            return 2;
        }
        if (e instanceof LuaParseError) {
            errLine(env, `settings.reader.lua failed to parse: ${e.message}`);
            return 1;
        }
        if (e instanceof KindlyError) {
            errLine(env, e.message);
            for (const r of e.remediation) {
                env.stderr.write(`  hint: ${r.text}\n`);
                if (r.command) env.stderr.write(`  try:  ${r.command}\n`);
            }
            return POLICY_BLOCK_CODES.has(e.code) ? 3 : 1;
        }
        errLine(env, (e as Error).message ?? String(e));
        return 1;
    }
}

// When invoked directly (not imported), run main().
//
// Round 3 history --json envelope F1: process.exit(code) is synchronous
// — buffered stdout/stderr writes that haven't reached the kernel are
// dropped on the floor. With `kindly history --json | jq` over a slow
// pipe, the receiver can see a truncated JSON object — every fix that
// shipped CONTROL_BYTES_IN_VALUE messages, history rows, gate event
// blobs etc. is exposed to the same hazard. Drain both streams via
// the empty-write callback pattern before exit; Node only fires the
// callback once the pipe has actually accepted the prior bytes.
if (import.meta.main) {
    main(process.argv.slice(2)).then((code) => {
        process.stdout.write("", () => {
            process.stderr.write("", () => {
                process.exit(code);
            });
        });
    });
}
