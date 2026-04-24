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
});
