// End-to-end byte-fidelity test: if a user `kindly pull`s, changes nothing
// in kindly.yaml, then `kindly apply`s, the on-device file must be
// byte-identical to what was there before. Anything less and KOReader
// can silently fall back to its .old copy via pcall(dofile).
//
// This is the single most important guarantee kindly makes. If it ever
// breaks, every other feature is in doubt.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    copyFileSync, mkdirSync, mkdtempSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

const REAL_FIXTURE = "tests/fixtures/kindle/redacted/settings.reader.lua";

function makeEnv(cwd: string, mountOverride: string): CliEnv {
    return {
        cwd,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        mountOverride,
        now: () => new Date("2026-04-21T12:00:00Z"),
    };
}

describe("byte-identical round-trip: pull → apply leaves the device untouched", () => {
    let fakeKindle: string;
    let workdir: string;
    let settingsPath: string;

    beforeEach(() => {
        fakeKindle = mkdtempSync(join(tmpdir(), "kindly-bid-k-"));
        mkdirSync(join(fakeKindle, "koreader"));
        settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        copyFileSync(REAL_FIXTURE, settingsPath);
        workdir = mkdtempSync(join(tmpdir(), "kindly-bid-w-"));
    });

    test("pull (minimal) → apply: device file byte-identical", async () => {
        const env = makeEnv(workdir, fakeKindle);
        const before = readFileSync(settingsPath, "utf8");

        expect(await main(["pull"], env)).toBe(0);
        // No changes to kindly.yaml — apply should be a no-op and device
        // must not be rewritten at all (no-change fast path).
        expect(await main(["apply"], env)).toBe(0);

        const after = readFileSync(settingsPath, "utf8");
        expect(after).toBe(before);
    });

    test("pull (full) → apply: even with ephemerals included, byte-identical", async () => {
        const env = makeEnv(workdir, fakeKindle);
        const before = readFileSync(settingsPath, "utf8");

        expect(await main(["pull", "--full"], env)).toBe(0);
        expect(await main(["apply"], env)).toBe(0);

        const after = readFileSync(settingsPath, "utf8");
        expect(after).toBe(before);
    });

    test("after trivial change + apply: secrets on device still exact", async () => {
        // Pull, flip one user-facing key, apply, check that the on-device
        // file still contains the exact secret values it had before apply.
        const env = makeEnv(workdir, fakeKindle);
        const before = readFileSync(settingsPath, "utf8");
        // The fixture stores these as REDACTED — we just need to show
        // the string survives round-trip.
        expect(before).toContain('"zlibrary_password"] = "REDACTED"');

        expect(await main(["pull"], env)).toBe(0);
        const yamlPath = join(workdir, "kindly.yaml");
        const yaml = readFileSync(yamlPath, "utf8")
            .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false");
        require("node:fs").writeFileSync(yamlPath, yaml);

        expect(await main(["apply"], env)).toBe(0);
        const after = readFileSync(settingsPath, "utf8");
        // The secret line survives unchanged (byte-for-byte)
        expect(after).toContain('"zlibrary_password"] = "REDACTED"');
        expect(after).toContain('"pinpadlock_pin_code"] = "REDACTED"');
        // and the change we requested landed
        expect(after).toContain('"avoid_flashing_ui"] = false');
    });
});
