// Hardened wrapper around the `yaml` library's parse. Pins the safety
// options we want at every call site so future library default changes
// don't surprise us. A12 from 87 — billion-laughs / YAML-bomb defense.
//
// Two independent caps:
//   - source length: a YAML document we're asked to parse cannot exceed
//     this many bytes. Protects against someone handing kindly a huge
//     file hoping we'll parse it.
//   - maxAliasCount: cap on resolved anchor references. The yaml library
//     defaults to 100, which is already a defensible number (billion
//     laughs requires exponential expansion); we pin it so the default
//     can't be relaxed under us.
//
// Callers that need to parse larger documents pass an explicit cap.

import { parse as yamlParseRaw } from "yaml";
import { ErrorCodes, KindlyError } from "../types/errors.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MiB
const MAX_ALIAS_COUNT = 100;

export interface ParseYamlSafeOptions {
    /** Override the 10 MiB source-length cap. Only rare callers need this. */
    maxBytes?: number;
}

export class YamlTooLargeError extends Error {
    constructor(public readonly observed: number, public readonly limit: number) {
        super(`YAML source is ${observed} bytes, exceeds ${limit} limit`);
        this.name = "YamlTooLargeError";
    }
}

// yaml@2's `version: "1.2"` option only sets a default; a `%YAML 1.1`
// directive in the source still flips parsing to 1.1 semantics, which
// reinterprets `no/yes/on/off` as booleans (S488). Reject any directive
// at the source layer — kindly never emits one and publishers have no
// legitimate reason to include one.
const YAML_DIRECTIVE_RE = /^%YAML\b/m;
export function parseYamlSafe(src: string, opts: ParseYamlSafeOptions = {}): unknown {
    const limit = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const bytes = Buffer.byteLength(src, "utf8");
    if (bytes > limit) {
        throw new YamlTooLargeError(bytes, limit);
    }
    if (YAML_DIRECTIVE_RE.test(src)) {
        throw new KindlyError(
            ErrorCodes.YAML_DIRECTIVE,
            "%YAML version directive is not allowed",
            [{ text: "Remove the %YAML directive from the document header. kindly pins YAML 1.2 semantics." }],
        );
    }
    return yamlParseRaw(src, {
        version: "1.2",
        maxAliasCount: MAX_ALIAS_COUNT,
        logLevel: "error",
    });
}
