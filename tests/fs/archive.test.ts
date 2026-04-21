import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTarGz, extractTarGz, listTarGz } from "../../src/fs/archive.ts";

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
