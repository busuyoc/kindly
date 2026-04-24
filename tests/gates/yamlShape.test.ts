import { describe, test, expect } from "bun:test";
import { normalizedYaml } from "../../src/gates/producers/normalizedYaml.ts";
import { YAML_SHAPE_NORMAL } from "../../src/gates/definitions/shape.ts";
import type { GateContext } from "../../src/gates/types.ts";

// ============================================================================
// S89 regression tests. Every variant in
// ~/.claude/memory/project_kindly_s89_yaml_null_wipes_secrets.md must
// now be detected by the normalizedYaml producer and blocked by the
// YAML_SHAPE_NORMAL gate.
//
// Baseline: on-device kosync = { auto_sync, userkey (SECRET),
// username (SECRET) } + zlibrary_password (SECRET). Attacker-supplied
// YAML that would wipe these on merge is the threat.
// ============================================================================

function ctx(
    yamlSettings: Record<string, unknown>,
    boundary: "import" | "apply" = "apply",
): GateContext {
    return {
        boundary,
        dryRun: false,
        strictImports: false,
        opts: { yamlSettings },
        producers: {},
    };
}

function runGate(
    yamlSettings: Record<string, unknown>,
    boundary: "import" | "apply" = "apply",
) {
    const c = ctx(yamlSettings, boundary);
    c.producers.normalizedYaml = normalizedYaml(c);
    return YAML_SHAPE_NORMAL.check(c);
}

describe("S89 variants — non-object at parent-of-secret path", () => {
    test("V1: kosync: null → blocked", () => {
        const r = runGate({ kosync: null });
        expect(r.kind).toBe("block");
        if (r.kind === "block") expect(r.message).toContain("kosync");
    });

    test("V2: kosync: <undefined-from-yaml-tilde>  (same as null in JS) → blocked", () => {
        // YAML `kosync: ~` and `kosync: null` both land as JS null; covered by V1.
        const r = runGate({ kosync: null });
        expect(r.kind).toBe("block");
    });

    test("V3: kosync: (empty value, YAML parses as null) → blocked", () => {
        // Same JS representation as V1 (null) — covered, kept for doc-fidelity.
        const r = runGate({ kosync: null });
        expect(r.kind).toBe("block");
    });

    test("V4: kosync: 'null' (string) → blocked as non-object", () => {
        const r = runGate({ kosync: "null" });
        expect(r.kind).toBe("block");
    });

    test("V5: kosync: [] (array) → blocked as non-object", () => {
        const r = runGate({ kosync: [] });
        expect(r.kind).toBe("block");
    });
});

describe("S89 variants — explicit null at nested secret", () => {
    test("V6: kosync.userkey: ~ (null in nested object) → blocked", () => {
        const r = runGate({ kosync: { userkey: null, auto_sync: true } });
        expect(r.kind).toBe("block");
        if (r.kind === "block") expect(r.message).toContain("kosync.userkey");
    });

    test("V6b: kosync.username: ~ also blocked", () => {
        const r = runGate({ kosync: { username: null } });
        expect(r.kind).toBe("block");
        if (r.kind === "block") expect(r.message).toContain("kosync.username");
    });
});

describe("S89 variants — top-level SECRET key in YAML (apply boundary)", () => {
    // On apply, nothing upstream strips SECRETs — this gate is the S89-V7 fix.
    // On import, filterForYaml + refusedSecrets handle these (silent strip);
    // those existing tests in tests/cli/setupImport.test.ts still pass.
    test("V7: zlibrary_password: ~ → blocked as secret-key-in-yaml", () => {
        const r = runGate({ zlibrary_password: null }, "apply");
        expect(r.kind).toBe("block");
        if (r.kind === "block") expect(r.message).toContain("zlibrary_password");
    });

    test("V7b: zlibrary_password with non-null value also blocked", () => {
        const r = runGate({ zlibrary_password: "anything-the-attacker-wants" }, "apply");
        expect(r.kind).toBe("block");
    });

    test("V7c: other SECRET top-level keys also blocked", () => {
        expect(runGate({ device_id: "x" }, "apply").kind).toBe("block");
        expect(runGate({ LocalSend_pin: "0000" }, "apply").kind).toBe("block");
        expect(runGate({ pinpadlock_pin_code: "1234" }, "apply").kind).toBe("block");
    });

    test("V7 on IMPORT boundary passes (filterForYaml handles it)", () => {
        const r = runGate({ zlibrary_password: "x" }, "import");
        expect(r.kind).toBe("pass");
    });
});

describe("S89 — safe variants pass through", () => {
    test("kosync: {} (empty object, no secret children wiped) passes", () => {
        const r = runGate({ kosync: {} });
        expect(r.kind).toBe("pass");
    });

    test("kosync: { auto_sync: true } (non-secret siblings only) passes", () => {
        const r = runGate({ kosync: { auto_sync: true, pages_before_update: 1 } });
        expect(r.kind).toBe("pass");
    });

    test("non-secret top-level key passes", () => {
        const r = runGate({ footer: { align: "center" } });
        expect(r.kind).toBe("pass");
    });

    test("empty yaml passes", () => {
        const r = runGate({});
        expect(r.kind).toBe("pass");
    });
});

describe("normalizedYaml producer — error shape", () => {
    test("each error carries kind + path + detail (apply boundary)", () => {
        const c = ctx({ kosync: null, zlibrary_password: null }, "apply");
        const result = normalizedYaml(c);
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
        for (const e of result.errors) {
            expect(typeof e.kind).toBe("string");
            expect(typeof e.path).toBe("string");
            expect(typeof e.detail).toBe("string");
        }
        const kinds = new Set(result.errors.map(e => e.kind));
        expect(kinds.has("non-object-at-secret-parent")).toBe(true);
        expect(kinds.has("secret-key-in-yaml")).toBe(true);
    });

    test("on import boundary, secret-key-in-yaml is silently skipped", () => {
        const c = ctx({ zlibrary_password: "x" }, "import");
        const result = normalizedYaml(c);
        expect(result.errors).toEqual([]);  // filtered downstream by filterForYaml
    });

    test("data is passed through unchanged", () => {
        const yamlSettings = { footer: { align: "center" } };
        const c = ctx(yamlSettings);
        const result = normalizedYaml(c);
        expect(result.data).toBe(yamlSettings);  // same reference
        expect(result.errors).toEqual([]);
    });
});
