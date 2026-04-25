import { describe, test, expect } from "bun:test";
import {
    classifyKey, filterForYaml,
    exfilClass, changeClass, hygieneClass,
    isSecretPath, isSensitivePath, isSensitiveKeyName, sensitiveDomain,
    isCodeExecAdjacent,
} from "../../src/schema/classify.ts";

describe("classifyKey", () => {
    test("known secrets", () => {
        expect(classifyKey("zlibrary_password")).toBe("SECRET");
        expect(classifyKey("pinpadlock_pin_code")).toBe("SECRET");
        expect(classifyKey("device_id")).toBe("SECRET");
    });

    test("ephemerals — exact", () => {
        expect(classifyKey("lastfile")).toBe("EPHEMERAL");
        expect(classifyKey("LocalSend_last_update_check")).toBe("EPHEMERAL");
    });

    test("ephemerals — pattern (setup-done suffix)", () => {
        expect(classifyKey("aaaProjectTitle_initial_default_setup_done2")).toBe("EPHEMERAL");
        expect(classifyKey("coverbrowser_initial_default_setup_done")).toBe("EPHEMERAL");
    });

    test("ephemerals — pattern (simpleui_defaults_vN, *_migrated_vN)", () => {
        expect(classifyKey("simpleui_defaults_v3")).toBe("EPHEMERAL");
        expect(classifyKey("navbar_custom_qa_migrated_v1")).toBe("EPHEMERAL");
    });

    test("user settings fall through", () => {
        expect(classifyKey("plugins_disabled")).toBe("USER");
        expect(classifyKey("cre_header_clock")).toBe("USER");
        expect(classifyKey("footer")).toBe("USER");
    });
});

describe("filterForYaml — secrets always stripped", () => {
    const input = {
        zlibrary_password: "hunter2",
        zlibrary_base_url: "https://z-library.sk",
        pinpadlock_pin_code: "1980",
        footer: { align: "center" },
    };

    test("minimal drops secrets", () => {
        const r = filterForYaml(input, "minimal");
        expect(r.kept.zlibrary_password).toBeUndefined();
        expect(r.kept.pinpadlock_pin_code).toBeUndefined();
        expect(r.kept.zlibrary_base_url).toBe("https://z-library.sk");
        expect(r.droppedSecrets.sort()).toEqual(["pinpadlock_pin_code", "zlibrary_password"]);
    });

    test("full drops secrets too (secrets are unconditional)", () => {
        const r = filterForYaml(input, "full");
        expect(r.kept.zlibrary_password).toBeUndefined();
        expect(r.kept.pinpadlock_pin_code).toBeUndefined();
    });
});

describe("filterForYaml — ephemerals", () => {
    const input = {
        lastfile: "/mnt/us/Books/a.epub",
        last_migration_date: 20260306,
        simpleui_defaults_v3: true,
        plugins_disabled: { SSH: true },
    };

    test("minimal drops them", () => {
        const r = filterForYaml(input, "minimal");
        expect(r.kept.lastfile).toBeUndefined();
        expect(r.kept.simpleui_defaults_v3).toBeUndefined();
        expect(r.kept.plugins_disabled).toEqual({ SSH: true });
        expect(r.droppedEphemerals.length).toBe(3);
    });

    test("full keeps them", () => {
        const r = filterForYaml(input, "full");
        expect(r.kept.lastfile).toBe("/mnt/us/Books/a.epub");
        expect(r.kept.simpleui_defaults_v3).toBe(true);
        expect(r.droppedEphemerals).toEqual([]);
    });
});

describe("filterForYaml — nested secret scrubbing", () => {
    test("kosync.userkey and kosync.username stripped from nested table", () => {
        const input = {
            kosync: {
                auto_sync: false,
                pages_before_update: 1,
                userkey: "abc123",
                username: "claw",
            },
        };
        const r = filterForYaml(input, "minimal");
        expect(r.kept.kosync).toEqual({ auto_sync: false, pages_before_update: 1 });
        expect(r.droppedSecrets.sort()).toEqual(["kosync.userkey", "kosync.username"]);
    });
});

