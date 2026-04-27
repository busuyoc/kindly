import { describe, test, expect } from "bun:test";
import { parseArgs, ArgError } from "../../src/cli/args.ts";

const spec = {
    verbose: { type: "boolean", default: false },
    output: { type: "string" },
    mode: { type: "string", default: "minimal" },
} as const;

describe("parseArgs", () => {
    test("returns defaults with no argv", () => {
        const r = parseArgs([], spec);
        expect(r.flags.verbose).toBe(false);
        expect(r.flags.output).toBeUndefined();
        expect(r.flags.mode).toBe("minimal");
        expect(r.positional).toEqual([]);
    });

    test("--flag sets boolean", () => {
        expect(parseArgs(["--verbose"], spec).flags.verbose).toBe(true);
    });

    test("--no-flag sets boolean false", () => {
        expect(parseArgs(["--no-verbose"], spec).flags.verbose).toBe(false);
        expect(parseArgs(["--verbose", "--no-verbose"], spec).flags.verbose).toBe(false);
    });

    test("--flag=value", () => {
        expect(parseArgs(["--output=foo.yaml"], spec).flags.output).toBe("foo.yaml");
    });

    test("--flag value (space-separated)", () => {
        expect(parseArgs(["--output", "foo.yaml"], spec).flags.output).toBe("foo.yaml");
    });

    test("--flag=true/false for booleans", () => {
        expect(parseArgs(["--verbose=true"], spec).flags.verbose).toBe(true);
        expect(parseArgs(["--verbose=false"], spec).flags.verbose).toBe(false);
    });

    test("collects positionals", () => {
        const r = parseArgs(["minimal", "other", "--verbose"], spec);
        expect(r.positional).toEqual(["minimal", "other"]);
        expect(r.flags.verbose).toBe(true);
    });

    test("unknown flag is an error", () => {
        expect(() => parseArgs(["--bogus"], spec)).toThrow(ArgError);
    });

    test("string flag without value is an error", () => {
        expect(() => parseArgs(["--output"], spec)).toThrow(ArgError);
    });

    test("--no-<stringflag> is an error (only valid on booleans)", () => {
        expect(() => parseArgs(["--no-output"], spec)).toThrow(ArgError);
    });

    test("boolean flag with non-bool value is an error", () => {
        expect(() => parseArgs(["--verbose=maybe"], spec)).toThrow(ArgError);
    });

    test("S2120: duplicate string flag → ArgError", () => {
        // Pre-fix `--output=A --output=B` silently kept B and dropped A.
        // For acceptance flags like --accept-key this collapsed multi-key
        // consent into a single key without warning.
        expect(() => parseArgs(["--output=a", "--output=b"], spec)).toThrow(ArgError);
        expect(() => parseArgs(["--output=a", "--output", "b"], spec)).toThrow(ArgError);
        expect(() => parseArgs(["--output", "a", "--output=b"], spec)).toThrow(ArgError);
    });

    test("S2120: duplicate boolean flag is fine (idempotent / --no- override)", () => {
        // Booleans are documented as overridable: `--verbose --no-verbose`
        // is the deliberate "override defaults" pattern.
        const a = parseArgs(["--verbose", "--verbose"], spec);
        expect(a.flags.verbose).toBe(true);
        const b = parseArgs(["--verbose", "--no-verbose"], spec);
        expect(b.flags.verbose).toBe(false);
    });
});
