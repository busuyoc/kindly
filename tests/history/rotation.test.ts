// History rotation (W17): active file spills to .kindly/history-archive/
// once it reaches HISTORY_ROTATION_THRESHOLD entries. Indexes stay
// monotonic across the boundary so `rollback --to N` keeps resolving
// regardless of which file an entry now lives in.
//
// Coverage:
//   - N < threshold → no rotation, no archive dir
//   - Nth entry (== threshold) → still in active
//   - (threshold+1)th entry → rotation fires, active holds only the new
//     entry, archive contains the prior `threshold` entries
//   - Archive bucketing respects each entry's own ts (YYYY-MM)
//   - Second rotation within the same month appends to the same archive
//   - Index continues from where it left off after rotation
//   - findHistoryEntryByIndex crosses active ↔ archives
//   - countAllHistory sums active + archives

import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    HISTORY_ROTATION_THRESHOLD,
    appendHistoryEntry,
    historyArchiveDir,
    historyPath,
    type HistoryEntry,
} from "../../src/history/writer.ts";
import {
    countAllHistory,
    findHistoryEntryByIndex,
} from "../../src/history/reader.ts";

function readActive(cwd: string): HistoryEntry[] {
    const p = historyPath(cwd);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
}

function readArchive(cwd: string, month: string): HistoryEntry[] {
    const p = join(historyArchiveDir(cwd), `${month}.jsonl`);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
}

function makeEnv(cwd: string, iso: string) {
    return { cwd, now: () => new Date(iso) };
}

let workdir: string;
beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-rot-"));
});

describe("appendHistoryEntry — indexing", () => {
    test("first entry gets index 1, second gets 2", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        const a = appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        const b = appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        expect(a.index).toBe(1);
        expect(b.index).toBe(2);
    });

    test("index field is persisted on disk", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        const lines = readActive(workdir);
        expect(lines[0]!.index).toBe(1);
        expect(lines[1]!.index).toBe(2);
    });
});

describe("rotation threshold", () => {
    test("under threshold → no archive dir", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        for (let i = 0; i < 3; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        }
        expect(existsSync(historyArchiveDir(workdir))).toBe(false);
        expect(readActive(workdir).length).toBe(3);
    });

    test("exactly threshold entries → still in active, no rotation yet", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        }
        expect(readActive(workdir).length).toBe(HISTORY_ROTATION_THRESHOLD);
        expect(existsSync(historyArchiveDir(workdir))).toBe(false);
    });

    test("threshold+1 → first `threshold` move to archive, new entry stands alone in active", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD + 1; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: 1 });
        }
        const active = readActive(workdir);
        expect(active.length).toBe(1);
        expect(active[0]!.index).toBe(HISTORY_ROTATION_THRESHOLD + 1);

        const archived = readArchive(workdir, "2026-04");
        expect(archived.length).toBe(HISTORY_ROTATION_THRESHOLD);
        expect(archived[0]!.index).toBe(1);
        expect(archived[archived.length - 1]!.index).toBe(HISTORY_ROTATION_THRESHOLD);
    });

    test("archive bucketing respects each entry's own ts month", () => {
        // Seed 3 march entries, then 2 april entries, then rotate.
        const marchEnv = makeEnv(workdir, "2026-03-15T10:00:00Z");
        for (let i = 0; i < 3; i++) appendHistoryEntry(marchEnv, "apply", {});
        const aprilEnv = makeEnv(workdir, "2026-04-01T10:00:00Z");
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD - 3; i++) {
            appendHistoryEntry(aprilEnv, "apply", {});
        }
        // Force rotation with one more append.
        appendHistoryEntry(aprilEnv, "apply", {});

        const march = readArchive(workdir, "2026-03");
        const april = readArchive(workdir, "2026-04");
        expect(march.length).toBe(3);
        expect(april.length).toBe(HISTORY_ROTATION_THRESHOLD - 3);
    });

    test("second rotation in the same month APPENDS to the existing archive", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        // First rotation: 500 → archive, 1 in active.
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD + 1; i++) {
            appendHistoryEntry(env, "apply", {});
        }
        expect(readArchive(workdir, "2026-04").length).toBe(HISTORY_ROTATION_THRESHOLD);

        // Keep writing until second rotation fires (index 1001).
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD; i++) {
            appendHistoryEntry(env, "apply", {});
        }
        const archived = readArchive(workdir, "2026-04");
        expect(archived.length).toBe(HISTORY_ROTATION_THRESHOLD * 2);
        // Indexes are monotonic across the two rotations.
        expect(archived[0]!.index).toBe(1);
        expect(archived[archived.length - 1]!.index).toBe(HISTORY_ROTATION_THRESHOLD * 2);

        const active = readActive(workdir);
        expect(active.length).toBe(1);
        expect(active[0]!.index).toBe(HISTORY_ROTATION_THRESHOLD * 2 + 1);
    });

    test("next index recovers from archives when active is empty", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        // Write 501 entries to trigger one rotation (active ends with 1 entry, index 501).
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD + 1; i++) {
            appendHistoryEntry(env, "apply", {});
        }
        // Simulate a wipe of active (e.g., user cleared it) — archives remain.
        writeFileSync(historyPath(workdir), "");

        const next = appendHistoryEntry(env, "apply", {});
        // Next index picks up from archived max (500) + 1.
        expect(next.index).toBe(HISTORY_ROTATION_THRESHOLD + 1);
    });
});

