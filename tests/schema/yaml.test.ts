import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { luaToYaml, yamlToLua, mergeYamlIntoLua } from "../../src/schema/yaml.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";
import type { LuaTable, LuaValue } from "../../src/lua/writer.ts";
import { KindlyError, ErrorCodes } from "../../src/types/errors.ts";

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

// S840/S1240/S1241/S1242 — hostile YAML anchors/aliases producing cyclic DOMs.
// Without the visited-Set guard in plainToLua, these blow the stack and
// surface as RangeError → UNKNOWN error code. We want a stable YAML_CYCLIC
// KindlyError instead.
describe("yamlToLua — cyclic anchor guard (P-cluster)", () => {
    function expectCyclic(yaml: string) {
        try {
            yamlToLua(yaml);
            throw new Error("expected YAML_CYCLIC, got success");
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe(ErrorCodes.YAML_CYCLIC);
        }
    }

    test("S1240 baseline: 14-byte self-referencing sequence", () => {
        expectCyclic("root: &a [*a]\n");
    });

    test("S1240 variant: flow-map self-cycle", () => {
        expectCyclic("root: &a {child: *a}\n");
    });

    test("S1240 variant: block-map self-cycle", () => {
        expectCyclic("root: &a\n  child: *a\n");
    });

    test("S1240 variant: custom-tagged anchor self-cycle", () => {
        expectCyclic("root: !mytag &a [*a]\n");
    });

    test("S1240 variant: nested sequence wrap", () => {
        expectCyclic("root: &a [[*a]]\n");
    });

    test("S1242: merge-key self-anchor", () => {
        // `<<: *a` with self-anchor — exercises the map branch under merge.
        expectCyclic("root: &a\n  <<: *a\n");
    });

    test("S1241: 50x sibling amplifier — each key is its own self-cycle", () => {
        const lines: string[] = [];
        for (let i = 0; i < 50; i++) lines.push(`k${i}: &a${i} [*a${i}]`);
        expectCyclic(lines.join("\n") + "\n");
    });

    test("legitimate structure-sharing (sibling DAG, not cyclic) still parses", () => {
        // Same anchor referenced at two sibling positions — NOT a cycle.
        // The guard must add-on-entry / remove-on-exit to allow this.
        const yaml = "shared: &s {a: 1, b: 2}\nleft: *s\nright: *s\n";
        const t = yamlToLua(yaml) as Record<string, LuaValue>;
        expect(t.left).toEqual({ a: 1, b: 2 } as any);
        expect(t.right).toEqual({ a: 1, b: 2 } as any);
    });

    test("deep but acyclic nesting parses without tripping the guard", () => {
        const yaml = "root:\n  a:\n    b:\n      c:\n        d: 1\n";
        const t = yamlToLua(yaml) as Record<string, LuaValue>;
        expect(t.root).toEqual({ a: { b: { c: { d: 1 } } } } as any);
    });
});

describe("yamlToLua — reserved-key rejection (C6 / S800)", () => {
    test("rejects top-level __proto__ key", () => {
        expect(() => yamlToLua("__proto__: evil\nx: 1\n"))
            .toThrow(/reserved and not allowed/);
    });

    test("rejects nested __proto__ key", () => {
        expect(() => yamlToLua("wrap:\n  __proto__: { polluted: true }\n"))
            .toThrow(/reserved and not allowed/);
    });

    test("rejects constructor key", () => {
        expect(() => yamlToLua("constructor: payload\n"))
            .toThrow(/reserved and not allowed/);
    });

    test("rejects prototype key", () => {
        expect(() => yamlToLua("prototype: payload\n"))
            .toThrow(/reserved and not allowed/);
    });

    test("error code is YAML_RESERVED_KEY", () => {
        try {
            yamlToLua("__proto__: x\n");
            expect.unreachable();
        } catch (e) {
            expect(e).toBeInstanceOf(KindlyError);
            expect((e as KindlyError).code).toBe(ErrorCodes.YAML_RESERVED_KEY);
        }
    });

    test("substrings of reserved keys are allowed", () => {
        // Only exact matches reject; keys that merely contain the reserved
        // substring (e.g. "my_prototype") are legitimate user data.
        const t = yamlToLua("my_prototype: 1\nproto_wrapper: 2\nuse_constructor: 3\n") as Record<string, LuaValue>;
        expect(t.my_prototype).toBe(1);
        expect(t.proto_wrapper).toBe(2);
        expect(t.use_constructor).toBe(3);
    });
});
