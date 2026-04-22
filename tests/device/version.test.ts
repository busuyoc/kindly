import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { kindleMountAt } from "../../src/device/kindle.ts";
import {
    parseKoreaderVersion, compareKoreaderVersion,
    readKoreaderVersion, detectDeviceFamily,
} from "../../src/device/version.ts";

describe("parseKoreaderVersion", () => {
    test("clean release tag v2026.03 → (2026, 3, 0)", () => {
        const v = parseKoreaderVersion("v2026.03");
        expect(v).toEqual({ year: 2026, month: 3, patch: 0, raw: "v2026.03" });
    });

    test("without leading v still parses", () => {
        const v = parseKoreaderVersion("2024.11");
        expect(v?.year).toBe(2024);
        expect(v?.month).toBe(11);
        expect(v?.patch).toBe(0);
    });

    test("explicit patch v2024.11.2 → patch=2", () => {
        expect(parseKoreaderVersion("v2024.11.2")?.patch).toBe(2);
    });

    test("git-describe suffix stripped: v2024.11-25-g1a2b3c4 → (2024, 11, 0)", () => {
        const v = parseKoreaderVersion("v2024.11-25-g1a2b3c4");
        expect(v).toEqual({ year: 2024, month: 11, patch: 0, raw: "v2024.11-25-g1a2b3c4" });
    });

    test("trims whitespace / newline (real file contents)", () => {
        expect(parseKoreaderVersion("v2026.03\n")?.month).toBe(3);
        expect(parseKoreaderVersion("  v2026.03  ")?.month).toBe(3);
    });

    test("returns null on empty / non-numeric / out-of-range", () => {
        expect(parseKoreaderVersion("")).toBeNull();
        expect(parseKoreaderVersion("not-a-version")).toBeNull();
        expect(parseKoreaderVersion("v2024.13")).toBeNull(); // month 13
        expect(parseKoreaderVersion("v2024.00")).toBeNull(); // month 0
        expect(parseKoreaderVersion("v2024")).toBeNull();    // no month
        expect(parseKoreaderVersion("v2024.11.2.3")).toBeNull(); // too many parts
    });
});

describe("compareKoreaderVersion", () => {
    const v = (s: string) => parseKoreaderVersion(s)!;

    test("same version → 0", () => {
        expect(compareKoreaderVersion(v("v2024.11"), v("v2024.11"))).toBe(0);
    });

    test("later year wins", () => {
        expect(compareKoreaderVersion(v("v2025.01"), v("v2024.12"))).toBe(1);
        expect(compareKoreaderVersion(v("v2024.12"), v("v2025.01"))).toBe(-1);
    });

    test("later month wins within the same year", () => {
        expect(compareKoreaderVersion(v("v2024.11"), v("v2024.09"))).toBe(1);
        // Guard against lexicographic bug: "2024.9" would be > "2024.10" as strings.
        expect(compareKoreaderVersion(v("v2024.9"), v("v2024.10"))).toBe(-1);
    });

    test("patch breaks ties", () => {
        expect(compareKoreaderVersion(v("v2024.11.1"), v("v2024.11"))).toBe(1);
        expect(compareKoreaderVersion(v("v2024.11"), v("v2024.11.0"))).toBe(0);
    });
});

describe("readKoreaderVersion", () => {
    test("reads and parses git-rev from the mount", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-ver-"));
        mkdirSync(join(root, "koreader"));
        writeFileSync(join(root, "koreader", "git-rev"), "v2026.03\n");
        expect(readKoreaderVersion(kindleMountAt(root))?.year).toBe(2026);
    });

    test("null when file missing", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-ver-"));
        mkdirSync(join(root, "koreader"));
        expect(readKoreaderVersion(kindleMountAt(root))).toBeNull();
    });

    test("null when file unparseable", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-ver-"));
        mkdirSync(join(root, "koreader"));
        writeFileSync(join(root, "koreader", "git-rev"), "garbage\n");
        expect(readKoreaderVersion(kindleMountAt(root))).toBeNull();
    });
});

describe("detectDeviceFamily", () => {
    test("kindle when system/version.txt starts with 'Kindle'", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-dev-"));
        mkdirSync(join(root, "system"));
        writeFileSync(join(root, "system", "version.txt"), "Kindle 5.18.5.0.1 (455681 001)\n");
        expect(detectDeviceFamily(kindleMountAt(root))).toBe("kindle");
    });

    test("unknown when file missing", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-dev-"));
        expect(detectDeviceFamily(kindleMountAt(root))).toBe("unknown");
    });

    test("unknown when file content doesn't start with Kindle", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-dev-"));
        mkdirSync(join(root, "system"));
        writeFileSync(join(root, "system", "version.txt"), "Kobo 4.32.0\n");
        expect(detectDeviceFamily(kindleMountAt(root))).toBe("unknown");
    });
});
