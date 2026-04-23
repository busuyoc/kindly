// Integration tests for fat Setup export + import (step 8).
//
// Fake Kindle mount has a koreader/ dir with settings, a plugins/
// subtree, and a patches/ subtree. We drive the CLI end-to-end via
// main() and assert on-device side effects + stderr disclosures.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
    statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { unpackSetup } from "../../src/setup/unpack.ts";

// ---- fake kindle -----------------------------------------------------------

function makeFakeKindle(luaBody: string): {
    root: string;
    settingsPath: string;
    pluginsDir: string;
    patchesDir: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-fat-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, luaBody);
    const pluginsDir = join(kor, "plugins");
    const patchesDir = join(kor, "patches");
    mkdirSync(pluginsDir);
    mkdirSync(patchesDir);
    return { root, settingsPath, pluginsDir, patchesDir };
}

function seedPlugin(pluginsDir: string, name: string, files: Record<string, string>): void {
    const dir = join(pluginsDir, name);
    mkdirSync(dir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
        const abs = join(dir, relPath);
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, content);
    }
}

function seedPatch(patchesDir: string, name: string, content: string): void {
    writeFileSync(join(patchesDir, name), content);
}

function makeEnv(
    cwd: string,
    mountOverride: string,
    setupsDir: string,
): { env: CliEnv; out: StringWriter; err: StringWriter } {
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

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
    ["zlibrary_password"] = "hunter2",
    ["lastfile"] = "/mnt/us/documents/book.epub",
    ["plugins_disabled"] = {
        ["coverbrowser"] = true,
    },
}
`;

let kindle: ReturnType<typeof makeFakeKindle>;
let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle(DEFAULT_LUA);
    workdir = mkdtempSync(join(tmpdir(), "kindly-fat-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-fat-s-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
});

// ---- export side -----------------------------------------------------------

describe("setup export — fat collection", () => {
    test("--include-plugin-files packs plugin dirs into a .kset", async () => {
        seedPlugin(kindle.pluginsDir, "SSH.koplugin", {
            "main.lua": "-- SSH plugin\nreturn {}\n",
            "_meta.lua": "return { name = 'SSH' }\n",
        });
        const out = join(workdir, "ssh.kset");
        const code = await main(["setup", "export", "ssh-only", "--include-plugin-files", "--output", out], env);
        expect(code).toBe(0);
        expect(existsSync(out)).toBe(true);

        const unpacked = unpackSetup(out);
        expect(unpacked.manifest.plugins?.files?.length).toBe(2);
        const paths = new Set(unpacked.manifest.plugins!.files!.map((f) => f.path));
        expect(paths.has("SSH.koplugin/main.lua")).toBe(true);
        expect(paths.has("SSH.koplugin/_meta.lua")).toBe(true);
        expect(unpacked.files.get("SSH.koplugin/main.lua")!.toString("utf8")).toContain("SSH plugin");
    });

    test("--include-patches packs *.lua from patches/", async () => {
        seedPatch(kindle.patchesDir, "2-autoflash.lua", "-- autoflash\n");
        seedPatch(kindle.patchesDir, "9-wifidance.lua", "-- wifidance\n");
        const out = join(workdir, "patches.kset");
        const code = await main(["setup", "export", "my-patches", "--include-patches", "--output", out], env);
        expect(code).toBe(0);
        const unpacked = unpackSetup(out);
        expect(unpacked.manifest.patches?.length).toBe(2);
        expect(new Set(unpacked.files.keys())).toEqual(new Set(["2-autoflash.lua", "9-wifidance.lua"]));
    });

    test("both flags together produce a round-trippable fat .kset", async () => {
        seedPlugin(kindle.pluginsDir, "SSH.koplugin", { "main.lua": "ssh" });
        seedPatch(kindle.patchesDir, "2-x.lua", "patch");
        const out = join(workdir, "full.kset");
        const code = await main(["setup", "export", "full", "--include-plugin-files", "--include-patches", "--output", out], env);
        expect(code).toBe(0);
        const unpacked = unpackSetup(out);
        expect(unpacked.manifest.plugins?.files?.length).toBe(1);
        expect(unpacked.manifest.patches?.length).toBe(1);
    });

    test("no fat flags → lean .kset.yaml even with plugins on device", async () => {
        seedPlugin(kindle.pluginsDir, "SSH.koplugin", { "main.lua": "x" });
        const out = join(workdir, "lean.kset.yaml");
        const code = await main(["setup", "export", "lean-test", "--output", out], env);
        expect(code).toBe(0);
        const raw = readFileSync(out, "utf8");
        expect(raw).not.toContain("SSH.koplugin"); // plugin FILES not declared
        // But plugins_disabled from settings should still lift into plugins.disabled
        expect(raw).toContain("coverbrowser");
    });

    test("--include-plugin-files with empty plugins dir stays lean", async () => {
        // No plugins seeded; empty dir exists from makeFakeKindle.
        const out = join(workdir, "empty.kset.yaml");
        const code = await main(["setup", "export", "empty", "--include-plugin-files", "--output", out], env);
        expect(code).toBe(0);
        // Since no files collected, output should be valid lean YAML.
        const raw = readFileSync(out, "utf8");
        expect(raw).not.toContain("files:");
    });

    test("hidden files (.DS_Store, .git/) inside plugin dirs are not shipped", async () => {
        seedPlugin(kindle.pluginsDir, "SSH.koplugin", {
            "main.lua": "ok",
            ".DS_Store": "mac junk",
        });
        // Simulate a .git dir inside the plugin
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin", ".git"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", ".git", "HEAD"), "ref");
        const out = join(workdir, "hidden.kset");
        const code = await main(["setup", "export", "hidden", "--include-plugin-files", "--output", out], env);
        expect(code).toBe(0);
        const unpacked = unpackSetup(out);
        const paths = unpacked.manifest.plugins!.files!.map((f) => f.path);
        expect(paths).toEqual(["SSH.koplugin/main.lua"]);
    });

    test("default output path extension is .kset when fat", async () => {
        seedPlugin(kindle.pluginsDir, "SSH.koplugin", { "main.lua": "x" });
        const code = await main(["setup", "export", "default-fat", "--include-plugin-files"], env);
        expect(code).toBe(0);
        const files = readdirSync(setupsDir).filter((f) => f.endsWith(".kset"));
        expect(files.length).toBe(1);
    });

    test("default output path extension is .kset.yaml when lean", async () => {
        const code = await main(["setup", "export", "default-lean"], env);
        expect(code).toBe(0);
        const files = readdirSync(setupsDir).filter((f) => f.endsWith(".kset.yaml"));
        expect(files.length).toBe(1);
    });
});

// ---- import side — gating --------------------------------------------------

function buildFatKset(): string {
    seedPlugin(kindle.pluginsDir, "SSH.koplugin", {
        "main.lua": "-- original ssh\n",
        "_meta.lua": "-- meta\n",
    });
    seedPatch(kindle.patchesDir, "2-autoflash.lua", "-- original autoflash\n");
    const out = join(workdir, "src.kset");
    // Use the export CLI so the manifest matches real-world shape.
    return out;
}

async function exportFatFixture(): Promise<string> {
    const outPath = buildFatKset();
    const code = await main([
        "setup", "export", "fat-src",
        "--include-plugin-files", "--include-patches",
        "--output", outPath,
    ], env);
    expect(code).toBe(0);
    // Reset stderr/stdout for clean per-test assertions post-import.
    stdout.reset();
    stderr.reset();
    return outPath;
}

async function freshKindle(): Promise<void> {
    kindle = makeFakeKindle(DEFAULT_LUA);
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root, setupsDir));
}

describe("setup import — fat gating", () => {
    test("no flags → refuse with disclosure + exit 1; no device writes", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        const before = readFileSync(kindle.settingsPath, "utf8");

        const code = await main(["setup", "import", src], env);
        expect(code).toBe(3);
        // Disclosure was printed before the refusal.
        expect(stdout.value).toContain("ships executable code");
        expect(stdout.value).toContain("SSH.koplugin");
        expect(stderr.value).toMatch(/--accept-plugins|--skip-plugins/);

        // Nothing written to the device.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
        expect(existsSync(kindle.pluginsDir + "/SSH.koplugin")).toBe(false);
    });

    test("--accept-plugins but missing patch gate refuses (partial flag isn't enough)", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        const code = await main(["setup", "import", src, "--accept-plugins"], env);
        expect(code).toBe(3);
        expect(stderr.value).toMatch(/--accept-patches|--skip-patches/);
    });

    test("--accept-plugins + --skip-plugins together → arg error (exit 2)", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--skip-plugins",
        ], env);
        expect(code).toBe(2);
        expect(stderr.value).toMatch(/mutually exclusive/);
    });
});

// ---- import side — installation -------------------------------------------

describe("setup import — fat installation", () => {
    test("--accept-plugins --accept-patches installs everything", async () => {
        const src = await exportFatFixture();
        await freshKindle();

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches",
        ], env);
        expect(code).toBe(4);

        expect(existsSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"))).toBe(true);
        expect(readFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "utf8"))
            .toContain("original ssh");
        expect(existsSync(join(kindle.patchesDir, "2-autoflash.lua"))).toBe(true);
        expect(readFileSync(join(kindle.patchesDir, "2-autoflash.lua"), "utf8"))
            .toContain("original autoflash");
    });

    test("--accept-plugins --skip-patches installs plugins, skips patches", async () => {
        const src = await exportFatFixture();
        await freshKindle();

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--skip-patches",
        ], env);
        expect(code).toBe(4);
        expect(existsSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"))).toBe(true);
        expect(existsSync(join(kindle.patchesDir, "2-autoflash.lua"))).toBe(false);
        expect(stdout.value).toMatch(/--skip-patches.*NOT installed/i);
    });

    test("--skip-plugins --skip-patches applies settings only; nothing in plugins/ or patches/", async () => {
        const src = await exportFatFixture();
        await freshKindle();

        const code = await main([
            "setup", "import", src,
            "--skip-plugins", "--skip-patches",
        ], env);
        expect(code).toBe(4);
        expect(readdirSync(kindle.pluginsDir).length).toBe(0);
        expect(readdirSync(kindle.patchesDir).length).toBe(0);
    });

    test("--dry-run with fat setup writes nothing even with accept flags", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches", "--dry-run",
        ], env);
        expect(code).toBe(4);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
        expect(readdirSync(kindle.pluginsDir).length).toBe(0);
        expect(readdirSync(kindle.patchesDir).length).toBe(0);
    });

    test("plugin dir collision: pre-existing dir is wiped and replaced", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        // Plant a stale plugin dir with a file the new version doesn't have.
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "STALE.lua"), "stale");

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches",
        ], env);
        expect(code).toBe(4);
        expect(existsSync(join(kindle.pluginsDir, "SSH.koplugin", "STALE.lua"))).toBe(false);
        expect(existsSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"))).toBe(true);
    });

    test("patch collision: pre-existing file is overwritten", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        seedPatch(kindle.patchesDir, "2-autoflash.lua", "old content\n");

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches",
        ], env);
        expect(code).toBe(4);
        expect(readFileSync(join(kindle.patchesDir, "2-autoflash.lua"), "utf8"))
            .toContain("original autoflash");
    });
});

// ---- safety snapshot -------------------------------------------------------

describe("setup import — fat safety snapshot", () => {
    test("pre-install tarball is written alongside the settings backup", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        // Diverge target settings from the fixture so the import produces
        // a settings write (and therefore a settings backup). Use a
        // non-secret key — secret keys are filtered from the manifest and
        // additive mode would leave them alone, yielding no diff.
        writeFileSync(kindle.settingsPath, DEFAULT_LUA.replace("[\"refresh_rate\"] = 8", "[\"refresh_rate\"] = 16"));
        // Plant originals so the snapshot has content.
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "original.lua"), "pre-import content");
        seedPatch(kindle.patchesDir, "2-autoflash.lua", "pre-import patch");

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches",
        ], env);
        expect(code).toBe(4);

        // The safety snapshot lives under workdir/.kindly/pre-import/<iso>/.
        const preImport = join(workdir, ".kindly", "pre-import");
        const stamps = readdirSync(preImport);
        expect(stamps.length).toBeGreaterThanOrEqual(1);
        const stampDir = join(preImport, stamps[0]!);
        expect(existsSync(join(stampDir, "settings.reader.lua"))).toBe(true);
        expect(existsSync(join(stampDir, "plugins-patches.tar.gz"))).toBe(true);
        // Tarball isn't empty.
        expect(statSync(join(stampDir, "plugins-patches.tar.gz")).size).toBeGreaterThan(0);
    });

    test("--no-safety-snapshot suppresses both settings backup and fat tarball", async () => {
        const src = await exportFatFixture();
        await freshKindle();
        mkdirSync(join(kindle.pluginsDir, "SSH.koplugin"), { recursive: true });
        writeFileSync(join(kindle.pluginsDir, "SSH.koplugin", "original.lua"), "pre-import content");

        const code = await main([
            "setup", "import", src,
            "--accept-plugins", "--accept-patches",
            "--no-safety-snapshot",
        ], env);
        expect(code).toBe(4);

        const preImport = join(workdir, ".kindly", "pre-import");
        const exists = existsSync(preImport);
        if (exists) {
            // If the dir exists, nothing inside it should be timestamped.
            const entries = readdirSync(preImport);
            expect(entries.length).toBe(0);
        }
    });
});

// ---- idempotence -----------------------------------------------------------

describe("setup import — fat idempotence", () => {
    test("re-importing the same fat setup writes the same bytes", async () => {
        const src = await exportFatFixture();
        await freshKindle();

        await main(["setup", "import", src, "--accept-plugins", "--accept-patches"], env);
        const afterFirst = readFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "utf8");
        const patchAfterFirst = readFileSync(join(kindle.patchesDir, "2-autoflash.lua"), "utf8");

        stdout.reset(); stderr.reset();
        const code = await main(["setup", "import", src, "--accept-plugins", "--accept-patches"], env);
        expect(code).toBe(4);
        expect(readFileSync(join(kindle.pluginsDir, "SSH.koplugin", "main.lua"), "utf8"))
            .toBe(afterFirst);
        expect(readFileSync(join(kindle.patchesDir, "2-autoflash.lua"), "utf8"))
            .toBe(patchAfterFirst);
    });
});
