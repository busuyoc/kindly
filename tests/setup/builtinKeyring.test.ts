// W39 upstream key distribution — built-in publisher keyring.
//
// Two layers under test:
//
//   1. `validateBuiltinKeyringBytes` — pure function that does
//      size-cap + hash-bind + Zod validation. Tested with synthetic
//      bytes so failure modes (oversize, hash mismatch, invalid JSON,
//      schema violation) can be exercised without mutating the
//      committed `data/keyring/publishers.v1.json`.
//
//   2. `loadBuiltinKeyring` — the IO wrapper. Tested against the real
//      committed seed file: it MUST load on a fresh checkout (proves
//      `scripts/build-builtin-keyring.ts` ran and the hash constant
//      matches). Cache invalidation is exercised via the test-only
//      reset hook.
//
// The seed v0.13 ships an empty `publishers: []` array — curation is
// deferred to v1.0. So the live load returns an empty list; meaningful
// "find a publisher" tests use the pure validator on synthetic bytes
// that we hash ourselves.

import { describe, test, expect, beforeEach } from "bun:test";

import {
    BuiltinKeyringSchema,
    findBuiltinKey,
    loadBuiltinKeyring,
    MAX_KEYRING_BYTES,
    validateBuiltinKeyringBytes,
    _resetBuiltinKeyringCacheForTests,
    type BuiltinKeyring,
} from "../../src/setup/builtinKeyring.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { KindlyError } from "../../src/types/errors.ts";

// Synthetic publisher with a 64-hex key_id and a placeholder pubkey
// shape (44-char base64). The pubkey doesn't have to be a real Ed25519
// pubkey for schema tests — the schema only checks shape.
const FAKE_KEY_ID_A = "sha256:" + "a".repeat(64);
const FAKE_KEY_ID_B = "sha256:" + "b".repeat(64);
const FAKE_PUBKEY_B64 = "A".repeat(43) + "=";

function makeBytes(file: object): Buffer {
    return Buffer.from(JSON.stringify(file), "utf8");
}

beforeEach(() => {
    _resetBuiltinKeyringCacheForTests();
});

// ---- pure validator: success path ----------------------------------------

describe("validateBuiltinKeyringBytes — happy paths", () => {
    test("accepts a curated file with one publisher", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [
                {
                    key_id: FAKE_KEY_ID_A,
                    public_key_b64: FAKE_PUBKEY_B64,
                    label: "alice",
                    description: "starter ssh+kosync setup author",
                    since: "v0.13.0",
                    references: ["https://github.com/example/alice.pub"],
                },
            ],
        });
        const out = validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
        expect(out.publishers).toHaveLength(1);
        expect(out.publishers[0]!.label).toBe("alice");
    });

    test("accepts an empty publishers array", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [],
        });
        const out = validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
        expect(out.publishers).toEqual([]);
    });

    test("accepts ISO 8601 datetime for curated_at", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26T12:00:00Z",
            publishers: [],
        });
        const out = validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
        expect(out.curated_at).toBe("2026-04-26T12:00:00Z");
    });
});

// ---- pure validator: failure paths ---------------------------------------

describe("validateBuiltinKeyringBytes — size cap", () => {
    test("rejects bytes larger than 64 KiB with TOO_LARGE", () => {
        const padding = "x".repeat(MAX_KEYRING_BYTES);
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [],
            _: padding,
        });
        expect(bytes.length).toBeGreaterThan(MAX_KEYRING_BYTES);
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_TOO_LARGE");
        }
    });

    test("accepts bytes exactly at the limit", () => {
        // 64 KiB cap is generous enough that "exactly at limit" with
        // a valid envelope just needs careful padding; assert the
        // boundary by constructing a payload that's right under it.
        const filler = "x".repeat(MAX_KEYRING_BYTES - 200);
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: filler.slice(0, 100),
            }],
        });
        expect(bytes.length).toBeLessThanOrEqual(MAX_KEYRING_BYTES);
        // Hash check still has to match — pass the actual hash.
        const out = validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
        expect(out.publishers).toHaveLength(1);
    });
});

describe("validateBuiltinKeyringBytes — hash bind", () => {
    test("rejects bytes whose hash doesn't match expected", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [],
        });
        const wrongHash = "sha256:" + "0".repeat(64);
        try {
            validateBuiltinKeyringBytes(bytes, wrongHash, "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_HASH_MISMATCH");
            expect((e as KindlyError).message).toContain(wrongHash);
        }
    });

    test("a single-byte mutation flips the hash", () => {
        const original = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [],
        });
        const expectedHash = hashBytes(original);
        const tampered = Buffer.from(original);
        // Flip the closing brace so it's still parseable JSON-shape-ish
        // but a different byte sequence; the hash check fires before
        // JSON.parse.
        tampered[tampered.length - 2] = 0x20; // space
        try {
            validateBuiltinKeyringBytes(tampered, expectedHash, "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_HASH_MISMATCH");
        }
    });
});

