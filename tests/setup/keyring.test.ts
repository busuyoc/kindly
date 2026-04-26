// W39 step 2 — local trust roster: load/save/add/remove + path resolution.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import {
    keyringPath, loadKeyring, saveKeyring, addKey, removeKey, findKey,
    KeyringError, type TrustedKeysFile,
} from "../../src/setup/keyring.ts";
import type { CliEnv } from "../../src/cli/env.ts";
import { StringWriter } from "../../src/cli/env.ts";

function makeEnv(homeOverride: string): CliEnv {
    return {
        cwd: homeOverride,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        homeOverride,
        now: () => new Date("2026-04-26T12:00:00Z"),
    };
}

function genEd25519Pem(): { privatePem: string; publicPem: string } {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
        privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    };
}

let home: string;
let env: CliEnv;
let now: Date;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-keyring-"));
    env = makeEnv(home);
    now = new Date("2026-04-26T12:00:00Z");
});

// ---- Path resolution + initial state --------------------------------------

describe("keyring path + empty state", () => {
    test("keyringPath honors homeOverride", () => {
        expect(keyringPath(env)).toBe(join(home, ".kindly", "trusted-keys.json"));
    });

    test("loadKeyring on missing file → empty roster (no file created)", () => {
        const file = loadKeyring(env);
        expect(file).toEqual({ kindly_trust: "v1", keys: [] });
        // No side effect — first run should not auto-write.
        expect(existsSync(keyringPath(env))).toBe(false);
    });
});

// ---- Round-trip ------------------------------------------------------------

describe("keyring round-trip", () => {
    test("add → save → load → findKey", () => {
        const { publicPem } = genEd25519Pem();
        const empty = loadKeyring(env);
        const { file, added } = addKey(empty, { publicKeyPem: publicPem, label: "alice", now });
        saveKeyring(env, file);

        const reloaded = loadKeyring(env);
        expect(reloaded.keys.length).toBe(1);
        expect(reloaded.keys[0]).toEqual(added);
        expect(reloaded.keys[0]!.label).toBe("alice");
        expect(reloaded.keys[0]!.added_at).toBe("2026-04-26T12:00:00.000Z");

        const found = findKey(reloaded, added.key_id);
        expect(found).not.toBeNull();
        expect(found!.key_id).toBe(added.key_id);
    });

    test("add without label → label field omitted", () => {
        const { publicPem } = genEd25519Pem();
        const { file, added } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        saveKeyring(env, file);
        const reloaded = loadKeyring(env);
        expect(reloaded.keys[0]!.label).toBeUndefined();
        expect(added.label).toBeUndefined();
    });

    test("save creates ~/.kindly/ if absent", () => {
        const dotKindly = join(home, ".kindly");
        expect(existsSync(dotKindly)).toBe(false);
        saveKeyring(env, { kindly_trust: "v1", keys: [] });
        expect(existsSync(dotKindly)).toBe(true);
        expect(existsSync(keyringPath(env))).toBe(true);
    });

    test("save is atomic — no .tmp left behind on success", () => {
        saveKeyring(env, { kindly_trust: "v1", keys: [] });
        const leftover = readdirSync(join(home, ".kindly"))
            .filter((n) => n.includes(".tmp."));
        expect(leftover).toEqual([]);
    });
});

// ---- Add semantics ---------------------------------------------------------

