import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump, dumpSettingsFile, luaQuoteString, type LuaValue } from "../../src/lua/writer.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";

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

describe("luaNumberString — negative-exponent regression (S400)", () => {
    // Numbers whose toPrecision(14) output uses exponential notation
    // (|n| < 1e-6 or |n| >= 1e21) — these are the cases that the buggy
    // regex mangled. Each must round-trip exactly.
    const explicitExpCases: Array<[number, string]> = [
        [1e-10, "1e-10"],
        [1e-100, "1e-100"],
        [1e-300, "1e-300"],
        [1.5e-10, "1.5e-10"],
        [2.5e-7, "2.5e-7"],
        [1.234e-50, "1.234e-50"],
        [1.234e-200, "1.234e-200"],
    ];
    for (const [n, expected] of explicitExpCases) {
        test(`dump(${n}) === ${JSON.stringify(expected)}`, () => {
            expect(dump(n)).toBe(expected);
        });
    }

    // Numbers whose toPrecision(14) uses fixed notation. Verify
    // round-trip semantics via parser (byte form may use leading zeros).
    const fixedCases: number[] = [3.14e-5, 0.1, 3.14, -3.14];
    for (const n of fixedCases) {
        test(`dump(${n}) round-trips through parser`, () => {
            const s = dump(n);
            const parsed = parseSettingsFile(`return { ["n"] = ${s} }`) as { n: number };
            expect(parsed.n).toBe(n);
        });
    }

    // Byte-fidelity spot check: cases the OLD code already handled
    // correctly must remain byte-identical post-fix.
    test("byte-fidelity: dump(3.14) === '3.14'", () => {
        expect(dump(3.14)).toBe("3.14");
    });
    test("byte-fidelity: dump(1.5) === '1.5'", () => {
        expect(dump(1.5)).toBe("1.5");
    });
    test("byte-fidelity: dump(42) === '42'", () => {
        expect(dump(42)).toBe("42");
    });
    test("byte-fidelity: dump(0) === '0'", () => {
        expect(dump(0)).toBe("0");
    });
    test("byte-fidelity: dump(-0) === '0'", () => {
        expect(dump(-0)).toBe("0");
    });

    test("explicit S400 reproducer: 1e-10 must not collapse to 0.1", () => {
        const s = dump(1e-10);
        expect(s).toBe("1e-10");
        const parsed = parseSettingsFile(`return { ["n"] = ${s} }`) as { n: number };
        expect(parsed.n).toBe(1e-10);
        expect(parsed.n).not.toBe(0.1);
    });

    test("property-based round-trip: 50 non-integer floats with short mantissas across ±300 orders of magnitude", () => {
        // Mantissas chosen to mirror the realistic settings.reader.lua surface
        // (and Angle B's documented bug surface): short, fewer-than-14
        // significant digits — so toPrecision(14) is lossless and the
        // round-trip is exact when the regex doesn't mangle.
        const mantissas = [1, 1.5, 2.5, 3, 5, 7, 1.2, 1.23, 1.234, 3.14];
        let seed = 0xdeadbeef;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 0x100000000;
        };
        let iterations = 0;
        for (let i = 0; i < 500 && iterations < 50; i++) {
            const sign = rand() < 0.5 ? -1 : 1;
            const mantissa = mantissas[Math.floor(rand() * mantissas.length)];
            const exp = Math.floor(rand() * 600 - 300);
            const n = sign * mantissa * 10 ** exp;
            if (!Number.isFinite(n) || n === 0) continue;
            // Skip integer-valued doubles — they hit the n.toString() branch,
            // which doesn't go through luaNumberString's regex.
            if (Number.isInteger(n)) continue;
            // Reference is the toPrecision(14)-rounded value: that is the
            // semantic luaNumberString preserves (matches KOReader's %.14g).
            // The bug we are catching is the regex collapsing the mantissa
            // (e.g. 1e-10 → 0.1, 1e9 drift), not 14-sig-digit rounding.
            const ref = parseFloat(n.toPrecision(14));
            const s = dump(n);
            const parsed = parseSettingsFile(`return { ["n"] = ${s} }`) as { n: number };
            expect(parsed.n).toBe(ref);
            iterations++;
        }
        expect(iterations).toBe(50);
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
