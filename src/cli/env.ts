// Injectable environment for CLI commands. Tests construct a fake env with
// in-memory streams and an override mount path; production uses process.*.
//
// Commands return an exit code and write user-facing output via env.stdout /
// env.stderr. They never call process.exit directly — that's the dispatcher's
// job. This keeps command functions pure and testable.

import { homedir } from "node:os";
import { join } from "node:path";

import type { KindleMount } from "../device/kindle.ts";
import { detectKindleMount, kindleMountAt, isKindleMount } from "../device/kindle.ts";

export interface Writer {
    write(s: string): void;
}

export class StreamWriter implements Writer {
    constructor(private stream: NodeJS.WritableStream) {}
    write(s: string): void { this.stream.write(s); }
}

export class StringWriter implements Writer {
    private chunks: string[] = [];
    write(s: string): void { this.chunks.push(s); }
    get value(): string { return this.chunks.join(""); }
    reset(): void { this.chunks = []; }
}

export type CliEnv = {
    cwd: string;
    stdout: Writer;
    stderr: Writer;
    /** Force a specific mount path. When undefined, auto-detect. */
    mountOverride?: string;
    /** If true, colored output even when stdout isn't a TTY. */
    color: boolean;
    /** Wall clock — injectable for deterministic backup timestamps in tests. */
    now: () => Date;
    /** Where `setup export` writes by default and `setup list` reads from.
     * Undefined means "~/.kindly/setups". Tests override with a tmpdir. */
    setupsDir?: string;
};

export function resolveSetupsDir(env: CliEnv): string {
    return env.setupsDir ?? join(homedir(), ".kindly", "setups");
}

export function defaultEnv(): CliEnv {
    return {
        cwd: process.cwd(),
        stdout: new StreamWriter(process.stdout),
        stderr: new StreamWriter(process.stderr),
        color: process.stdout.isTTY ?? false,
        now: () => new Date(),
    };
}

// Resolve the mount to operate against. Throws a user-readable error if not
// found — the dispatcher catches and prints it.
export function resolveMount(env: CliEnv): KindleMount {
    if (env.mountOverride) {
        if (!isKindleMount(env.mountOverride)) {
            throw new Error(
                `--mount ${env.mountOverride} doesn't look like a Kindle (no koreader/ dir)`
            );
        }
        return kindleMountAt(env.mountOverride);
    }
    const m = detectKindleMount();
    if (!m) {
        throw new Error(
            `No Kindle found. Plug in the Kindle, wait for it to mount, then try again. ` +
            `(Or pass --mount <path> to point kindly at a specific directory.)`
        );
    }
    return m;
}
