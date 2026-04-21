import { describe, test, expect } from "bun:test";
import { parse as yamlParse } from "yaml";
import {
    canonicalizeManifest,
    manifestHash,
    hashBytes,
    shortId,
} from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function make(raw: unknown): SetupManifest {
    return parseManifest(raw);
}

const baseRaw = {
    kindly_setup: "v1",
    meta: { name: "Test", created_at: "2026-04-21T12:00:00Z" },
    apply_mode: "additive",
};

describe("canonicalizeManifest", () => {
    test("ends with a single trailing newline", () => {
        const s = canonicalizeManifest(make(baseRaw));
        expect(s.endsWith("\n")).toBe(true);
        expect(s.endsWith("\n\n")).toBe(false);
    });

    test("uses 2-space indent", () => {
        const s = canonicalizeManifest(make(baseRaw));
        // meta is a nested block; its children are indented 2 spaces.
        expect(s).toMatch(/^meta:\n  created_at: /m);
    });

    test("sorts top-level keys lexicographically", () => {
        const s = canonicalizeManifest(make(baseRaw));
        const lines = s.split("\n").filter((l) => l && !l.startsWith(" "));
        // Drop value trailing "; keep the keys.
        const topKeys = lines.map((l) => l.split(":")[0]).filter(Boolean);
        expect(topKeys).toEqual([...topKeys].sort());
    });

    test("sorts nested map keys", () => {
        const s = canonicalizeManifest(make({
            ...baseRaw,
            settings: { zebra: 1, apple: 2, mango: 3 },
        }));
        const settingsBlock = s.slice(s.indexOf("settings:"));
        const nested = settingsBlock.split("\n").filter((l) => l.startsWith("  "));
        const nestedKeys = nested.map((l) => l.trim().split(":")[0]);
        expect(nestedKeys).toEqual(["apple", "mango", "zebra"]);
    });

    test("sorts deeply nested keys", () => {
        const s = canonicalizeManifest(make({
            ...baseRaw,
            settings: { outer: { z: 1, a: 2, m: 3 } },
        }));
        // Inner keys must appear in alpha order.
        const aIdx = s.indexOf("a: 2");
        const mIdx = s.indexOf("m: 3");
        const zIdx = s.indexOf("z: 1");
        expect(aIdx).toBeGreaterThan(0);
        expect(mIdx).toBeGreaterThan(aIdx);
        expect(zIdx).toBeGreaterThan(mIdx);
    });

    test("array order is preserved (arrays are ordered by meaning)", () => {
        const s = canonicalizeManifest(make({
            ...baseRaw,
            meta: {
                name: "x",
                created_at: "2026-04-21T12:00:00Z",
                tags: ["gamma", "alpha", "beta"],
            },
        }));
        // tags preserve insertion order — we don't sort arrays.
        const tagsBlock = s.slice(s.indexOf("tags:"));
        expect(tagsBlock.indexOf("gamma")).toBeLessThan(tagsBlock.indexOf("alpha"));
        expect(tagsBlock.indexOf("alpha")).toBeLessThan(tagsBlock.indexOf("beta"));
    });

    test("strips undefined optional fields (don't emit them)", () => {
        const m = make(baseRaw);
        const s = canonicalizeManifest(m);
        expect(s).not.toContain("compat");
        expect(s).not.toContain("settings");
        expect(s).not.toContain("plugins");
        expect(s).not.toContain("patches");
    });

    test("round-trips through YAML parser (our output is valid YAML)", () => {
        const original = {
            ...baseRaw,
            settings: { a: 1, b: [1, 2, 3], c: { nested: true } },
            compat: { device: ["kindle-pw5"] },
        };
        const m = make(original);
        const s = canonicalizeManifest(m);
        const parsed = yamlParse(s);
        expect(parsed.kindly_setup).toBe("v1");
        expect(parsed.settings.a).toBe(1);
        expect(parsed.settings.b).toEqual([1, 2, 3]);
        expect(parsed.settings.c.nested).toBe(true);
        expect(parsed.compat.device).toEqual(["kindle-pw5"]);
    });

    test("equal-data / different-input-order → identical bytes", () => {
        const a = make({
            kindly_setup: "v1",
            apply_mode: "additive",
            meta: { name: "x", created_at: "2026-04-21T12:00:00Z" },
            settings: { b: 2, a: 1, c: 3 },
        });
        const b = make({
            // keys deliberately in a different order
            meta: { created_at: "2026-04-21T12:00:00Z", name: "x" },
            settings: { c: 3, a: 1, b: 2 },
            apply_mode: "additive",
            kindly_setup: "v1",
        });
        expect(canonicalizeManifest(a)).toBe(canonicalizeManifest(b));
    });

    test("byte-stable snapshot for a fixed fixture", () => {
        // THIS TEST EXISTS TO CATCH LIBRARY DRIFT.
        // If it fails, the `yaml` library changed its emission. Either
        // update the expected bytes AND bump the Setup schema version, or
        // pin the `yaml` version harder. Never silently update the bytes
        // without also considering that all existing hashes change.
        const m = make({
            kindly_setup: "v1",
            apply_mode: "additive",
            meta: {
                name: "Snapshot Fixture",
                author: "kindly-tests",
                created_at: "2026-04-21T12:00:00Z",
                tags: ["test"],
            },
            compat: { koreader_version_min: "2024.03", device: ["kindle-pw5"] },
            settings: { avoid_flashing_ui: true, refresh_rate: 8 },
            plugins: { disabled: ["coverbrowser"] },
        });
        const expected =
`apply_mode: additive
compat:
  device:
    - kindle-pw5
  koreader_version_min: "2024.03"
kindly_setup: v1
meta:
  author: kindly-tests
  created_at: 2026-04-21T12:00:00Z
  name: Snapshot Fixture
  tags:
    - test
plugins:
  disabled:
    - coverbrowser
settings:
  avoid_flashing_ui: true
  refresh_rate: 8
`;
        expect(canonicalizeManifest(m)).toBe(expected);
    });
});

