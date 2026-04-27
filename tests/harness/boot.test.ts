// Slice 2 — KOReader harness boot-and-exit regression.
//
// Builds a fake KO_HOME from the redacted fixture, runs the harness
// container in --mode=boot-and-exit, asserts exit 0. Catches the same
// class of bugs as docs/96 red-team probes (apply a bad config, watch
// the device wedge) but reproducibly and locally instead of on
// hardware.
//
// Gated by KINDLY_HARNESS_DOCKER=1 because the container build is a
// 15-30 min cold cost. CI sets the flag once the harness image lives
// in GHCR; local devs run `bun test:harness` after building once.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS_ENABLED = process.env.KINDLY_HARNESS_DOCKER === "1";
const IMAGE = "kindly-koreader:dev";
const REDACTED_FIXTURE = "tests/fixtures/kindle/redacted/settings.reader.lua";

function dockerAvailable(): boolean {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function makeKoHome(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-harness-"));
    mkdirSync(root, { recursive: true });
    copyFileSync(REDACTED_FIXTURE, join(root, "settings.reader.lua"));
    return root;
}

describe("harness/boot — KOReader emulator boots cleanly under offscreen SDL3", () => {
    if (!HARNESS_ENABLED) {
        test.skip("KINDLY_HARNESS_DOCKER!=1 — skipping (cold harness build is expensive)", () => {});
        return;
    }
    if (!dockerAvailable()) {
        test.skip("docker daemon not reachable — skipping", () => {});
        return;
    }

    test("boot-and-exit on the redacted fixture exits 0", () => {
        const koHome = makeKoHome();
        const r = spawnSync(
            "docker",
            [
                "run", "--rm",
                "--network=none",
                "-e", "KO_HOME=/work/ko_home",
                "-v", `${koHome}:/work/ko_home`,
                IMAGE,
                "--mode=boot-and-exit",
            ],
            { encoding: "utf8" },
        );
        if (r.status !== 0) {
            // Surface stderr so a CI failure is debuggable.
            throw new Error(`harness exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
        }
        expect(r.status).toBe(0);
    }, 60_000);
});
