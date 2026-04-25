import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import {
    ArchiveTooLargeError, assertSafeArchive, createTarGz, extractTarGz,
    listTarGz, MalformedArchiveError,
} from "../../src/fs/archive.ts";

let src: string;
let dest: string;
let archive: string;

beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "kindly-arc-src-"));
    dest = mkdtempSync(join(tmpdir(), "kindly-arc-dest-"));
    archive = join(mkdtempSync(join(tmpdir(), "kindly-arc-out-")), "out.tar.gz");

    // Build a small "koreader-like" tree:
    //   src/settings.reader.lua
    //   src/patches/userpatch.lua
    //   src/plugins/zlibrary.koplugin/main.lua
    writeFileSync(join(src, "settings.reader.lua"), "return { a = 1 }\n");
    mkdirSync(join(src, "patches"));
    writeFileSync(join(src, "patches", "userpatch.lua"), "-- user patch\n");
    mkdirSync(join(src, "plugins", "zlibrary.koplugin"), { recursive: true });
    writeFileSync(join(src, "plugins", "zlibrary.koplugin", "main.lua"), "-- plugin\n");
});

describe("createTarGz", () => {
    test("produces a file with nonzero size", () => {
        const res = createTarGz({
            cwd: src,
            paths: ["settings.reader.lua", "patches", "plugins"],
            outputPath: archive,
        });
        expect(existsSync(archive)).toBe(true);
        expect(res.bytesWritten).toBeGreaterThan(0);
        expect(statSync(archive).size).toBe(res.bytesWritten);
        expect(res.includedPaths).toEqual(["settings.reader.lua", "patches", "plugins"]);
        expect(res.skippedPaths).toEqual([]);
    });

    test("silently skips non-existent paths (reports them)", () => {
        const res = createTarGz({
            cwd: src,
            paths: ["settings.reader.lua", "defaults.custom.lua", "history.lua"],
            outputPath: archive,
        });
        expect(res.includedPaths).toEqual(["settings.reader.lua"]);
        expect(res.skippedPaths.sort()).toEqual(["defaults.custom.lua", "history.lua"]);
    });

    test("refuses empty archive (no input paths exist)", () => {
        expect(() =>
            createTarGz({
                cwd: src,
                paths: ["nope", "also-nope"],
                outputPath: archive,
            })
        ).toThrow(/refusing to create empty archive/);
    });

    test("creates parent output dir if missing", () => {
        const nested = join(dest, "a", "b", "out.tar.gz");
        createTarGz({
            cwd: src,
            paths: ["settings.reader.lua"],
            outputPath: nested,
        });
        expect(existsSync(nested)).toBe(true);
    });
});

describe("listTarGz", () => {
    test("lists all archived files", () => {
        createTarGz({
            cwd: src,
            paths: ["settings.reader.lua", "patches", "plugins"],
            outputPath: archive,
        });
        const entries = listTarGz(archive);
        expect(entries).toContain("settings.reader.lua");
        expect(entries.some((e) => e.includes("userpatch.lua"))).toBe(true);
        expect(entries.some((e) => e.includes("zlibrary.koplugin"))).toBe(true);
    });
});

describe("extractTarGz", () => {
    test("round-trip: create → extract → content preserved", () => {
        createTarGz({
            cwd: src,
            paths: ["settings.reader.lua", "patches", "plugins"],
            outputPath: archive,
        });
        const res = extractTarGz({ archivePath: archive, destRoot: dest });

        expect(res.fileCount).toBe(3);
        expect(readFileSync(join(dest, "settings.reader.lua"), "utf8"))
            .toBe("return { a = 1 }\n");
        expect(readFileSync(join(dest, "patches", "userpatch.lua"), "utf8"))
            .toBe("-- user patch\n");
        expect(readFileSync(join(dest, "plugins", "zlibrary.koplugin", "main.lua"), "utf8"))
            .toBe("-- plugin\n");
    });

    test("overwrites existing destination files (restore semantics)", () => {
        writeFileSync(join(dest, "settings.reader.lua"), "OLD CONTENT");
        createTarGz({
            cwd: src,
            paths: ["settings.reader.lua"],
            outputPath: archive,
        });
        extractTarGz({ archivePath: archive, destRoot: dest });
        expect(readFileSync(join(dest, "settings.reader.lua"), "utf8"))
            .toBe("return { a = 1 }\n");
    });

    test("creates destRoot if missing", () => {
        const newDest = join(dest, "does-not-exist-yet");
        createTarGz({
            cwd: src,
            paths: ["settings.reader.lua"],
            outputPath: archive,
        });
        extractTarGz({ archivePath: archive, destRoot: newDest });
        expect(existsSync(join(newDest, "settings.reader.lua"))).toBe(true);
    });

    test("refuses if archive doesn't exist", () => {
        expect(() =>
            extractTarGz({ archivePath: "/nowhere/nope.tar.gz", destRoot: dest })
        ).toThrow(/archive not found/);
    });
});

