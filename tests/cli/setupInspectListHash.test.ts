import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest, hashBytes, manifestHash, shortId } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function makeEnv(cwd: string, setupsDir: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            now: () => new Date("2026-04-21T12:00:00Z"),
            setupsDir,
        },
        out,
        err,
    };
}

function makeManifest(overrides: Partial<Record<string, unknown>> = {}): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: {
            name: "example",
            author: "tester",
            description: "a test setup",
            created_at: "2026-04-21T12:00:00Z",
            tags: ["demo"],
        },
        apply_mode: "additive",
        settings: { a: 1, b: 2, c: 3 },
        plugins: { disabled: ["SSH", "calibre"] },
        ...overrides,
    });
}

function writeManifestFile(path: string, m: SetupManifest): string {
    const bytes = canonicalizeManifest(m);
    writeFileSync(path, bytes);
    return bytes;
}

let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-setup-ilh-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-setup-ilh-d-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, setupsDir));
});

describe("kindly setup inspect", () => {
    test("prints name, id, hash, and content counts for a valid file", async () => {
        const m = makeManifest();
        const p = join(setupsDir, "a.kset.yaml");
        const bytes = writeManifestFile(p, m);

        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("example");
        expect(stdout.value).toContain(shortId(hashBytes(bytes)));
        expect(stdout.value).toContain(hashBytes(bytes));
        expect(stdout.value).toContain("apply_mode:");
        expect(stdout.value).toContain("additive");
        expect(stdout.value).toContain("settings:        3");
        expect(stdout.value).toContain("plugins off:     2");
        expect(stdout.value).toContain("author:       tester");
        expect(stdout.value).toContain("description:  a test setup");
        expect(stdout.value).toContain("tags:         demo");
        expect(stderr.value).toBe(""); // canonical file → no warning
    });

    test("prints compat block when present", async () => {
        const m = makeManifest({ compat: { koreader_version_min: "2024.03", device: ["kindle-pw5"] } });
        const p = join(setupsDir, "a.kset.yaml");
        writeManifestFile(p, m);
        await main(["setup", "inspect", p], env);
        expect(stdout.value).toContain("koreader >= 2024.03");
        expect(stdout.value).toContain("kindle-pw5");
    });

    test("warns when file is not in canonical form", async () => {
        const m = makeManifest();
        // Valid YAML, valid manifest, but keys out of lexicographic order.
        const nonCanonical = [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: example",
            "  author: tester",
            "  description: a test setup",
            "  created_at: 2026-04-21T12:00:00Z",
            "  tags: [demo]",
            "settings: {a: 1, b: 2, c: 3}",
            "plugins:",
            "  disabled: [SSH, calibre]",
            "",
        ].join("\n");
        const p = join(setupsDir, "noncanon.kset.yaml");
        writeFileSync(p, nonCanonical);

        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(0);
        expect(stderr.value).toContain("not in canonical form");
        // The canonical-form hash we mention should match manifestHash(m).
        expect(stdout.value).toContain(manifestHash(m));
    });

    test("errors on missing file", async () => {
        const code = await main(["setup", "inspect", join(setupsDir, "nope.kset.yaml")], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not found");
    });

    test("errors on malformed YAML", async () => {
        const p = join(setupsDir, "bad.kset.yaml");
        writeFileSync(p, "this: is: not: valid: yaml: [\n");
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not valid YAML");
    });

    test("errors on invalid manifest shape (schema failure)", async () => {
        const p = join(setupsDir, "shape.kset.yaml");
        writeFileSync(p, "kindly_setup: v1\napply_mode: additive\nmeta:\n  name: x\n");
        // Missing meta.created_at → schema fails.
        const code = await main(["setup", "inspect", p], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not a valid Setup manifest");
    });

    test("requires a <file> argument", async () => {
        const code = await main(["setup", "inspect"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("usage: kindly setup inspect");
    });

    test("rejects extra positional args", async () => {
        const p = join(setupsDir, "a.kset.yaml");
        writeManifestFile(p, makeManifest());
        const code = await main(["setup", "inspect", p, "extra"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unexpected extra argument");
    });
});

describe("kindly setup list", () => {
    test("reports when setupsDir does not exist", async () => {
        env = { ...env, setupsDir: join(setupsDir, "nonexistent") };
        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no setups");
    });

    test("reports when setupsDir is empty", async () => {
        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no setups");
    });

    test("lists multiple .kset.yaml files with id + name + mode", async () => {
        const m1 = makeManifest({ meta: { name: "alpha", created_at: "2026-04-21T12:00:00Z" } });
        const m2 = makeManifest({
            meta: { name: "beta", created_at: "2026-04-21T13:00:00Z" },
            apply_mode: "replace",
        });
        writeManifestFile(join(setupsDir, "a.kset.yaml"), m1);
        writeManifestFile(join(setupsDir, "b.kset.yaml"), m2);

        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("alpha");
        expect(stdout.value).toContain("beta");
        expect(stdout.value).toContain("additive");
        expect(stdout.value).toContain("replace");
        expect(stdout.value).toContain("ID");
        expect(stdout.value).toContain("NAME");
    });

    test("ignores non-kset files", async () => {
        writeFileSync(join(setupsDir, "notes.txt"), "not a setup");
        writeFileSync(join(setupsDir, "random.yaml"), "foo: bar");
        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no setups");
    });

    test("skips invalid .kset.yaml files with a warning, keeps going", async () => {
        writeManifestFile(join(setupsDir, "good.kset.yaml"), makeManifest({
            meta: { name: "good", created_at: "2026-04-21T12:00:00Z" },
        }));
        writeFileSync(join(setupsDir, "bad.kset.yaml"), "not a manifest at all");

        const code = await main(["setup", "list"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("good");
        expect(stderr.value).toContain("skipped");
        expect(stderr.value).toContain("bad.kset.yaml");
    });

    test("rejects positional args", async () => {
        const code = await main(["setup", "list", "extra"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unexpected argument");
    });
});

describe("kindly setup hash", () => {
    test("prints sha256:<64 hex> for a canonical file and no warning", async () => {
        const m = makeManifest();
        const p = join(setupsDir, "a.kset.yaml");
        const bytes = writeManifestFile(p, m);

        const code = await main(["setup", "hash", p], env);
        expect(code).toBe(0);
        const firstLine = stdout.value.split("\n")[0]!;
        expect(firstLine).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(firstLine).toBe(hashBytes(bytes));
        expect(stderr.value).toBe("");
    });

    test("hashes raw bytes (not re-canonicalized) and warns when non-canonical", async () => {
        const m = makeManifest();
        const nonCanonical = "kindly_setup: v1\napply_mode: additive\nmeta:\n  name: example\n  created_at: 2026-04-21T12:00:00Z\n";
        const p = join(setupsDir, "nc.kset.yaml");
        writeFileSync(p, nonCanonical);

        const code = await main(["setup", "hash", p], env);
        expect(code).toBe(0);
        const printedHash = stdout.value.split("\n")[0]!;
        expect(printedHash).toBe(hashBytes(nonCanonical));
        expect(printedHash).not.toBe(manifestHash(parseManifest({
            kindly_setup: "v1",
            apply_mode: "additive",
            meta: { name: "example", created_at: "2026-04-21T12:00:00Z" },
        })));
        expect(stderr.value).toContain("not in canonical form");
    });

    test("errors on missing file", async () => {
        const code = await main(["setup", "hash", join(setupsDir, "nope.kset.yaml")], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not found");
    });

    test("errors on invalid manifest (don't hash garbage)", async () => {
        const p = join(setupsDir, "bad.kset.yaml");
        writeFileSync(p, "just a string");
        const code = await main(["setup", "hash", p], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not a valid Setup manifest");
    });

    test("requires a <file> argument", async () => {
        const code = await main(["setup", "hash"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("usage: kindly setup hash");
    });
});

describe("dispatcher help for new subcommands", () => {
    test("kindly setup inspect --help works", async () => {
        const code = await main(["setup", "inspect", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly setup inspect");
    });

    test("kindly setup list --help works", async () => {
        const code = await main(["setup", "list", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly setup list");
    });

    test("kindly setup hash --help works", async () => {
        const code = await main(["setup", "hash", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly setup hash");
    });

    test("kindly setup top-level help mentions all four subcommands", async () => {
        await main(["setup"], env);
        expect(stdout.value).toContain("export");
        expect(stdout.value).toContain("inspect");
        expect(stdout.value).toContain("list");
        expect(stdout.value).toContain("hash");
    });
});
