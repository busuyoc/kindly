// Adversarial tests for the v0.3 Setup surface.
//
// Goal: try to break `kindly setup export/inspect/list/hash` with inputs
// a malicious or careless user could produce. Covers malformed files,
// weird YAML, resource abuse, unicode, edge cases in --keys and --output.
// Some of these tests exist precisely to *document* behavior — e.g. that
// we reject unknown schema versions, or that hash identity is bytes-exact.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest, hashBytes } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function makeFakeKindle(luaBody: string): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-adv-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), luaBody);
    return root;
}

function makeEnv(
    cwd: string,
    opts: { mountOverride?: string; setupsDir?: string } = {},
): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            now: () => new Date("2026-04-21T12:00:00Z"),
            ...opts,
        },
        out,
        err,
    };
}

function makeManifest(overrides: Partial<Record<string, unknown>> = {}): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "ex", created_at: "2026-04-21T12:00:00Z" },
        apply_mode: "additive",
        ...overrides,
    });
}

let workdir: string;
let setupsDir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-adv-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-adv-d-"));
});

// ==========================================================================
// Malformed / hostile manifest files hit inspect/hash/list
// ==========================================================================

describe("adversarial: malformed manifest files", () => {
    test("unknown schema version (v2) is rejected by inspect", async () => {
        const p = join(setupsDir, "future.kset.yaml");
        writeFileSync(p, [
            "kindly_setup: v2",
            "apply_mode: additive",
            "meta:",
            "  name: from-the-future",
            "  created_at: 2030-01-01T00:00:00Z",
            "",
        ].join("\n"));
        const { env, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("not a valid Setup manifest");
    });

    test("unknown top-level field is rejected (strict schema)", async () => {
        const p = join(setupsDir, "extra.kset.yaml");
        writeFileSync(p, [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: ex",
            "  created_at: 2026-04-21T12:00:00Z",
            "unknown_field: should-fail",
            "",
        ].join("\n"));
        const { env, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("not a valid Setup manifest");
    });

    test("unknown meta field is rejected (strict nested schema)", async () => {
        const p = join(setupsDir, "meta-extra.kset.yaml");
        writeFileSync(p, [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: ex",
            "  created_at: 2026-04-21T12:00:00Z",
            "  mystery: xyz",
            "",
        ].join("\n"));
        const { env, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("not a valid Setup manifest");
    });

    test("apply_mode other than 'additive'/'replace' rejected", async () => {
        const p = join(setupsDir, "bad-mode.kset.yaml");
        writeFileSync(p, [
            "kindly_setup: v1",
            "apply_mode: nuke-everything",
            "meta:",
            "  name: ex",
            "  created_at: 2026-04-21T12:00:00Z",
            "",
        ].join("\n"));
        const { env, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "hash", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("not a valid Setup manifest");
    });

    test("0-byte .kset.yaml in setups dir is skipped, not crashes", async () => {
        writeFileSync(join(setupsDir, "empty.kset.yaml"), "");
        writeFileSync(join(setupsDir, "good.kset.yaml"),
            canonicalizeManifest(makeManifest({ meta: { name: "good", created_at: "2026-04-21T12:00:00Z" } })));
        const { env, out, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("good");
        expect(err.value).toContain("empty.kset.yaml");
    });

    test("binary garbage in a .kset.yaml file is skipped", async () => {
        const bad = Buffer.from([0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]);
        writeFileSync(join(setupsDir, "bin.kset.yaml"), bad);
        writeFileSync(join(setupsDir, "good.kset.yaml"),
            canonicalizeManifest(makeManifest({ meta: { name: "g", created_at: "2026-04-21T12:00:00Z" } })));
        const { env, out, err } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(out.value).toContain("g");
        expect(err.value).toContain("bin.kset.yaml");
    });

    test("YAML with duplicate top-level key is handled (last-wins or rejected, not crash)", async () => {
        const p = join(setupsDir, "dup.kset.yaml");
        writeFileSync(p, [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: first",
            "  created_at: 2026-04-21T12:00:00Z",
            "meta:",
            "  name: second",
            "  created_at: 2026-04-21T12:00:00Z",
            "",
        ].join("\n"));
        const { env } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        // Either YAML library rejects it (parse error → code 1) or accepts
        // with last-wins semantics (code 0). Either is acceptable; crash
        // isn't.
        expect([0, 1]).toContain(code);
    });

    test("YAML with self-referential anchor does not hang or stack-overflow", async () => {
        const p = join(setupsDir, "cycle.kset.yaml");
        // A cyclic alias in a field Zod will try to traverse.
        writeFileSync(p, [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: ex",
            "  created_at: 2026-04-21T12:00:00Z",
            "settings:",
            "  a: &ref",
            "    nested: *ref",
            "",
        ].join("\n"));
        const { env } = makeEnv(workdir, { setupsDir });
        // Zod's recursive SettingValueSchema will walk the alias; on a
        // cycle it should throw (stack overflow surfaces as an Error),
        // not hang. We just want to exit cleanly with code 1.
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
    });

    test("huge inline string in a setting doesn't blow up export reading", async () => {
        const hugeLua = `return {
    ["big_string"] = "${"x".repeat(100_000)}",
}
`;
        const kindle = makeFakeKindle(hugeLua);
        const { env } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const code = await main(["setup", "export", "huge"], env);
        expect(code).toBe(0);
    });
});

// ==========================================================================
// Unicode + weird encoding round-trips
// ==========================================================================

describe("adversarial: unicode and encoding", () => {
    test("emoji in meta.name round-trips through canonical + re-parse", async () => {
        const m = makeManifest({
            meta: { name: "night reading 🌙", created_at: "2026-04-21T12:00:00Z" },
        });
        const bytes = canonicalizeManifest(m);
        const p = join(setupsDir, "emoji.kset.yaml");
        writeFileSync(p, bytes);
        const { env, out } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(0);
        expect(out.value).toContain("night reading 🌙");
    });

    test("RTL text in meta.author survives canonicalization", async () => {
        const m = makeManifest({
            meta: { name: "x", author: "بسم الله", created_at: "2026-04-21T12:00:00Z" },
        });
        const p = join(setupsDir, "rtl.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));
        const { env, out } = makeEnv(workdir, { setupsDir });
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(0);
        expect(out.value).toContain("بسم الله");
    });

    test("zero-width / bidi-override chars in name don't break parsing", async () => {
        const weird = "setup​‮-name";
        const m = makeManifest({ meta: { name: weird, created_at: "2026-04-21T12:00:00Z" } });
        const p = join(setupsDir, "zw.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));
        const { env } = makeEnv(workdir, { setupsDir });
        expect(await main(["setup", "inspect", p], env)).toBe(0);
    });
});

// ==========================================================================
// --keys flag abuse
// ==========================================================================

describe("adversarial: --keys flag", () => {
    const luaWithSecrets = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = true,
    ["pinpadlock_pin_code"] = "1234",
    ["zlibrary_password"] = "hunter2",
}
`;

    test("--keys with only commas/whitespace is a no-op (treat as 'all kept')", async () => {
        const kindle = makeFakeKindle(luaWithSecrets);
        const { env, out } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const outPath = join(workdir, "k.kset.yaml");
        const code = await main(
            ["setup", "export", "x", "--keys", "  ,, , ,,", "--output", outPath],
            env,
        );
        expect(code).toBe(0);
        const manifest = parseManifest(
            require("yaml").parse(readFileSync(outPath, "utf8")),
        );
        // Non-secret, non-ephemeral keys should all be present.
        expect(Object.keys(manifest.settings ?? {}).sort()).toEqual(
            ["avoid_flashing_ui", "refresh_rate"],
        );
        // No secret leaked.
        expect(manifest.settings).not.toHaveProperty("pinpadlock_pin_code");
        expect(manifest.settings).not.toHaveProperty("zlibrary_password");
        expect(out.value).toContain("filtered");
    });

    test("requesting a secret via --keys silently drops it (secret filter wins)", async () => {
        const kindle = makeFakeKindle(luaWithSecrets);
        const { env, out } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const outPath = join(workdir, "k.kset.yaml");
        const code = await main(
            ["setup", "export", "x",
                "--keys", "refresh_rate,pinpadlock_pin_code,zlibrary_password",
                "--output", outPath],
            env,
        );
        expect(code).toBe(0);
        const manifest = parseManifest(
            require("yaml").parse(readFileSync(outPath, "utf8")),
        );
        expect(manifest.settings).toEqual({ refresh_rate: 8 });
        // Stdout reports that requested-but-missing keys were skipped.
        expect(out.value).toMatch(/--keys entr/i);
    });

    test("--keys with pure junk produces empty settings, still valid manifest", async () => {
        const kindle = makeFakeKindle(luaWithSecrets);
        const { env } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const outPath = join(workdir, "k.kset.yaml");
        const code = await main(
            ["setup", "export", "x", "--keys", "zzz,qqq,not_a_real_key", "--output", outPath],
            env,
        );
        expect(code).toBe(0);
        const manifest = parseManifest(
            require("yaml").parse(readFileSync(outPath, "utf8")),
        );
        expect(manifest.settings).toBeUndefined();
    });
});

// ==========================================================================
// --output abuse
// ==========================================================================

describe("adversarial: --output path handling", () => {
    const simpleLua = `return { ["refresh_rate"] = 8 }\n`;

    test("--output pointing at an existing directory fails clearly (without --force)", async () => {
        const kindle = makeFakeKindle(simpleLua);
        const dir = mkdtempSync(join(tmpdir(), "kindly-adv-o-"));
        const { env, err } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const code = await main(["setup", "export", "x", "--output", dir], env);
        // The "already exists" check catches directories before writeFileSync
        // would EISDIR. Message is generic but at least the user sees
        // something and the dir isn't touched.
        expect(code).toBe(1);
        expect(err.value).toContain("already exists");
    });

    test("--output at a directory WITH --force still fails (doesn't silently clobber)", async () => {
        const kindle = makeFakeKindle(simpleLua);
        const dir = mkdtempSync(join(tmpdir(), "kindly-adv-o-"));
        writeFileSync(join(dir, "canary.txt"), "don't touch me\n");
        const { env, err } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const code = await main(["setup", "export", "x", "--output", dir, "--force"], env);
        expect(code).toBe(1);
        expect(err.value.toLowerCase()).toMatch(/(directory|eisdir|is a dir)/);
        // Canary is untouched.
        expect(readFileSync(join(dir, "canary.txt"), "utf8")).toBe("don't touch me\n");
    });

    test("--output with 4 levels of missing parent dirs creates all of them", async () => {
        const kindle = makeFakeKindle(simpleLua);
        const deep = join(workdir, "a", "b", "c", "d", "out.kset.yaml");
        const { env } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const code = await main(["setup", "export", "x", "--output", deep], env);
        expect(code).toBe(0);
        expect(existsSync(deep)).toBe(true);
    });

    test("--output at an existing file without --force is refused", async () => {
        const kindle = makeFakeKindle(simpleLua);
        const p = join(workdir, "existing.kset.yaml");
        writeFileSync(p, "previous\n");
        const { env, err } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const code = await main(["setup", "export", "x", "--output", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("--force");
        // File was NOT overwritten.
        expect(readFileSync(p, "utf8")).toBe("previous\n");
    });
});

// ==========================================================================
// Identity math: does hash actually lock to bytes?
// ==========================================================================

describe("adversarial: content-hash identity", () => {
    test("adding a trailing newline changes the hash (bytes-are-identity)", async () => {
        const m = makeManifest();
        const canon = canonicalizeManifest(m);
        const p1 = join(setupsDir, "clean.kset.yaml");
        const p2 = join(setupsDir, "extra-nl.kset.yaml");
        writeFileSync(p1, canon);
        writeFileSync(p2, canon + "\n");

        const { env: e1, out: o1 } = makeEnv(workdir, { setupsDir });
        const { env: e2, out: o2 } = makeEnv(workdir, { setupsDir });
        expect(await main(["setup", "hash", p1], e1)).toBe(0);
        expect(await main(["setup", "hash", p2], e2)).toBe(0);
        const h1 = o1.value.split("\n")[0];
        const h2 = o2.value.split("\n")[0];
        expect(h1).not.toBe(h2);
    });

    test("two re-exports at the same timestamp produce byte-identical files", async () => {
        const kindle = makeFakeKindle(`return { ["refresh_rate"] = 8 }\n`);
        const o1 = join(workdir, "a.kset.yaml");
        const o2 = join(workdir, "b.kset.yaml");
        const { env: e1 } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        const { env: e2 } = makeEnv(workdir, { mountOverride: kindle, setupsDir });
        expect(await main(["setup", "export", "x", "--output", o1], e1)).toBe(0);
        expect(await main(["setup", "export", "x", "--output", o2], e2)).toBe(0);
        expect(readFileSync(o1, "utf8")).toBe(readFileSync(o2, "utf8"));
    });

    test("two re-exports at DIFFERENT timestamps yield different hashes", async () => {
        const kindle = makeFakeKindle(`return { ["refresh_rate"] = 8 }\n`);
        const o1 = join(workdir, "a.kset.yaml");
        const o2 = join(workdir, "b.kset.yaml");
        const e1 = makeEnv(workdir, { mountOverride: kindle, setupsDir }).env;
        const e2: CliEnv = {
            ...e1,
            stdout: new StringWriter(), stderr: new StringWriter(),
            now: () => new Date("2026-05-01T00:00:00Z"),
        };
        expect(await main(["setup", "export", "x", "--output", o1], e1)).toBe(0);
        expect(await main(["setup", "export", "x", "--output", o2], e2)).toBe(0);
        expect(hashBytes(readFileSync(o1, "utf8")))
            .not.toBe(hashBytes(readFileSync(o2, "utf8")));
    });
});
