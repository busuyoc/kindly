import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { luaToYaml, yamlToLua, mergeYamlIntoLua } from "../../src/schema/yaml.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";
import type { LuaTable, LuaValue } from "../../src/lua/writer.ts";

describe("luaToYaml", () => {
    test("flat keys, alphabetical order", () => {
        const { yaml } = luaToYaml(
            { zed: 1, alpha: 2, middle: 3 } as LuaTable,
            "minimal"
        );
        const lines = yaml.trim().split("\n");
        expect(lines).toEqual(["alpha: 2", "middle: 3", "zed: 1"]);
    });

    test("nested objects are sorted too", () => {
        const { yaml } = luaToYaml(
            { footer: { z: 1, a: 2 } } as LuaTable,
            "minimal"
        );
        expect(yaml).toContain("  a: 2");
        expect(yaml.indexOf("  a:")).toBeLessThan(yaml.indexOf("  z:"));
    });

    test("strips secrets even in full mode", () => {
        const { yaml, filter } = luaToYaml(
            { zlibrary_password: "hunter2", foo: "bar" } as LuaTable,
            "full"
        );
        expect(yaml).not.toContain("hunter2");
        expect(filter.droppedSecrets).toContain("zlibrary_password");
    });

    test("minimal drops ephemerals, full keeps them", () => {
        const input = { lastfile: "/a.epub", foo: "bar" } as LuaTable;
        const minRes = luaToYaml(input, "minimal");
        expect(minRes.yaml).not.toContain("lastfile");
        const fullRes = luaToYaml(input, "full");
        expect(fullRes.yaml).toContain("lastfile");
    });
});

describe("yamlToLua + mergeYamlIntoLua", () => {
    test("parses back to a Lua-compatible table", () => {
        const yaml = "foo: bar\nn: 42\nok: true\n";
        const t = yamlToLua(yaml) as Record<string, LuaValue>;
        expect(t.foo).toBe("bar");
        expect(t.n).toBe(42);
        expect(t.ok).toBe(true);
    });

    test("merge preserves on-device secrets not in YAML", () => {
        const onDevice: Record<string, LuaValue> = {
            zlibrary_password: "hunter2",
            footer: { align: "left", battery: true } as any,
            plugins_disabled: { SSH: true } as any,
        };
        const fromYaml: Record<string, LuaValue> = {
            footer: { align: "center" } as any,     // override just one field
            plugins_disabled: { SSH: true, calibre: true } as any,
        };
        const merged = mergeYamlIntoLua(onDevice, fromYaml);
        // Secret survives — not in YAML, still on device
        expect(merged.zlibrary_password).toBe("hunter2");
        // footer is shallow-merged: battery preserved, align updated
        expect(merged.footer).toEqual({ align: "center", battery: true } as any);
        // plugins_disabled replaced (both keys present in YAML)
        expect(merged.plugins_disabled).toEqual({ SSH: true, calibre: true } as any);
    });
});

describe("full pipeline: real file → YAML → back → merge", () => {
    test("real fixture: pull (minimal) then apply restores all user settings", () => {
        const src = readFileSync(
            "tests/fixtures/kindle/redacted/settings.reader.lua",
            "utf8"
        );
        const onDevice = parseSettingsFile(src) as Record<string, LuaValue>;

        // pull
        const { yaml, filter } = luaToYaml(onDevice as LuaTable, "minimal");
        expect(filter.droppedSecrets.length).toBeGreaterThan(0);
        expect(filter.droppedEphemerals.length).toBeGreaterThan(0);

        // apply back onto (a copy of) the same device
        const fromYaml = yamlToLua(yaml) as Record<string, LuaValue>;
        const merged = mergeYamlIntoLua(onDevice, fromYaml);

        // Secrets untouched — still equal to the on-device value (REDACTED
        // in the fixture, but the point is they survive round-trip).
        expect(merged.zlibrary_password).toBe(onDevice.zlibrary_password);
        expect(merged.pinpadlock_pin_code).toBe(onDevice.pinpadlock_pin_code);
        expect(merged.device_id).toBe(onDevice.device_id);

        // User settings preserved
        expect(merged.plugins_disabled).toEqual(onDevice.plugins_disabled);
        expect(merged.footer).toEqual(onDevice.footer);

        // Ephemerals survive in merged too — because they were on-device
        // and the YAML didn't touch them. Apply is non-destructive.
        expect(merged.lastfile).toBe(onDevice.lastfile);
    });

    test("YAML output is deterministic (same input → same bytes)", () => {
        const src = readFileSync(
            "tests/fixtures/kindle/redacted/settings.reader.lua",
            "utf8"
        );
        const onDevice = parseSettingsFile(src) as LuaTable;
        const a = luaToYaml(onDevice, "minimal").yaml;
        const b = luaToYaml(onDevice, "minimal").yaml;
        expect(a).toBe(b);
    });
});
