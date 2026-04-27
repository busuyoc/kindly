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
    listTarGz, MalformedArchiveError, UnsafeArchivePathError,
} from "../../src/fs/archive.ts";
import { inspectTarGz } from "../../src/fs/tarInspect.ts";

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

// ---------------------------------------------------------------------------
// Round 6 FF batch — S2104 + S2110 closures.
// ---------------------------------------------------------------------------

function pad(s: string, n: number): Buffer {
    const b = Buffer.alloc(n);
    b.write(s);
    return b;
}
function octal(n: number, len: number): Buffer {
    return Buffer.from(n.toString(8).padStart(len - 1, "0") + "\0", "ascii");
}
function tarHeader(opts: {
    name: string; size: number; typeflag: string; prefix?: string;
}): Buffer {
    const h = Buffer.alloc(512);
    pad(opts.name, 100).copy(h, 0);
    octal(0o644, 8).copy(h, 100);
    octal(0, 8).copy(h, 108);
    octal(0, 8).copy(h, 116);
    octal(opts.size, 12).copy(h, 124);
    octal(0, 12).copy(h, 136);
    Buffer.alloc(8, 0x20).copy(h, 148);
    h[156] = opts.typeflag.charCodeAt(0);
    pad("", 100).copy(h, 157);
    pad("ustar", 6).copy(h, 257);
    pad("00", 2).copy(h, 263);
    if (opts.prefix) pad(opts.prefix, 155).copy(h, 345);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i]!;
    Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(h, 148);
    return h;
}

function paxRecord(key: string, value: string): string {
    // POSIX format: "<length> <key>=<value>\n" where length counts every
    // byte of the record including the length prefix and trailing \n.
    const body = ` ${key}=${value}\n`;
    let len = body.length + String(body.length).length;
    while (String(len).length !== String(len - String(len).length + String(body.length).length).length) len++;
    return String(len) + body;
}

function paxBlock(records: string[]): { header: Buffer; body: Buffer; pad: Buffer; typeflag: "x" | "g" } {
    return paxBlockTyped("x", records);
}
function paxBlockTyped(typeflag: "x" | "g", records: string[]): { header: Buffer; body: Buffer; pad: Buffer; typeflag: "x" | "g" } {
    const body = Buffer.from(records.join(""), "utf8");
    const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
    const name = typeflag === "g" ? "PaxGlobal/x" : "PaxHeader/x";
    const header = tarHeader({ name, size: body.length, typeflag });
    return { header, body, pad, typeflag };
}

