import { describe, test, expect } from "bun:test";
import { parse, parseSettingsFile, LuaParseError } from "../../src/lua/reader.ts";
import { dump, dumpSettingsFile, type LuaValue } from "../../src/lua/writer.ts";

describe("reader — primitives", () => {
    test("nil", () => expect(parse("nil")).toBe(null));
    test("true", () => expect(parse("true")).toBe(true));
    test("false", () => expect(parse("false")).toBe(false));
    test("integer", () => expect(parse("42")).toBe(42));
    test("negative", () => expect(parse("-7")).toBe(-7));
    test("float", () => expect(parse("3.14")).toBe(3.14));
    test("exponent", () => expect(parse("1.5e2")).toBe(150));
    test("negative exponent", () => expect(parse("2e-3")).toBe(0.002));
    test("simple string", () => expect(parse('"hi"')).toBe("hi"));
});

describe("reader — string escapes", () => {
    test("escaped quote", () => expect(parse('"a\\"b"')).toBe('a"b'));
    test("escaped backslash", () => expect(parse('"a\\\\b"')).toBe("a\\b"));
    // dump.lua emits \n as backslash + literal newline
    test("backslash-newline → \\n", () => expect(parse('"a\\\nb"')).toBe("a\nb"));
    test("decimal escape \\0", () => expect(parse('"a\\0b"')).toBe("a\0b"));
    test("decimal escape \\13", () => expect(parse('"x\\13y"')).toBe("x\ry"));
    test("decimal stops at non-digit", () => expect(parse('"\\7a"')).toBe("\x07a"));
    test("decimal greedy up to 3", () => expect(parse('"\\127x"')).toBe("\x7fx"));
    test("named \\n (if someone hand-writes it)", () => expect(parse('"\\n"')).toBe("\n"));
    test("named \\t", () => expect(parse('"\\t"')).toBe("\t"));
    test("utf-8 passes through", () => expect(parse('"café"')).toBe("café"));
});

describe("reader — tables", () => {
    test("empty", () => expect(parse("{}")).toEqual({}));

    test("single string key", () => {
        expect(parse('{["foo"] = "bar",}')).toEqual({ foo: "bar" });
    });

    test("multiple keys with trailing comma", () => {
        expect(parse('{["a"] = 1,["b"] = 2,}')).toEqual({ a: 1, b: 2 });
    });

    test("no trailing comma", () => {
        expect(parse('{["a"] = 1,["b"] = 2}')).toEqual({ a: 1, b: 2 });
    });

    test("nested table", () => {
        expect(parse('{["x"] = {["y"] = true,},}')).toEqual({ x: { y: true } });
    });

    test("dense 1..N numeric keys → array", () => {
        expect(parse('{[1] = "a",[2] = "b",[3] = "c",}')).toEqual(["a", "b", "c"]);
    });

    test("sparse numeric keys → Map", () => {
        const r = parse('{[1] = "a",[3] = "c",}') as Map<number, string>;
        expect(r instanceof Map).toBe(true);
        expect(r.get(1)).toBe("a");
        expect(r.get(3)).toBe("c");
    });

    test("mixed keys → Map", () => {
        const r = parse('{[1] = "a",["foo"] = "bar",}') as Map<string | number, unknown>;
        expect(r instanceof Map).toBe(true);
        expect(r.get(1)).toBe("a");
        expect(r.get("foo")).toBe("bar");
    });

    test("whitespace-tolerant", () => {
        const src = `{
            ["a"]  =  1 ,
            ["b"]  =  2 ,
        }`;
        expect(parse(src)).toEqual({ a: 1, b: 2 });
    });
});

describe("parseSettingsFile", () => {
    test("requires return prefix", () => {
        expect(() => parseSettingsFile('{["a"]=1}')).toThrow(LuaParseError);
    });

    test("parses full file", () => {
        expect(parseSettingsFile('return {\n    ["k"] = 1,\n}')).toEqual({ k: 1 });
    });

    test("rejects trailing garbage", () => {
        expect(() => parseSettingsFile('return 1 junk')).toThrow(LuaParseError);
    });
});

