// Unit tests for src/history/snapshotHash.ts — round-3 snapshot
// integrity hash-binding.
//
// Verifies: deterministic hash for identical content, content drift
// flips the hash, file rename flips the hash, file order is stable
// (sorted), symlinks are rejected (lstat-not-stat discipline), nested
// dirs are rejected (snapshots are flat by contract).

import { describe, test, expect, beforeEach } from "bun:test";
import {
    chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashSnapshotDir } from "../../src/history/snapshotHash.ts";

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-snaphash-"));
});

describe("hashSnapshotDir — happy path", () => {
    test("returns sha256:<64 hex> for a dir with one file", () => {
        writeFileSync(join(workdir, "settings.reader.lua"), "return { foo = 1 }");
        const hash = hashSnapshotDir(workdir);
        expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    test("identical contents in two dirs hash to the same value", () => {
        const a = mkdtempSync(join(tmpdir(), "kindly-hash-a-"));
        const b = mkdtempSync(join(tmpdir(), "kindly-hash-b-"));
        writeFileSync(join(a, "settings.reader.lua"), "return { foo = 1 }");
        writeFileSync(join(b, "settings.reader.lua"), "return { foo = 1 }");
        expect(hashSnapshotDir(a)).toBe(hashSnapshotDir(b));
    });

    test("different file contents hash to different values", () => {
        const a = mkdtempSync(join(tmpdir(), "kindly-hash-a-"));
        const b = mkdtempSync(join(tmpdir(), "kindly-hash-b-"));
        writeFileSync(join(a, "settings.reader.lua"), "return { foo = 1 }");
        writeFileSync(join(b, "settings.reader.lua"), "return { foo = 2 }");
        expect(hashSnapshotDir(a)).not.toBe(hashSnapshotDir(b));
    });

    test("renaming a file flips the hash (manifest binds names)", () => {
        const a = mkdtempSync(join(tmpdir(), "kindly-hash-a-"));
        const b = mkdtempSync(join(tmpdir(), "kindly-hash-b-"));
        writeFileSync(join(a, "settings.reader.lua"), "return { foo = 1 }");
        writeFileSync(join(b, "renamed.lua"), "return { foo = 1 }");
        expect(hashSnapshotDir(a)).not.toBe(hashSnapshotDir(b));
    });

    test("file order is stable — same hash regardless of fs creation order", () => {
        const a = mkdtempSync(join(tmpdir(), "kindly-hash-a-"));
        const b = mkdtempSync(join(tmpdir(), "kindly-hash-b-"));
        writeFileSync(join(a, "z.txt"), "z");
        writeFileSync(join(a, "a.txt"), "a");
        writeFileSync(join(b, "a.txt"), "a");
        writeFileSync(join(b, "z.txt"), "z");
        expect(hashSnapshotDir(a)).toBe(hashSnapshotDir(b));
    });

    test("typical pre-import dir (settings + plugins-patches.tar.gz) hashes deterministically", () => {
        writeFileSync(join(workdir, "settings.reader.lua"), "return { foo = 1 }");
        writeFileSync(join(workdir, "plugins-patches.tar.gz"), Buffer.from([0x1f, 0x8b, 0x08]));
        const h1 = hashSnapshotDir(workdir);
        const h2 = hashSnapshotDir(workdir);
        expect(h1).toBe(h2);
    });
});

describe("hashSnapshotDir — tampering rejection", () => {
    test("rejects non-directory input", () => {
        const f = join(workdir, "not-a-dir");
        writeFileSync(f, "x");
        expect(() => hashSnapshotDir(f)).toThrow(/not a directory/);
    });

    test("rejects nested subdirs (snapshots must be flat)", () => {
        writeFileSync(join(workdir, "settings.reader.lua"), "x");
        mkdirSync(join(workdir, "subdir"));
        expect(() => hashSnapshotDir(workdir)).toThrow(/not a regular file/);
    });

    test("rejects symlinks inside the snapshot dir (no follow)", () => {
        const target = join(workdir, "real.lua");
        writeFileSync(target, "real");
        symlinkSync(target, join(workdir, "link.lua"));
        expect(() => hashSnapshotDir(workdir)).toThrow(/not a regular file/);
    });

    test("flipping a single byte in a file flips the hash", () => {
        writeFileSync(join(workdir, "settings.reader.lua"), "return { pin = \"1234\" }");
        const before = hashSnapshotDir(workdir);
        writeFileSync(join(workdir, "settings.reader.lua"), "return { pin = \"4321\" }");
        const after = hashSnapshotDir(workdir);
        expect(after).not.toBe(before);
    });

    test("renaming a file in place flips the hash", () => {
        writeFileSync(join(workdir, "a.txt"), "x");
        const before = hashSnapshotDir(workdir);
        renameSync(join(workdir, "a.txt"), join(workdir, "b.txt"));
        const after = hashSnapshotDir(workdir);
        expect(after).not.toBe(before);
    });

    test("perm-only changes do NOT flip the hash (content addressing only)", () => {
        const f = join(workdir, "settings.reader.lua");
        writeFileSync(f, "x");
        const before = hashSnapshotDir(workdir);
        chmodSync(f, 0o600);
        const after = hashSnapshotDir(workdir);
        expect(after).toBe(before);
    });
});
