// C10b/C10c: detection + recovery of step-4-interrupted safeWrite state.
//
// Step-4 means: settings.reader.lua absent + .old present. We test that:
//   1. Pull/diff/doctor surface SETTINGS_INTERRUPTED_APPLY (not raw ENOENT).
//   2. doctor --repair restores .old when no marker matches.
//   3. doctor --repair promotes a .tmp whose hash matches the marker's
//      intended_sha256.
//   4. Orphan .tmps are swept regardless of step-4 state.
//   5. Mount fingerprint mismatch on a marker blocks repair (override
//      via --force-mount).

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
    rmSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executePull } from "../../src/lib/pull.ts";
import { executeDiff } from "../../src/lib/diff.ts";
import { executeDoctor } from "../../src/lib/doctor.ts";
import { executeDoctorRepair } from "../../src/lib/doctorRepair.ts";
import { executeApply } from "../../src/lib/apply.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import { KindlyError } from "../../src/types/errors.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let settingsPath: string;
let oldPath: string;

function makeFakeKindle(initial: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-c10-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initial, "./settings.reader.lua"),
    );
    // Mount fingerprint anchors — without these, computeMountFingerprint
    // returns all-nulls, and the C10a "null on either side = no signal"
    // rule would short-circuit the mismatch check.
    mkdirSync(join(root, "system"));
    writeFileSync(join(root, "system", "version.txt"), "Kindle 5.16.2.1\n");
    writeFileSync(join(root, "koreader", "git-rev"), "v2026.04-1");
    return root;
}

/** Manually fabricate a step-4 interrupted state: rename main → .old,
 *  leave main absent. Mirrors what safeWrite does between step 3 and 4. */
function induceStep4Interruption(kindle: string): void {
    const main = join(kindle, "koreader", "settings.reader.lua");
    const old = main + ".old";
    renameSync(main, old);
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({ avoid_flashing_ui: true });
    workdir = mkdtempSync(join(tmpdir(), "kindly-c10-w-"));
    settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
    oldPath = settingsPath + ".old";
    env = {
        cwd: workdir,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-25T12:00:00Z"),
    };
});

