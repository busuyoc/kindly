// `kindly serve` — long-running JSON-IPC over stdin/stdout (W26).
//
// The GUI (or any other controller) spawns `kindly serve` once and streams
// requests through stdin/stdout line-delimited JSON. Each request is the
// exact argv the caller would have passed to `kindly <cmd>` — serve just
// amortizes Bun startup across many invocations.
//
// Wire protocol ($serve_protocol = 1):
//
//   stdout, on start:
//     {"$serve_protocol":1, "kindly_version":"...", "ready_at":"<ISO>"}
//
//   stdin, one JSON object per line:
//     {"id": 1, "argv": ["pull", "--out", "kindly.yaml"]}
//
//   stdout, one JSON object per response:
//     {"$serve_protocol":1, "id":1, "envelope": { ...standard --json envelope... }}
//
//   Framing errors (bad JSON, missing id/argv, unsupported command) get their
//   own shape so callers can distinguish transport failure from command failure:
//     {"$serve_protocol":1, "id":<id|null>, "error": {"code":"BAD_REQUEST","message":"..."}}
//
// Design notes:
// - argv is passed through to the same `main()` dispatcher the CLI uses.
//   `--json` is prepended if absent so every response is a machine-readable
//   envelope — text output in serve would break the line-delimited stream.
// - A command whitelist blocks recursion (no `serve`-in-`serve`) and meta
//   commands (help/--version) that have no envelope shape.
// - Per-request output goes to a StringWriter-backed env so the parent
//   process's stdout stays clean — only framed responses are written.
// - Nothing in this module closes stdin. The loop ends when the async
//   iterator does (EOF from parent), at which point the process exits 0.

import type { CliEnv } from "./env.ts";
import { StringWriter } from "./env.ts";
// NOTE: `main` is imported dynamically inside handleRequest to break the
// module cycle (cli.ts → serve.ts → cli.ts). By the time a request arrives,
// cli.ts has fully loaded and the lookup is a cache hit.

import pkg from "../../package.json" with { type: "json" };
const KINDLY_VERSION: string = pkg.version;

export const SERVE_PROTOCOL_VERSION = 1;

// Commands `serve` will forward. Excludes:
//   - serve itself (no recursive spawn)
//   - help / --version (not envelope-shaped)
const COMMAND_WHITELIST = new Set<string>([
    "pull", "apply", "diff", "init", "doctor",
    "snapshot", "restore", "rollback", "history",
    "setup", "plugin", "preview",
]);

interface ServeRequest {
    id: number | string;
    argv: string[];
}

function emitHello(env: CliEnv): void {
    const hello = {
        $serve_protocol: SERVE_PROTOCOL_VERSION,
        kindly_version: KINDLY_VERSION,
        ready_at: env.now().toISOString(),
    };
    env.stdout.write(JSON.stringify(hello) + "\n");
}

function emitFramingError(
    env: CliEnv,
    id: number | string | null,
    code: string,
    message: string,
): void {
    const payload = {
        $serve_protocol: SERVE_PROTOCOL_VERSION,
        id,
        error: { code, message },
    };
    env.stdout.write(JSON.stringify(payload) + "\n");
}

function parseRequest(line: string): ServeRequest | { error: string } {
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch (e) { return { error: `invalid JSON: ${(e as Error).message}` }; }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: "request must be a JSON object" };
    }
    const r = parsed as Record<string, unknown>;
    if (typeof r.id !== "number" && typeof r.id !== "string") {
        return { error: "request.id must be number or string" };
    }
    if (!Array.isArray(r.argv) || !r.argv.every((x) => typeof x === "string")) {
        return { error: "request.argv must be string[]" };
    }
    return { id: r.id, argv: r.argv as string[] };
}

