import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump, dumpSettingsFile, luaQuoteString, type LuaValue } from "../../src/lua/writer.ts";

// Reference dump.lua from the KOReader tree (cloned during research).
// Tests that need a ground-truth Lua implementation shell out to luajit.
const DUMP_LUA_PATH = "/tmp/koreader-src/frontend/dump.lua";

function luajitAvailable(): boolean {
    const r = spawnSync("luajit", ["-v"], { stdio: "ignore" });
    return r.status === 0;
}

// Run a Lua snippet through luajit and return stdout.
function runLua(src: string): string {
    const r = spawnSync("luajit", ["-e", src], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`luajit failed: ${r.stderr}`);
    return r.stdout;
}

// Load our dump output with luajit and re-serialize via KOReader's dump.lua.
// If the bytes match on the second pass, parsing succeeded end-to-end.
function luaRoundTrip(ourOutput: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kindly-"));
    const inputPath = join(dir, "in.lua");
    writeFileSync(inputPath, "return " + ourOutput);
    // orderedPairs lives in ffi/util, which pulls in a lot. For test purposes
    // we inject a minimal orderedPairs so dump.lua works standalone.
    const script = `
        package.path = package.path .. ";/tmp/koreader-src/frontend/?.lua"
        -- shim ffi/util.orderedPairs so dump.lua can require it
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
        local dump = dofile("${DUMP_LUA_PATH}")
        local data = dofile("${inputPath}")
        io.write(dump(data, nil, true))
    `;
    return runLua(script);
}

describe("luaQuoteString — matches Lua's %q byte-for-byte", () => {
    const cases = [
        "",
        "hello",
        'has "quote"',
        "back\\slash",
        "line\nbreak",
        "carriage\rreturn",
        "null\0byte",
        "tab\there",
        "bell\x07",
        "mixed \"q\" \\ \n end",
        "utf-8: café — ☃",
        String.fromCharCode(1, 2, 3, 27),
    ];

    if (!luajitAvailable()) {
        test.skip("luajit not available", () => {});
        return;
    }

    for (const s of cases) {
        test(`quote(${JSON.stringify(s)})`, () => {
            const ours = luaQuoteString(s);
            // Pass the string to luajit via stdin-equivalent: encode as a Lua
            // long bracket literal can't handle arbitrary bytes either, so
            // write it to a file and read it back.
            const dir = mkdtempSync(join(tmpdir(), "kindly-q-"));
            const p = join(dir, "s.bin");
            writeFileSync(p, s);
            const theirs = runLua(`
                local f = io.open("${p}", "rb")
                local data = f:read("*a")
                f:close()
                io.write(string.format("%q", data))
            `);
            expect(ours).toBe(theirs);
        });
    }
});

describe("dump — primitives", () => {
    test("nil", () => expect(dump(null)).toBe("nil"));
    test("true", () => expect(dump(true)).toBe("true"));
    test("false", () => expect(dump(false)).toBe("false"));
    test("integer", () => expect(dump(42)).toBe("42"));
    test("negative integer", () => expect(dump(-7)).toBe("-7"));
    test("zero", () => expect(dump(0)).toBe("0"));
    test("float", () => expect(dump(3.14)).toBe("3.14"));
    test("string", () => expect(dump("hi")).toBe('"hi"'));
});

describe("dump — tables", () => {
    test("empty table", () => {
        expect(dump({})).toBe("{}");
    });

    test("single string key", () => {
        expect(dump({ foo: "bar" })).toBe('{\n    ["foo"] = "bar",\n}');
    });

    test("keys sorted alphabetically", () => {
        const out = dump({ zed: 1, alpha: 2, middle: 3 });
        expect(out).toBe(
            '{\n    ["alpha"] = 2,\n    ["middle"] = 3,\n    ["zed"] = 1,\n}'
        );
    });

    test("nested table indent", () => {
        const out = dump({ outer: { inner: true } });
        expect(out).toBe(
            '{\n    ["outer"] = {\n        ["inner"] = true,\n    },\n}'
        );
    });

    test("array (1-indexed numeric keys)", () => {
        expect(dump(["a", "b", "c"])).toBe(
            '{\n    [1] = "a",\n    [2] = "b",\n    [3] = "c",\n}'
        );
    });

    test("Map preserves numeric key ordering", () => {
        const m = new Map<string | number, LuaValue>([
            [2, "two"],
            [1, "one"],
            [10, "ten"],
        ]);
        expect(dump(m)).toBe(
            '{\n    [1] = "one",\n    [2] = "two",\n    [10] = "ten",\n}'
        );
    });
});

describe("dumpSettingsFile", () => {
    test("prepends 'return ' and appends trailing newline", () => {
        expect(dumpSettingsFile({ k: 1 })).toBe(
            'return {\n    ["k"] = 1,\n}\n'
        );
    });
    test("includes filepath header when provided (matches util.writeToFile)", () => {
        expect(dumpSettingsFile({ k: 1 }, "./settings.reader.lua")).toBe(
            '-- ./settings.reader.lua\nreturn {\n    ["k"] = 1,\n}\n'
        );
    });
});

describe("luajit round-trip — our output is parseable, and re-dumping matches", () => {
    if (!luajitAvailable()) {
        test.skip("luajit not available", () => {});
        return;
    }

    const samples: LuaValue[] = [
        { foo: "bar", n: 42, ok: true, nope: false, gone: null },
        { nested: { a: 1, b: { c: [1, 2, 3] } } },
        { "key with spaces": "and \"quotes\" and \\ backslash" },
        { empty: {}, list: [10, 20, 30] },
        // settings.reader.lua-ish shape
        {
            plugins_disabled: { coverbrowser: true, gestures: false },
            css_tweaks: { night_colors: true },
            last_page: 142,
        },
    ];

    for (const [i, s] of samples.entries()) {
        test(`sample ${i}`, () => {
            const ours = dump(s);
            const theirs = luaRoundTrip(ours);
            expect(ours).toBe(theirs);
        });
    }
});