describe("C10b: step-4 interruption surfaces SETTINGS_INTERRUPTED_APPLY", () => {
    test("pull throws SETTINGS_INTERRUPTED_APPLY (not SETTINGS_NOT_FOUND)", () => {
        induceStep4Interruption(fakeKindle);
        let err: KindlyError | null = null;
        try { executePull({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("SETTINGS_INTERRUPTED_APPLY");
        expect(err!.remediation[0]?.command).toBe("kindly doctor --repair");
    });

    test("diff throws SETTINGS_INTERRUPTED_APPLY when YAML present + main absent", () => {
        writeFileSync(join(workdir, "kindly.yaml"), "avoid_flashing_ui: true\n");
        induceStep4Interruption(fakeKindle);
        let err: KindlyError | null = null;
        try { executeDiff({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("SETTINGS_INTERRUPTED_APPLY");
    });

    test("apply throws SETTINGS_INTERRUPTED_APPLY (not raw ENOENT) when main absent + .old present", () => {
        writeFileSync(join(workdir, "kindly.yaml"), "avoid_flashing_ui: true\n");
        induceStep4Interruption(fakeKindle);
        let err: KindlyError | null = null;
        try { executeApply({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("SETTINGS_INTERRUPTED_APPLY");
        expect(err!.remediation[0]?.command).toBe("kindly doctor --repair");
    });

    test("doctor reports settings_interrupted_apply as fatal (does not throw)", () => {
        induceStep4Interruption(fakeKindle);
        const r = executeDoctor(env);
        expect(r.ok).toBe(false);
        const interrupted = r.checks.find((c) => c.id === "settings_interrupted_apply");
        expect(interrupted).toBeDefined();
        expect(interrupted!.severity).toBe("fatal");
        expect(interrupted!.detail).toContain("kindly doctor --repair");
    });

    test("plain ENOENT on both main and .old still reports settings_present (no false positive)", () => {
        rmSync(settingsPath);
        // .old never existed in our fake kindle setup.
        const r = executeDoctor(env);
        const interrupted = r.checks.find((c) => c.id === "settings_interrupted_apply");
        expect(interrupted).toBeUndefined();
        const notFound = r.checks.find((c) => c.id === "settings_present");
        expect(notFound).toBeDefined();
        expect(notFound!.severity).toBe("fatal");
    });
});

describe("C10c: doctor --repair recovers step-4 state", () => {
    test("no markers, no tmps: restores .old → main", () => {
        induceStep4Interruption(fakeKindle);
        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("restored-old");
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(oldPath)).toBe(false);
        expect(r.sweptTmps).toEqual([]);
    });

    test("matching marker + tmp: promotes .tmp → main", () => {
        induceStep4Interruption(fakeKindle);
        // Create a tmp that contains "intended" bytes, plus a marker
        // whose intended_sha256 matches them.
        const intended = dumpSettingsFile(
            { avoid_flashing_ui: true, font_size: 24 },
            "./settings.reader.lua",
        );
        const tmpPath = settingsPath + ".tmp." + process.pid + ".deadbeef";
        writeFileSync(tmpPath, intended);
        const wantHash = createHash("sha256").update(intended).digest("hex");

        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "apply-99999-x.json"), JSON.stringify({
            cmd: "apply",
            started_at: "2026-04-25T11:59:00Z",
            pid: 99999,
            settings_path: settingsPath,
            intended_sha256: wantHash,
        }));

        const r = executeDoctorRepair({}, env);
        expect(r.settingsRecovery).toBe("promoted-tmp");
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(tmpPath)).toBe(false);
        // .old was the prior state; after promotion we leave it on disk
        // (KOReader still uses it as a fallback). Sweep is tmp-only.
        expect(existsSync(oldPath)).toBe(true);
        // Promoted bytes equal what the marker said.
        expect(readFileSync(settingsPath, "utf8")).toBe(intended);
        expect(r.clearedMarkers).toHaveLength(1);
    });

    test("non-matching tmp: falls through to .old restoration and sweeps the tmp", () => {
        induceStep4Interruption(fakeKindle);
        const tmpPath = settingsPath + ".tmp." + process.pid + ".cafef00d";
        writeFileSync(tmpPath, "garbage that does not match any marker");

        const r = executeDoctorRepair({}, env);
        expect(r.settingsRecovery).toBe("restored-old");
        expect(r.sweptTmps).toContain(tmpPath);
        expect(existsSync(tmpPath)).toBe(false);
    });

    test("dry-run reports the plan without writing", () => {
        induceStep4Interruption(fakeKindle);
        const r = executeDoctorRepair({ dryRun: true }, env);
        expect(r.mode).toBe("dry-run");
        expect(r.settingsRecovery).toBe("restored-old");
        // .old is still on disk; main is still absent.
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(oldPath)).toBe(true);
    });

    test("no-op when there's nothing to recover", () => {
        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("no-op");
        expect(r.settingsRecovery).toBe("none");
    });

    test("orphan tmp is swept even when main is present", () => {
        const tmpPath = settingsPath + ".tmp." + process.pid + ".0badf00d";
        writeFileSync(tmpPath, "leftover");
        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("none");
        expect(r.sweptTmps).toContain(tmpPath);
        expect(existsSync(tmpPath)).toBe(false);
    });

    test("marker fingerprint mismatch blocks repair; --force-mount overrides", () => {
        induceStep4Interruption(fakeKindle);
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "apply-1-y.json"), JSON.stringify({
            cmd: "apply",
            started_at: "2026-04-25T11:00:00Z",
            pid: 1,
            settings_path: settingsPath,
            mount: {
                device_version: "Kindle 99.99 — different device",
                koreader_version: "v9999",
                anchor_mtime_iso: "2099-01-01T00:00:00.000Z",
            },
        }));

        let err: KindlyError | null = null;
        try { executeDoctorRepair({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("MOUNT_FINGERPRINT_MISMATCH");

        const r = executeDoctorRepair({ forceMount: true }, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("restored-old");
    });
});
