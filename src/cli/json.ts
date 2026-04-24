// JSON output envelope and helpers for `--json` mode.
//
// Every command that emits JSON wraps its payload in a JsonEnvelope with
// version metadata, a command identifier, and a status discriminator. A
// consumer scripting against kindly reads the envelope first, branches on
// `status`, then pulls `data` or `error` as typed.
//
// Wire layout (v0.6, $schema_version = 1):
//
//   success → stdout (single JSON object + newline)
//   {
//     "$schema_version": 1,
//     "kindly_version": "0.11.0",
//     "generated_at": "2026-04-22T12:00:00.000Z",
//     "command": "pull",
//     "status": "ok",
//     "data": { ... typed result ... },
//     "warnings": []
//   }
//
//   error → stderr (single JSON object + newline)
//   {
//     "$schema_version": 1, ...,
//     "status": "error",
//     "error": { "code": "OUTPUT_EXISTS", "message": "...", "remediation": [...] }
//   }
//
// The split (ok→stdout, error→stderr) matches how CLI consumers pipe:
// `kindly pull --json | jq` stays clean on success; on error, stderr still
// carries machine-readable detail, exit code is non-zero.

import type { CliEnv } from "./env.ts";
import { KindlyError } from "../types/errors.ts";
import type { Remediation } from "../types/errors.ts";
import { sanitizeForTerminal } from "./sanitize.ts";

import pkg from "../../package.json" with { type: "json" };
const KINDLY_VERSION: string = pkg.version;

// A JSON.stringify replacer that sanitizes every string value it
// encounters. `--json` output is still rendered to a terminal in
// practice (`kindly pull --json | jq` inherits the parent TTY), so
// attacker-controlled strings inside the envelope need the same
// control-byte protection as human renderers. Belt to the Writer-layer
// suspenders — sanitize is idempotent so double application is safe.
function sanitizeReplacer(_key: string, value: unknown): unknown {
    if (typeof value === "string") return sanitizeForTerminal(value);
    return value;
}

export const JSON_SCHEMA_VERSION = 1;

export interface JsonEnvelopeOk<T = unknown> {
    $schema_version: number;
    kindly_version: string;
    generated_at: string;
    command: string;
    status: "ok";
    data: T;
    warnings: string[];
}

export interface JsonEnvelopeError {
    $schema_version: number;
    kindly_version: string;
    generated_at: string;
    command: string;
    status: "error";
    error: {
        code: string;
        message: string;
        remediation: Remediation[];
    };
}

export type JsonEnvelope<T = unknown> = JsonEnvelopeOk<T> | JsonEnvelopeError;

// Emit a successful envelope on stdout, followed by a single newline.
export function emitJson<T>(
    env: CliEnv,
    command: string,
    data: T,
    warnings: string[] = [],
): void {
    const envelope: JsonEnvelopeOk<T> = {
        $schema_version: JSON_SCHEMA_VERSION,
        kindly_version: KINDLY_VERSION,
        generated_at: env.now().toISOString(),
        command,
        status: "ok",
        data,
        warnings,
    };
    env.stdout.writeRaw(JSON.stringify(envelope, sanitizeReplacer) + "\n");
}

// Emit an error envelope on stderr, followed by a single newline.
// Non-KindlyError values get wrapped under an `UNKNOWN` code so consumers
// never see an unstructured string.
export function emitJsonError(
    env: CliEnv,
    command: string,
    err: unknown,
): void {
    const kindly = err instanceof KindlyError
        ? err
        : null;
    const envelope: JsonEnvelopeError = {
        $schema_version: JSON_SCHEMA_VERSION,
        kindly_version: KINDLY_VERSION,
        generated_at: env.now().toISOString(),
        command,
        status: "error",
        error: kindly
            ? { code: kindly.code, message: kindly.message, remediation: kindly.remediation }
            : { code: "UNKNOWN", message: (err as Error)?.message ?? String(err), remediation: [] },
    };
    env.stderr.writeRaw(JSON.stringify(envelope, sanitizeReplacer) + "\n");
}
