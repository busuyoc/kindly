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

    test("uses a per-PID + random tmp path so it cannot collide with stale tmps or peers", () => {
        const path = join(workdir, "settings.reader.lua");
        // Plant a stale legacy bare `.tmp` (older kindly versions used this
        // shared name). New writes must not touch it.
        writeFileSync(path + ".tmp", "stale-junk-from-legacy-version");
        const content = dumpSettingsFile({ fresh: true });
        safeWrite(path, content, { backupDir });
        expect(readFileSync(path, "utf8")).toBe(content);
        // Stale legacy .tmp is left alone — no collision with our unique tmp.
        expect(existsSync(path + ".tmp")).toBe(true);
        // Per-PID + random tmp consumed by the atomic rename → no leftover
        // .tmp.<pid>.<rand> sibling.
        const leftovers = readdirSync(workdir).filter((f) =>
            f.startsWith("settings.reader.lua.tmp.")
        );
        expect(leftovers).toEqual([]);
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

    // Round 3 rollback gate-parity F4 (Angle V S862 sibling): when the
    // post-write reparse fails mid-string, the LuaParseError surfaces a
    // 40-byte window around the parse position. Those bytes are whatever
    // we just wrote — a tampered snapshot or a YAML carrying a SECRET
    // could position the failure inside a string value and leak up to
    // ~27 bytes of the secret to stderr (and to the --json envelope).
    // The fix rethrows the verify-step parse error as a snippet-free
    // KindlyError; the byte position remains for diagnosis.
    test("verify-reparse failure does not leak the on-disk snippet", () => {
        const path = join(workdir, "settings.reader.lua");
        // Construct a file that's almost-Lua but unparseable mid-string.
        // The string contains a known SECRET token; if the legacy snippet
        // path were still wired we'd see "TOPSECRETPINxxxxxxxx" in the
        // thrown message.
        const bad =
            'return {\n' +
            '  ["passcode"] = "TOPSECRETPINxxxxxxxx",\n' +
            '  ["broken"] = "no closing quote\n' +  // unterminated string → parse error
            '}\n';

        let caught: Error | null = null;
        try {
            safeWrite(path, bad, { backupDir, verifyLua: true });
        } catch (e) {
            caught = e as Error;
        }
        expect(caught).not.toBeNull();
        expect(caught!.message).not.toContain("TOPSECRETPIN");
        expect(caught!.message).toContain("snippet redacted");
        expect(caught!.message).toContain("post-write verify-reparse failed at byte ");
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
