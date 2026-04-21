import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest } from "../../src/setup/schema.ts";
import { canonicalizeManifest, manifestHash } from "../../src/setup/canonical.ts";

// A fake Kindle with a realistic-ish settings.reader.lua — enough to
// exercise filtering, plugin-disabled lifting, and cherry-picking.
function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-setup-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settings = `return {
    ["avoid_flashing_ui"] = true,
    ["refresh_rate"] = 8,
    ["screen_warmth"] = 60,
    ["lastfile"] = "/mnt/us/documents/book.epub",
    ["last_migration_date"] = 20250101,
    ["pinpadlock_pin_code"] = "1234",
    ["zlibrary_password"] = "hunter2",
    ["plugins_disabled"] = {
        ["coverbrowser"] = true,
        ["statistics"] = true,
        ["SSH"] = false,
    },
}
`;
    writeFileSync(join(kor, "settings.reader.lua"), settings);
    return root;
}

function makeEnv(cwd: string, mountOverride: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride,
            now: () => new Date("2026-04-21T12:00:00Z"),
        },
        out,
        err,
    };
}

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    fakeKindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-setup-w-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, fakeKindle));
});

describe("kindly setup export — basics", () => {
    test("writes a valid manifest file to --output", async () => {
        const out = join(workdir, "my.kset.yaml");
        const code = await main(
            ["setup", "export", "Night Reading", "--output", out],
            env
        );
        expect(code).toBe(0);
        expect(existsSync(out)).toBe(true);

        const bytes = readFileSync(out, "utf8");
        const parsed = yamlParse(bytes);
        const manifest = parseManifest(parsed);
        expect(manifest.meta.name).toBe("Night Reading");
        expect(manifest.kindly_setup).toBe("v1");
        expect(manifest.apply_mode).toBe("additive");
    });

    test("content on disk is canonical (hash matches re-hash)", async () => {
        const out = join(workdir, "my.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const bytes = readFileSync(out, "utf8");
        const parsed = yamlParse(bytes);
        const manifest = parseManifest(parsed);
        // Re-canonicalize and compare — if we emit canonical form, the
        // bytes on disk must equal canonicalizeManifest(parsed).
        expect(bytes).toBe(canonicalizeManifest(manifest));
    });

    test("prints the content hash", async () => {
        await main(
            ["setup", "export", "x", "--output", join(workdir, "x.kset.yaml")],
            env
        );
        expect(stdout.value).toMatch(/hash: sha256:[a-f0-9]{64}/);
    });
});

describe("kindly setup export — filtering", () => {
    test("secrets are never included", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        const settingsKeys = Object.keys(manifest.settings ?? {});
        expect(settingsKeys).not.toContain("pinpadlock_pin_code");
        expect(settingsKeys).not.toContain("zlibrary_password");
    });

    test("ephemerals are never included (always minimal mode for shared Setups)", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        const settingsKeys = Object.keys(manifest.settings ?? {});
        expect(settingsKeys).not.toContain("lastfile");
        expect(settingsKeys).not.toContain("last_migration_date");
    });

    test("stdout reports how many secrets/ephemerals were filtered", async () => {
        await main(
            ["setup", "export", "x", "--output", join(workdir, "x.kset.yaml")],
            env
        );
        expect(stdout.value).toContain("filtered");
        expect(stdout.value).toContain("secret");
        expect(stdout.value).toContain("ephemeral");
    });
});

describe("kindly setup export — plugins_disabled lift", () => {
    test("lifts plugins_disabled into manifest.plugins.disabled (sorted, true-only)", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.plugins?.disabled).toEqual(["coverbrowser", "statistics"]);
        // SSH was `false` on device → not "disabled" → not in the list
        expect(manifest.plugins?.disabled).not.toContain("SSH");
    });

    test("plugins_disabled is not duplicated in settings after lifting", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.settings?.plugins_disabled).toBeUndefined();
    });
});

describe("kindly setup export — --keys cherry-pick", () => {
    test("only includes keys listed in --keys (when set)", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(
            ["setup", "export", "x", "--keys", "avoid_flashing_ui,refresh_rate", "--output", out],
            env
        );
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(Object.keys(manifest.settings ?? {}).sort()).toEqual([
            "avoid_flashing_ui",
            "refresh_rate",
        ]);
        // screen_warmth was on device but not requested → absent
        expect(manifest.settings?.screen_warmth).toBeUndefined();
    });

    test("unknown --keys entries are reported but don't fail", async () => {
        const out = join(workdir, "x.kset.yaml");
        const code = await main(
            ["setup", "export", "x", "--keys", "avoid_flashing_ui,not_a_real_key", "--output", out],
            env
        );
        expect(code).toBe(0);
        expect(stdout.value).toContain("not found");
    });

    test("requesting a secret key via --keys silently skips it (secrets are always filtered first)", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(
            ["setup", "export", "x", "--keys", "pinpadlock_pin_code,avoid_flashing_ui", "--output", out],
            env
        );
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.settings?.pinpadlock_pin_code).toBeUndefined();
        expect(manifest.settings?.avoid_flashing_ui).toBe(true);
    });
});

