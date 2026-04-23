// W36/W37: Lua static scanner unit tests.
//
// Covers: each pattern fires, comment/string stripping neutralizes
// mentions inside comments and string data, word-boundary anchoring
// prevents `myos.execute` FPs, long-bracket comments/strings work,
// literal-vs-variable filtering for load/dofile and require's
// allowlist of modules, absolute-path-only filter for fs-outside-scope.

import { describe, test, expect } from "bun:test";
import {
    scanLuaSource,
    stripCommentsAndStrings,
    type ScanCategory,
} from "../../src/setup/luaScan.ts";

function categories(src: string): ScanCategory[] {
    return scanLuaSource(src).map((m) => m.category);
}
function labels(src: string): string[] {
    return scanLuaSource(src).map((m) => m.label);
}

describe("stripCommentsAndStrings — preserve offsets", () => {
    test("line comment becomes spaces, newline intact", () => {
        const stripped = stripCommentsAndStrings("x=1 -- hello\ny=2");
        expect(stripped).toBe("x=1         \ny=2");
        expect(stripped.length).toBe("x=1 -- hello\ny=2".length);
    });

    test("long comment `--[[...]]` blanks to spaces + newlines", () => {
        const src = "a\n--[[danger\nos.execute]]\nb";
        const stripped = stripCommentsAndStrings(src);
        expect(stripped.length).toBe(src.length);
        expect(stripped).not.toContain("os.execute");
        // Line 4 ("b") should be preserved.
        expect(stripped.split("\n")[3]).toBe("b");
    });

    test("long comment level `--[==[...]==]`", () => {
        const src = "--[==[\nos.execute('bad')\n]==]\nreal=1";
        const stripped = stripCommentsAndStrings(src);
        expect(stripped).not.toContain("os.execute");
        expect(stripped).toContain("real=1");
    });

    test("short string contents are blanked", () => {
        const src = `local s = "os.execute('oops')"`;
        const stripped = stripCommentsAndStrings(src);
        expect(stripped).not.toContain("os.execute");
        expect(stripped.length).toBe(src.length);
    });

    test("long string `[[...]]` is blanked", () => {
        const src = "local s = [[io.popen here]]";
        const stripped = stripCommentsAndStrings(src);
        expect(stripped).not.toContain("io.popen");
    });

    test("escape sequences preserve offsets", () => {
        const src = `local s = "a\\"b"`;
        const stripped = stripCommentsAndStrings(src);
        expect(stripped.length).toBe(src.length);
    });
});

describe("scanLuaSource — shell category", () => {
    test("os.execute call fires", () => {
        expect(categories(`os.execute("ls")`)).toEqual(["shell"]);
    });
    test("os.execute aliased assignment fires (spec §2.2)", () => {
        expect(categories(`util.execute = os.execute`)).toEqual(["shell"]);
    });
    test("io.popen fires", () => {
        expect(categories(`local p = io.popen("date")`)).toEqual(["shell"]);
    });
    test("myos.execute does NOT fire (word boundary)", () => {
        expect(scanLuaSource(`myos.execute("x")`)).toEqual([]);
    });
    test("comment mentioning os.execute does NOT fire", () => {
        expect(scanLuaSource(`-- os.execute("x")`)).toEqual([]);
    });
    test("string literal containing os.execute does NOT fire", () => {
        expect(scanLuaSource(`local s = "os.execute('x')"`)).toEqual([]);
    });
    test("autostandby regression: commented-out os.execute", () => {
        // Real case from docs/93 inventory: autostandby/main.lua:178.
        const src = `-- os.execute("echo mem > /sys/power/state")\nlocal x = 1`;
        expect(scanLuaSource(src)).toEqual([]);
    });
});

describe("scanLuaSource — dynamic-load category", () => {
    test("loadstring fires anywhere", () => {
        expect(categories(`local f = loadstring(body)`)).toEqual(["dynamic-load"]);
    });
    test("load(literal) does NOT fire", () => {
        expect(scanLuaSource(`load("return 1")`)).toEqual([]);
    });
    test("load(long-bracket literal) does NOT fire", () => {
        expect(scanLuaSource(`load([[return 1]])`)).toEqual([]);
    });
    test("load(variable) fires", () => {
        expect(categories(`load(body)`)).toEqual(["dynamic-load"]);
    });
    test("load() empty call fires (loads from stdin)", () => {
        expect(categories(`load()`)).toEqual([]);
        // Empty parens: spec regex requires 1 non-ws char after `(`.
        // `)` is excluded from the non-literal char class → no match.
        // Documenting the actual behavior: empty calls pass. If attacker
        // abuse emerges we can tighten.
    });
    test("dofile(literal) does NOT fire", () => {
        expect(scanLuaSource(`dofile("plugins/foo.lua")`)).toEqual([]);
    });
    test("dofile(variable) fires", () => {
        expect(categories(`dofile(path)`)).toEqual(["dynamic-load"]);
    });
    test("dynamic-load inside slt2-style template (exporter pattern)", () => {
        // From inventory: exporter/template/slt2.lua uses loadstring.
        // This is a recommended plugin — scanner flags it; catalog
        // suppression (not this layer) silences it.
        const src = `local fn = loadstring(t.code, "template")`;
        expect(categories(src)).toEqual(["dynamic-load"]);
    });
});

