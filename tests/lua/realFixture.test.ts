// Byte-identical round-trip tests against real KOReader-written files.
//
// The redacted fixture is committed and always runs. The un-redacted real
// fixture at tests/fixtures/kindle/settings.reader.lua is gitignored
// (contains PINs, passwords, device IDs), and the corresponding test is
// skipped when it's not present — useful when developing with a Kindle
// plugged in, invisible in CI.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseSettingsFile } from "../../src/lua/reader.ts";
import { dumpSettingsFile } from "../../src/lua/writer.ts";

const REAL_PATH = "tests/fixtures/kindle/settings.reader.lua";
const REDACTED_PATH = "tests/fixtures/kindle/redacted/settings.reader.lua";

function assertByteIdenticalRoundTrip(path: string) {
    const src = readFileSync(path, "utf8");
    const parsed = parseSettingsFile(src);
    const redumped = dumpSettingsFile(parsed as any, "./settings.reader.lua");
    expect(redumped).toBe(src);
}

describe("real-device round-trip — redacted fixture (committed)", () => {
    test("parse + re-dump is byte-identical", () => {
        assertByteIdenticalRoundTrip(REDACTED_PATH);
    });
});

describe("real-device round-trip — live Kindle fixture (gitignored)", () => {
    if (!existsSync(REAL_PATH)) {
        test.skip("no live fixture present", () => {});
        return;
    }
    test("parse + re-dump is byte-identical on real settings.reader.lua", () => {
        assertByteIdenticalRoundTrip(REAL_PATH);
    });
});
