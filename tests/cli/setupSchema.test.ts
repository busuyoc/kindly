// v0.5 — schema validation at import/export boundaries.
//
// Covers: the typo that motivated this work (nightmode vs night_mode),
// type mismatches, --strict blocking behavior, --allow-unknown-keys
// silencing, and the clean-settings no-op path.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest } from "../../src/setup/schema.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-sch-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["night_mode"] = false,
    ["home_dir"] = "/mnt/books",
}
`);
    mkdirSync(join(kor, "plugins"));
    mkdirSync(join(kor, "patches"));
    return { root, settingsPath };
}

function makeEnv(cwd: string, mountOverride: string, setupsDir: string): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd, stdout: out, stderr: err, color: false, mountOverride,
            now: () => new Date("2026-04-22T12:00:00Z"),
            setupsDir,
        },
        out, err,
    };
}

function writeManifest(path: string, settings: Record<string, unknown>): void {
    const parsed = parseManifest({
        kindly_setup: "v1",
        meta: { name: "schema-test", created_at: "2026-04-22T12:00:00Z" },
        apply_mode: "additive",
        settings,
    } as unknown as Parameters<typeof parseManifest>[0]);
    writeFileSync(path, canonicalizeManifest(parsed));
}

let workdir: string;
let setupsDir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-sch-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-sch-s-"));
});

describe("setup import — schema validation default (warn, proceed)", () => {
    test("manifest with typo → warns on stderr, import proceeds (exit 0)", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { nightmode: true });  // THE typo from field testing

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(4);
        expect(err.value).toMatch(/unknown key/i);
        expect(err.value).toContain("nightmode");
    });

    test("manifest with type mismatch → warns but proceeds", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { night_mode: "yes" });  // bool key, string value

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(4);
        expect(err.value).toMatch(/type mismatch/i);
        expect(err.value).toContain("night_mode");
        expect(err.value).toContain("expected boolean");
    });

    test("clean manifest → no schema warnings", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { night_mode: true, home_dir: "/mnt/books" });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
        expect(err.value).not.toMatch(/unknown key/i);
        expect(err.value).not.toMatch(/type mismatch/i);
    });
});

describe("setup import — --strict", () => {
    test("typo + --strict → exit 1, device untouched", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { nightmode: true });

        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", p, "--strict"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("nightmode");
        expect(err.value).toMatch(/--strict/);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("type mismatch + --strict → exit 3", async () => {
        const kindle = makeFakeKindle();
        const { env } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { night_mode: 42 });

        const code = await main(["setup", "import", p, "--strict"], env);
        expect(code).toBe(3);
    });
});

describe("setup import — --allow-unknown-keys", () => {
    test("typo + --allow-unknown-keys → no unknown warning, proceeds", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { nightmode: true });

        const code = await main(["setup", "import", p, "--allow-unknown-keys"], env);
        expect(code).toBe(4);
        expect(err.value).not.toMatch(/unknown key/i);
    });

    test("--allow-unknown-keys does NOT silence type mismatches", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { night_mode: 42, custom_plugin_key: true });

        const code = await main(["setup", "import", p, "--allow-unknown-keys"], env);
        expect(code).toBe(4);
        expect(err.value).not.toMatch(/unknown key/i);
        expect(err.value).toMatch(/type mismatch/i);
        expect(err.value).toContain("night_mode");
    });

    test("--strict + --allow-unknown-keys: unknowns pass, mismatches still block", async () => {
        const kindle = makeFakeKindle();
        const { env } = makeEnv(workdir, kindle.root, setupsDir);
        const p1 = join(workdir, "typo-only.kset.yaml");
        writeManifest(p1, { nightmode: true });
        expect(await main(["setup", "import", p1, "--strict", "--allow-unknown-keys"], env)).toBe(4);

        const p2 = join(workdir, "mismatch.kset.yaml");
        writeManifest(p2, { night_mode: 5 });
        expect(await main(["setup", "import", p2, "--strict", "--allow-unknown-keys"], env)).toBe(3);
    });
});

describe("setup export — schema validation on exported subset", () => {
    test("exporting a device with a custom key warns but succeeds", async () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-sch-dev-"));
        const kor = join(root, "koreader");
        mkdirSync(kor);
        writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["night_mode"] = false,
    ["made_up_key"] = 123,
}
`);
        mkdirSync(join(kor, "plugins"));
        mkdirSync(join(kor, "patches"));

        const { env, err } = makeEnv(workdir, root, setupsDir);
        const out = join(workdir, "out.kset.yaml");
        const code = await main(["setup", "export", "dev", "--output", out], env);
        expect(code).toBe(0);
        expect(err.value).toMatch(/unknown key/i);
        expect(err.value).toContain("made_up_key");
    });

    test("--strict on export with a made-up key → exit 3, no file written", async () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-sch-dev-"));
        const kor = join(root, "koreader");
        mkdirSync(kor);
        writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["made_up_key"] = 1,
}
`);
        mkdirSync(join(kor, "plugins"));
        mkdirSync(join(kor, "patches"));

        const { env } = makeEnv(workdir, root, setupsDir);
        const out = join(workdir, "out.kset.yaml");
        const code = await main(["setup", "export", "dev", "--strict", "--output", out], env);
        expect(code).toBe(3);
        expect(() => readFileSync(out, "utf8")).toThrow();
    });
});
