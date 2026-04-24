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

export function parseYamlSafe(src: string, opts: ParseYamlSafeOptions = {}): unknown {
    const limit = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    // String.length is UTF-16 units; byteLength via Buffer is the actual
    // on-the-wire byte count. We cap on bytes so the check is stable
    // across encodings.
    const bytes = Buffer.byteLength(src, "utf8");
    if (bytes > limit) {
        throw new YamlTooLargeError(bytes, limit);
    }
    // logLevel:"error" keeps YAMLWarning off stderr — it breaks --json
    // framing for consumers parsing line-delimited envelopes, and the
    // multi-line stack traces can leak node_modules absolute paths.
    // We deliberately pick "error" not "silent": the latter also swallows
    // the throw on malformed YAML (yaml@2 silently returns a partial
    // object), which would turn parse errors into invisible data issues.
    return yamlParseRaw(src, {
        maxAliasCount: MAX_ALIAS_COUNT,
        logLevel: "error",
    });
}
