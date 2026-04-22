// Step 9 — compat metadata export flags.
//
// The compat block records the author's claim about what KOReader version
// and device(s) the Setup targets. v0.3 stores and displays these values;
// enforcement is deferred to v0.4. Tests cover:
//   - each individual flag writes into the manifest
//   - all flags together produce a full compat block
//   - no flags → manifest has no compat block (not an empty one)
//   - empty-string values are treated as absent
//   - compat round-trips through canonical YAML and fat .kset pack/unpack
//   - inspect displays the block from an exported file
//   - import displays the block with the "NOT verified" disclaimer

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest } from "../../src/setup/schema.ts";
import { unpackSetup } from "../../src/setup/unpack.ts";

function makeFakeKindle(): {
    root: string;
    settingsPath: string;
    pluginsDir: string;
    patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-compat-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
}
`);
    const pluginsDir = join(kor, "plugins");
    const patchesDir = join(kor, "patches");
    mkdirSync(pluginsDir);
    mkdirSync(patchesDir);
    return { root, settingsPath, pluginsDir, patchesDir };
}

function makeEnv(cwd: string, mountOverride: string, setupsDir: string): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
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
            setupsDir,
        },
        out,
        err,
    };
}

let kindle: ReturnType<typeof makeFakeKindle>;
let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-compat-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-compat-s-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
});

describe("setup export — compat flags", () => {
    test("no compat flags → manifest has no compat block", async () => {
        const out = join(workdir, "plain.kset.yaml");
        const code = await main(["setup", "export", "plain", "--output", out], env);
        expect(code).toBe(0);
        const parsed = yamlParse(readFileSync(out, "utf8"));
        expect(parsed.compat).toBeUndefined();
    });

    test("--compat-koreader-min writes koreader_version_min only", async () => {
        const out = join(workdir, "min-only.kset.yaml");
        const code = await main([
            "setup", "export", "min-only",
            "--compat-koreader-min", "2024.03",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat?.koreader_version_min).toBe("2024.03");
        expect(m.compat?.koreader_version_max).toBeUndefined();
        expect(m.compat?.device).toBeUndefined();
    });

    test("--compat-koreader-max writes koreader_version_max only", async () => {
        const out = join(workdir, "max-only.kset.yaml");
        const code = await main([
            "setup", "export", "max-only",
            "--compat-koreader-max", "2025.12",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat?.koreader_version_max).toBe("2025.12");
        expect(m.compat?.koreader_version_min).toBeUndefined();
    });

    test("--compat-device CSV lands as string[]", async () => {
        const out = join(workdir, "devs.kset.yaml");
        const code = await main([
            "setup", "export", "devs",
            "--compat-device", "kindle-pw5,kindle-oasis3,kobo-libra2",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat?.device).toEqual(["kindle-pw5", "kindle-oasis3", "kobo-libra2"]);
    });

    test("all three flags together produce a full compat block", async () => {
        const out = join(workdir, "full-compat.kset.yaml");
        const code = await main([
            "setup", "export", "full-compat",
            "--compat-koreader-min", "2024.03",
            "--compat-koreader-max", "2025.12",
            "--compat-device", "kindle-pw5",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat).toEqual({
            koreader_version_min: "2024.03",
            koreader_version_max: "2025.12",
            device: ["kindle-pw5"],
        });
    });

    test("empty-string compat values are treated as absent, not written", async () => {
        const out = join(workdir, "empty-vals.kset.yaml");
        const code = await main([
            "setup", "export", "empty-vals",
            "--compat-koreader-min", "",
            "--compat-device", "",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const parsed = yamlParse(readFileSync(out, "utf8"));
        expect(parsed.compat).toBeUndefined();
    });

    test("--compat-device with whitespace-only entries drops them", async () => {
        const out = join(workdir, "dev-ws.kset.yaml");
        const code = await main([
            "setup", "export", "dev-ws",
            "--compat-device", "kindle-pw5, ,kindle-oasis3",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const m = parseManifest(yamlParse(readFileSync(out, "utf8")));
        expect(m.compat?.device).toEqual(["kindle-pw5", "kindle-oasis3"]);
    });

    test("compat survives a fat .kset round-trip", async () => {
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "-- ssh\n");
        const out = join(workdir, "fat-with-compat.kset");
        const code = await main([
            "setup", "export", "fat",
            "--include-plugin-files",
            "--compat-koreader-min", "2024.03",
            "--compat-device", "kindle-pw5",
            "--output", out,
        ], env);
        expect(code).toBe(0);
        const unpacked = unpackSetup(out);
        expect(unpacked.manifest.compat?.koreader_version_min).toBe("2024.03");
        expect(unpacked.manifest.compat?.device).toEqual(["kindle-pw5"]);
    });
});

describe("setup inspect / import — compat display", () => {
    test("inspect prints the compat block from an exported file", async () => {
        const out = join(workdir, "inspect-me.kset.yaml");
        await main([
            "setup", "export", "inspect-me",
            "--compat-koreader-min", "2024.03",
            "--compat-device", "kindle-pw5,kindle-oasis3",
            "--output", out,
        ], env);
        stdout.reset();
        stderr.reset();

        const code = await main(["setup", "inspect", out], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("compat:");
        expect(stdout.value).toContain("koreader >= 2024.03");
        expect(stdout.value).toContain("kindle-pw5");
        expect(stdout.value).toContain("kindle-oasis3");
    });

    test("import displays compat with verification results", async () => {
        const out = join(workdir, "import-me.kset.yaml");
        await main([
            "setup", "export", "import-me",
            "--compat-koreader-min", "2024.03",
            "--compat-koreader-max", "2025.12",
            "--compat-device", "kindle-pw5",
            "--output", out,
        ], env);
        stdout.reset();
        stderr.reset();

        const code = await main(["setup", "import", out, "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("koreader >= 2024.03");
        expect(stdout.value).toContain("koreader <= 2025.12");
        expect(stdout.value).toContain("kindle-pw5");
        expect(stdout.value).toContain("compat check");
        // This fake kindle has no git-rev / version.txt — detection falls
        // through as "unknown" but import still proceeds. Enforcement
        // tests live in setupCompatEnforce.test.ts.
        expect(stdout.value).toContain("detected: koreader=unknown");
    });
});
