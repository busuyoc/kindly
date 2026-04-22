import { describe, test, expect, beforeEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { reloadPluginCatalog } from "../../src/catalog/reader.ts";

const FIXTURE_CATALOG = join(import.meta.dir, "..", "fixtures", "catalog", "plugins.bundled.v1.json");

function makeWorkdir(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-pdesc-"));
    mkdirSync(join(root, "data", "catalog"), { recursive: true });
    copyFileSync(FIXTURE_CATALOG, join(root, "data", "catalog", "plugins.bundled.v1.json"));
    return root;
}

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-pdesc-k-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

function makeNonKindle(): string {
    return mkdtempSync(join(tmpdir(), "kindly-pdesc-nk-"));
}

let workdir: string;
let stdout: StringWriter;
let stderr: StringWriter;
let env: CliEnv;

beforeEach(() => {
    reloadPluginCatalog();
    workdir = makeWorkdir();
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: makeNonKindle(),
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("plugin describe — text mode", () => {
    test("prints fullname, description, references, sections", async () => {
        const code = await main(["plugin", "describe", "SSH"], env);
        expect(code).toBe(0);
        const out = stdout.value;
        expect(out).toContain("SSH");
        expect(out).toContain("SFTP server");
        expect(out).toContain("plugins/SSH.koplugin");
        expect(out).toContain("hardware_gated");
        expect(out).toContain("niche");
        expect(out).toContain("References");
        expect(out).toContain("https://example.invalid/ssh");
        expect(out).toContain("Kindle notes");
    });

    test("shows deprecated line when set", async () => {
        await main(["plugin", "describe", "exporter"], env);
        expect(stdout.value).toContain("deprecated:");
        expect(stdout.value).toContain("Joplin");
    });

    test("case-sensitive lookup: missing name produces PLUGIN_NOT_FOUND", async () => {
        const code = await main(["plugin", "describe", "ssh"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not in catalog");
        expect(stderr.value).toContain("Available:");
    });

    test("no positional arg fails with usage hint", async () => {
        const code = await main(["plugin", "describe"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("missing plugin name");
    });

    test("offline mode shows catalog-only state line", async () => {
        await main(["plugin", "describe", "SSH"], env);
        expect(stdout.value).toContain("no device");
    });
});

describe("plugin describe — JSON envelope", () => {
    test("emits typed PluginDescribeResult", async () => {
        const code = await main(["plugin", "describe", "calibre", "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.command).toBe("plugin:describe");
        expect(payload.status).toBe("ok");
        const d = payload.data;
        expect(d.plugin.name).toBe("calibre");
        expect(d.plugin.curation_opinion).toBe("recommended");
        expect(d.deviceStateAvailable).toBe(false);
        expect(d.enabledOnDevice).toBeNull();
    });

    test("PLUGIN_NOT_FOUND produces structured error envelope", async () => {
        const code = await main(["plugin", "describe", "nope", "--json"], env);
        expect(code).toBe(1);
        expect(stdout.value).toBe("");
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("PLUGIN_NOT_FOUND");
        expect(payload.error.remediation.length).toBeGreaterThan(0);
    });

    test("device state reflected when mounted", async () => {
        const kindle = makeFakeKindle({
            plugins_disabled: { SSH: true },
        });
        env = { ...env, mountOverride: kindle };

        await main(["plugin", "describe", "SSH", "--json"], env);
        const { data } = JSON.parse(stdout.value);
        expect(data.deviceStateAvailable).toBe(true);
        expect(data.enabledOnDevice).toBe(false);
    });
});

describe("plugin subcommand dispatch", () => {
    test("bare `plugin` shows help", async () => {
        const code = await main(["plugin"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("kindly plugin");
        expect(stdout.value).toContain("list");
        expect(stdout.value).toContain("describe");
    });

    test("unknown subcommand fails with ArgError", async () => {
        const code = await main(["plugin", "foo"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown plugin subcommand");
    });
});
