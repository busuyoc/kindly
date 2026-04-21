import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    candidateMounts, isKindleMount, kindleMountAt,
} from "../../src/device/kindle.ts";

describe("candidateMounts", () => {
    test("darwin → /Volumes/Kindle", () => {
        expect(candidateMounts("darwin")).toEqual(["/Volumes/Kindle"]);
    });
    test("linux → /mnt/us", () => {
        expect(candidateMounts("linux")).toEqual(["/mnt/us"]);
    });
    test("unsupported platform → empty", () => {
        expect(candidateMounts("win32")).toEqual([]);
    });
});

describe("isKindleMount", () => {
    test("returns true when koreader/ directory exists", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-m-"));
        mkdirSync(join(root, "koreader"));
        expect(isKindleMount(root)).toBe(true);
    });

    test("returns false when koreader/ is missing", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-m-"));
        expect(isKindleMount(root)).toBe(false);
    });

    test("returns false when koreader is a regular file, not a dir", () => {
        const root = mkdtempSync(join(tmpdir(), "kindly-m-"));
        writeFileSync(join(root, "koreader"), "decoy");
        expect(isKindleMount(root)).toBe(false);
    });

    test("returns false for non-existent path", () => {
        expect(isKindleMount("/this/path/does/not/exist")).toBe(false);
    });
});

describe("kindleMountAt", () => {
    test("derives canonical paths from a mount root", () => {
        const m = kindleMountAt("/tmp/fakeKindle");
        expect(m.root).toBe("/tmp/fakeKindle");
        expect(m.koreaderRoot).toBe("/tmp/fakeKindle/koreader");
        expect(m.settingsPath).toBe("/tmp/fakeKindle/koreader/settings.reader.lua");
        expect(m.pluginsDir).toBe("/tmp/fakeKindle/koreader/plugins");
    });
});
