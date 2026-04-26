// Angle X cleanup — small Zod-schema hardening pass.
//
// Three independent concerns, all at the same parse seam:
//
//   S961 — `meta.source_url` had only `z.url()` and would accept
//          `javascript:`, `data:`, `file:`, `vbscript:`. The W33 GUI
//          will eventually render this as a click-through; reject any
//          scheme that isn't http(s)/mailto/git+https at parse time so
//          the GUI never has to remember.
//
//   S962 — `parseManifest`'s error summary did `issue.path.join(".")`
//          with raw bytes. For a manifest like
//          `settings: {"\x1b]0;pwn\x07key": ...}` the thrown
//          Error.message contains an OSC sequence; renderers sanitize
//          stdout, but `e.message` direct reads (test harnesses, GUI
//          IPC error envelopes, log forwarders) are not in the
//          renderer path. Sanitize at construction.
//
//   S964 — `settings: z.record(z.string(), ...)` accepts the literal
//          keys `constructor` and `prototype`. (`__proto__` gets
//          stripped by Zod's record parser via `Object.entries`
//          enumeration — null-prototype objects from yaml@2 don't
//          enumerate it either.) `kindly apply` catches this in
//          `plainToLua` (yaml.ts), but `setup import` flattens the
//          validated manifest directly into the apply pipeline
//          without going through `plainToLua` — close at the schema.
//
// Why these are tiny: the structural Zod surface has no transforms
// or coerce or async refines (S967 INFO), so each fix is a single
// refine + a few probes.

import { describe, test, expect } from "bun:test";

import {
    parseManifest,
    SetupSchemaError,
} from "../../src/setup/schema.ts";

function baseManifest(extra: Record<string, unknown> = {}): unknown {
    return {
        kindly_setup: "v1",
        meta: { name: "x", created_at: "2026-04-22T12:00:00Z" },
        apply_mode: "additive",
        ...extra,
    };
}

describe("S961 — source_url scheme allowlist", () => {
    test("rejects javascript:", () => {
        expect(() => parseManifest(baseManifest({
            meta: {
                name: "x",
                created_at: "2026-04-22T12:00:00Z",
                source_url: "javascript:alert(1)",
            },
        }))).toThrow(/scheme must be/);
    });

    test("rejects data:", () => {
        expect(() => parseManifest(baseManifest({
            meta: {
                name: "x",
                created_at: "2026-04-22T12:00:00Z",
                source_url: "data:text/html,<script>1</script>",
            },
        }))).toThrow(SetupSchemaError);
    });

    test("rejects file://", () => {
        expect(() => parseManifest(baseManifest({
            meta: {
                name: "x",
                created_at: "2026-04-22T12:00:00Z",
                source_url: "file:///etc/passwd",
            },
        }))).toThrow(SetupSchemaError);
    });

    test("rejects vbscript:", () => {
        expect(() => parseManifest(baseManifest({
            meta: {
                name: "x",
                created_at: "2026-04-22T12:00:00Z",
                source_url: "vbscript:msgbox",
            },
        }))).toThrow(SetupSchemaError);
    });

    test("accepts http://, https://, mailto:, git+https://", () => {
        for (const url of [
            "http://example.com",
            "https://github.com/foo/bar",
            "mailto:author@example.com",
            "git+https://github.com/foo/bar.git",
        ]) {
            const m = parseManifest(baseManifest({
                meta: {
                    name: "x",
                    created_at: "2026-04-22T12:00:00Z",
                    source_url: url,
                },
            }));
            expect(m.meta.source_url).toBe(url);
        }
    });
});

describe("S962 — sanitize Zod issue.path components in error summary", () => {
    // The path segment is the offending key; trigger a record-value
    // mismatch by supplying a function-typed value at a malicious key.
    // Functions don't match any SettingValueSchema union member, so Zod
    // raises an issue with `path: ["settings", "<bad-key>"]`.
    test("OSC bytes in settings key are stripped from Error.message", () => {
        const settings = { ["\x1b]0;pwn\x07normalkey"]: (() => 1) };
        try {
            parseManifest(baseManifest({ settings }));
        } catch (e) {
            const msg = (e as Error).message;
            // OSC start byte must not survive into the thrown message.
            expect(msg).not.toContain("\x1b");
            // Likewise BEL.
            expect(msg).not.toContain("\x07");
            // The post-strip key remains so the user still locates the
            // problem.
            expect(msg).toContain("normalkey");
        }
    });

    test("CSI bytes in nested path are stripped", () => {
        // `settings.outer.<csi-key>` — bad value at a key with CSI sequence.
        const settings = {
            outer: { ["\x1b[31mevil\x1b[0m"]: (() => 1) },
        };
        try {
            parseManifest(baseManifest({ settings }));
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).not.toContain("\x1b");
        }
    });
});

describe("S964 — reserved-key denylist on settings", () => {
    test("rejects top-level `constructor` key", () => {
        expect(() => parseManifest(baseManifest({
            settings: { constructor: 1 },
        }))).toThrow(SetupSchemaError);
    });

    test("rejects top-level `prototype` key", () => {
        expect(() => parseManifest(baseManifest({
            settings: { prototype: 1 },
        }))).toThrow(SetupSchemaError);
    });

    test("rejects `constructor` at nested depth", () => {
        expect(() => parseManifest(baseManifest({
            settings: { kosync: { constructor: 1 } },
        }))).toThrow(SetupSchemaError);
    });

    test("rejects `prototype` at nested depth", () => {
        expect(() => parseManifest(baseManifest({
            settings: { kosync: { prototype: 1 } },
        }))).toThrow(SetupSchemaError);
    });

    test("ordinary keys still pass", () => {
        const m = parseManifest(baseManifest({
            settings: { night_mode: true, kosync: { username: "alice" } },
        }));
        expect(m.settings).toEqual({
            night_mode: true,
            kosync: { username: "alice" },
        });
    });
});
