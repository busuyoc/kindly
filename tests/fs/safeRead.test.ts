import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdtempSync,
    writeFileSync,
    symlinkSync,
    mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    readText,
    readBytes,
    exists,
    statFollow,
    statNoFollow,
    copyFile,
    SafeReadError,
} from "../../src/fs/safeRead.ts";

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-sr-"));
});

describe("safeRead — user-provided symlinks are followed", () => {
    test("readText follows symlink and returns target content", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "hello");
        symlinkSync(target, link);
        expect(readText(link, "user-provided")).toBe("hello");
    });
});

describe("safeRead — derived-from-mount symlinks are REJECTED (mount content is untrusted)", () => {
    // Mount is attacker-plantable (USB-writable, historically pwned via
    // KOReader RCE). A symlink at settings.reader.lua → ~/.ssh/id_rsa
    // would exfiltrate host secrets through LuaParseError or pull write.
    // Closes S211/S241/S242/S243 (Batch K).

    test("readText throws on mount-derived symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "id_rsa-bytes");
        symlinkSync(target, link);
        expect(() => readText(link, "derived-from-mount")).toThrow(SafeReadError);
    });

    test("readBytes throws on mount-derived symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "id_rsa-bytes");
        symlinkSync(target, link);
        expect(() => readBytes(link, "derived-from-mount")).toThrow(SafeReadError);
    });

    test("statFollow throws on mount-derived symlink (blocks metadata oracle)", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "x");
        symlinkSync(target, link);
        expect(() => statFollow(link, "derived-from-mount")).toThrow(SafeReadError);
    });

    test("statNoFollow throws on mount-derived symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "x");
        symlinkSync(target, link);
        expect(() => statNoFollow(link, "derived-from-mount")).toThrow(SafeReadError);
    });

    test("error carries provenance and code for consumer disambiguation", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "x");
        symlinkSync(target, link);
        try {
            readText(link, "derived-from-mount");
            throw new Error("should have thrown");
        } catch (e) {
            expect(e).toBeInstanceOf(SafeReadError);
            const sre = e as SafeReadError;
            expect(sre.code).toBe("UNTRUSTED_SYMLINK");
            expect(sre.provenance).toBe("derived-from-mount");
            expect(sre.message).toContain("mount-derived");
        }
    });

    test("regular files (non-symlinks) read normally", () => {
        const path = join(workdir, "settings.reader.lua");
        writeFileSync(path, "return { ok = true }");
        expect(readText(path, "derived-from-mount")).toBe("return { ok = true }");
    });
});

describe("safeRead — derived-from-cwd symlinks are followed", () => {
    test("readText follows symlink and returns target content", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "cwd-content");
        symlinkSync(target, link);
        expect(readText(link, "derived-from-cwd")).toBe("cwd-content");
    });
});

describe("safeRead — extracted-archive symlinks are rejected", () => {
    test("readText throws on symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "leaked");
        symlinkSync(target, link);
        expect(() => readText(link, "extracted-archive")).toThrow(SafeReadError);
    });

    test("readBytes throws on symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "leaked");
        symlinkSync(target, link);
        expect(() => readBytes(link, "extracted-archive")).toThrow(SafeReadError);
    });

    test("statNoFollow throws on symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "x");
        symlinkSync(target, link);
        expect(() => statNoFollow(link, "extracted-archive")).toThrow(SafeReadError);
    });

    test("statFollow throws on symlink", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "x");
        symlinkSync(target, link);
        expect(() => statFollow(link, "extracted-archive")).toThrow(SafeReadError);
    });

    test("statNoFollow on regular file returns stat without throwing", () => {
        const path = join(workdir, "real.txt");
        writeFileSync(path, "x");
        const st = statNoFollow(path, "extracted-archive");
        expect(st.isFile()).toBe(true);
    });

    test("readText on regular file returns content", () => {
        const path = join(workdir, "real.txt");
        writeFileSync(path, "content");
        expect(readText(path, "extracted-archive")).toBe("content");
    });
});

describe("safeRead — exists preserves existsSync semantics", () => {
    test("returns false for broken symlink (user-provided)", () => {
        const link = join(workdir, "dangling");
        symlinkSync(join(workdir, "does-not-exist"), link);
        // existsSync follows symlinks and returns false when the target
        // is missing. Preserve that behavior.
        expect(exists(link, "user-provided")).toBe(false);
    });

    test("returns true for existing file", () => {
        const path = join(workdir, "exists.txt");
        writeFileSync(path, "x");
        expect(exists(path, "user-provided")).toBe(true);
    });

    test("returns false for absent path", () => {
        expect(exists(join(workdir, "nope"), "derived-from-mount")).toBe(false);
    });
});

describe("safeRead — copyFile", () => {
    test("copies regular file from archive to cwd", () => {
        const src = join(workdir, "src.txt");
        const dst = join(workdir, "dst.txt");
        writeFileSync(src, "payload");
        copyFile(src, "extracted-archive", dst, "derived-from-cwd");
        expect(readText(dst, "derived-from-cwd")).toBe("payload");
    });

    test("rejects symlink source from extracted-archive", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        const dst = join(workdir, "dst.txt");
        writeFileSync(target, "leaked");
        symlinkSync(target, link);
        expect(() =>
            copyFile(link, "extracted-archive", dst, "derived-from-cwd"),
        ).toThrow(SafeReadError);
    });

    test("allows symlink source from user-provided", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        const dst = join(workdir, "dst.txt");
        writeFileSync(target, "ok");
        symlinkSync(target, link);
        copyFile(link, "user-provided", dst, "derived-from-cwd");
        expect(readText(dst, "derived-from-cwd")).toBe("ok");
    });
});

describe("safeRead — readBytes returns Buffer", () => {
    test("user-provided file", () => {
        const path = join(workdir, "bin.bin");
        writeFileSync(path, Buffer.from([0x00, 0x01, 0xff]));
        const buf = readBytes(path, "user-provided");
        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf.length).toBe(3);
        expect(buf[0]).toBe(0x00);
        expect(buf[2]).toBe(0xff);
    });
});

describe("safeRead — statFollow mirrors statSync", () => {
    test("returns regular file stats for user-provided path", () => {
        const path = join(workdir, "f.txt");
        writeFileSync(path, "abc");
        const st = statFollow(path, "user-provided");
        expect(st.isFile()).toBe(true);
        expect(st.size).toBe(3);
    });

    test("follows symlink when provenance allows (user-provided / derived-from-cwd)", () => {
        const target = join(workdir, "target.txt");
        const link = join(workdir, "link.txt");
        writeFileSync(target, "abc");
        symlinkSync(target, link);
        const st = statFollow(link, "derived-from-cwd");
        expect(st.isFile()).toBe(true);
        expect(st.size).toBe(3);
    });
});

describe("safeRead — directories", () => {
    test("statFollow recognizes directory", () => {
        const d = join(workdir, "sub");
        mkdirSync(d);
        const st = statFollow(d, "derived-from-cwd");
        expect(st.isDirectory()).toBe(true);
    });
});