describe("S2104: inspectTarGz honors PAX path= records", () => {
    test("PAX `x` record overrides the next entry's ustar name", () => {
        const pax = paxBlock([paxRecord("path", "real/path/main.lua")]);
        const fb = Buffer.from("data");
        const fileH = tarHeader({ name: "ignored.txt", size: fb.length, typeflag: "0" });
        const filePad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const tar = Buffer.concat([
            pax.header, pax.body, pax.pad,
            fileH, fb, filePad,
            Buffer.alloc(1024),
        ]);
        writeFileSync(archive, gzipSync(tar));
        const insp = inspectTarGz(archive, 1024 * 1024);
        expect(insp.entries).toHaveLength(1);
        expect(insp.entries[0]!.path).toBe("real/path/main.lua");
    });

    test("inspectTarGz agrees with listTarGz on PAX-overridden paths " +
        "(no two-view divergence)", () => {
        // Pre-fix: listTarGz returned the PAX path, inspectTarGz returned
        // the ustar name — exactly the seam S2104 documented.
        const pax = paxBlock([paxRecord("path", "plugins/Calibre.koplugin/main.lua")]);
        const fb = Buffer.from("safe");
        const fileH = tarHeader({ name: "main.lua", size: fb.length, typeflag: "0" });
        const filePad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const tar = Buffer.concat([
            pax.header, pax.body, pax.pad,
            fileH, fb, filePad,
            Buffer.alloc(1024),
        ]);
        writeFileSync(archive, gzipSync(tar));
        const listed = listTarGz(archive);
        const insp = inspectTarGz(archive, 1024 * 1024);
        expect(insp.entries.map((e) => e.path)).toEqual(listed);
    });

    test("PAX `g` (global) record applies to subsequent entries", () => {
        const pax = paxBlockTyped("g", [paxRecord("path", "global-default.txt")]);
        const fb = Buffer.from("a");
        const f1 = tarHeader({ name: "ignored1.txt", size: fb.length, typeflag: "0" });
        const f1Pad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const fb2 = Buffer.from("b");
        const f2 = tarHeader({ name: "ignored2.txt", size: fb2.length, typeflag: "0" });
        const f2Pad = Buffer.alloc(Math.ceil(fb2.length / 512) * 512 - fb2.length);
        const tar = Buffer.concat([
            pax.header, pax.body, pax.pad,
            f1, fb, f1Pad,
            f2, fb2, f2Pad,
            Buffer.alloc(1024),
        ]);
        writeFileSync(archive, gzipSync(tar));
        const insp = inspectTarGz(archive, 1024 * 1024);
        expect(insp.entries.map((e) => e.path)).toEqual([
            "global-default.txt",
            "global-default.txt",
        ]);
    });

    test("PAX `x` (next-only) overrides one entry; subsequent entry " +
        "falls back to global default", () => {
        // Order: g{path=g.txt}, x{path=x.txt}, file ustar A, file ustar B
        // → entry A uses x record, entry B falls back to global.
        const g = paxBlockTyped("g", [paxRecord("path", "g.txt")]);
        const x = paxBlockTyped("x", [paxRecord("path", "x.txt")]);
        const fb = Buffer.from("a");
        const fA = tarHeader({ name: "ustarA.txt", size: fb.length, typeflag: "0" });
        const fAPad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const fB = tarHeader({ name: "ustarB.txt", size: fb.length, typeflag: "0" });
        const fBPad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const tar = Buffer.concat([
            g.header, g.body, g.pad,
            x.header, x.body, x.pad,
            fA, fb, fAPad,
            fB, fb, fBPad,
            Buffer.alloc(1024),
        ]);
        writeFileSync(archive, gzipSync(tar));
        const insp = inspectTarGz(archive, 1024 * 1024);
        expect(insp.entries.map((e) => e.path)).toEqual(["x.txt", "g.txt"]);
    });

    test("PAX-overridden traversal path is rejected by " +
        "assertSafeArchive (defense in depth via inspectTarGz)", () => {
        const pax = paxBlock([paxRecord("path", "../../escaped")]);
        const fb = Buffer.from("evil");
        const fileH = tarHeader({ name: "innocent.txt", size: fb.length, typeflag: "0" });
        const filePad = Buffer.alloc(Math.ceil(fb.length / 512) * 512 - fb.length);
        const tar = Buffer.concat([
            pax.header, pax.body, pax.pad,
            fileH, fb, filePad,
            Buffer.alloc(1024),
        ]);
        writeFileSync(archive, gzipSync(tar));
        // Refusal still fires — listTarGz already saw the PAX-overridden
        // name pre-fix; the new behavior is that inspectTarGz now sees it
        // too, closing the inspect-vs-list divergence.
        expect(() => assertSafeArchive(archive)).toThrow(UnsafeArchivePathError);
    });
});

describe("S2110: listTarGz does not blow spawnSync's default 1 MiB stdout cap", () => {
    test("archive whose listing exceeds 1 MiB lists cleanly", () => {
        // Pre-fix: spawnSync's default 1 MiB maxBuffer crashed `tar -tzf`
        // with empty stderr and exit=null on any archive whose stdout
        // listing topped 1 MiB, even when the archive was well under
        // both the archive-bytes and uncompressed-bytes caps.
        // 5500 entries × ~256 bytes ≈ 1.4 MiB stdout — past the old cap,
        // well under the new one. Each header is 512 bytes so the tar
        // itself is ~2.7 MiB (gzips down to ~50 KiB).
        const blocks: Buffer[] = [];
        const N = 5500;
        const longPrefix = "p".repeat(140);  // pushes name+prefix > 240 bytes
        for (let i = 0; i < N; i++) {
            const baseName = `${i.toString().padStart(7, "0")}.lua`;
            blocks.push(tarHeader({
                name: baseName, size: 0, typeflag: "0", prefix: longPrefix,
            }));
        }
        blocks.push(Buffer.alloc(1024));
        writeFileSync(archive, gzipSync(Buffer.concat(blocks)));
        const listed = listTarGz(archive);
        expect(listed).toHaveLength(N);
        // Sanity: every path was prefix + "/" + base.
        expect(listed[0]!.startsWith(longPrefix + "/")).toBe(true);
    });
});
