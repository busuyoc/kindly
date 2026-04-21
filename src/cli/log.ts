// Minimal output helpers. Colors when env.color is true; plain otherwise.
// We don't need full ANSI; just enough to make diffs readable and warnings
// visible. No dependency on a logging library.

import type { CliEnv } from "./env.ts";

const ANSI = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
};

export function paint(env: CliEnv, color: keyof typeof ANSI, text: string): string {
    if (!env.color) return text;
    return ANSI[color] + text + ANSI.reset;
}

export function info(env: CliEnv, msg: string): void {
    env.stdout.write(msg + "\n");
}

export function warn(env: CliEnv, msg: string): void {
    env.stderr.write(paint(env, "yellow", "warn: ") + msg + "\n");
}

export function errLine(env: CliEnv, msg: string): void {
    env.stderr.write(paint(env, "red", "error: ") + msg + "\n");
}

export function ok(env: CliEnv, msg: string): void {
    env.stdout.write(paint(env, "green", "✓ ") + msg + "\n");
}

export function heading(env: CliEnv, msg: string): void {
    env.stdout.write(paint(env, "bold", msg) + "\n");
}

export function dim(env: CliEnv, msg: string): string {
    return paint(env, "dim", msg);
}
