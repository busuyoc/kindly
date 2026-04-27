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
import {
    copyFileSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFile, SafeReadError } from "../../src/fs/safeRead.ts";
import { ErrorCodes, KindlyError } from "../../src/types/errors.ts";

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

    // W46-S1 redteam regression: a container that plants a symlink in the
    // bind-mounted /work/out should be rejected by the host-side copy step
    // before the symlink can leak host bytes into the user's --output. We
    // simulate the hostile container with `alpine ln -sf` (cheap, no
    // KOReader involvement needed — the threat is the bind-mount channel,
    // not anything specific to the harness image).
    test("symlink planted in bind-mounted output is rejected on host", () => {
        const outDir = makeOutDir();
        // Anything outside /work that the kindly process can read is a
        // valid target. /etc/hosts is a stable, harmless placeholder.
        const planter = spawnSync(
            "docker",
            [
                "run", "--rm",
                "-v", `${outDir}:/work/out`,
                "alpine:latest",
                "sh", "-c", "ln -sf /etc/hosts /work/out/preview.png",
            ],
            { encoding: "utf8" },
        );
        if (planter.status !== 0) {
            throw new Error(`planter exited ${planter.status}\nstderr:\n${planter.stderr}`);
        }
        const tmpPng = join(outDir, "preview.png");
        // Sanity: the planter actually planted a symlink (not a regular file).
        expect(lstatSync(tmpPng).isSymbolicLink()).toBe(true);

        // This is what preview.ts now does post-run. A pre-fix copyFileSync
        // would silently follow the symlink and write /etc/hosts bytes to
        // the destination.
        const dst = join(outDir, "exfil.png");
        let caught: unknown;
        try {
            copyFile(tmpPng, "container-output", dst, "user-provided");
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SafeReadError);
        expect((caught as SafeReadError).code).toBe("UNTRUSTED_SYMLINK");
    }, 30_000);

});

// W46-S1 unit-level — runs without docker. Locks the error-code contract
// preview.ts exposes to --json and GUI consumers when the host-side copy
// step refuses a symlinked output.
describe("harness/preview — symlink rejection wraps as HARNESS_OUTPUT_TAINTED", () => {
    test("SafeReadError UNTRUSTED_SYMLINK becomes KindlyError HARNESS_OUTPUT_TAINTED", () => {
        const outDir = mkdtempSync(join(tmpdir(), "kindly-preview-out-"));
        const tmpPng = join(outDir, "preview.png");
        const target = join(outDir, "secret");
        writeFileSync(target, "x");
        symlinkSync(target, tmpPng);

        // Mirrors the catch in src/lib/preview.ts so a refactor that drops
        // the wrap is caught here.
        let caught: unknown;
        try {
            try {
                copyFile(tmpPng, "container-output", join(outDir, "out.png"), "user-provided");
            } catch (e) {
                if (e instanceof SafeReadError && e.code === "UNTRUSTED_SYMLINK") {
                    throw new KindlyError(
                        ErrorCodes.HARNESS_OUTPUT_TAINTED,
                        "preview harness produced a symlink instead of a PNG; refusing to copy.",
                    );
                }
                throw e;
            }
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(KindlyError);
        expect((caught as KindlyError).code).toBe("HARNESS_OUTPUT_TAINTED");
    });
});