async function handleRequest(parentEnv: CliEnv, req: ServeRequest): Promise<void> {
    const cmd = req.argv[0];
    if (!cmd || !COMMAND_WHITELIST.has(cmd)) {
        emitFramingError(
            parentEnv, req.id,
            "UNSUPPORTED_COMMAND",
            cmd ? `command not supported over serve: ${cmd}` : "empty argv",
        );
        return;
    }

    // Force --json so every response is a parseable envelope. Harmless if
    // the caller already included it.
    const argv = req.argv.includes("--json")
        ? req.argv
        : [...req.argv, "--json"];

    // Per-request env: capture stdout/stderr into strings so only framed
    // responses reach the parent's stdout. Inherit mount/cwd/clock from
    // the serve-process env — a long-running serve points at one device.
    const reqStdout = new StringWriter();
    const reqStderr = new StringWriter();
    const reqEnv: CliEnv = {
        ...parentEnv,
        stdout: reqStdout,
        stderr: reqStderr,
        // Trace is per-invocation; an outer `kindly serve` already logged
        // one entry. Don't double-count per request.
        trace: false,
    };

    let exitCode: number;
    try {
        const { main } = await import("../cli.ts");
        exitCode = await main(argv, reqEnv);
    } catch (e) {
        // main() already handles KindlyError → envelope. An exception
        // escaping is a genuine internal fault.
        emitFramingError(
            parentEnv, req.id, "INTERNAL",
            (e as Error).message ?? String(e),
        );
        return;
    }

    // On success, envelope is on reqStdout. On error (--json mode), main()
    // writes the error envelope to reqStderr. Pick whichever is non-empty.
    //
    // Red-team S442 (2026-04-26): exit code 4 means "command produced a
    // result envelope on stdout, but with warnings" — that's `doctor`'s
    // canonical exit when any check warns. Pre-fix, `serve` treated
    // anything non-zero as error and looked at stderr only, which made
    // every doctor-via-serve return INTERNAL/no envelope. Route exit 4
    // through stdout alongside exit 0.
    const raw = (exitCode === 0 || exitCode === 4)
        ? reqStdout.value
        : reqStderr.value;
    if (!raw.trim()) {
        emitFramingError(
            parentEnv, req.id, "INTERNAL",
            `no envelope produced (exit ${exitCode})`,
        );
        return;
    }

    let envelope: unknown;
    try { envelope = JSON.parse(raw); }
    catch (e) {
        emitFramingError(
            parentEnv, req.id, "INTERNAL",
            `command produced non-JSON output: ${(e as Error).message}`,
        );
        return;
    }

    const resp = {
        $serve_protocol: SERVE_PROTOCOL_VERSION,
        id: req.id,
        envelope,
    };
    parentEnv.stdout.write(JSON.stringify(resp) + "\n");
}

// Red-team S1180 (2026-04-26): without a buffer cap, a client (malicious
// or buggy) that sends 50 MiB without a newline drives serve's RSS to
// hundreds of MB. Cap each line at 1 MiB (well above any legitimate
// request — kindly argv is dozens of bytes), and resync at the next
// newline on overflow so the loop survives.
const MAX_LINE_BYTES = 1024 * 1024;

type LineEvent = { kind: "line"; line: string } | { kind: "overflow" };

/** Read lines from an async iterable of string chunks. Splits on \n, holds
 *  a trailing partial line across chunks, drops \r. Empty lines are skipped.
 *  Yields `{kind: "overflow"}` once per buffer overrun and resyncs at the
 *  next newline. */
async function* lines(
    chunks: AsyncIterable<string>,
    maxBytes: number = MAX_LINE_BYTES,
): AsyncGenerator<LineEvent> {
    let buf = "";
    for await (const chunk of chunks) {
        buf += chunk;
        if (buf.length > maxBytes) {
            const nl = buf.indexOf("\n");
            yield { kind: "overflow" };
            buf = nl < 0 ? "" : buf.slice(nl + 1);
        }
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line.length > 0) yield { kind: "line", line };
        }
    }
    if (buf.length > 0 && buf.length <= maxBytes) {
        const tail = buf.replace(/\r$/, "");
        if (tail.length > 0) yield { kind: "line", line: tail };
    }
}

/** Testable core: read requests from `input`, write framed responses to
 *  `env.stdout`. Returns when the input stream ends. */
export async function runServeLoop(
    input: AsyncIterable<string>,
    env: CliEnv,
): Promise<void> {
    emitHello(env);
    for await (const ev of lines(input)) {
        if (ev.kind === "overflow") {
            emitFramingError(
                env, null, "FRAMING_OVERFLOW",
                `request line exceeded ${MAX_LINE_BYTES}-byte cap`,
            );
            continue;
        }
        const parsed = parseRequest(ev.line);
        if ("error" in parsed) {
            emitFramingError(env, null, "BAD_REQUEST", parsed.error);
            continue;
        }
        await handleRequest(env, parsed);
    }
}

export const serveHelp = `
kindly serve — long-running JSON-IPC mode for GUIs and scripts.

usage: kindly serve

Reads line-delimited JSON requests from stdin, writes line-delimited JSON
responses to stdout. Amortizes Bun startup cost across many invocations.

Protocol ($serve_protocol = 1):

  Hello (sent once on start):
    {"$serve_protocol":1, "kindly_version":"...", "ready_at":"<ISO>"}

  Request (one per line):
    {"id": 1, "argv": ["pull", "--out", "kindly.yaml"]}

  Response (one per line):
    {"$serve_protocol":1, "id":1, "envelope": { ...standard JSON envelope... }}

  Framing error (bad JSON, unsupported command, etc.):
    {"$serve_protocol":1, "id":<id|null>, "error":{"code":"...","message":"..."}}

Supported argv[0]: ${[...COMMAND_WHITELIST].sort().join(", ")}.

--json is injected automatically — every response is a machine-readable envelope.
`.trim();

export async function runServe(argv: readonly string[], env: CliEnv): Promise<number> {
    if (argv.length > 0) {
        env.stderr.write(`serve takes no arguments (got: ${argv.join(" ")})\n`);
        return 2;
    }

    // Stream stdin as string chunks.
    const stdin = (async function* (): AsyncGenerator<string> {
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) {
            yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
        }
    })();

    await runServeLoop(stdin, env);
    return 0;
}
