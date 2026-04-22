import { describe, test, expect } from "bun:test";

import { checkCompat, formatCompatIssue, type Detected } from "../../src/setup/compat.ts";
import { parseKoreaderVersion } from "../../src/device/version.ts";

const detected = (version: string | null, family: "kindle" | "unknown" = "kindle"): Detected => ({
    version: version !== null ? parseKoreaderVersion(version) : null,
    family,
});

describe("checkCompat — no compat block", () => {
    test("undefined compat → no issues, verified", () => {
        const r = checkCompat(undefined, detected("v2026.03"));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toEqual([]);
    });

    test("empty compat → no issues", () => {
        const r = checkCompat({}, detected("v2026.03"));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toEqual([]);
    });
});

describe("checkCompat — koreader version gate", () => {
    test("detected == min → ok", () => {
        const r = checkCompat({ koreader_version_min: "2026.03" }, detected("v2026.03"));
        expect(r.blocking).toEqual([]);
    });

    test("detected > min → ok", () => {
        const r = checkCompat({ koreader_version_min: "2024.11" }, detected("v2026.03"));
        expect(r.blocking).toEqual([]);
    });

    test("detected < min → blocks with too_old", () => {
        const r = checkCompat({ koreader_version_min: "2026.06" }, detected("v2026.03"));
        expect(r.blocking).toHaveLength(1);
        expect(r.blocking[0]!.kind).toBe("koreader_too_old");
    });

    test("detected > max → blocks with too_new", () => {
        const r = checkCompat({ koreader_version_max: "2024.11" }, detected("v2026.03"));
        expect(r.blocking).toHaveLength(1);
        expect(r.blocking[0]!.kind).toBe("koreader_too_new");
    });

    test("both bounds, detected in window → ok", () => {
        const r = checkCompat(
            { koreader_version_min: "2024.01", koreader_version_max: "2027.12" },
            detected("v2026.03"),
        );
        expect(r.blocking).toEqual([]);
    });

    test("version detection failed but manifest requires version → unverifiable, not blocking", () => {
        const r = checkCompat({ koreader_version_min: "2024.03" }, detected(null));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toHaveLength(1);
        expect(r.unverifiable[0]!.kind).toBe("koreader_unknown");
    });

    test("unparseable min in manifest → unverifiable, not blocking", () => {
        const r = checkCompat({ koreader_version_min: "not-a-version" }, detected("v2026.03"));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toHaveLength(1);
        expect(r.unverifiable[0]!.kind).toBe("version_unparseable");
    });

    test("lexicographic trap guarded: v2024.9 < v2024.10", () => {
        const r = checkCompat({ koreader_version_min: "2024.10" }, detected("v2024.9"));
        expect(r.blocking).toHaveLength(1);
        expect(r.blocking[0]!.kind).toBe("koreader_too_old");
    });
});

describe("checkCompat — device family gate", () => {
    test("exact family match → ok", () => {
        const r = checkCompat({ device: ["kindle"] }, detected("v2026.03", "kindle"));
        expect(r.blocking).toEqual([]);
    });

    test("prefix match 'kindle-pw5' against detected 'kindle' → ok", () => {
        const r = checkCompat({ device: ["kindle-pw5"] }, detected("v2026.03", "kindle"));
        expect(r.blocking).toEqual([]);
    });

    test("mix of families in list, one matches → ok", () => {
        const r = checkCompat({ device: ["kobo-libra", "kindle"] }, detected("v2026.03", "kindle"));
        expect(r.blocking).toEqual([]);
    });

    test("no match → blocks", () => {
        const r = checkCompat({ device: ["kobo-libra", "kobo-clara"] }, detected("v2026.03", "kindle"));
        expect(r.blocking).toHaveLength(1);
        expect(r.blocking[0]!.kind).toBe("device_mismatch");
    });

    test("detection failed → unverifiable, not blocking", () => {
        const r = checkCompat({ device: ["kindle"] }, detected("v2026.03", "unknown"));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toHaveLength(1);
        expect(r.unverifiable[0]!.kind).toBe("device_unknown");
    });

    test("empty device list → no check", () => {
        const r = checkCompat({ device: [] }, detected("v2026.03", "kindle"));
        expect(r.blocking).toEqual([]);
        expect(r.unverifiable).toEqual([]);
    });
});

describe("checkCompat — combined", () => {
    test("both version + device mismatches → two blocks", () => {
        const r = checkCompat(
            { koreader_version_min: "2099.01", device: ["kobo-libra"] },
            detected("v2026.03", "kindle"),
        );
        expect(r.blocking).toHaveLength(2);
    });
});

describe("formatCompatIssue", () => {
    test("too_old / too_new mention both required and detected", () => {
        expect(formatCompatIssue({ kind: "koreader_too_old", required: "2026.06", detected: "v2026.03" }))
            .toContain("2026.06");
        expect(formatCompatIssue({ kind: "koreader_too_new", required: "2024.11", detected: "v2026.03" }))
            .toContain("2024.11");
    });

    test("device_mismatch lists allowed set and detected family", () => {
        const s = formatCompatIssue({ kind: "device_mismatch", required: ["kobo-libra", "kobo-clara"], detected: "kindle" });
        expect(s).toContain("kobo-libra");
        expect(s).toContain("kindle");
    });
});
