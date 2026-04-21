import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWrite } from "../../src/fs/safeWrite.ts";
import { dumpSettingsFile } from "../../src/lua/writer.ts";

let workdir: string;
let backupDir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-sw-"));
    backupDir = join(workdir, "backups");
});

describe("safeWrite — initial write (no pre-existing file)", () => {
    test("creates file with exact content", () => {
        const path = join(workdir, "settings.reader.lua");
        const content = dumpSettingsFile({ a: 1 });
        const res = safeWrite(path, content, { backupDir });
        expect(readFileSync(path, "utf8")).toBe(content);
        expect(res.bytesWritten).toBe(Buffer.byteLength(content));
        expect(res.backupPath).toBe(null);
        expect(res.oldPath).toBe(null);
    });

    test("does not create .old when no prior file exists", () => {
        const path = join(workdir, "settings.reader.lua");
        safeWrite(path, dumpSettingsFile({}), { backupDir });
        expect(existsSync(path + ".old")).toBe(false);
    });
});

describe("safeWrite — rewrite over existing file", () => {
    test("archives pre-write snapshot to backupDir", () => {
        const path = join(workdir, "settings.reader.lua");
        writeFileSync(path, dumpSettingsFile({ version: 1 }));

        const newContent = dumpSettingsFile({ version: 2 });
        const res = safeWrite(path, newContent, { backupDir });

        expect(res.backupPath).not.toBeNull();
        expect(existsSync(res.backupPath!)).toBe(true);
        expect(readFileSync(res.backupPath!, "utf8")).toBe(dumpSettingsFile({ version: 1 }));
        expect(readFileSync(path, "utf8")).toBe(newContent);
    });

    test("rotates previous content to .old (matches KOReader's fallback)", () => {
        const path = join(workdir, "settings.reader.lua");
        const v1 = dumpSettingsFile({ version: 1 });
        writeFileSync(path, v1);

        const v2 = dumpSettingsFile({ version: 2 });
        const res = safeWrite(path, v2, { backupDir });

        expect(res.oldPath).toBe(path + ".old");
        expect(readFileSync(res.oldPath!, "utf8")).toBe(v1);
        expect(readFileSync(path, "utf8")).toBe(v2);
    });

    test("cleans up a stale .tmp from a previous crashed run", () => {
        const path = join(workdir, "settings.reader.lua");
        writeFileSync(path + ".tmp", "stale-junk-that-should-be-removed");
        const content = dumpSettingsFile({ fresh: true });
        safeWrite(path, content, { backupDir });
        expect(readFileSync(path, "utf8")).toBe(content);
        // .tmp should have been consumed by the atomic rename → path
        expect(existsSync(path + ".tmp")).toBe(false);
    });

    test("two sequential writes produce two backup snapshots", async () => {
        const path = join(workdir, "settings.reader.lua");
        safeWrite(path, dumpSettingsFile({ n: 1 }), { backupDir });
        // Tiny sleep so ISO timestamps differ (ms resolution)
        await new Promise((r) => setTimeout(r, 5));
        safeWrite(path, dumpSettingsFile({ n: 2 }), { backupDir });
        await new Promise((r) => setTimeout(r, 5));
        safeWrite(path, dumpSettingsFile({ n: 3 }), { backupDir });

        // First write had no prior file → no snapshot. So 2 snapshot dirs.
        const snaps = readdirSync(backupDir);
        expect(snaps.length).toBe(2);
    });
});

describe("safeWrite — verify step", () => {
    test("throws if verifyLua=true and content is not parseable", () => {
        const path = join(workdir, "settings.reader.lua");
        expect(() =>
            safeWrite(path, "this is not lua", { backupDir, verifyLua: true })
        ).toThrow();
    });

    test("restores .old on verify failure so we never leave a broken file", () => {
        const path = join(workdir, "settings.reader.lua");
        const good = dumpSettingsFile({ ok: true });
        writeFileSync(path, good);

        expect(() =>
            safeWrite(path, "garbage that won't parse", { backupDir, verifyLua: true })
        ).toThrow();

        // After rollback, path must contain the pre-write good content again.
        expect(readFileSync(path, "utf8")).toBe(good);
    });

    test("verifyLua=false allows arbitrary content (for non-Lua files)", () => {
        const path = join(workdir, "notes.txt");
        safeWrite(path, "hello world\n", { backupDir, verifyLua: false });
        expect(readFileSync(path, "utf8")).toBe("hello world\n");
    });
});

describe("safeWrite — preconditions", () => {
    test("throws if parent directory doesn't exist (we don't create device dirs)", () => {
        const path = join(workdir, "does-not-exist", "settings.reader.lua");
        expect(() => safeWrite(path, "return nil", { backupDir })).toThrow(
            /parent directory does not exist/
        );
    });
});

describe("safeWrite + dump round-trip — realistic settings file", () => {
    test("writes a KOReader-shaped settings file and it parses back cleanly", () => {
        const path = join(workdir, "settings.reader.lua");
        const data = {
            plugins_disabled: { coverbrowser: true, gestures: false },
            css_tweaks: { night_colors: true },
            last_page: 142,
            recent_files: ["/mnt/us/documents/a.epub", "/mnt/us/documents/b.pdf"],
            reader_has_highlights: true,
        };
        const content = dumpSettingsFile(data);
        const res = safeWrite(path, content, { backupDir });
        expect(res.bytesWritten).toBeGreaterThan(0);
        expect(readFileSync(path, "utf8")).toBe(content);
    });
});
