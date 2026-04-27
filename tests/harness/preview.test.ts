// Slice 3 — KOReader harness screenshot pipeline.
//
// Builds a fake KO_HOME, runs the harness in --mode=preview, asserts
// the screenshot lands at the bind-mounted output path with PNG magic
// bytes. No pixel-level assertion in MVP — that's image-snapshot
// territory and belongs in v0.15+.
//
// Gated by KINDLY_HARNESS_DOCKER=1 same as boot.test.ts.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS_ENABLED = process.env.KINDLY_HARNESS_DOCKER === "1";
const IMAGE = "kindly-koreader:dev";
const REDACTED_FIXTURE = "tests/fixtures/kindle/redacted/settings.reader.lua";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dockerAvailable(): boolean {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function makeKoHome(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-preview-ko-"));
    mkdirSync(root, { recursive: true });
    copyFileSync(REDACTED_FIXTURE, join(root, "settings.reader.lua"));
    return root;
}

function makeOutDir(): string {
    return mkdtempSync(join(tmpdir(), "kindly-preview-out-"));
}

describe("harness/preview — Screen:shot writes a PNG to bind-mounted output", () => {
    if (!HARNESS_ENABLED) {
        test.skip("KINDLY_HARNESS_DOCKER!=1 — skipping", () => {});
        return;
    }
    if (!dockerAvailable()) {
        test.skip("docker daemon not reachable — skipping", () => {});
        return;
    }

    test("preview mode against the redacted fixture produces a PNG", () => {
        const koHome = makeKoHome();
        const outDir = makeOutDir();

        const r = spawnSync(
            "docker",
            [
                "run", "--rm",
                "--network=none",
                "-e", "KO_HOME=/work/ko_home",
                "-e", "KINDLY_SCREENSHOT=/work/out/preview.png",
                "-e", "KINDLY_SCREENSHOT_DELAY=2",
                "-v", `${koHome}:/work/ko_home`,
                "-v", `${outDir}:/work/out`,
                IMAGE,
                "--mode=preview",
            ],
            { encoding: "utf8" },
        );
        if (r.status !== 0) {
            throw new Error(`harness exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
        }

        const pngPath = join(outDir, "preview.png");
        const stat = statSync(pngPath);
        // A real KOReader frame is at least a few KB; arbitrary lower
        // bound just to catch "0-byte file got created and abandoned".
        expect(stat.size).toBeGreaterThan(1024);

        const head = readFileSync(pngPath).subarray(0, 8);
        expect(Buffer.compare(head, PNG_MAGIC)).toBe(0);
    }, 90_000);
});
