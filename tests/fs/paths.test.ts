import { describe, test, expect } from "bun:test";
import { isSafeRelativePath } from "../../src/fs/paths.ts";

describe("isSafeRelativePath", () => {
    test("accepts normal POSIX relative paths", () => {
        expect(isSafeRelativePath("a")).toBe(true);
        expect(isSafeRelativePath("a/b")).toBe(true);
        expect(isSafeRelativePath("SSH.koplugin/main.lua")).toBe(true);
        expect(isSafeRelativePath("patches/001-fix.lua")).toBe(true);
    });

    test("rejects empty path", () => {
        expect(isSafeRelativePath("")).toBe(false);
    });

    test("rejects null byte", () => {
        expect(isSafeRelativePath("a\0b")).toBe(false);
    });

    test("rejects POSIX absolute paths", () => {
        expect(isSafeRelativePath("/etc/passwd")).toBe(false);
        expect(isSafeRelativePath("/")).toBe(false);
    });

    test("rejects Windows drive letters and backslashes", () => {
        expect(isSafeRelativePath("C:/x")).toBe(false);
        expect(isSafeRelativePath("c:/x")).toBe(false);
        expect(isSafeRelativePath("a\\b")).toBe(false);
    });

    test("rejects `..` traversal at any position", () => {
        expect(isSafeRelativePath("..")).toBe(false);
        expect(isSafeRelativePath("../a")).toBe(false);
        expect(isSafeRelativePath("a/../b")).toBe(false);
        expect(isSafeRelativePath("a/..")).toBe(false);
    });

    // S690: a `.` segment under installPluginFiles() collapses join(root, ".")
    // to `root` itself and the subsequent rmSync wipes the entire dir. The
    // attacker then writes their payload at root/<file>. One-flag RCE via
    // --accept-plugins. Reject `.` segments at the validator.
    test("rejects `.` current-dir segment (S690)", () => {
        expect(isSafeRelativePath(".")).toBe(false);
        expect(isSafeRelativePath("./a")).toBe(false);
        expect(isSafeRelativePath("a/./b")).toBe(false);
        expect(isSafeRelativePath("a/.")).toBe(false);
    });

    // Empty segments (from `a//b`, leading `/`, trailing `/`) should also
    // fail — callers pass file paths, not directory-suffixed ones; archive
    // entry directory markers are filtered upstream before validation.
    test("rejects empty segments from `//` / leading / trailing slashes", () => {
        expect(isSafeRelativePath("a//b")).toBe(false);
        expect(isSafeRelativePath("a/")).toBe(false);
    });

    // S965 (Angle X): zero-width controls glued onto `.` / `..` would slip
    // past strict-equality if we compared raw bytes; NFC-normalized + ZW
    // strip catches them. ZW-only segments are equivalent to empty and
    // also rejected.
    test("rejects `..` and `.` masked by zero-width characters (S965)", () => {
        // ZWSP-suffixed dotdot → strips to `..` → reject.
        expect(isSafeRelativePath("..​")).toBe(false);
        expect(isSafeRelativePath("​..")).toBe(false);
        // ZWNJ between dots and rest of path component.
        expect(isSafeRelativePath("a/..‌/b")).toBe(false);
        // BOM-prefixed `.` segment.
        expect(isSafeRelativePath("﻿.")).toBe(false);
        // WJ-suffixed `.` segment.
        expect(isSafeRelativePath(".⁠")).toBe(false);
        // ZWJ-only segment → strips to empty → reject.
        expect(isSafeRelativePath("a/‍/b")).toBe(false);
    });

    test("rejects ZW-decorated segments outright (round 3 filter-parity)", () => {
        // Round 3 hardening: any Cf/Cc codepoint anywhere in a segment
        // is rejected, not just the ones that collapse to `.`/`..`.
        // Symmetric with v0.13.0 filterCheck and yamlSafe (Lead 19).
        // ZWSP after a real name was previously accepted; now refused
        // because plugin paths like `SSH<ZWSP>.koplugin` are typo-
        // squatting / RLO-flip primitives even when they don't escape
        // the extraction root.
        expect(isSafeRelativePath("valid​")).toBe(false);
        expect(isSafeRelativePath("a/SSH​.koplugin/main.lua")).toBe(false);
    });

    test("still accepts non-Cf/Cc Unicode (combining marks)", () => {
        // Combining accent on dotdot is a literal 3-character filename, not
        // path-equivalent to parent reference. Mn (Mark, Nonspacing) is NOT
        // in the round-3 reject set — only Cf+Cc are.
        expect(isSafeRelativePath("..́")).toBe(true);
    });

    // S2201: cap path and per-segment lengths so pathological manifest
    // entries can't reach writeFileSync and crash mid-install with
    // ENAMETOOLONG. Cap is JS string length (UTF-16 code units), matching
    // FAT32's 255-LFN-component and a comfortable 1024 total.
    test("rejects pathologically long paths (S2201)", () => {
        // 256-char single segment: one over FAT32 LFN cap.
        expect(isSafeRelativePath("a".repeat(256))).toBe(false);
        // 255-char segment is allowed (boundary).
        expect(isSafeRelativePath("a".repeat(255))).toBe(true);
        // 1025-char total path (multiple segments, all individually fine).
        const longPath = Array.from({ length: 9 }, () => "a".repeat(113)).join("/") + "/x";
        expect(longPath.length).toBeGreaterThan(1024);
        expect(isSafeRelativePath(longPath)).toBe(false);
    });
});