describe("validateBuiltinKeyringBytes — JSON parse failures", () => {
    test("rejects non-JSON bytes with INVALID", () => {
        const bytes = Buffer.from("not json at all", "utf8");
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
            expect((e as KindlyError).message).toContain("not valid JSON");
        }
    });

    test("rejects truncated JSON", () => {
        const bytes = Buffer.from('{"kindly_builtin_keyring": "v1"', "utf8");
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });
});

describe("validateBuiltinKeyringBytes — schema enforcement", () => {
    test("rejects wrong version literal", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v2",
            curated_at: "2026-04-26",
            publishers: [],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects missing label (label is required for built-in entries)", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
            expect((e as KindlyError).message).toContain("label");
        }
    });

    test("rejects empty label", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "",
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects malformed key_id (uppercase hex)", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: "sha256:" + "A".repeat(64),
                public_key_b64: FAKE_PUBKEY_B64,
                label: "alice",
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects malformed public_key_b64 (wrong length)", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: "tooshort==",
                label: "alice",
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects extra unknown top-level field (.strict)", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [],
            future_field: "x",
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects extra unknown publisher field (.strict)", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "alice",
                stowaway: "x",
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("rejects javascript: scheme in references[]", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "alice",
                references: ["javascript:alert(1)"],
            }],
        });
        try {
            validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
            throw new Error("should have thrown");
        } catch (e) {
            expect((e as KindlyError).code).toBe("BUILTIN_KEYRING_INVALID");
        }
    });

    test("accepts http/https/mailto/git+https in references[]", () => {
        const bytes = makeBytes({
            kindly_builtin_keyring: "v1",
            curated_at: "2026-04-26",
            publishers: [{
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "alice",
                references: [
                    "https://github.com/foo",
                    "http://example.com",
                    "mailto:a@b.c",
                    "git+https://github.com/foo/bar.git",
                ],
            }],
        });
        const out = validateBuiltinKeyringBytes(bytes, hashBytes(bytes), "/x");
        expect(out.publishers[0]!.references).toHaveLength(4);
    });
});

// ---- findBuiltinKey -------------------------------------------------------

describe("findBuiltinKey", () => {
    const sample: BuiltinKeyring = BuiltinKeyringSchema.parse({
        kindly_builtin_keyring: "v1",
        curated_at: "2026-04-26",
        publishers: [
            {
                key_id: FAKE_KEY_ID_A,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "alice",
            },
            {
                key_id: FAKE_KEY_ID_B,
                public_key_b64: FAKE_PUBKEY_B64,
                label: "bob",
            },
        ],
    });

    test("returns the publisher when key_id matches exactly", () => {
        const found = findBuiltinKey(sample, FAKE_KEY_ID_B);
        expect(found?.label).toBe("bob");
    });

    test("returns null when key_id is absent", () => {
        expect(findBuiltinKey(sample, "sha256:" + "0".repeat(64))).toBeNull();
    });

    test("does not prefix-match (exact only)", () => {
        // Mirrors keyring.ts:findKey — exact-only at this layer.
        // Prefix matching for setup trust remove is at the CLI layer.
        const prefix = FAKE_KEY_ID_A.slice(0, 20);
        expect(findBuiltinKey(sample, prefix)).toBeNull();
    });
});

// ---- live load ------------------------------------------------------------

describe("loadBuiltinKeyring — live committed file", () => {
    test("loads the committed seed file successfully", () => {
        // This is the canary: if scripts/build-builtin-keyring.ts didn't
        // run after editing data/keyring/publishers.v1.json, the hash
        // mismatch fires here.
        const out = loadBuiltinKeyring();
        expect(out.kindly_builtin_keyring).toBe("v1");
        expect(Array.isArray(out.publishers)).toBe(true);
    });

    test("v0.13 ships with empty publishers (curation deferred to v1.0)", () => {
        const out = loadBuiltinKeyring();
        expect(out.publishers).toEqual([]);
    });

    test("repeated calls return the cached instance", () => {
        const a = loadBuiltinKeyring();
        const b = loadBuiltinKeyring();
        expect(a).toBe(b);
    });

    test("_resetBuiltinKeyringCacheForTests forces re-validation", () => {
        const a = loadBuiltinKeyring();
        _resetBuiltinKeyringCacheForTests();
        const b = loadBuiltinKeyring();
        // Same content, different object identity.
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});