describe("manifestHash", () => {
    test("format is sha256:<64 lowercase hex>", () => {
        const h = manifestHash(make(baseRaw));
        expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    test("identical manifests produce identical hashes", () => {
        const a = make(baseRaw);
        const b = make(baseRaw);
        expect(manifestHash(a)).toBe(manifestHash(b));
    });

    test("different-input-order but same data → same hash", () => {
        const a = make({
            kindly_setup: "v1",
            apply_mode: "additive",
            meta: { name: "x", created_at: "2026-04-21T12:00:00Z" },
            settings: { a: 1, b: 2 },
        });
        const b = make({
            apply_mode: "additive",
            settings: { b: 2, a: 1 },
            meta: { created_at: "2026-04-21T12:00:00Z", name: "x" },
            kindly_setup: "v1",
        });
        expect(manifestHash(a)).toBe(manifestHash(b));
    });

    test("changing any field changes the hash", () => {
        const h1 = manifestHash(make(baseRaw));
        const h2 = manifestHash(make({ ...baseRaw, apply_mode: "replace" }));
        const h3 = manifestHash(make({
            ...baseRaw,
            meta: { name: "different", created_at: "2026-04-21T12:00:00Z" },
        }));
        expect(h1).not.toBe(h2);
        expect(h1).not.toBe(h3);
        expect(h2).not.toBe(h3);
    });

    test("adding an optional field changes the hash", () => {
        const h1 = manifestHash(make(baseRaw));
        const h2 = manifestHash(make({
            ...baseRaw,
            compat: { device: ["kindle-pw5"] },
        }));
        expect(h1).not.toBe(h2);
    });

    test("explicitly-present vs absent optional field → different hash", () => {
        // `tags: []` and `tags: undefined` are different — the first
        // emits an empty tags block, the second strips it entirely.
        const h1 = manifestHash(make({
            ...baseRaw,
            meta: { name: "x", created_at: "2026-04-21T12:00:00Z" },
        }));
        const h2 = manifestHash(make({
            ...baseRaw,
            meta: { name: "x", created_at: "2026-04-21T12:00:00Z", tags: [] },
        }));
        expect(h1).not.toBe(h2);
    });
});

describe("hashBytes", () => {
    test("hashes utf8 bytes of a string", () => {
        const h = hashBytes("hello world");
        // sha256("hello world") — known value
        expect(h).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });

    test("matches manifestHash output for canonicalized bytes", () => {
        const m = make(baseRaw);
        const fromManifest = manifestHash(m);
        const fromBytes = hashBytes(canonicalizeManifest(m));
        expect(fromBytes).toBe(fromManifest);
    });

    test("accepts Uint8Array", () => {
        const bytes = new TextEncoder().encode("hello world");
        expect(hashBytes(bytes)).toBe(
            "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    });
});

describe("shortId", () => {
    test("returns 12 lowercase hex chars from a full hash string", () => {
        const id = shortId("sha256:" + "a1b2c3d4e5f6".padEnd(64, "0"));
        expect(id).toBe("a1b2c3d4e5f6");
        expect(id).toHaveLength(12);
    });

    test("accepts a manifest directly", () => {
        const m = make(baseRaw);
        const fromManifest = shortId(m);
        const fromHash = shortId(manifestHash(m));
        expect(fromManifest).toBe(fromHash);
    });

    test("handles raw hex without sha256: prefix", () => {
        expect(shortId("abcdef1234567890".padEnd(64, "0"))).toBe("abcdef123456");
    });
});
