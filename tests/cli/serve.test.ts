// W26 — `kindly serve` long-running JSON-IPC protocol.
//
// runServeLoop() is the testable core. We feed it an AsyncIterable of
// string chunks (scripted stdin) and inspect the StringWriter stdout for
// line-delimited JSON responses. This exercises framing + dispatching
// without touching real stdin/stdout.

import { describe, test, expect, beforeEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runServeLoop, SERVE_PROTOCOL_VERSION } from "../../src/cli/serve.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { reloadPluginCatalog } from "../../src/catalog/reader.ts";

const FIXTURE_CATALOG = join(import.meta.dir, "..", "fixtures", "catalog", "plugins.bundled.v1.json");

function makeWorkdir(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-serve-"));
    mkdirSync(join(root, "data", "catalog"), { recursive: true });
    copyFileSync(FIXTURE_CATALOG, join(root, "data", "catalog", "plugins.bundled.v1.json"));
    return root;
}

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-serve-k-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

function makeNonKindle(): string {
    return mkdtempSync(join(tmpdir(), "kindly-serve-nk-"));
}

/** Turn a list of request objects (or raw lines) into an AsyncIterable<string>
 *  that emits one newline-terminated line at a time. */
async function* scripted(items: Array<object | string>): AsyncGenerator<string> {
    for (const it of items) {
        const line = typeof it === "string" ? it : JSON.stringify(it);
        yield line + "\n";
    }
}