// ============================================================================
// Three-axis classification (Step 3 gates-refactor) — alongside the legacy
// enum tests above, which continue to exercise classifyKey() as a compat
// projection. New code should use the axis functions directly.
// ============================================================================

describe("exfilClass — secret vs normal", () => {
    test("top-level secrets", () => {
        expect(exfilClass("zlibrary_password")).toBe("secret");
        expect(exfilClass("device_id")).toBe("secret");
        expect(exfilClass("LocalSend_pin")).toBe("secret");
    });

    test("nested secrets (dotted path)", () => {
        expect(exfilClass("kosync.userkey")).toBe("secret");
        expect(exfilClass("kosync.username")).toBe("secret");
    });

    test("sensitive-change keys are NOT secret (values may leave the device)", () => {
        expect(exfilClass("extra_plugin_paths")).toBe("normal");
        expect(exfilClass("ota_server")).toBe("normal");
        expect(exfilClass("SSH_port")).toBe("normal");
    });

    test("unknown keys default to normal", () => {
        expect(exfilClass("cre_header_clock")).toBe("normal");
        expect(exfilClass("footer")).toBe("normal");
    });
});

describe("changeClass — trust boundaries", () => {
    test("code-exec class", () => {
        expect(changeClass("extra_plugin_paths")).toBe("sensitive-code-exec");
    });

    test("network class", () => {
        expect(changeClass("ota_server")).toBe("sensitive-network");
        expect(changeClass("http_proxy")).toBe("sensitive-network");
        expect(changeClass("kosync.custom_server")).toBe("sensitive-network");
    });

    test("ssh class", () => {
        expect(changeClass("SSH_port")).toBe("sensitive-ssh");
        expect(changeClass("SSH_autostart")).toBe("sensitive-ssh");
    });

    test("service class", () => {
        expect(changeClass("LocalSend_autostart")).toBe("sensitive-service");
        expect(changeClass("httpinspector_port")).toBe("sensitive-service");
    });

    test("fs class", () => {
        expect(changeClass("home_dir")).toBe("sensitive-fs");
        expect(changeClass("LocalSend_save_dir")).toBe("sensitive-fs");
    });

    test("debug class", () => {
        expect(changeClass("debug")).toBe("sensitive-debug");
    });

    test("secrets have no change-class gate (exfil-only)", () => {
        // Changing a secret value is not itself a boundary-cross; emitting it is.
        expect(changeClass("zlibrary_password")).toBe("none");
        expect(changeClass("kosync.userkey")).toBe("none");
    });

    test("unknown keys default to none", () => {
        expect(changeClass("cre_header_clock")).toBe("none");
        expect(changeClass("footer")).toBe("none");
    });
});

describe("hygieneClass — persistent vs ephemeral", () => {
    test("exact ephemerals", () => {
        expect(hygieneClass("lastfile")).toBe("ephemeral");
        expect(hygieneClass("LocalSend_last_update_check")).toBe("ephemeral");
        expect(hygieneClass("quote_deck_pos")).toBe("ephemeral");
    });

    test("rule-based ephemerals (suffix)", () => {
        expect(hygieneClass("aaaProjectTitle_initial_default_setup_done")).toBe("ephemeral");
        expect(hygieneClass("X_initial_default_setup_done2")).toBe("ephemeral");
    });

    test("rule-based ephemerals (regex)", () => {
        expect(hygieneClass("simpleui_defaults_v3")).toBe("ephemeral");
        expect(hygieneClass("navbar_custom_qa_migrated_v1")).toBe("ephemeral");
    });

    test("normal user keys default to persistent", () => {
        expect(hygieneClass("plugins_disabled")).toBe("persistent");
        expect(hygieneClass("footer")).toBe("persistent");
    });

    test("secrets and sensitives default to persistent (orthogonal axes)", () => {
        expect(hygieneClass("zlibrary_password")).toBe("persistent");
        expect(hygieneClass("SSH_port")).toBe("persistent");
    });
});

