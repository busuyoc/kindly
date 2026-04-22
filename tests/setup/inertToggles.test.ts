import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findInertToggles, listInstalledPluginFolders } from "../../src/setup/files.ts";

function makePluginsDir(names: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-inert-"));
    for (const n of names) {
        mkdirSync(join(root, n), { recursive: true });
        // A plugin needs main.lua; presence of the dir is enough for our check.
        writeFileSync(join(root, n, "main.lua"), "-- stub\n");
    }
    return root;
}

describe("listInstalledPluginFolders", () => {
    test("returns bare names, sorted, with .koplugin stripped", () => {
        const root = makePluginsDir(["SSH.koplugin", "calendar.koplugin", "coverbrowser.koplugin"]);
        expect(listInstalledPluginFolders(root)).toEqual(["SSH", "calendar", "coverbrowser"]);
    });

    test("ignores non-koplugin directories", () => {
        const root = makePluginsDir(["SSH.koplugin", "scratch", "data"]);
        expect(listInstalledPluginFolders(root)).toEqual(["SSH"]);
    });

    test("ignores dotfiles", () => {
        const root = makePluginsDir(["SSH.koplugin", ".Trash.koplugin"]);
        expect(listInstalledPluginFolders(root)).toEqual(["SSH"]);
    });

    test("missing dir → empty", () => {
        expect(listInstalledPluginFolders("/nonexistent/path/nope")).toEqual([]);
    });
});

describe("findInertToggles", () => {
    test("all toggles installed → empty", () => {
        expect(findInertToggles(["SSH", "calendar"], ["SSH", "calendar", "hello"])).toEqual([]);
    });

    test("toggle for missing plugin → returned", () => {
        expect(findInertToggles(["calendar"], ["SSH"])).toEqual(["calendar"]);
    });

    test("preserves input order", () => {
        expect(findInertToggles(["zzz", "aaa", "mmm"], [])).toEqual(["zzz", "aaa", "mmm"]);
    });

    test("mixed installed + inert", () => {
        expect(findInertToggles(["SSH", "calendar", "hello"], ["SSH", "hello"])).toEqual(["calendar"]);
    });

    test("empty toggle list → empty", () => {
        expect(findInertToggles([], ["SSH"])).toEqual([]);
    });
});
