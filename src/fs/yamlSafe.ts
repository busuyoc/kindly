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
//
// Round 4 narrow audit (S1240 HIGH): yaml@2 silently consumes a leading
// U+FEFF BOM before reading directives, so a BOM-prefixed `%YAML 1.1`
// header activated 1.1 mode while the original `^%YAML` regex saw the
// BOM at position 0 and missed the match. Allow zero or more BOMs after
// `^`. The `/m` flag's LineTerminator class covers LF, CR, U+2028 and
// U+2029 but NOT BOM, since yaml@2 treats BOM as a special encoding
// marker rather than content. End-to-end consequence of the original
// bug: any unsigned source path (kindly.yaml, lean `.kset.yaml` without
// sidecar, manifest.yaml inside an archive trusted by filename only)
// could silently flip every yes/no/on/off in the document from string
// to boolean — semantic inversion of every boolean-shaped key in the
// schema.
const YAML_DIRECTIVE_RE = /^﻿*%YAML\b/m;
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
    const parsed = yamlParseRaw(src, {
        version: "1.2",
        maxAliasCount: MAX_ALIAS_COUNT,
        logLevel: "error",
    });
    assertNfcKeys(parsed, "$", new WeakSet());
    return parsed;
}

// C5: reject keys that aren't in Unicode Normalization Form C. This
// closes the Lead 19 / Batch W class of bypasses where non-NFC variants
// of a SENSITIVE/SECRET key (e.g. ZWSP-injected, NFD-decomposed
// accents, math-italic letters) defeat byte-equality lookups in
// classify.ts. We REJECT rather than silently NFC-fold so the publisher
// fixes their pipeline — silent normalization would mask drift between
// the bytes signed and the bytes verified (Q1/Q2 in the v0.12 plan).
//
// Lead 19 round 2 (2026-04-26): NFC-equivalent invisible codepoints
// (ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, BOM U+FEFF, BiDi marks
// U+202A-202E + U+2066-2069, soft hyphen U+00AD, etc.) are their own
// NFC form — a ZWSP-injected variant of `kosync` normalizes to itself —
// so they pass the byte-equality check above but still defeat
// classify.ts lookups (the ZWSP-injected variant !== `kosync`). Reject
// any Cf (format) or Cc (control) codepoint in keys to close that
// remaining bypass surface. Same fail-closed posture as NFC.
const INVISIBLE_OR_CONTROL_RE = /[\p{Cf}\p{Cc}]/u;
function assertNfcKeys(value: unknown, pathHint: string, seen: WeakSet<object>): void {
    if (value === null || typeof value !== "object") return;
    // Cyclic YAML anchor-alias graphs (e.g. `root: &a [*a]`) produce a
    // self-referencing object; without this guard, the walk recurses
    // until stack overflow and `yamlToLua`'s YAML_CYCLIC check never
    // gets to fire. Cycles aren't a kindly error here — let
    // yamlToLua's downstream walker raise YAML_CYCLIC with full context.
    if (seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            assertNfcKeys(value[i], `${pathHint}[${i}]`, seen);
        }
        return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k.normalize("NFC") !== k) {
            throw new KindlyError(
                ErrorCodes.YAML_NON_NFC_KEY,
                `YAML key at ${pathHint} is not in Unicode Normalization Form C`,
                [
                    { text: "Re-encode the key in NFC. classify lookups depend on NFC equality." },
                    { text: "Common cause: macOS filenames or copy-paste from sources that use NFD or insert ZWSP/ZWJ characters." },
                ],
            );
        }
        if (INVISIBLE_OR_CONTROL_RE.test(k)) {
            throw new KindlyError(
                ErrorCodes.YAML_INVISIBLE_KEY,
                `YAML key at ${pathHint} contains an invisible or control codepoint`,
                [
                    { text: "Remove zero-width / BiDi / control characters from the key. classify lookups treat them as part of the name, defeating SECRET/SENSITIVE detection." },
                    { text: "Common offenders: U+200B (ZWSP), U+200C/D (ZWNJ/ZWJ), U+202A-E (BiDi overrides), U+FEFF (BOM)." },
                ],
            );
        }
        assertNfcKeys(v, `${pathHint}.${k}`, seen);
    }
}
