// S960 — control bytes in `plugins.disabled` plugin names must not survive
// import. The names land as keys under on-device `plugins_disabled`, which
// KOReader's plugin manager UI reads back; ESC/OSC bytes there feed Batch
// O on-device renderer-injection chains (S321-class).
//
// The producer (controlByteHits) already scans keys at sensitive parents.
// What this file pins down: import passes the FLATTENED manifest into the
// gate so manifest.plugins.disabled — which lifts to plugins_disabled
// keys at apply time — gets scanned at the right boundary.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest } from "../../src/setup/schema.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-s960-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["night_mode"] = false,
}
`);
    mkdirSync(join(kor, "plugins"));
    mkdirSync(join(kor, "patches"));
    return root;
}

function makeEnv(cwd: string, mountOverride: string, setupsDir: string): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd, stdout: out, stderr: err, color: false, mountOverride,
            now: () => new Date("2026-04-26T12:00:00Z"),
            setupsDir,
            homeOverride: cwd,
        },
        out, err,
    };
}

function writeManifest(path: string, disabled: string[]): void {
    const parsed = parseManifest({
        kindly_setup: "v1",
        meta: { name: "s960-test", created_at: "2026-04-26T00:00:00Z" },
        apply_mode: "additive",
        plugins: { disabled },
    } as unknown as Parameters<typeof parseManifest>[0]);
    writeFileSync(path, canonicalizeManifest(parsed));
}

let workdir: string;
let setupsDir: string;
let kindleRoot: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-s960-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-s960-s-"));
    kindleRoot = makeFakeKindle();
});

describe("setup import — S960 control bytes in plugins.disabled", () => {
    test("ESC byte in plugin name → CONTROL_BYTES_IN_VALUE block", async () => {
        const { env, err } = makeEnv(workdir, kindleRoot, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        // Plugin name with embedded ESC — same shape as a Batch O
        // S321-class on-device-renderer injection payload.
        writeManifest(p, ["evil\x1bname"]);

        const code = await main(["setup", "import", p, "--dry-run"], env);
        expect(code).toBe(3);
        // Gate message names the path so the user can locate the bad entry.
        expect(err.value).toContain("plugins_disabled");
        // Hex codepoint listed; raw byte is NOT echoed (sanitize discipline).
        expect(err.value).toContain("0x1B");
        expect(err.value).not.toContain("\x1b");
    });

    test("CR byte in plugin name → blocks (CRLF smuggle class)", async () => {
        const { env, err } = makeEnv(workdir, kindleRoot, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["alice\r\nHost: evil"]);

        const code = await main(["setup", "import", p, "--dry-run"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("0x0D");
    });

    test("clean plugin names → import proceeds (no false positive)", async () => {
        const { env, err } = makeEnv(workdir, kindleRoot, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["SSH", "calibre", "kosync"]);

        // Clean names: no control-byte gate should fire. Inert-toggle
        // warning may still fire (those plugins aren't installed), so we
        // accept exit 0 or 4 — what we require is the absence of the
        // CONTROL_BYTES_IN_VALUE block (exit 3).
        const code = await main(
            ["setup", "import", p, "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).not.toBe(3);
        expect(err.value).not.toContain("0x1B");
    });

    test("--accept-sensitive does NOT bypass control-byte block", async () => {
        // CONTROL_BYTES_IN_VALUE is structural (no consent flag dissolves
        // it) — confirm that even the broadest sensitive-bypass doesn't
        // wave through ESC bytes in plugin names.
        const { env, err } = makeEnv(workdir, kindleRoot, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["evil\x1bname"]);

        const code = await main(
            ["setup", "import", p, "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(3);
        expect(err.value).toContain("0x1B");
    });
});