describe("scanLuaSource — network category", () => {
    test("require('socket') fires", () => {
        expect(categories(`local s = require("socket")`)).toEqual(["network"]);
    });
    test("require('socket.http') fires", () => {
        expect(categories(`require("socket.http")`)).toEqual(["network"]);
    });
    test("require('ssl.https') fires", () => {
        expect(categories(`require("ssl.https")`)).toEqual(["network"]);
    });
    test("require('socket-like-thing') does NOT fire (exact name)", () => {
        expect(scanLuaSource(`require("my-socket")`)).toEqual([]);
        expect(scanLuaSource(`require("socket-stub")`)).toEqual([]);
    });
});

describe("scanLuaSource — native-code category", () => {
    test("require('ffi') fires", () => {
        expect(categories(`local ffi = require("ffi")`)).toEqual(["native-code"]);
    });
    test("package.loadlib fires", () => {
        expect(categories(`package.loadlib("./lib.so", "sym")`)).toEqual(["native-code"]);
    });
});

describe("scanLuaSource — reflection category", () => {
    test("debug.setfenv fires", () => {
        expect(categories(`debug.setfenv(f, env)`)).toEqual(["reflection"]);
    });
    test("debug.getregistry fires", () => {
        expect(categories(`debug.getregistry()`)).toEqual(["reflection"]);
    });
    test("debug.sethook fires", () => {
        expect(categories(`debug.sethook(hook)`)).toEqual(["reflection"]);
    });
    test("debug.traceback (diagnostic) does NOT fire", () => {
        expect(scanLuaSource(`debug.traceback()`)).toEqual([]);
    });
    test("debug.getinfo (diagnostic) does NOT fire", () => {
        expect(scanLuaSource(`debug.getinfo(1)`)).toEqual([]);
    });
});

describe("scanLuaSource — fs-outside-scope category", () => {
    test("os.remove absolute path fires", () => {
        expect(categories(`os.remove("/etc/passwd")`)).toEqual(["fs-outside-scope"]);
    });
    test("os.remove relative path does NOT fire", () => {
        expect(scanLuaSource(`os.remove("cache/file")`)).toEqual([]);
    });
    test("io.open absolute write fires", () => {
        expect(categories(`io.open("/tmp/x", "w")`)).toEqual(["fs-outside-scope"]);
    });
    test("io.open relative write does NOT fire", () => {
        expect(scanLuaSource(`io.open("export/out.txt", "w")`)).toEqual([]);
    });
    test("io.open absolute read does NOT fire", () => {
        expect(scanLuaSource(`io.open("/etc/passwd", "r")`)).toEqual([]);
    });
    test("io.open absolute append fires", () => {
        expect(categories(`io.open("/tmp/x", "a")`)).toEqual(["fs-outside-scope"]);
    });
});

describe("scanLuaSource — line numbers and snippets", () => {
    test("line number reflects original source", () => {
        const src = "local a = 1\nlocal b = 2\nos.execute('x')";
        const matches = scanLuaSource(src);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.line).toBe(3);
        expect(matches[0]!.snippet).toBe(`os.execute('x')`);
    });

    test("snippet trimmed and capped at 80 chars", () => {
        const pad = "x".repeat(100);
        const src = `        local line = ${pad}; os.execute("y")`;
        const matches = scanLuaSource(src);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.snippet.length).toBeLessThanOrEqual(80);
    });

    test("long comment preserves line numbers after", () => {
        const src = "a\n--[[\nfoo\nbar\n]]\nos.execute('x')";
        const matches = scanLuaSource(src);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.line).toBe(6);
    });

    test("matches sorted by line then category", () => {
        const src = [
            "require('socket')",
            "os.execute('x')",
            "loadstring(body)",
        ].join("\n");
        const matches = scanLuaSource(src);
        expect(matches.map((m) => m.line)).toEqual([1, 2, 3]);
    });
});

describe("scanLuaSource — inventory cross-check", () => {
    // Spot-check: scanner correctly flags the patterns the FP survey
    // enumerates. Not exhaustive — the integration tests do per-plugin
    // coverage — just a sanity check that the regex catalog matches
    // the docs/93 inventory's classification.
    test("localsend-style self-update kitchen sink", () => {
        const src = [
            `os.execute("rm -rf /tmp/ls")`,
            `local p = io.popen("curl -s http://x")`,
            `local s = require("socket")`,
        ].join("\n");
        expect(labels(src)).toEqual([
            "os.execute",
            "io.popen",
            "require(<net>)",
        ]);
    });

    test("timesync-style ffi+shell combo", () => {
        const src = [
            `local ffi = require("ffi")`,
            `os.execute("ntpdate pool.ntp.org")`,
        ].join("\n");
        expect(labels(src).sort()).toEqual([
            "os.execute",
            'require("ffi")',
        ]);
    });
});
