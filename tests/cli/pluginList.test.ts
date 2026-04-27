import { describe, test, expect, beforeEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { reloadPluginCatalog } from "../../src/catalog/reader.ts";

const FIXTURE_CATALOG = join(import.meta.dir, "..", "fixtures", "catalog", "plugins.bundled.v1.json");

function makeWorkdir(): { root: string; catalogPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-plist-"));
    mkdirSync(join(root, "data", "catalog"), { recursive: true });
    const catalogPath = join(root, "data", "catalog", "plugins.bundled.v1.json");
    copyFileSync(FIXTURE_CATALOG, catalogPath);
    return { root, catalogPath };
}

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-plist-k-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

/** Create a mount override that doesn't look like a Kindle — forces the
 *  offline path (resolveMount throws MOUNT_INVALID, plugin.ts swallows). */
function makeNonKindle(): string {
    return mkdtempSync(join(tmpdir(), "kindly-plist-nk-"));
}

let workdir: string;
let catalogPath: string;
let stdout: StringWriter;
let stderr: StringWriter;
let env: CliEnv;

beforeEach(() => {
    reloadPluginCatalog();
    const w = makeWorkdir();
    workdir = w.root;
    catalogPath = w.catalogPath;
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: makeNonKindle(),
        now: () => new Date("2026-04-22T12:00:00Z"),
        catalogPath,
    };
});

describe("plugin list — text mode", () => {
    test("lists all fixture plugins with counts", async () => {
        const code = await main(["plugin", "list"], env);
        expect(code).toBe(0);
        const out = stdout.value;
        expect(out).toContain("SSH");
        expect(out).toContain("calibre");
        expect(out).toContain("hello");
        expect(out).toContain("exporter");
        expect(out).toContain("4 shown");
        expect(out).toContain("2 recommended");
        expect(out).toContain("1 debloat");
        expect(out).toContain("1 niche");
    });

    test("shows no-device note when offline", async () => {
        await main(["plugin", "list"], env);
        expect(stdout.value).toContain("no device mounted");
    });

    test("--category filters", async () => {
        await main(["plugin", "list", "--category", "dev"], env);
        const out = stdout.value;
        expect(out).toContain("SSH");
        expect(out).toContain("hello");
        expect(out).not.toContain("calibre");
        expect(out).not.toContain("exporter");
        expect(out).toContain("2 shown");
    });

    test("--opinion filters", async () => {
        await main(["plugin", "list", "--opinion", "debloat"], env);
        const out = stdout.value;
        expect(out).toContain("hello");
        expect(out).not.toContain("SSH");
        expect(out).toContain("1 shown");
    });

    test("empty filter result emits a no-match line", async () => {
        await main(["plugin", "list", "--category", "system"], env);
        expect(stdout.value).toContain("no plugins match");
    });

    test("rejects unknown --opinion values", async () => {
        const code = await main(["plugin", "list", "--opinion", "greatness"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("--opinion must be one of");
    });
});

describe("plugin list — JSON envelope", () => {
    test("emits typed PluginListResult with counts", async () => {
        const code = await main(["plugin", "list", "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.$schema_version).toBe(1);
        expect(payload.command).toBe("plugin:list");
        expect(payload.status).toBe("ok");
        const d = payload.data;
        expect(d.catalogVersion).toBe("v1");
        expect(d.plugins).toHaveLength(4);
        expect(d.deviceStateAvailable).toBe(false);
        expect(d.counts.total).toBe(4);
        expect(d.counts.recommended).toBe(2);
        expect(d.counts.debloat).toBe(1);
        expect(d.counts.niche).toBe(1);
        expect(d.plugins.every((p: { enabled_on_device: unknown }) => p.enabled_on_device === null)).toBe(true);
    });

    test("filters propagate into envelope fields", async () => {
        await main(["plugin", "list", "--category", "dev", "--opinion", "niche", "--json"], env);
        const { data } = JSON.parse(stdout.value);
        expect(data.filteredByCategory).toBe("dev");
        expect(data.filteredByOpinion).toBe("niche");
        expect(data.plugins.map((p: { name: string }) => p.name)).toEqual(["SSH"]);
    });
});

describe("plugin list — with device state", () => {
    test("device state joins the catalog", async () => {
        const kindle = makeFakeKindle({
            plugins_disabled: { hello: true, calibre: true },
        });
        env = { ...env, mountOverride: kindle };

        await main(["plugin", "list", "--json"], env);
        const { data } = JSON.parse(stdout.value);
        expect(data.deviceStateAvailable).toBe(true);

        const byName = Object.fromEntries(
            data.plugins.map((p: { name: string; enabled_on_device: boolean }) => [p.name, p.enabled_on_device]),
        );
        expect(byName).toEqual({
            SSH: true, calibre: false, exporter: true, hello: false,
        });
        expect(data.counts.enabled_on_device).toBe(2);
        expect(data.counts.disabled_on_device).toBe(2);
    });
});
