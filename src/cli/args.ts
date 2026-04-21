// Tiny argv parser.
//
// Subcommand style: `kindly <cmd> [flags] [positionals]`. Each command
// declares its own flag spec; unknown flags are errors (safer default — we
// don't want a typo to silently run the command with fewer guardrails).
//
// Supported flag syntaxes:
//   --flag              → boolean true
//   --flag=value        → string value
//   --flag value        → string value (if flag is declared with takesValue)
//   --no-flag           → boolean false (only for flags declared as boolean)
//
// Short flags are deliberately not supported. Kindle interactions are rare;
// a user typing `kindly apply --dry-run` once a week doesn't need `-d`.

export type FlagSpec = {
    type: "boolean" | "string";
    default?: string | boolean;
    description?: string;
};

export type FlagSpecs = Record<string, FlagSpec>;

export type ParsedArgs<F extends FlagSpecs> = {
    flags: { [K in keyof F]: F[K]["type"] extends "boolean" ? boolean : string | undefined };
    positional: string[];
};

export class ArgError extends Error {}

export function parseArgs<F extends FlagSpecs>(
    argv: readonly string[],
    spec: F
): ParsedArgs<F> {
    const flags: Record<string, string | boolean | undefined> = {};
    const positional: string[] = [];

    // Initialize defaults.
    for (const [name, s] of Object.entries(spec)) {
        flags[name] = s.default !== undefined
            ? s.default
            : (s.type === "boolean" ? false : undefined);
    }

    let i = 0;
    while (i < argv.length) {
        const token = argv[i]!;

        if (!token.startsWith("--")) {
            positional.push(token);
            i++;
            continue;
        }

        // --no-flag → set boolean to false (only valid for declared booleans)
        if (token.startsWith("--no-")) {
            const name = token.slice(5);
            const s = spec[name];
            if (!s) throw new ArgError(`unknown flag: --no-${name}`);
            if (s.type !== "boolean") throw new ArgError(`--no-${name} is only valid on boolean flags`);
            flags[name] = false;
            i++;
            continue;
        }

        // --flag=value
        const eq = token.indexOf("=");
        if (eq !== -1) {
            const name = token.slice(2, eq);
            const value = token.slice(eq + 1);
            const s = spec[name];
            if (!s) throw new ArgError(`unknown flag: --${name}`);
            if (s.type === "boolean") {
                if (value === "true") flags[name] = true;
                else if (value === "false") flags[name] = false;
                else throw new ArgError(`boolean flag --${name} expects 'true' or 'false', got ${JSON.stringify(value)}`);
            } else {
                flags[name] = value;
            }
            i++;
            continue;
        }

        // --flag [value]
        const name = token.slice(2);
        const s = spec[name];
        if (!s) throw new ArgError(`unknown flag: --${name}`);
        if (s.type === "boolean") {
            flags[name] = true;
            i++;
        } else {
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                throw new ArgError(`--${name} expects a value`);
            }
            flags[name] = next;
            i += 2;
        }
    }

    return { flags: flags as ParsedArgs<F>["flags"], positional };
}
