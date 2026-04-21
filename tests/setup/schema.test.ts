import { describe, test, expect } from "bun:test";
import {
    parseManifest,
    tryParseManifest,
    SetupSchemaError,
    type SetupManifest,
} from "../../src/setup/schema.ts";

// A minimal valid manifest — reused across tests as a starting point for
// "add one thing, expect valid" or "break one thing, expect failure".
function minimal(): unknown {
    return {
        kindly_setup: "v1",
        meta: {
            name: "Test Setup",
            created_at: "2026-04-21T12:00:00Z",
        },
        apply_mode: "additive",
    };
}

describe("parseManifest — valid manifests", () => {
    test("accepts the minimal required shape", () => {
        const m = parseManifest(minimal());
        expect(m.kindly_setup).toBe("v1");
        expect(m.meta.name).toBe("Test Setup");
        expect(m.apply_mode).toBe("additive");
    });

    test("accepts a fully-populated manifest", () => {
        const raw = {
            kindly_setup: "v1",
            meta: {
                name: "Night Reading",
                author: "alice",
                description: "Low-flash, warm UI",
                created_at: "2026-04-21T12:00:00.000Z",
                tags: ["night", "minimal"],
            },
            compat: {
                koreader_version_min: "2024.03",
                koreader_version_max: null,
                device: ["kindle-pw5"],
            },
            apply_mode: "replace",
            settings: {
                avoid_flashing_ui: true,
                refresh_rate: 8,
                screen_warmth: 60,
                nested: { a: 1, b: [true, false, null] },
            },
            plugins: {
                disabled: ["coverbrowser", "statistics"],
                files: [
                    {
                        path: "plugins/SSH.koplugin",
                        hash: "sha256:" + "a".repeat(64),
                        bytes: 48231,
                    },
                ],
            },
            patches: [
                {
                    path: "patches/2-autoflash.lua",
                    hash: "sha256:" + "b".repeat(64),
                    bytes: 412,
                    description: "Force full refresh every 6 pages",
                },
            ],
        };
        const m = parseManifest(raw);
        expect(m.apply_mode).toBe("replace");
        expect(m.plugins?.files?.[0]?.path).toBe("plugins/SSH.koplugin");
        expect(m.patches?.[0]?.description).toBe("Force full refresh every 6 pages");
    });

    test("accepts all Lua-expressible setting value types", () => {
        const raw = {
            ...(minimal() as object),
            settings: {
                s: "string",
                n: 42,
                f: 3.14,
                b: true,
                z: null,
                arr: [1, "two", true, null, [1, 2]],
                nested: { deep: { deeper: { deepest: [1] } } },
            },
        };
        const m = parseManifest(raw);
        expect(m.settings?.s).toBe("string");
        expect(m.settings?.arr).toEqual([1, "two", true, null, [1, 2]]);
    });

    test("accepts ISO datetime with offset", () => {
        const raw = {
            ...(minimal() as object),
            meta: {
                name: "x",
                created_at: "2026-04-21T14:00:00+02:00",
            },
        };
        const m = parseManifest(raw);
        expect(m.meta.created_at).toBe("2026-04-21T14:00:00+02:00");
    });
});

describe("parseManifest — invalid manifests", () => {
    test("rejects missing kindly_setup", () => {
        const raw: Record<string, unknown> = { ...(minimal() as Record<string, unknown>) };
        delete raw.kindly_setup;
        expect(() => parseManifest(raw)).toThrow(SetupSchemaError);
    });

    test("rejects wrong schema version", () => {
        const raw = { ...(minimal() as object), kindly_setup: "v2" };
        expect(() => parseManifest(raw)).toThrow(/kindly_setup/);
    });

    test("rejects missing meta.name", () => {
        const raw = {
            ...(minimal() as object),
            meta: { created_at: "2026-04-21T12:00:00Z" },
        };
        expect(() => parseManifest(raw)).toThrow(/meta\.name|name/);
    });

    test("rejects empty meta.name", () => {
        const raw = {
            ...(minimal() as object),
            meta: { name: "", created_at: "2026-04-21T12:00:00Z" },
        };
        expect(() => parseManifest(raw)).toThrow();
    });

    test("rejects malformed created_at", () => {
        const raw = {
            ...(minimal() as object),
            meta: { name: "x", created_at: "not-a-date" },
        };
        expect(() => parseManifest(raw)).toThrow(/created_at|datetime/i);
    });

    test("rejects unknown apply_mode", () => {
        const raw = { ...(minimal() as object), apply_mode: "merge-deep" };
        expect(() => parseManifest(raw)).toThrow();
    });

    test("rejects unknown top-level keys (strict)", () => {
        const raw = { ...(minimal() as object), wat: "unexpected" };
        expect(() => parseManifest(raw)).toThrow();
    });

    test("rejects unknown keys inside meta (strict)", () => {
        const raw = {
            ...(minimal() as object),
            meta: {
                name: "x",
                created_at: "2026-04-21T12:00:00Z",
                autrhor: "typo here",  // note the typo
            },
        };
        expect(() => parseManifest(raw)).toThrow();
    });

    test("rejects bad hash format in embedded file", () => {
        const raw = {
            ...(minimal() as object),
            patches: [{ path: "patches/x.lua", hash: "md5:short", bytes: 10 }],
        };
        expect(() => parseManifest(raw)).toThrow(/hash/);
    });

    test("rejects negative bytes count", () => {
        const raw = {
            ...(minimal() as object),
            patches: [{
                path: "patches/x.lua",
                hash: "sha256:" + "a".repeat(64),
                bytes: -1,
            }],
        };
        expect(() => parseManifest(raw)).toThrow();
    });

    test("rejects empty path in embedded file", () => {
        const raw = {
            ...(minimal() as object),
            patches: [{
                path: "",
                hash: "sha256:" + "a".repeat(64),
                bytes: 10,
            }],
        };
        expect(() => parseManifest(raw)).toThrow(/path/);
    });

    test("error lists up to 5 issues then truncates", () => {
        const raw = {
            // all wrong
            kindly_setup: "v99",
            meta: { name: "" },
            apply_mode: "nope",
            settings: "not an object",
        };
        try {
            parseManifest(raw);
            expect(true).toBe(false); // unreachable
        } catch (e) {
            expect(e).toBeInstanceOf(SetupSchemaError);
            const err = e as SetupSchemaError;
            expect(err.issues.length).toBeGreaterThanOrEqual(3);
            // Message should include multiple semicolon-separated issues.
            expect(err.message.split(";").length).toBeGreaterThanOrEqual(2);
        }
    });
});

describe("tryParseManifest — non-throwing variant", () => {
    test("returns ok: true with manifest on success", () => {
        const r = tryParseManifest(minimal());
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.manifest.kindly_setup).toBe("v1");
    });

    test("returns ok: false with issues on failure", () => {
        const r = tryParseManifest({ nope: "not a manifest" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    });
});

describe("SetupManifest type surface", () => {
    test("optional fields are actually optional at the type level", () => {
        // This test exists mainly as a type-check — if the type becomes
        // over-required, this stops compiling. Runtime assertion is
        // secondary.
        const m: SetupManifest = {
            kindly_setup: "v1",
            meta: { name: "x", created_at: "2026-04-21T12:00:00Z" },
            apply_mode: "additive",
        };
        expect(m.compat).toBeUndefined();
        expect(m.settings).toBeUndefined();
        expect(m.plugins).toBeUndefined();
        expect(m.patches).toBeUndefined();
    });
});
