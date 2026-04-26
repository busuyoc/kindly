// W39 step 3 — `kindly setup trust list/add/remove`. UX-only at this
// stage; setup verify / import wiring lands in steps 4-5.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { keyringPath } from "../../src/setup/keyring.ts";

function genEd25519Pem(): string {
    const { publicKey } = generateKeyPairSync("ed25519");
    return publicKey.export({ type: "spki", format: "pem" }) as string;
}

function makeEnv(home: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd: home,
            stdout: out,
            stderr: err,
            color: false,
            homeOverride: home,
            now: () => new Date("2026-04-26T12:00:00Z"),
        },
        out,
        err,
    };
}

let home: string;
let pubPath: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kindly-trust-cli-"));
    pubPath = join(home, "alice.pub");
    writeFileSync(pubPath, genEd25519Pem());
});

// ---- list (empty) ---------------------------------------------------------

describe("setup trust list", () => {
    test("empty roster → friendly message, no file created", async () => {
        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "list"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("no trusted keys yet");
        expect(out.value).toContain("kindly setup trust add");
        expect(existsSync(keyringPath(env))).toBe(false);
    });

    test("--json on empty roster → keys: [] envelope", async () => {
        const { env, out } = makeEnv(home);
        await main(["setup", "trust", "list", "--json"], env);
        const payload = JSON.parse(out.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.keys).toEqual([]);
    });
});

// ---- add ------------------------------------------------------------------

describe("setup trust add", () => {
    test("add → roster file created with one key", async () => {
        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "add", pubPath, "--label", "alice"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("added key sha256:");
        expect(out.value).toContain("alice");
        expect(existsSync(keyringPath(env))).toBe(true);
    });

    test("add without label → still works, label omitted", async () => {
        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "add", pubPath], env);
        expect(code).toBe(0);
        expect(out.value).toContain("added key sha256:");
        expect(out.value).not.toContain("label:");
    });

    test("add same key twice → error with KEYRING_DUP_KEY remediation", async () => {
        const { env: e1 } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath], e1);

        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "add", pubPath], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("already in the roster");
    });

    test("add with --json → emits envelope with added.key_id and roster_size", async () => {
        const { env, out } = makeEnv(home);
        await main(["setup", "trust", "add", "--json", pubPath, "--label", "alice"], env);
        const payload = JSON.parse(out.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.added.key_id).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(payload.data.added.label).toBe("alice");
        expect(payload.data.roster_size).toBe(1);
    });

    test("missing positional → ArgError", async () => {
        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "add"], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("usage:");
    });

    test("non-Ed25519 key → KEYRING_INVALID_KEY remediation", async () => {
        const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const rsaPem = publicKey.export({ type: "spki", format: "pem" }) as string;
        const rsaPath = join(home, "rsa.pub");
        writeFileSync(rsaPath, rsaPem);

        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "add", rsaPath], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("Ed25519");
    });

    test("non-existent file → readable error", async () => {
        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "add", join(home, "missing.pub")], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("cannot read public key");
    });
});

// ---- list (populated) ------------------------------------------------------

describe("setup trust list — populated", () => {
    test("after add → list shows the key block", async () => {
        const { env: e1 } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], e1);

        const { env, out } = makeEnv(home);
        await main(["setup", "trust", "list"], env);
        expect(out.value).toContain("trusted keys (1)");
        expect(out.value).toContain("alice");
        expect(out.value).toMatch(/key_id:\s+sha256:[a-f0-9]{64}/);
        expect(out.value).toContain("added_at:");
    });

    test("after two adds → list shows both", async () => {
        const pubPath2 = join(home, "bob.pub");
        writeFileSync(pubPath2, genEd25519Pem());

        const { env: e1 } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], e1);
        await main(["setup", "trust", "add", pubPath2, "--label", "bob"], e1);

        const { env, out } = makeEnv(home);
        await main(["setup", "trust", "list"], env);
        expect(out.value).toContain("trusted keys (2)");
        expect(out.value).toContain("alice");
        expect(out.value).toContain("bob");
    });
});

// ---- remove ---------------------------------------------------------------

describe("setup trust remove", () => {
    test("remove by full key_id → roster shrinks", async () => {
        const { env: e1, out: addOut } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], e1);
        const keyIdLine = addOut.value.split("\n").find((l) => l.includes("sha256:"))!;
        const keyId = keyIdLine.match(/sha256:[a-f0-9]+/)![0];

        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "remove", keyId], env);
        expect(code).toBe(0);
        expect(out.value).toContain("removed key");
        expect(out.value).toContain("was labeled: alice");
    });

    test("remove by short prefix → resolves uniquely", async () => {
        const { env: e1 } = makeEnv(home);
        await main(["setup", "trust", "add", pubPath, "--label", "alice"], e1);

        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "remove", "sha256:"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("removed key");
    });

    test("remove with no match → KEYRING_KEY_NOT_FOUND error", async () => {
        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "remove", "sha256:" + "z".repeat(64)], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("no key in roster");
    });

    test("missing positional → ArgError", async () => {
        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "remove"], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("usage:");
    });
});

// ---- dispatch -------------------------------------------------------------

describe("setup trust dispatch", () => {
    test("`setup trust` (no sub) → prints help", async () => {
        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("kindly setup trust");
        expect(out.value).toContain("Subcommands:");
    });

    test("`setup trust --help` → prints help", async () => {
        const { env, out } = makeEnv(home);
        const code = await main(["setup", "trust", "--help"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("kindly setup trust");
    });

    test("unknown subcommand → ArgError", async () => {
        const { env, err } = makeEnv(home);
        const code = await main(["setup", "trust", "explode"], env);
        expect(code).not.toBe(0);
        expect(err.value).toContain("unknown setup trust subcommand");
    });
});
