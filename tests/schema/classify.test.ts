import { describe, test, expect } from "bun:test";
import {
    classifyKey, filterForYaml,
    exfilClass, changeClass, hygieneClass,
    isSecretPath, isSensitivePath, isSensitiveKeyName, sensitiveDomain,
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