describe("kindly setup export — metadata flags", () => {
    test("stores author / description / tags in meta", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(
            [
                "setup", "export", "My Night",
                "--output", out,
                "--author", "alice",
                "--description", "Low-flash night reading",
                "--tags", "night, minimal, pw5",
            ],
            env
        );
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.meta.author).toBe("alice");
        expect(manifest.meta.description).toBe("Low-flash night reading");
        expect(manifest.meta.tags).toEqual(["night", "minimal", "pw5"]);
    });

    test("created_at uses env.now() (deterministic in tests)", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.meta.created_at).toBe("2026-04-21T12:00:00.000Z");
    });

    test("--apply-mode replace is honored", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(
            ["setup", "export", "x", "--apply-mode", "replace", "--output", out],
            env
        );
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.apply_mode).toBe("replace");
    });

    test("rejects invalid --apply-mode", async () => {
        const code = await main(
            ["setup", "export", "x", "--apply-mode", "merge-deep",
                "--output", join(workdir, "x.kset.yaml")],
            env
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("apply-mode");
    });
});

describe("kindly setup export — determinism", () => {
    test("two exports with same inputs produce identical file bytes", async () => {
        const outA = join(workdir, "a.kset.yaml");
        const outB = join(workdir, "b.kset.yaml");
        await main(["setup", "export", "Fixed", "--output", outA], env);
        await main(["setup", "export", "Fixed", "--output", outB], env);
        expect(readFileSync(outA, "utf8")).toBe(readFileSync(outB, "utf8"));
    });

    test("identical exports have identical content hashes", async () => {
        const outA = join(workdir, "a.kset.yaml");
        const outB = join(workdir, "b.kset.yaml");
        await main(["setup", "export", "Fixed", "--output", outA], env);
        await main(["setup", "export", "Fixed", "--output", outB], env);
        const mA = parseManifest(yamlParse(readFileSync(outA, "utf8")));
        const mB = parseManifest(yamlParse(readFileSync(outB, "utf8")));
        expect(manifestHash(mA)).toBe(manifestHash(mB));
    });
});

describe("kindly setup export — output path handling", () => {
    test("default output lives under ~/.kindly/setups/ (tested via --output)", async () => {
        // We don't actually touch $HOME in tests — just assert --output
        // controls the path when provided. Default-path behavior is
        // covered at the unit level via defaultOutputPath if/when exposed.
        const out = join(workdir, "custom.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        expect(existsSync(out)).toBe(true);
    });

    test("creates parent dir if missing", async () => {
        const out = join(workdir, "nested", "deep", "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        expect(existsSync(out)).toBe(true);
    });

    test("refuses to overwrite existing file without --force", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const code = await main(["setup", "export", "x", "--output", out], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("already exists");
    });

    test("--force overwrites", async () => {
        const out = join(workdir, "x.kset.yaml");
        await main(["setup", "export", "x", "--output", out], env);
        const code = await main(
            ["setup", "export", "y", "--output", out, "--force"],
            env
        );
        expect(code).toBe(0);
        const manifest = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(manifest.meta.name).toBe("y");
    });
});

describe("kindly setup export — usage / errors", () => {
    test("requires a <name> positional", async () => {
        const code = await main(["setup", "export"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("usage");
    });

    test("rejects extra positional arg", async () => {
        const code = await main(
            ["setup", "export", "name1", "name2"],
            env
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("unexpected");
    });

    test("errors cleanly if koreader dir missing", async () => {
        const bareRoot = mkdtempSync(join(tmpdir(), "kindly-setup-bare-"));
        mkdirSync(join(bareRoot, "koreader"));
        // no settings.reader.lua
        const { env: bareEnv, err: bareErr } = makeEnv(workdir, bareRoot);
        const code = await main(
            ["setup", "export", "x", "--output", join(workdir, "x.kset.yaml")],
            bareEnv
        );
        expect(code).toBe(1);
        expect(bareErr.value.toLowerCase()).toContain("settings.reader.lua");
    });
});

describe("kindly setup — dispatcher", () => {
    test("`kindly setup` (no sub) prints setup help", async () => {
        const code = await main(["setup"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("setup");
        expect(stdout.value).toContain("export");
    });

    test("`kindly setup --help` prints setup help", async () => {
        const code = await main(["setup", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("export");
    });

    test("`kindly setup export --help` prints export help (subcommand level)", async () => {
        const code = await main(["setup", "export", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("--keys");
        expect(stdout.value).toContain("--apply-mode");
    });

    test("unknown subcommand errors", async () => {
        const code = await main(["setup", "wat"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown setup subcommand");
    });

    test("top-level help mentions the setup command", async () => {
        await main(["--help"], env);
        expect(stdout.value).toContain("setup");
    });
});