/** Parse the stdout from a serve run into its sequence of JSON objects. */
function parseStream(raw: string): Array<Record<string, unknown>> {
    return raw
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let workdir: string;
let stdout: StringWriter;
let stderr: StringWriter;
let env: CliEnv;

beforeEach(() => {
    reloadPluginCatalog();
    workdir = makeWorkdir();
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: makeNonKindle(),
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("serve — hello handshake", () => {
    test("emits hello line before processing any requests", async () => {
        await runServeLoop(scripted([]), env);
        const msgs = parseStream(stdout.value);
        expect(msgs).toHaveLength(1);
        const hello = msgs[0]!;
        expect(hello.$serve_protocol).toBe(SERVE_PROTOCOL_VERSION);
        expect(typeof hello.kindly_version).toBe("string");
        expect(hello.ready_at).toBe("2026-04-22T12:00:00.000Z");
    });
});

describe("serve — request dispatch", () => {
    test("plugin list returns a wrapped envelope with the same id", async () => {
        await runServeLoop(
            scripted([{ id: 42, argv: ["plugin", "list"] }]),
            env,
        );
        const msgs = parseStream(stdout.value);
        expect(msgs).toHaveLength(2); // hello + 1 response

        const resp = msgs[1]!;
        expect(resp.$serve_protocol).toBe(SERVE_PROTOCOL_VERSION);
        expect(resp.id).toBe(42);
        const envelope = resp.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("ok");
        expect(envelope.command).toBe("plugin:list");
        const data = envelope.data as Record<string, unknown>;
        expect(data.catalogVersion).toBe("v1");
    });

    test("string ids round-trip unchanged", async () => {
        await runServeLoop(
            scripted([{ id: "req-abc", argv: ["plugin", "list"] }]),
            env,
        );
        const resp = parseStream(stdout.value)[1]!;
        expect(resp.id).toBe("req-abc");
    });

    test("multiple sequential requests each get framed responses", async () => {
        await runServeLoop(
            scripted([
                { id: 1, argv: ["plugin", "list"] },
                { id: 2, argv: ["plugin", "describe", "SSH"] },
            ]),
            env,
        );
        const msgs = parseStream(stdout.value);
        expect(msgs).toHaveLength(3); // hello + 2
        expect(msgs[1]!.id).toBe(1);
        expect(msgs[2]!.id).toBe(2);
        const env2 = msgs[2]!.envelope as Record<string, unknown>;
        expect(env2.status).toBe("ok");
    });

    test("--json is injected when the caller omits it", async () => {
        await runServeLoop(
            scripted([{ id: 1, argv: ["plugin", "list"] }]),
            env,
        );
        const resp = parseStream(stdout.value)[1]!;
        const envelope = resp.envelope as Record<string, unknown>;
        // Would be undefined if --json never reached plugin:list.
        expect(envelope.$schema_version).toBe(1);
    });

    test("explicit --json in argv is harmless (no double flag)", async () => {
        await runServeLoop(
            scripted([{ id: 1, argv: ["plugin", "list", "--json"] }]),
            env,
        );
        const resp = parseStream(stdout.value)[1]!;
        const envelope = resp.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("ok");
    });

    test("command errors come back as error envelopes, not framing errors", async () => {
        await runServeLoop(
            scripted([{ id: 7, argv: ["plugin", "describe", "NoSuchPlugin"] }]),
            env,
        );
        const resp = parseStream(stdout.value)[1]!;
        // Envelope shape — not framing — because the command ran and failed.
        expect(resp.error).toBeUndefined();
        const envelope = resp.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("error");
        const err = envelope.error as Record<string, unknown>;
        expect(err.code).toBe("PLUGIN_NOT_FOUND");
    });

    test("preview is whitelisted (Slice 4) — missing --output surfaces ARG_INVALID, not UNSUPPORTED_COMMAND", async () => {
        // We don't spin docker here. The argv triggers ArgError before the
        // harness ever runs, which is enough to prove `preview` is in the
        // whitelist.
        await runServeLoop(
            scripted([{ id: 99, argv: ["preview"] }]),
            env,
        );
        const resp = parseStream(stdout.value)[1]!;
        expect(resp.error).toBeUndefined();
        const envelope = resp.envelope as Record<string, unknown>;
        expect(envelope.status).toBe("error");
        const err = envelope.error as Record<string, unknown>;
        expect(err.code).toBe("ARG_INVALID");
        expect(String(err.message)).toContain("--output");
    });
});

describe("serve — framing errors", () => {
    test("malformed JSON line → BAD_REQUEST with null id", async () => {
        await runServeLoop(scripted(["{not json"]), env);
        const resp = parseStream(stdout.value)[1]!;
        expect(resp.id).toBeNull();
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("BAD_REQUEST");
    });

    test("missing id → BAD_REQUEST", async () => {
        await runServeLoop(scripted([{ argv: ["plugin", "list"] }]), env);
        const resp = parseStream(stdout.value)[1]!;
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("BAD_REQUEST");
        expect(String(err.message)).toContain("id");
    });

    test("argv not an array → BAD_REQUEST", async () => {
        await runServeLoop(scripted([{ id: 1, argv: "plugin list" }]), env);
        const resp = parseStream(stdout.value)[1]!;
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("BAD_REQUEST");
    });

    test("non-whitelisted command → UNSUPPORTED_COMMAND", async () => {
        await runServeLoop(scripted([{ id: 1, argv: ["serve"] }]), env);
        const resp = parseStream(stdout.value)[1]!;
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("UNSUPPORTED_COMMAND");
        expect(String(err.message)).toContain("serve");
    });

    test("unknown command (not in whitelist) → UNSUPPORTED_COMMAND", async () => {
        await runServeLoop(scripted([{ id: 1, argv: ["help"] }]), env);
        const resp = parseStream(stdout.value)[1]!;
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("UNSUPPORTED_COMMAND");
    });

    test("empty argv → UNSUPPORTED_COMMAND with 'empty argv' message", async () => {
        await runServeLoop(scripted([{ id: 1, argv: [] }]), env);
        const resp = parseStream(stdout.value)[1]!;
        const err = resp.error as Record<string, unknown>;
        expect(err.code).toBe("UNSUPPORTED_COMMAND");
        expect(String(err.message)).toContain("empty argv");
    });

    test("loop continues after a framing error", async () => {
        await runServeLoop(
            scripted([
                "{bad",
                { id: 2, argv: ["plugin", "list"] },
            ]),
            env,
        );
        const msgs = parseStream(stdout.value);
        expect(msgs).toHaveLength(3); // hello + framing error + envelope
        const err = msgs[1]!.error as Record<string, unknown>;
        expect(err.code).toBe("BAD_REQUEST");
        const ok = msgs[2]!.envelope as Record<string, unknown>;
        expect(ok.status).toBe("ok");
    });
});

describe("serve — stream framing", () => {
    test("handles chunks split mid-line", async () => {
        // Split the JSON request across three chunks to exercise the buffer.
        const req = JSON.stringify({ id: 1, argv: ["plugin", "list"] });
        const mid = Math.floor(req.length / 2);
        async function* chunks(): AsyncGenerator<string> {
            yield req.slice(0, mid);
            yield req.slice(mid);
            yield "\n";
        }
        await runServeLoop(chunks(), env);
        const resp = parseStream(stdout.value)[1]!;
        expect(resp.id).toBe(1);
    });

    test("handles multiple requests in a single chunk", async () => {
        const a = JSON.stringify({ id: 1, argv: ["plugin", "list"] });
        const b = JSON.stringify({ id: 2, argv: ["plugin", "list"] });
        async function* chunks(): AsyncGenerator<string> {
            yield `${a}\n${b}\n`;
        }
        await runServeLoop(chunks(), env);
        const msgs = parseStream(stdout.value);
        expect(msgs).toHaveLength(3);
        expect(msgs[1]!.id).toBe(1);
        expect(msgs[2]!.id).toBe(2);
    });

    test("tolerates \\r\\n line endings", async () => {
        async function* chunks(): AsyncGenerator<string> {
            yield JSON.stringify({ id: 1, argv: ["plugin", "list"] }) + "\r\n";
        }
        await runServeLoop(chunks(), env);
        const resp = parseStream(stdout.value)[1]!;
        expect(resp.id).toBe(1);
    });
});

describe("serve — env inheritance", () => {
    test("mountOverride is reused across requests", async () => {
        // Point the serve-env at a fake Kindle; plugin list should pick it
        // up (deviceStateAvailable=true) without having to re-pass it per
        // request.
        const kindle = makeFakeKindle({ plugins_disabled: { hello: true } });
        env = { ...env, mountOverride: kindle };

        await runServeLoop(
            scripted([
                { id: 1, argv: ["plugin", "list"] },
                { id: 2, argv: ["plugin", "list"] },
            ]),
            env,
        );
        const msgs = parseStream(stdout.value);
        for (const m of [msgs[1]!, msgs[2]!]) {
            const envelope = m.envelope as Record<string, unknown>;
            const data = envelope.data as Record<string, unknown>;
            expect(data.deviceStateAvailable).toBe(true);
        }
    });
});
