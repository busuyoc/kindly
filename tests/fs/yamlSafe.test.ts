import { describe, test, expect } from "bun:test";
import { parseYamlSafe, YamlTooLargeError } from "../../src/fs/yamlSafe.ts";
import { ErrorCodes } from "../../src/types/errors.ts";

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

    describe("C6 — YAML 1.1 directive rejection (S488)", () => {
        test("rejects %YAML 1.1 directive", () => {
            expect(() => parseYamlSafe("%YAML 1.1\n---\nx: 1\n"))
                .toThrow(/YAML version directive is not allowed/);
        });

        test("rejects %YAML 1.2 directive (all directives banned, not just 1.1)", () => {
            expect(() => parseYamlSafe("%YAML 1.2\n---\nx: 1\n"))
                .toThrow(/YAML version directive is not allowed/);
        });

        test("error code is YAML_DIRECTIVE", () => {
            try {
                parseYamlSafe("%YAML 1.1\n---\nx: 1\n");
                expect.unreachable();
            } catch (e: any) {
                expect(e.code).toBe(ErrorCodes.YAML_DIRECTIVE);
            }
        });

        test("without directive, no/yes/on parse as strings (YAML 1.2 core schema)", () => {
            // Without a directive, yaml@2 defaults to 1.2 and parses these as
            // strings. This is the positive path C6 preserves.
            expect(parseYamlSafe("x: no\ny: yes\nz: on\n")).toEqual({ x: "no", y: "yes", z: "on" });
        });

        test("true/false still parse as booleans", () => {
            expect(parseYamlSafe("a: true\nb: false\n")).toEqual({ a: true, b: false });
        });

        test("the string '%YAML' inside a value is allowed", () => {
            // Only directives (column-0, standalone line) are rejected.
            expect(parseYamlSafe('note: "see %YAML docs"\n')).toEqual({ note: "see %YAML docs" });
        });
    });

    describe("C5 — non-NFC key rejection (Lead 19, S730-S739)", () => {
        // codepoint construction — see below
        // Build NFD/NFC variants explicitly from codepoints so the test
        // doesn't depend on what form the editor saved this file in.
        // Both render as "café"; bytes differ.
        const NFC = "café";              // c a f é (precomposed)
        const NFD = "café";        // c a f e + combining acute

        test("self-test: NFD differs by bytes, equals by NFC", () => {
            expect(NFD).not.toBe(NFC);
            expect(NFD.normalize("NFC")).toBe(NFC);
            expect(NFC.normalize("NFC")).toBe(NFC);
        });

        test("rejects an NFD-decomposed top-level key", () => {
            expect(() => parseYamlSafe(`${NFD}: 1\n`))
                .toThrow(/Unicode Normalization Form C/);
        });

        test("error code is YAML_NON_NFC_KEY", () => {
            try {
                parseYamlSafe(`${NFD}: 1\n`);
                expect.unreachable();
            } catch (e: any) {
                expect(e.code).toBe(ErrorCodes.YAML_NON_NFC_KEY);
            }
        });

        test("rejects a non-NFC nested key (recursion)", () => {
            const doc = `kosync:\n  ${NFD}: x\n`;
            expect(() => parseYamlSafe(doc)).toThrow(/Unicode Normalization Form C/);
        });

        test("path hint points at the offending location", () => {
            try {
                parseYamlSafe(`kosync:\n  ${NFD}: x\n`);
                expect.unreachable();
            } catch (e: any) {
                expect(e.message).toContain("$.kosync");
            }
        });

        test("plain ASCII keys pass through (NFC == self)", () => {
            expect(parseYamlSafe("kosync:\n  userkey: v\n")).toEqual({
                kosync: { userkey: "v" },
            });
        });

        test("NFC-precomposed accents pass through", () => {
            expect(parseYamlSafe(`${NFC}: 1\n`)).toEqual({ [NFC]: 1 });
        });

        test("ZWSP-injected key is rejected as YAML_INVISIBLE_KEY (Lead 19 round 2)", () => {
            // U+200B is preserved by NFC normalization, so the byte-level
            // NFC check above wouldn't catch it. The Cf/Cc check in
            // assertNfcKeys closes that residual gap so attackers can't
            // smuggle a ZWSP-bearing variant of a SECRET key past the
            // YAML boundary even though NFC normalization is a no-op.
            const variant = "kosync​";
            expect(variant.normalize("NFC")).toBe(variant);
            expect(() => parseYamlSafe(`${variant}: 1\n`))
                .toThrow(/invisible or control codepoint/);
        });

        test("array entries are walked", () => {
            const doc = `list:\n  - ${NFD}: 1\n`;
            expect(() => parseYamlSafe(doc)).toThrow(/Unicode Normalization Form C/);
        });
    });
});