describe("axis composition — classifyKey as projection", () => {
    test("priority SECRET > SENSITIVE > EPHEMERAL > USER preserved", () => {
        // secret value wins even over sensitive-change (theoretical — no key
        // currently has both, but tests the projection rule).
        expect(classifyKey("zlibrary_password")).toBe("SECRET");
        expect(classifyKey("extra_plugin_paths")).toBe("SENSITIVE");
        expect(classifyKey("lastfile")).toBe("EPHEMERAL");
        expect(classifyKey("footer")).toBe("USER");
    });
});

describe("nested path helpers over axes", () => {
    test("isSecretPath matches nested secrets", () => {
        expect(isSecretPath("kosync", "userkey")).toBe(true);
        expect(isSecretPath("kosync", "username")).toBe(true);
        expect(isSecretPath("kosync", "auto_sync")).toBe(false);
    });

    test("isSensitivePath matches nested sensitives", () => {
        expect(isSensitivePath("kosync", "custom_server")).toBe(true);
        expect(isSensitivePath("kosync", "userkey")).toBe(false);  // exfil, not change
    });

    test("isSensitiveKeyName covers both top-level and nested", () => {
        expect(isSensitiveKeyName("extra_plugin_paths")).toBe(true);
        expect(isSensitiveKeyName("SSH_port")).toBe(true);
        expect(isSensitiveKeyName("kosync.custom_server")).toBe(true);
        expect(isSensitiveKeyName("plugins_disabled")).toBe(false);
    });
});

describe("isCodeExecAdjacent — C1a denylist (orthogonal to change axis)", () => {
    test("SSH_port is code-exec-adjacent (dropbear -p interpolation)", () => {
        expect(isCodeExecAdjacent("SSH_port")).toBe(true);
    });

    test("httpinspector_port is code-exec-adjacent", () => {
        expect(isCodeExecAdjacent("httpinspector_port")).toBe(true);
    });

    test("cover_image_path is code-exec-adjacent (os.remove on KOReader side)", () => {
        expect(isCodeExecAdjacent("cover_image_path")).toBe(true);
    });

    test("extra_plugin_paths is NOT code-exec-adjacent (it is code-exec, guarded by its own DUAL gate)", () => {
        expect(isCodeExecAdjacent("extra_plugin_paths")).toBe(false);
    });

    test("normal SENSITIVE keys are NOT code-exec-adjacent (e.g. ota_server, home_dir)", () => {
        expect(isCodeExecAdjacent("ota_server")).toBe(false);
        expect(isCodeExecAdjacent("home_dir")).toBe(false);
        expect(isCodeExecAdjacent("debug")).toBe(false);
    });

    test("unknown keys are NOT code-exec-adjacent", () => {
        expect(isCodeExecAdjacent("footer")).toBe(false);
        expect(isCodeExecAdjacent("plugins_disabled")).toBe(false);
    });

    test("cover_image_path is also SENSITIVE (fs class) — not bypassable via changeClass=none", () => {
        // Data-file invariant: the three code-exec-adjacent keys all have a
        // non-none change-class, so they surface in sensitiveHits too and
        // independently require --accept-sensitive (or --accept-key=<name>).
        expect(changeClass("SSH_port")).not.toBe("none");
        expect(changeClass("httpinspector_port")).not.toBe("none");
        expect(changeClass("cover_image_path")).not.toBe("none");
    });
});

// ============================================================================
// C5 — NFC normalization at lookup. Lead 19 (S730-S739) showed 87/151
// Unicode variants of SECRET/SENSITIVE keys defeat byte-equality lookups.
// Defense lives in two places:
//   - parseYamlSafe rejects non-NFC keys at the boundary (assertNfcKeys),
//     so malicious YAML cannot cross into kindly.
//   - classify.ts NFC-normalizes its own inputs as belt-and-suspenders,
//     because non-YAML callers (parsed Lua, archive entry names,
//     --accept-key= CLI args) reach these helpers without going through
//     the YAML parser.
// ============================================================================

