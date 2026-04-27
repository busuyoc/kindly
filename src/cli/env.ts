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
import { KindlyError, ErrorCodes } from "../types/errors.ts";
import { sanitizeForTerminal } from "./sanitize.ts";

// Writer is the minimal sink abstraction every CLI output path goes
// through. All writes default to `sanitizeForTerminal` — attacker-
// controlled strings that slip into error messages, manifest fields, or
// JSON payloads cannot inject OSC title-change sequences or other
// control bytes into the user's terminal (red-team S282/S283/S284).
// Callers that have already produced safe bytes — or legitimately need
// to emit raw bytes (tests that inspect ANSI, serve.ts relay) — use
// `writeRaw()`.
export interface Writer {
    write(s: string): void;
    writeRaw(s: string): void;
}

export class StreamWriter implements Writer {
    constructor(private stream: NodeJS.WritableStream) {}
    // Red-team S1181 (2026-04-26): if the consumer closes the read end
    // (e.g. `kindly pull | head -5`, GUI quits mid-response, broken pipe
    // mid-serve write), Node raises EPIPE/ERR_STREAM_DESTROYED on the
    // next write. Without this catch, serve crashed uncaught — every
    // pipe-closed-by-consumer scenario was a hard fault. Swallow these
    // because by definition the consumer no longer cares; let other I/O
    // errors propagate so genuine fs/permission problems still surface.
    write(s: string): void {
        try { this.stream.write(sanitizeForTerminal(s)); }
        catch (e) { if (!isBrokenPipe(e)) throw e; }
    }
    writeRaw(s: string): void {
        try { this.stream.write(s); }
        catch (e) { if (!isBrokenPipe(e)) throw e; }
    }
}

function isBrokenPipe(e: unknown): boolean {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

export class StringWriter implements Writer {
    private chunks: string[] = [];
    write(s: string): void { this.chunks.push(sanitizeForTerminal(s)); }
    writeRaw(s: string): void { this.chunks.push(s); }
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
    /** Override for `os.homedir()`. Used by the keyring loader/saver and
     * any future per-user-config path. Tests pass a tmpdir; production
     * leaves it undefined. */
    homeOverride?: string;
    /** When true, commands emit a JSON envelope to stdout instead of human
     * text, and the dispatcher emits a JSON error envelope to stderr on
     * failure. Set by the dispatcher when --json is present in argv. */
    jsonMode?: boolean;
    /** When true, the dispatcher appends a line to `.kindly/trace.jsonl`
     * per invocation. Opt-in for Claudiu's own self-dogfooding; not
     * telemetry. defaultEnv() reads `KINDLY_TRACE=1` from process.env. */
    trace?: boolean;
    /** Test-only override for the plugin catalog path. Production runs
     * always resolve the bundled catalog relative to the module — there
     * is no cwd hatch (round-5 S2081 closure: previously
     * `commands/plugin.ts` would honour `<cwd>/data/catalog/...` if
     * present, letting an attacker drop a hostile catalog under any
     * directory the user happened to run `kindly plugin list/describe`
     * from). Tests inject a fixture path here. */
    catalogPath?: string;
    /** Whether stdin is a TTY (R8: gates the interrupted-apply prompt).
     *  defaultEnv() reads `process.stdin.isTTY`. Tests pass `true`/`false`
     *  explicitly. */
    tty?: boolean;
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
        trace: process.env.KINDLY_TRACE === "1",
        tty: process.stdin.isTTY ?? false,
    };
}

// Resolve the mount to operate against. Throws a user-readable error if not
// found — the dispatcher catches and prints it.
export function resolveMount(env: CliEnv): KindleMount {
    if (env.mountOverride) {
        if (!isKindleMount(env.mountOverride)) {
            throw new KindlyError(
                ErrorCodes.MOUNT_INVALID,
                `--mount ${env.mountOverride} doesn't look like a Kindle (no koreader/ dir)`,
                [{ text: "Verify the path has a koreader/ directory, then retry." }],
            );
        }
        return kindleMountAt(env.mountOverride);
    }
    const m = detectKindleMount();
    if (!m) {
        throw new KindlyError(
            ErrorCodes.MOUNT_NOT_FOUND,
            `No Kindle found. Plug in the Kindle, wait for it to mount, then try again. ` +
            `(Or pass --mount <path> to point kindly at a specific directory.)`,
            [
                { text: "Plug in the Kindle and wait for it to appear as a USB drive." },
                { text: "Run device diagnostics.", command: "kindly doctor" },
            ],
        );
    }
    return m;
}
