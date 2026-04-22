// Library-level tests for src/lib/importSetup.ts. Locks the programmatic
// API surface (SetupImportOptions shape, ImportResultWithExtras shape) and
// the "no printing" contract. Focused smoke tests — full behavior coverage
// lives in tests/cli/setupImport*.test.ts.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    executeSetupImport,
    loadManifestFile,
    flattenManifestForApply,
    type SetupImportOptions,
} from "../../src/lib/importSetup.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
}
`;

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-lib-si-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "test", created_at: "2026-04-22T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

let kindle: { root: string; settingsPath: string };
let workdir: string;
let manifestPath: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-lib-si-w-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeSetupImport (library)", () => {
    test("happy path: dryRun returns populated result without writing", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 2 },
        })));
        const opts: SetupImportOptions = { file: manifestPath, dryRun: true };
        const r = executeSetupImport(opts, env);
        expect(r.mode).toBe("dry-run");
        expect(r.setupFile).toBe(manifestPath);
        expect(r.applyMode).toBe("additive");
        expect(r.name).toBe("test");
        expect(r.changes.length).toBeGreaterThan(0);
    });

    test("no printing — stdout and stderr stay empty", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 2 },
        })));
        executeSetupImport({ file: manifestPath, dryRun: true }, env);
        expect(stdout.value).toBe("");
        expect(stderr.value).toBe("");
    });

    test("SetupImportOptions shape: no changes → mode=no-op", () => {
        writeFileSync(manifestPath, canonicalizeManifest(makeManifest({
            settings: { refresh_rate: 8, avoid_flashing_ui: false },
        })));
        const r = executeSetupImport({ file: manifestPath }, env);
        expect(r.mode).toBe("no-op");
    });
});

describe("loadManifestFile (library helper)", () => {
    test("returns parsed manifest + raw bytes", () => {
        const m = makeManifest({ settings: { refresh_rate: 2 } });
        writeFileSync(manifestPath, canonicalizeManifest(m));
        const { raw, manifest } = loadManifestFile(manifestPath);
        expect(manifest.meta.name).toBe("test");
        expect(raw.length).toBeGreaterThan(0);
    });
});

describe("flattenManifestForApply (library helper)", () => {
    test("merges settings with plugin toggles into a single flat map", () => {
        const m = makeManifest({
            settings: { refresh_rate: 2 },
            plugins: { disabled: ["SSH"] },
        });
        const flat = flattenManifestForApply(m);
        expect(flat["refresh_rate"]).toBe(2);
        expect(flat["plugins_disabled"]).toBeDefined();
    });
});
