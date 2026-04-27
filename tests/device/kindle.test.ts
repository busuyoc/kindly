import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

// R3 (review hardening): subprocess-bounded stat probe. Hard to simulate a
// truly hung filesystem in tests, but the contract is: isKindleMount must
// return within a few seconds even when the kernel is slow. We assert the
// happy paths still work (R3 must not regress detection on real Kindles)
// and lightly probe the timeout machinery's wiring via spawnSync timing.
const skipIfWindows = process.platform === "win32" ? describe.skip : describe;

skipIfWindows("R3: bounded mount detection", () => {
    test("happy path still detects a mock koreader/ dir", () => {
        // Confirms the subprocess+statFollow chain works end-to-end.
        const root = mkdtempSync(join(tmpdir(), "kindly-r3-"));
        mkdirSync(join(root, "koreader"));
        expect(isKindleMount(root)).toBe(true);
    });

    test("returns false on non-existent path within seconds (no hang)", () => {
        // Asserts the bound — even the negative case completes in well
        // under the 3s cap. Establishes the timeout infrastructure
        // doesn't block the happy path.
        const start = Date.now();
        expect(isKindleMount("/this/path/does/not/exist/at/all")).toBe(false);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2000);
    });

    test("subprocess timeout machinery is functional", () => {
        // Verify that spawnSync's timeout option actually fires SIGTERM.
        // This is the kernel mechanism R3 relies on. If this stops
        // working in some future Bun/Node version, isKindleMount loses
        // its hang-protection guarantee.
        const r = spawnSync("sleep", ["10"], { timeout: 100 });
        expect(r.signal).toBeTruthy();
    });
});