describe("addKey", () => {
    test("derived key_id matches signing.ts keyIdFromPublicKey shape", () => {
        const { publicPem } = genEd25519Pem();
        const { added } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        expect(added.key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(added.public_key_b64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    });

    test("dup key_id → KEYRING_DUP_KEY", () => {
        const { publicPem } = genEd25519Pem();
        const { file } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        expect(() => addKey(file, { publicKeyPem: publicPem, now })).toThrow(KeyringError);
        try {
            addKey(file, { publicKeyPem: publicPem, now });
        } catch (e) {
            expect(e).toBeInstanceOf(KeyringError);
            expect((e as KeyringError).code).toBe("KEYRING_DUP_KEY");
        }
    });

    test("non-Ed25519 PEM → KEYRING_INVALID_KEY", () => {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
        try {
            addKey(loadKeyring(env), { publicKeyPem: pem, now });
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_INVALID_KEY");
        }
    });

    test("garbage PEM → KEYRING_INVALID_KEY", () => {
        try {
            addKey(loadKeyring(env), { publicKeyPem: "not a PEM", now });
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_INVALID_KEY");
        }
    });

    test("two distinct keys both add successfully", () => {
        const a = genEd25519Pem();
        const b = genEd25519Pem();
        let file = loadKeyring(env);
        ({ file } = addKey(file, { publicKeyPem: a.publicPem, label: "alice", now }));
        ({ file } = addKey(file, { publicKeyPem: b.publicPem, label: "bob", now }));
        expect(file.keys.length).toBe(2);
        expect(file.keys.map((k) => k.label)).toEqual(["alice", "bob"]);
    });
});

// ---- Remove semantics ------------------------------------------------------

describe("removeKey", () => {
    test("remove by full key_id → KEYRING_KEY_NOT_FOUND on missing", () => {
        try {
            removeKey({ kindly_trust: "v1", keys: [] }, "sha256:" + "z".repeat(64));
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_KEY_NOT_FOUND");
        }
    });

    test("remove by short prefix → resolves uniquely", () => {
        const { publicPem } = genEd25519Pem();
        const { file, added } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        const prefix = added.key_id.slice(0, "sha256:".length + 8);
        const { file: after, removed } = removeKey(file, prefix);
        expect(after.keys).toEqual([]);
        expect(removed.key_id).toBe(added.key_id);
    });

    test("ambiguous prefix → KEYRING_KEY_AMBIGUOUS", () => {
        // Force two keys whose key_id share a common prefix by handcrafting
        // a roster (since real key_ids are sha256, true collision in the
        // first N hex chars is statistically negligible — bypass via direct
        // construction).
        const file: TrustedKeysFile = {
            kindly_trust: "v1",
            keys: [
                { key_id: "sha256:" + "ab".padEnd(64, "0"), public_key_b64: "A".repeat(43) + "=", added_at: "2026-04-26T12:00:00Z" },
                { key_id: "sha256:" + "ab".padEnd(64, "1"), public_key_b64: "B".repeat(43) + "=", added_at: "2026-04-26T12:00:00Z" },
            ],
        };
        try {
            removeKey(file, "sha256:ab");
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_KEY_AMBIGUOUS");
            expect((e as KeyringError).message).toContain("matches 2 keys");
        }
    });
});

// ---- Corruption handling ---------------------------------------------------

describe("KEYRING_CORRUPT", () => {
    function corruptWith(content: string): void {
        const dir = join(home, ".kindly");
        mkdirSync(dir, { recursive: true });
        writeFileSync(keyringPath(env), content);
    }

    test("malformed JSON → KEYRING_CORRUPT", () => {
        corruptWith("{ not json");
        try {
            loadKeyring(env);
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
            expect((e as KeyringError).message).toContain("valid JSON");
        }
    });

    test("schema mismatch — wrong version", () => {
        corruptWith(JSON.stringify({ kindly_trust: "v2", keys: [] }));
        try {
            loadKeyring(env);
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
        }
    });

    test("schema mismatch — invalid key_id format", () => {
        corruptWith(JSON.stringify({
            kindly_trust: "v1",
            keys: [{ key_id: "RWT123", public_key_b64: "A".repeat(43) + "=", added_at: "2026-04-26T12:00:00Z" }],
        }));
        try {
            loadKeyring(env);
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
        }
    });

    test("schema mismatch — extra top-level field rejected (.strict)", () => {
        corruptWith(JSON.stringify({
            kindly_trust: "v1",
            keys: [],
            extra_field: "should reject",
        }));
        try {
            loadKeyring(env);
            throw new Error("expected throw");
        } catch (e) {
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
        }
    });
});

// ---- Find lookup -----------------------------------------------------------

describe("findKey", () => {
    test("returns null when key absent", () => {
        const result = findKey({ kindly_trust: "v1", keys: [] }, "sha256:" + "0".repeat(64));
        expect(result).toBeNull();
    });

    test("returns entry when key present", () => {
        const { publicPem } = genEd25519Pem();
        const { file, added } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        const found = findKey(file, added.key_id);
        expect(found).not.toBeNull();
        expect(found!.key_id).toBe(added.key_id);
    });

    test("requires exact match (not prefix)", () => {
        const { publicPem } = genEd25519Pem();
        const { file, added } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        expect(findKey(file, added.key_id.slice(0, 20))).toBeNull();
    });
});

// ---- Round 3 hardening: load-time integrity ------------------------------

describe("loadKeyring round-3 hardening", () => {
    function writeRoster(content: unknown): void {
        const path = keyringPath(env);
        mkdirSync(join(home, ".kindly"), { recursive: true });
        writeFileSync(path, JSON.stringify(content));
    }

    test("rejects oversize roster (> KEYRING_MAX_BYTES)", () => {
        const path = keyringPath(env);
        mkdirSync(join(home, ".kindly"), { recursive: true });
        // 5 MiB blob — over the 4 MiB cap.
        writeFileSync(path, "x".repeat(5 * 1024 * 1024));
        try {
            loadKeyring(env);
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KeyringError);
            expect((e as KeyringError).code).toBe("KEYRING_TOO_LARGE");
        }
    });

    test("rejects key_id that does not match hash of public_key_b64", () => {
        const { publicPem: pemA } = genEd25519Pem();
        const { publicPem: pemB } = genEd25519Pem();
        // Add key A, then swap in key B's pubkey under A's key_id.
        const { file: a } = addKey(loadKeyring(env), { publicKeyPem: pemA, now });
        const { added: b } = addKey({ kindly_trust: "v1", keys: [] }, { publicKeyPem: pemB, now });
        const tampered = {
            ...a,
            keys: [
                { ...a.keys[0]!, public_key_b64: b.public_key_b64 },
            ],
        };
        writeRoster(tampered);
        try {
            loadKeyring(env);
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KeyringError);
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
            expect((e as KeyringError).message).toContain("does not match the hash");
        }
    });

    test("rejects duplicate key_id", () => {
        const { publicPem } = genEd25519Pem();
        const { file } = addKey(loadKeyring(env), { publicKeyPem: publicPem, now });
        const dup = { ...file, keys: [file.keys[0]!, file.keys[0]!] };
        writeRoster(dup);
        try {
            loadKeyring(env);
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(KeyringError);
            expect((e as KeyringError).code).toBe("KEYRING_CORRUPT");
            expect((e as KeyringError).message).toContain("duplicate key_id");
        }
    });
});

