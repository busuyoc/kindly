import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rotateBackups } from "../../src/fs/backupRotation.ts";

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kindly-rot-"));
});

function seed(n: number): string[] {
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
        const stamp = `2026-04-${String(i + 1).padStart(2, "0")}T12-00-00-000Z`;
        mkdirSync(join(dir, stamp));
        names.push(stamp);
    }
    return names;
}

describe("rotateBackups", () => {
    test("25 dirs, keep 20 → removes oldest 5, keeps newest 20", () => {
        const all = seed(25);
        const { kept, removed } = rotateBackups(dir, 20);
        expect(removed).toEqual(all.slice(0, 5));
        expect(kept).toEqual(all.slice(5));
        expect(readdirSync(dir).sort()).toEqual(all.slice(5));
    });

    test("exactly keepN dirs → no removals", () => {
        seed(20);
        const { kept, removed } = rotateBackups(dir, 20);
        expect(removed).toEqual([]);
        expect(kept.length).toBe(20);
        expect(readdirSync(dir).length).toBe(20);
    });

    test("fewer than keepN dirs → no removals", () => {
        seed(3);
        const { kept, removed } = rotateBackups(dir, 20);
        expect(removed).toEqual([]);
        expect(kept.length).toBe(3);
    });

    test("empty dir → no-op", () => {
        const { kept, removed } = rotateBackups(dir, 20);
        expect(kept).toEqual([]);
        expect(removed).toEqual([]);
    });

    test("nonexistent dir → no-op, no throw", () => {
        const { kept, removed } = rotateBackups("/tmp/does-not-exist-kindly-test", 20);
        expect(kept).toEqual([]);
        expect(removed).toEqual([]);
    });

    test("dotfiles are ignored in count and not removed", () => {
        seed(3);
        mkdirSync(join(dir, ".DS_Store_dir"));
        const { kept, removed } = rotateBackups(dir, 2);
        expect(removed.length).toBe(1);
        expect(kept.length).toBe(2);
        expect(readdirSync(dir)).toContain(".DS_Store_dir");
    });

    test("keep=0 removes everything", () => {
        seed(5);
        const { kept, removed } = rotateBackups(dir, 0);
        expect(removed.length).toBe(5);
        expect(kept).toEqual([]);
        expect(readdirSync(dir).length).toBe(0);
    });

    test("keep=1 retains only the newest", () => {
        const all = seed(10);
        const { kept, removed } = rotateBackups(dir, 1);
        expect(kept).toEqual([all[9]!]);
        expect(removed.length).toBe(9);
        expect(readdirSync(dir)).toEqual([all[9]!]);
    });
});
