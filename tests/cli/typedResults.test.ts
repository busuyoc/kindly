// Direct tests for the typed result shapes returned by executePull and
// executeDiff. These exist alongside commands.test.ts (which tests via
// main() and stdout grep) to lock the result contract independent of how
// text rendering happens to print things today.
//
// If these tests fail, the JSON output (W3) and any future in-process
// consumer are off-spec. If commands.test.ts fails, rendering is off.
// The split is intentional.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { executePull } from "../../src/commands/pull.ts";
import { executeDiff } from "../../src/commands/diff.ts";
import type { PullResult, DiffResult } from "../../src/types/results.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({
        avoid_flashing_ui: true,
        back_to_exit: "prompt",
        footer: { align: "left", battery: true } as any,
        plugins_disabled: { SSH: true } as any,
        // secrets
        zlibrary_password: "hunter2",
        pinpadlock_pin_code: "1980",
        device_id: "ABC123",
        // ephemerals
        lastfile: "/mnt/us/Books/a.epub",
        last_migration_date: 20260306,
        // nested secret
        kosync: { auto_sync: true, userkey: "s3cr3t" } as any,
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
    env = {
        cwd: workdir,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("PullResult shape", () => {
    test("default (minimal) pull returns populated result", () => {
        const result: PullResult = executePull({}, env);

        expect(result.mode).toBe("minimal");
        expect(result.settingsPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua"));
        expect(result.outputPath).toBe(join(workdir, "kindly.yaml"));
        expect(result.bytes).toBeGreaterThan(0);
        expect(result.lines).toBeGreaterThan(0);
        expect(result.bytes).toBe(Buffer.byteLength(readFileSync(result.outputPath, "utf8")));
    });

    test("droppedSecrets lists top-level + nested secrets, sorted", () => {
        const { droppedSecrets } = executePull({}, env);

        // Top-level denylisted secrets
        expect(droppedSecrets).toContain("zlibrary_password");
        expect(droppedSecrets).toContain("pinpadlock_pin_code");
        expect(droppedSecrets).toContain("device_id");
        // Nested secret path
        expect(droppedSecrets).toContain("kosync.userkey");

        // Deterministic ordering — callers can rely on this for display / diff.
        const sorted = [...droppedSecrets].sort();
        expect(droppedSecrets).toEqual(sorted);
    });

    test("minimal mode populates droppedEphemerals", () => {
        const { mode, droppedEphemerals } = executePull({}, env);

        expect(mode).toBe("minimal");
        expect(droppedEphemerals).toContain("lastfile");
        expect(droppedEphemerals).toContain("last_migration_date");

        const sorted = [...droppedEphemerals].sort();
        expect(droppedEphemerals).toEqual(sorted);
    });

    test("full mode returns empty droppedEphemerals", () => {
        const result = executePull({ full: true }, env);

        expect(result.mode).toBe("full");
        expect(result.droppedEphemerals).toEqual([]);
        // Secrets still dropped even in --full.
        expect(result.droppedSecrets).toContain("zlibrary_password");
    });

    test("custom output path is reflected in result", () => {
        const result = executePull({ output: "my.yaml" }, env);
        expect(result.outputPath).toBe(join(workdir, "my.yaml"));
        expect(existsSync(result.outputPath)).toBe(true);
    });

    test("output collision without --force throws", () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        expect(() => executePull({}, env)).toThrow(/already exists/);
    });

    test("--force overwrites", () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        const result = executePull({ force: true }, env);
        expect(readFileSync(result.outputPath, "utf8")).not.toBe("already here");
    });

    test("result is JSON-serializable (no Map/function/undefined fields)", () => {
        const result = executePull({}, env);
        // Round-trips through JSON unchanged — this is the W3 precondition.
        const roundtripped = JSON.parse(JSON.stringify(result));
        expect(roundtripped).toEqual(result);
    });
});

describe("DiffResult shape", () => {
    function pulledYaml(): string {
        // Pull first so a sibling kindly.yaml exists for diffing.
        executePull({}, env);
        return join(workdir, "kindly.yaml");
    }

    test("device matches pulled YAML → empty changes", () => {
        pulledYaml();
        const result: DiffResult = executeDiff({}, env);

        expect(result.changes).toEqual([]);
        expect(result.yamlPath).toBe(join(workdir, "kindly.yaml"));
        expect(result.settingsPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua"));
    });

    test("modified YAML produces structured Change entries", () => {
        const yamlPath = pulledYaml();
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );

        const result = executeDiff({}, env);
        expect(result.changes.length).toBeGreaterThan(0);

        const affected = result.changes.find((c) => c.path.join(".") === "avoid_flashing_ui");
        expect(affected).toBeDefined();
        expect(affected?.kind).toBe("changed");
        if (affected?.kind === "changed") {
            expect(affected.prev).toBe(true);
            expect(affected.next).toBe(false);
        }
    });

    test("untrackedKeys reports on-device keys missing from YAML", () => {
        // --minimal pull drops ephemerals; device still has lastfile etc.
        pulledYaml();
        const result = executeDiff({}, env);

        expect(result.untrackedKeys).toContain("lastfile");
        expect(result.untrackedKeys).toContain("last_migration_date");
        // Secrets stay on device too — they were never in YAML to begin with.
        expect(result.untrackedKeys).toContain("zlibrary_password");
        // Sorted for determinism.
        expect(result.untrackedKeys).toEqual([...result.untrackedKeys].sort());
    });

    test("changes are in deterministic order", () => {
        const yamlPath = pulledYaml();
        // Introduce multiple changes at once.
        let yaml = readFileSync(yamlPath, "utf8");
        yaml = yaml.replace("avoid_flashing_ui: true", "avoid_flashing_ui: false");
        yaml = yaml.replace("back_to_exit: prompt", "back_to_exit: disable");
        writeFileSync(yamlPath, yaml);

        const a = executeDiff({}, env);
        const b = executeDiff({}, env);
        expect(a.changes).toEqual(b.changes);
    });

    test("missing YAML throws", () => {
        expect(() => executeDiff({}, env)).toThrow(/not found/);
    });

    test("custom --file path is used", () => {
        executePull({ output: "custom.yaml" }, env);
        const result = executeDiff({ file: "custom.yaml" }, env);
        expect(result.yamlPath).toBe(join(workdir, "custom.yaml"));
    });

    test("result is JSON-serializable", () => {
        pulledYaml();
        const result = executeDiff({}, env);
        const roundtripped = JSON.parse(JSON.stringify(result));
        expect(roundtripped).toEqual(result);
    });
});
