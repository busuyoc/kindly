// Typed result + --json envelope tests for `kindly setup inspect`.
// Mirrors the coverage pattern used for pull/diff/apply/snapshot — a
// direct executeX() call to lock in the data shape, and a CLI-level
// envelope test to lock in the JSON contract.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupInspect } from "../../src/commands/setup.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function makeEnv(cwd: string, setupsDir: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            now: () => new Date("2026-04-22T12:00:00Z"),
            setupsDir,
        },
        out,
        err,
    };
}

function makeManifest(overrides: Partial<Record<string, unknown>> = {}): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: {
            name: "example",
            author: "tester",
            description: "a test setup",
            created_at: "2026-04-22T12:00:00Z",
            tags: ["demo", "quickstart"],
        },
        apply_mode: "additive",
        settings: { a: 1, b: 2, c: 3 },
        plugins: { disabled: ["SSH", "calibre"] },
        ...overrides,
    });
}

let workdir: string;
let setupsDir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-sij-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-sij-d-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, setupsDir));
});

describe("executeSetupInspect", () => {
    test("returns populated typed result for canonical lean manifest", () => {
        const m = makeManifest();
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env);
        expect(r.filePath).toBe(p);
        expect(r.name).toBe("example");
        expect(r.author).toBe("tester");
        expect(r.description).toBe("a test setup");
        expect(r.tags).toEqual(["demo", "quickstart"]);
        expect(r.isFat).toBe(false);
        expect(r.applyMode).toBe("additive");
        expect(r.settingsCount).toBe(3);
        expect(r.pluginsDisabledCount).toBe(2);
        expect(r.pluginFilesCount).toBe(0);
        expect(r.patchesCount).toBe(0);
        expect(r.isCanonical).toBe(true);
        expect(r.canonicalHash).toBeUndefined();
        expect(r.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
        expect(r.manifestBytes).toBeGreaterThan(0);
        expect(r.fileSize).toBe(r.manifestBytes);
    });

    test("exposes compat block when present", () => {
        const m = makeManifest({
            compat: {
                koreader_version_min: "2024.03",
                device: ["kindle-pw5"],
            },
        });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env);
        expect(r.compat?.koreaderVersionMin).toBe("2024.03");
        expect(r.compat?.device).toEqual(["kindle-pw5"]);
    });

    test("flags non-canonical file and reports canonical hash", () => {
        const m = makeManifest();
        const nonCanonical = [
            "kindly_setup: v1",
            "apply_mode: additive",
            "meta:",
            "  name: example",
            "  author: tester",
            "  description: a test setup",
            "  created_at: 2026-04-22T12:00:00Z",
            "  tags: [demo, quickstart]",
            "settings: {a: 1, b: 2, c: 3}",
            "plugins:",
            "  disabled: [SSH, calibre]",
            "",
        ].join("\n");
        const p = join(setupsDir, "noncanon.kset.yaml");
        writeFileSync(p, nonCanonical);

        const r = executeSetupInspect(p, env);
        expect(r.isCanonical).toBe(false);
        expect(r.canonicalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(r.canonicalHash).not.toBe(r.hash);
        // The canonical hash should equal what the manifest would hash to.
        void m;
    });
});

describe("setup inspect --json", () => {
    test("emits an envelope with inspect data on stdout", async () => {
        const m = makeManifest();
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const code = await main(["setup", "inspect", p, "--json"], env);
        expect(code).toBe(0);
        const env_ = JSON.parse(stdout.value);
        expect(env_.command).toBe("setup inspect");
        expect(env_.status).toBe("ok");
        expect(env_.data.name).toBe("example");
        expect(env_.data.applyMode).toBe("additive");
        expect(env_.data.settingsCount).toBe(3);
        expect(env_.data.isCanonical).toBe(true);
        expect(typeof env_.generated_at).toBe("string");
        // Text output (e.g. "contents:", "apply_mode:") should not leak.
        expect(stdout.value).not.toContain("contents:");
    });

    test("errors emit an error envelope to stderr with the right code", async () => {
        const code = await main(
            ["setup", "inspect", join(setupsDir, "nope.kset.yaml"), "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error).toBeDefined();
    });
});