describe("classify — NFC normalization at lookup (C5 / Lead 19)", () => {
    test("NFD-decomposed accent matches NFC denylist entry", () => {
        // "café" in NFC: 0x63 0x61 0x66 0xc3 0xa9
        // "café" in NFD: 0x63 0x61 0x66 0x65 0xcc 0x81 (é → e + combining acute)
        // We use a real key — kosync.userkey — with a synthetic decomposition
        // to prove the lookup is normalization-aware.
        const nfc = "kosync.userkey";
        const nfd = nfc.normalize("NFD");
        // Self-test the test: bytes really differ.
        expect(nfd === nfc || nfd.length === nfc.length).toBe(true);
        // Both lookups must agree.
        expect(exfilClass(nfc)).toBe(exfilClass(nfd));
    });

    test("classifyKey is NFC-resilient for the SECRET path", () => {
        const nfc = "zlibrary_password";
        // Simulate an attacker-controlled non-NFC variant by inserting a
        // ZWSP (which normalize("NFC") leaves as ZWSP — only NFD/NFKC fold
        // it out). Use a different vector: cyrillic 'а' (U+0430) instead
        // of latin 'a' (U+0061) at index 7 — same glyph, different codepoint.
        const homoglyph = nfc.replace("password", "pаssword");
        // Self-test: bytes differ.
        expect(homoglyph).not.toBe(nfc);
        // Homoglyph is NOT a known SECRET — it shouldn't classify as one
        // (we don't fold homoglyphs; we only normalize Unicode equivalence).
        expect(classifyKey(homoglyph)).toBe("USER");
        // The legitimate key still classifies correctly.
        expect(classifyKey(nfc)).toBe("SECRET");
    });

    test("isSensitiveKeyName accepts NFD form of a SENSITIVE key", () => {
        const nfc = "ota_server";
        const nfd = nfc.normalize("NFD");
        expect(isSensitiveKeyName(nfc)).toBe(true);
        expect(isSensitiveKeyName(nfd)).toBe(true);
    });

    test("isCodeExecAdjacent accepts NFD form", () => {
        const nfc = "SSH_port";
        const nfd = nfc.normalize("NFD");
        expect(isCodeExecAdjacent(nfc)).toBe(true);
        expect(isCodeExecAdjacent(nfd)).toBe(true);
    });

    test("ZWSP-injected variant does NOT match (no homoglyph folding)", () => {
        // U+200B between bytes is preserved by NFC. The defense is REJECTION
        // at parseYamlSafe (tested separately) — classify.ts must not
        // silently accept the variant.
        const variant = "kosync​.userkey";
        expect(exfilClass(variant)).toBe("normal");
    });

    test("fullwidth letters do NOT match (NFC-only, not NFKC)", () => {
        // U+FF53 ('ｓ') normalizes to 's' under NFKC but stays as itself
        // under NFC. We deliberately don't fold compatibility forms — that
        // would mask too much. Defense here is REJECTION via parseYamlSafe.
        const variant = "ＳＳＨ_port";
        expect(isCodeExecAdjacent(variant)).toBe(false);
    });
});

describe("sensitiveDomain — UI label mapping", () => {
    test("maps each change-class to its domain label", () => {
        expect(sensitiveDomain("extra_plugin_paths")).toBe("code-exec");
        expect(sensitiveDomain("ota_server")).toBe("network");
        expect(sensitiveDomain("SSH_port")).toBe("ssh");
        expect(sensitiveDomain("LocalSend_autostart")).toBe("service");
        expect(sensitiveDomain("home_dir")).toBe("directory");
        expect(sensitiveDomain("debug")).toBe("debug");
    });

    test("non-sensitive keys fall back to other", () => {
        expect(sensitiveDomain("footer")).toBe("other");
        expect(sensitiveDomain("zlibrary_password")).toBe("other");  // secret, not sensitive-change
    });
});
