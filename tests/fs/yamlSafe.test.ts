import { describe, test, expect } from "bun:test";
import { parseYamlSafe, YamlTooLargeError } from "../../src/fs/yamlSafe.ts";

describe("parseYamlSafe — A12 YAML-bomb guard", () => {
    test("parses normal YAML unchanged", () => {
        expect(parseYamlSafe("a: 1\nb: two\n")).toEqual({ a: 1, b: "two" });
    });

    test("rejects a source larger than the cap", () => {
        const big = "x: " + "a".repeat(2 * 1024 * 1024);   // ~2 MiB
        expect(() => parseYamlSafe(big, { maxBytes: 64 * 1024 }))
            .toThrow(YamlTooLargeError);
    });

    test("billion-laughs refused via maxAliasCount", () => {
        // Classic YAML bomb: each level references the last 9 times, so
        // `h` would expand to 9^7 references. yaml's default maxAliasCount
        // (100) kicks in well before then; we pin it inside parseYamlSafe.
        const bomb = `
a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]
h: [*g,*g,*g,*g,*g,*g,*g,*g,*g]
`;
        expect(() => parseYamlSafe(bomb)).toThrow();
    });

    test("default cap is above any legit kindly YAML", () => {
        // ~1 MiB of unique keys. Well under the 10 MiB default, well
        // above any real kindly.yaml.
        const lines: string[] = [];
        for (let i = 0; i < 10_000; i++) lines.push(`key_${i}: value_${i}`);
        const doc = lines.join("\n") + "\n";
        expect(() => parseYamlSafe(doc)).not.toThrow();
    });

    test("S843/S1243: unresolved custom tags do not emit YAMLWarning on stderr", () => {
        // yaml@2 emits "Unresolved tag" warnings via console.warn by default.
        // They break --json framing and can leak node_modules paths in stack
        // traces. `logLevel:"silent"` in parseYamlSafe must suppress them.
        const origWarn = console.warn;
        const origError = console.error;
        const captured: string[] = [];
        console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
        console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
        try {
            // Parsing succeeds; unresolved tag just produces a raw value.
            parseYamlSafe("root: !unknown_tag hello\n");
            parseYamlSafe("root: !another value\nchild: !yet_more 42\n");
        } finally {
            console.warn = origWarn;
            console.error = origError;
        }
        expect(captured.join("\n")).not.toMatch(/YAMLWarning|Unresolved tag/i);
    });
});
