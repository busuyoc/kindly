// Library-level tests for src/lib/setupInspect.ts. Locks the programmatic
// API (SetupInspectOptions, SetupInspectResult shape) and the "no printing"
// contract.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    executeSetupInspect,
    type SetupInspectOptions,
} from "../../src/lib/setupInspect.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "inspect-fixture", created_at: "2026-04-22T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

let workdir: string;
let manifestPath: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-si-w-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeSetupInspect (library)", () => {
    test("happy path: returns structured summary of a lean manifest", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 2, avoid_flashing_ui: true },
        })));
        const r = executeSetupInspect(manifestPath, env);
        expect(r.name).toBe("inspect-fixture");
        expect(r.applyMode).toBe("additive");
        expect(r.settingsCount).toBe(2);
        expect(r.isFat).toBe(false);
        expect(r.isCanonical).toBe(true);
        expect(r.id).toMatch(/^[0-9a-f]{12}$/);
    });

    test("no printing — stdout and stderr stay empty", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 2 },
        })));
        executeSetupInspect(manifestPath, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("SetupInspectOptions shape: preview=vs-default attaches a diff", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 2 },
        })));
        const opts: SetupInspectOptions = { preview: "vs-default" };
        const r = executeSetupInspect(manifestPath, env, opts);
        expect(r.preview).toBeDefined();
        expect(r.preview!.mode).toBe("vs-default");
        expect(r.preview!.changes.length).toBeGreaterThan(0);
        expect(r.preview!.settingsPath).toBeUndefined();
    });
});