describe("C4: magic-byte sniff", () => {
    test("rejects zip-as-.kset polyglot at listTarGz", () => {
        // Zip local-file-header magic.
        const zipBytes = Buffer.concat([
            Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            Buffer.alloc(64),
        ]);
        writeFileSync(archive, zipBytes);
        expect(() => listTarGz(archive)).toThrow(MalformedArchiveError);
        expect(() => listTarGz(archive)).toThrow(/zip file/);
    });

    test("rejects bare uncompressed tar at extractTarGz", () => {
        // BSD tar's ustar magic lives at offset 257.
        const buf = Buffer.alloc(512);
        buf.write("ustar", 257);
        // Make the rest look tar-ish enough to bypass any glance-checks.
        writeFileSync(archive, buf);
        expect(() =>
            extractTarGz({ archivePath: archive, destRoot: dest })
        ).toThrow(/uncompressed tar/);
    });

    test("rejects random non-archive bytes", () => {
        writeFileSync(archive, "this is not a tarball at all");
        expect(() => listTarGz(archive)).toThrow(MalformedArchiveError);
        expect(() => listTarGz(archive)).toThrow(/gzip magic/);
    });

    test("accepts a legitimate gzipped tar", () => {
        createTarGz({ cwd: src, paths: ["settings.reader.lua"], outputPath: archive });
        expect(() => listTarGz(archive)).not.toThrow();
    });
});

describe("C4: tar-header inspection", () => {
    test("rejects archive containing a symlink (typeflag 2) pre-extract", () => {
        symlinkSync("/etc/passwd", join(src, "evil-link"));
        const r = spawnSync("tar", [
            "-czf", archive, "-C", src, "settings.reader.lua", "evil-link",
        ]);
        expect(r.status).toBe(0);
        expect(() =>
            extractTarGz({ archivePath: archive, destRoot: dest })
        ).toThrow(MalformedArchiveError);
        expect(() =>
            extractTarGz({ archivePath: archive, destRoot: dest })
        ).toThrow(/symlink entry/);
    });

    test("rejects sparse-tar bomb whose header sizes vastly exceed gzip ISIZE", () => {
        // Build a tar by hand: one header declaring a 1 GiB file, but
        // we only emit 0 content blocks (typeflag 0 with size 1 GiB
        // and zero data blocks would normally be malformed; we emit a
        // pair-of-zero-blocks footer to terminate). gzip-ing this is
        // tiny — sub-100 bytes — but the header says 1 GiB.
        const block = Buffer.alloc(512);
        block.write("evil.lua", 0, 100);                  // name
        block.write("0000644", 100, 8);                   // mode
        block.write("0000000", 108, 8);                   // uid
        block.write("0000000", 116, 8);                   // gid
        // size = 1 GiB in octal, 11 chars + space.
        block.write((1024 * 1024 * 1024).toString(8).padStart(11, "0") + "\0", 124, 12);
        block.write("00000000000\0", 136, 12);            // mtime
        // Fill checksum field with spaces while computing.
        for (let i = 148; i < 156; i++) block[i] = 0x20;
        block[156] = 0x30;                                // typeflag '0'
        block.write("ustar  \0", 257, 8);                 // ustar magic
        // Compute checksum (signed-byte sum).
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += block[i]!;
        block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
        const tar = Buffer.concat([block, Buffer.alloc(1024)]);
        writeFileSync(archive, gzipSync(tar));
        // 1 GiB > 500 MiB default cap → rejection (size cap or apparent-size cap).
        expect(() =>
            extractTarGz({ archivePath: archive, destRoot: dest })
        ).toThrow(ArchiveTooLargeError);
    });

    test("assertSafeArchive rejects symlink entries", () => {
        symlinkSync("/etc/passwd", join(src, "evil-link"));
        const r = spawnSync("tar", [
            "-czf", archive, "-C", src, "settings.reader.lua", "evil-link",
        ]);
        expect(r.status).toBe(0);
        expect(() => assertSafeArchive(archive)).toThrow(MalformedArchiveError);
    });
});