describe("findHistoryEntryByIndex + countAllHistory", () => {
    test("finds an entry in active", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", { settings_delta_n: 7 });
        appendHistoryEntry(env, "snapshot", {});
        const hit = findHistoryEntryByIndex(workdir, 1);
        expect(hit?.cmd).toBe("apply");
        expect(hit?.summary.settings_delta_n).toBe(7);
    });

    test("finds an entry that was rotated into archive", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD + 1; i++) {
            appendHistoryEntry(env, "apply", { settings_delta_n: i + 1 });
        }
        // index 7 is now in archive
        const hit = findHistoryEntryByIndex(workdir, 7);
        expect(hit?.index).toBe(7);
        expect(hit?.summary.settings_delta_n).toBe(7);
    });

    test("returns null for an unknown index", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        appendHistoryEntry(env, "apply", {});
        expect(findHistoryEntryByIndex(workdir, 99)).toBeNull();
    });

    test("countAllHistory sums active + every archive file", () => {
        const env = makeEnv(workdir, "2026-04-22T12:00:00Z");
        for (let i = 0; i < HISTORY_ROTATION_THRESHOLD + 3; i++) {
            appendHistoryEntry(env, "apply", {});
        }
        expect(countAllHistory(workdir)).toBe(HISTORY_ROTATION_THRESHOLD + 3);
        // Two files: archive has 500, active has 3.
        const archiveFiles = readdirSync(historyArchiveDir(workdir));
        expect(archiveFiles).toContain("2026-04.jsonl");
    });
});

describe("rotation crash — archive+truncate not atomic", () => {
    // Simulate the window between appendFileSync(archive) and
    // writeFileSync("") on active: the same entry lives in both files.
    test("countAllHistory dedupes the overlap by index", () => {
        const dup = {
            ts: "2026-04-22T10:00:00.000Z",
            cmd: "apply" as const,
            kindly_version: "0.3.0",
            index: 1,
            summary: {},
        };
        mkdirSync(historyArchiveDir(workdir), { recursive: true });
        writeFileSync(historyPath(workdir), JSON.stringify(dup) + "\n");
        writeFileSync(
            join(historyArchiveDir(workdir), "2026-04.jsonl"),
            JSON.stringify(dup) + "\n",
        );
        expect(countAllHistory(workdir)).toBe(1);
    });

    test("findHistoryEntryByIndex prefers active over archive for duplicates", () => {
        // Active copy has a distinguishing label; archive has the stale one.
        // This verifies the active-first search order survives the generator
        // refactor — future-you can change one or the other's content to
        // eyeball which won.
        const activeCopy = {
            ts: "2026-04-22T10:00:00.000Z",
            cmd: "apply" as const,
            kindly_version: "0.3.0",
            index: 1,
            label: "active-copy",
            summary: {},
        };
        const archiveCopy = { ...activeCopy, label: "archive-copy" };
        mkdirSync(historyArchiveDir(workdir), { recursive: true });
        writeFileSync(historyPath(workdir), JSON.stringify(activeCopy) + "\n");
        writeFileSync(
            join(historyArchiveDir(workdir), "2026-04.jsonl"),
            JSON.stringify(archiveCopy) + "\n",
        );
        const hit = findHistoryEntryByIndex(workdir, 1);
        expect(hit?.label).toBe("active-copy");
    });
});
