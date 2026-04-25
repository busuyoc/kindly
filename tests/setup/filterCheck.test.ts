// Q2 Option B filter-invariance check — pure-function tests (no archive,
// no signing). The two rules are: every string in the manifest is NFC,
// and no string contains a forbidden control byte. Anything that's
// already canonical YAML+NFC+sanitized passes; everything else throws.

import { describe, test, expect } from "bun:test";
import {
    assertManifestFilterInvariant, FilterInvariantError,
} from "../../src/setup/filterCheck.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function clean(): SetupManifest {
    const ssh = Buffer.from("-- SSH stub\n", "utf8");
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "Clean", created_at: "2026-04-25T00:00:00Z" },
        apply_mode: "additive",
        plugins: { files: [{ path: "SSH.koplugin/main.lua", hash: hashBytes(ssh), bytes: ssh.length }] },
        settings: { home_dir: "/mnt/onboard/books" },
    });
}

describe("filter-invariance — pass cases", () => {
    test("clean manifest passes", () => {
        expect(() => assertManifestFilterInvariant(clean())).not.toThrow();
    });
    test("ASCII-only manifest passes", () => {
        const m = parseManifest({
            kindly_setup: "v1",
            meta: { name: "ASCII", created_at: "2026-04-25T00:00:00Z" },
            apply_mode: "additive",
            settings: { refresh_rate: 8, theme: "dark" },
        });
        expect(() => assertManifestFilterInvariant(m)).not.toThrow();
    });
    test("multiline string with LF + TAB passes (allowed bytes)", () => {
        const m = clean();
        m.meta.description = "line1\n\tline2 indented";
        expect(() => assertManifestFilterInvariant(m)).not.toThrow();
    });
});

describe("filter-invariance — reject cases", () => {
    function expectViolation(m: SetupManifest, kind: "non-nfc" | "control-byte", pathSubstr?: string) {
        try {
            assertManifestFilterInvariant(m);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(FilterInvariantError);
            const v = (e as FilterInvariantError).violations;
            expect(v.some((x) => x.kind === kind && (!pathSubstr || x.path.includes(pathSubstr)))).toBe(true);
        }
    }

    test("non-NFC string in meta.name → reject", () => {
        const m = clean();
        m.meta.name = "Café";   // NFD form of "Café"
        expectViolation(m, "non-nfc", "meta.name");
    });

    test("non-NFC key in settings → reject", () => {
        const m = clean();
        // Build settings with NFD-form key directly (parseManifest would
        // accept it — kindly's filter is what enforces NFC).
        const settings = m.settings as Record<string, unknown>;
        settings["café_path"] = "/tmp/x";
        expectViolation(m, "non-nfc", "cafe");
    });

    test("ESC in a string value → reject", () => {
        const m = clean();
        (m.settings as Record<string, unknown>)["home_dir"] = "/tmp\x1bfoo";
        expectViolation(m, "control-byte", "home_dir");
    });

    test("CR in a string value → reject (CRLF smuggle defense)", () => {
        const m = clean();
        (m.settings as Record<string, unknown>)["home_dir"] = "value\rsmuggled";
        expectViolation(m, "control-byte", "home_dir");
    });

    test("NUL in a nested object → reject with deep path", () => {
        const m = clean();
        (m.settings as Record<string, unknown>)["kosync"] = { username: "u\x00ser" };
        expectViolation(m, "control-byte", "kosync.username");
    });

    test("control byte inside an array element → reject with [i] path", () => {
        const m = clean();
        (m.settings as Record<string, unknown>)["extra_plugin_paths"] = ["/ok", "/evil\x07"];
        expectViolation(m, "control-byte", "extra_plugin_paths[1]");
    });

    test("error message is bounded — many violations don't dump the manifest", () => {
        const m = clean();
        const settings = m.settings as Record<string, unknown>;
        for (let i = 0; i < 50; i++) settings[`key_${i}`] = "x\x1by";
        try {
            assertManifestFilterInvariant(m);
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(FilterInvariantError);
            // Message lists the first 3 then summarises the rest — never
            // echoes raw bytes (only hex).
            const msg = (e as FilterInvariantError).message;
            expect(msg).toContain("...and 47 more");
            expect(msg).not.toContain("\x1b");
            expect(msg).toContain("0x1B");
        }
    });
});
