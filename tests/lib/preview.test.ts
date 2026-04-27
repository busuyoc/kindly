// Library-level tests for src/lib/preview.ts. Locks PreviewOptions /
// PreviewResult shape and end-to-end pipeline behavior.
//
// The "spawn docker, render PNG" path is gated by KINDLY_HARNESS_DOCKER=1.
// Argument-validation paths run unconditionally.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executePreview } from "../../src/lib/preview.ts";
import { runPreview } from "../../src/commands/preview.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { ArgError } from "../../src/cli/args.ts";
import { KindlyError } from "../../src/types/errors.ts";

const HARNESS_ENABLED = process.env.KINDLY_HARNESS_DOCKER === "1";
const dockerAvailable = (): boolean =>
    spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-preview-lib-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        now: () => new Date("2026-04-27T12:00:00Z"),
    };
});

describe("executePreview — argument validation", () => {
    test("YAML missing → YAML_NOT_FOUND", async () => {
        let err: KindlyError | null = null;
        try {
            await executePreview(
                { file: "missing.yaml", output: join(workdir, "out.png"), mount: "" },
                env,
            );
        } catch (e) { err = e as KindlyError; }
        expect(err).not.toBeNull();
        expect(err!.code).toBe("YAML_NOT_FOUND");
    });

    test("runPreview without --output → ArgError", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "font_size: 22\n");
        let err: ArgError | null = null;
        try { await runPreview([], env); }
        catch (e) { err = e as ArgError; }
        expect(err).not.toBeNull();
        expect(err!.message).toContain("--output");
    });

    test("--delay rejects non-numeric", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "font_size: 22\n");
        let err: ArgError | null = null;
        try {
            await runPreview(
                ["--output=out.png", "--delay=abc", "--mount="],
                env,
            );
        } catch (e) { err = e as ArgError; }
        expect(err).not.toBeNull();
        expect(err!.message).toContain("--delay");
    });
});

describe("executePreview — end-to-end (gated)", () => {
    if (!HARNESS_ENABLED) {
        test.skip("KINDLY_HARNESS_DOCKER!=1 — skipping", () => {});
        return;
    }
    if (!dockerAvailable()) {
        test.skip("docker daemon not reachable — skipping", () => {});
        return;
    }

    test("renders a PNG against KOReader defaults (--mount=)", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "font_size: 22\n");
        const out = join(workdir, "preview.png");
        const r = await executePreview(
            { output: out, mount: "", delaySeconds: 2 },
            env,
        );
        expect(r.outputPath).toBe(out);
        expect(r.usedDeviceBaseline).toBe(false);
    }, 90_000);

    test("merges over device baseline when a fake mount is supplied", async () => {
        // A fake mount with the redacted fixture as settings.reader.lua.
        const mount = mkdtempSync(join(tmpdir(), "kindly-preview-mount-"));
        mkdirSync(join(mount, "koreader"), { recursive: true });
        const fixture = join(
            import.meta.dir, "..", "fixtures", "kindle", "redacted",
            "settings.reader.lua",
        );
        writeFileSync(
            join(mount, "koreader", "settings.reader.lua"),
            require("node:fs").readFileSync(fixture, "utf8"),
        );

        writeFileSync(join(workdir, "kindly.yaml"), "font_size: 22\n");
        const out = join(workdir, "preview.png");
        const r = await executePreview(
            { output: out, mount, delaySeconds: 2 },
            env,
        );
        expect(r.usedDeviceBaseline).toBe(true);
    }, 90_000);
});
