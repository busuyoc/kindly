#!/usr/bin/env bun
// Top-level dispatcher. Commands are pure functions that take argv + env and
// return an exit code; this file is the glue that maps `kindly <cmd>` to
// the right handler, renders errors, and exits the process.

import { ArgError } from "./cli/args.ts";
import { LuaParseError } from "./lua/reader.ts";
import { defaultEnv, type CliEnv } from "./cli/env.ts";
import { errLine } from "./cli/log.ts";

import { runPull, pullHelp } from "./commands/pull.ts";
import { runApply, applyHelp } from "./commands/apply.ts";
import { runDiff, diffHelp } from "./commands/diff.ts";
import { runInit, initHelp } from "./commands/init.ts";
import { runDoctor, doctorHelp } from "./commands/doctor.ts";
import { runSnapshot, snapshotHelp } from "./commands/snapshot.ts";
import { runRestore, restoreHelp } from "./commands/restore.ts";
import { runSetup, setupHelp } from "./commands/setup.ts";

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
    setup:    { run: runSetup,    help: setupHelp },
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

Shareable Setups:
  setup      create, inspect, and apply curated Setup manifests
             (see \`kindly setup --help\` for subcommands)

Other:
  help <cmd>   print that command's help
  --version    print the kindly version and exit

Run \`kindly <command> --help\` (or \`kindly help <command>\`) for per-command options.
`.trim();

export async function main(argv: readonly string[], env: CliEnv = defaultEnv()): Promise<number> {
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

    try {
        return await cmd.run(rest, env);
    } catch (e) {
        if (e instanceof ArgError) {
            errLine(env, e.message);
            env.stderr.write("\n" + cmd.help + "\n");
            return 2;
        }
        if (e instanceof LuaParseError) {
            errLine(env, `settings.reader.lua failed to parse: ${e.message}`);
            return 1;
        }
        errLine(env, (e as Error).message ?? String(e));
        return 1;
    }
}

// When invoked directly (not imported), run main().
if (import.meta.main) {
    main(process.argv.slice(2)).then((code) => process.exit(code));
}