describe("round-trip — parse(dump(x)) === x, dump(parse(dump(x))) === dump(x)", () => {
    const samples: LuaValue[] = [
        null,
        true,
        false,
        0,
        42,
        -7,
        3.14,
        "",
        "hello",
        'quotes "and" \\ slashes',
        "new\nline",
        "null\0byte",
        "control\x01\x1f\x7f",
        {},
        { k: 1 },
        { a: 1, b: "two", c: true, d: null },
        { nested: { deep: { deeper: [1, 2, 3] } } },
        ["a", "b", "c"],
        {
            plugins_disabled: { coverbrowser: true, gestures: false },
            css_tweaks: { night_colors: true },
            last_page: 142,
            recent_files: ["/mnt/us/documents/a.epub", "/mnt/us/documents/b.pdf"],
        },
    ];

    for (const [i, s] of samples.entries()) {
        test(`sample ${i}`, () => {
            const d1 = dump(s);
            const p = parse(d1);
            const d2 = dump(p);
            // dump is canonical: round-tripping must produce identical bytes
            expect(d2).toBe(d1);
            // and for simple primitive values the parsed form equals the input
            if (s === null || typeof s !== "object") {
                expect(p).toBe(s);
            }
        });
    }

    test("settings-file wrapper round-trip", () => {
        const data = { foo: "bar", n: 42 };
        const text = dumpSettingsFile(data);
        const parsed = parseSettingsFile(text);
        expect(dump(parsed)).toBe(dump(data));
    });
});

describe("differential — our reader consumes luajit+dump.lua output", () => {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const available = spawnSync("luajit", ["-v"], { stdio: "ignore" }).status === 0;

    function luaDump(luaLiteral: string): string {
        const script = `
            package.loaded["ffi/util"] = {
                orderedPairs = function(t)
                    local keys = {}
                    for k in pairs(t) do keys[#keys+1] = k end
                    table.sort(keys, function(a, b)
                        if type(a) == type(b) then return a < b end
                        return type(a) == "number"
                    end)
                    local i = 0
                    return function()
                        i = i + 1
                        if keys[i] ~= nil then return keys[i], t[keys[i]] end
                    end
                end,
            }
            local dump = dofile("/tmp/koreader-src/frontend/dump.lua")
            local v = ${luaLiteral}
            io.write(dump(v, nil, true))
        `;
        const r = spawnSync("luajit", ["-e", script], { encoding: "utf8" });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout;
    }

    const cases: Array<{ lua: string; expected: unknown }> = [
        { lua: "42", expected: 42 },
        { lua: '"hello \\"world\\"\\nnewline"', expected: 'hello "world"\nnewline' },
        { lua: "{foo=1, bar=2}", expected: { bar: 2, foo: 1 } },
        { lua: "{1, 2, 3}", expected: [1, 2, 3] },
        { lua: '"\\0\\1\\127"', expected: "\x00\x01\x7f" },
        { lua: "true", expected: true },
        { lua: "nil", expected: null },
    ];

    if (!available) {
        test.skip("luajit not available", () => {});
        return;
    }

    for (const [i, c] of cases.entries()) {
        test(`case ${i}: ${c.lua}`, () => {
            const text = luaDump(c.lua);
            const parsed = parse(text);
            expect(parsed).toEqual(c.expected as any);
        });
    }
});

describe("parser safety — doesn't execute code", () => {
    test("rejects function calls", () => {
        expect(() => parse('os.execute("rm -rf /")')).toThrow();
    });
    test("rejects bareword identifiers", () => {
        expect(() => parse('{foo = 1}')).toThrow();
    });
});

describe("reader — Lua comments", () => {
    // Real settings.reader.lua files start with `-- ./settings.reader.lua`
    // written by luasettings.lua. dump.lua also emits --[[ LOOP ]] markers
    // for recursive tables. We must skip both.
    test("short comment before return", () => {
        expect(parseSettingsFile("-- ./settings.reader.lua\nreturn 42")).toBe(42);
    });
    test("comment at EOF (no trailing newline)", () => {
        expect(parse("42 -- trailing")).toBe(42);
    });
    test("long-bracket comment", () => {
        expect(parse("--[[ block\ncomment ]] 42")).toBe(42);
    });
    test("long-bracket comment with = levels", () => {
        expect(parse("--[==[ weird ]] not-closed-yet ]==] 42")).toBe(42);
    });
    test("comment inside a table", () => {
        expect(parse('{\n-- inline\n["k"] = 1,\n}')).toEqual({ k: 1 });
    });
});
