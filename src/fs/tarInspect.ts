// Magic-byte sniff and in-memory tar-header walk for archive defense.
//
// Two threats this file closes that the existing shell-out-to-`tar`
// pipeline can't:
//   - dispatch by extension (S941): a `.kset` named file might actually
//     be a zip / bare tar / random bytes. tar will sometimes still
//     extract from those formats, or extract attacker-influenced bytes
//     before failing.
//   - sparse-tar bomb (S1452): the gzip trailer (ISIZE) is ≪ the sum
//     of header-declared file sizes when the archive uses sparse
//     entries. tar honors the per-entry sizes on extract.
//   - hardlink/symlink TOCTOU (S1454/S1455): a tar entry of typeflag
//     1 or 2 plants a link before kindly's safeRead post-extract guard
//     ever sees it.
//
// We parse tar headers ourselves in memory rather than `tar -tzvf`
// because the verbose listing format diverges between BSD and GNU tar.

import { openSync, readFileSync, readSync, closeSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const TAR_USTAR_AT_257 = Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72]);

export class MalformedArchiveError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MalformedArchiveError";
    }
}

/** Reject anything that isn't a gzipped tar before we shell out. The
 *  4-byte zip prefix and the bare-tar `ustar` magic at offset 257 are
 *  the two non-gzip formats most likely to be misidentified as a
 *  `.kset` (or to make `tar` perform partial work). */
export function assertGzipMagic(archivePath: string): void {
    const head = Buffer.alloc(264);
    let read = 0;
    let fd: number;
    try {
        fd = openSync(archivePath, "r");
    } catch (e) {
        throw new MalformedArchiveError(
            `archive unreadable: ${(e as Error).message}`,
        );
    }
    try {
        read = readSync(fd, head, 0, head.length, 0);
    } finally {
        closeSync(fd);
    }
    if (read >= 4 && head.subarray(0, 4).equals(ZIP_MAGIC)) {
        throw new MalformedArchiveError(
            "archive is a zip file (PK\\x03\\x04); kindly only accepts gzipped tar",
        );
    }
    if (read >= 262 && head.subarray(257, 262).equals(TAR_USTAR_AT_257)) {
        throw new MalformedArchiveError(
            "archive is an uncompressed tar; kindly only accepts gzipped tar",
        );
    }
    if (read < 3 || !head.subarray(0, 3).equals(GZIP_MAGIC)) {
        const got = head.subarray(0, Math.min(3, read)).toString("hex");
        throw new MalformedArchiveError(
            `archive does not have gzip magic bytes (got ${got || "<empty>"}); expected 1f8b08`,
        );
    }
}

export type TarEntryType =
    | "file"
    | "dir"
    | "symlink"
    | "hardlink"
    | "longname"
    | "longlink"
    | "pax"
    | "other";

export interface TarEntry {
    path: string;
    type: TarEntryType;
    /** Header-declared size in bytes (per-entry). Authoritative input
     *  to tar's extractor; used here for sparse-tar bomb detection. */
    size: number;
}

export interface TarInspection {
    entries: TarEntry[];
    /** Sum of header-declared sizes for regular-file entries. Detects
     *  sparse-tar bombs where the gzip trailer reports a small
     *  uncompressed size while the tar headers declare huge files. */
    totalApparentBytes: number;
}

/** Walk tar headers in memory. `maxUncompressedBytes` bounds the
 *  in-memory inflate; callers must enforce the gzip-trailer cap and
 *  archive-bytes cap separately so this is reachable only for
 *  already-bounded inputs. */
export function inspectTarGz(archivePath: string, maxUncompressedBytes: number): TarInspection {
    let data: Buffer;
    try {
        const compressed = readFileSync(archivePath);
        data = gunzipSync(compressed, { maxOutputLength: maxUncompressedBytes });
    } catch (e) {
        throw new MalformedArchiveError(
            `archive cannot be decompressed: ${(e as Error).message}`,
        );
    }
    const entries: TarEntry[] = [];
    let totalApparentBytes = 0;
    let pendingLongName: string | null = null;
    let offset = 0;
    let zeroBlocks = 0;
    while (offset + 512 <= data.length) {
        const header = data.subarray(offset, offset + 512);
        if (isAllZero(header)) {
            zeroBlocks += 1;
            offset += 512;
            if (zeroBlocks >= 2) break;
            continue;
        }
        zeroBlocks = 0;
        const baseName = readField(header, 0, 100);
        const sizeStr = readField(header, 124, 12).trim();
        const parsedSize = sizeStr ? parseInt(sizeStr, 8) : 0;
        const size = Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : 0;
        const typeflag = String.fromCharCode(header[156] ?? 0);
        const prefix = readField(header, 345, 155);
        const ustarName = prefix ? `${prefix}/${baseName}` : baseName;
        const name = pendingLongName ?? ustarName;
        pendingLongName = null;
        const type = classifyTypeflag(typeflag);
        if (type === "longname") {
            pendingLongName = readBytes(data, offset + 512, size).replace(/\0+$/, "");
        } else if (type === "longlink" || type === "pax") {
            // PAX/long-link extension headers describe the next entry;
            // they don't themselves represent files in the archive.
        } else {
            entries.push({ path: name, type, size });
            if (type === "file") totalApparentBytes += size;
        }
        const contentBlocks = Math.ceil(size / 512);
        offset += 512 + contentBlocks * 512;
    }
    return { entries, totalApparentBytes };
}

function classifyTypeflag(t: string): TarEntryType {
    switch (t) {
        case "0":
        case "\x00": return "file";
        case "1": return "hardlink";
        case "2": return "symlink";
        case "5": return "dir";
        case "L": return "longname";
        case "K": return "longlink";
        case "x":
        case "g": return "pax";
        default: return "other";
    }
}

function isAllZero(buf: Buffer): boolean {
    for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
    return true;
}

function readField(buf: Buffer, start: number, length: number): string {
    const end = Math.min(start + length, buf.length);
    const slice = buf.subarray(start, end);
    const nul = slice.indexOf(0);
    return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function readBytes(buf: Buffer, start: number, length: number): string {
    const end = Math.min(start + length, buf.length);
    return buf.subarray(start, end).toString("utf8");
}
