import { describe, test, expect } from "bun:test";
import { classifyKey, filterForYaml } from "../../src/schema/classify.ts";

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
