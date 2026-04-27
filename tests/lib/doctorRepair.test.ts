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
    test("no markers, no tmps, --accept-old: restores .old → main", () => {
        // Round-6 S2126: missing-marker path now requires --accept-old.
        // The legitimate "I trust this .old" recovery still works behind
        // the explicit opt-in.
        induceStep4Interruption(fakeKindle);
        const r = executeDoctorRepair({ acceptOld: true }, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("restored-old");
        expect(existsSync(settingsPath)).toBe(true);
        expect(existsSync(oldPath)).toBe(false);
        expect(r.sweptTmps).toEqual([]);
    });

    // Round 3 doctor HIGH closure: tmp promotion is opt-in. Default
    // recovery (no --promote-tmp) restores .old; --promote-tmp is the
    // explicit "yes I trust the on-disk marker" path. Both behaviors
    // are tested so the gate stays meaningful.
    test("matching marker + tmp WITH --promote-tmp: promotes .tmp → main", () => {
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

        const r = executeDoctorRepair({ promoteTmp: true }, env);
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

    test("matching marker + tmp WITHOUT --promote-tmp: restores .old, sweeps tmp", () => {
        induceStep4Interruption(fakeKindle);
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

        // Default repair: even though the marker hash-matches, promotion
        // requires explicit opt-in. Forged-marker RCE primitive denied.
        const r = executeDoctorRepair({}, env);
        expect(r.settingsRecovery).toBe("restored-old");
        expect(r.sweptTmps).toContain(tmpPath);
        expect(existsSync(tmpPath)).toBe(false);
        expect(r.clearedMarkers).toHaveLength(1);
    });

    test("non-matching tmp + --accept-old: falls through to .old restoration and sweeps the tmp", () => {
        induceStep4Interruption(fakeKindle);
        const tmpPath = settingsPath + ".tmp." + process.pid + ".cafef00d";
        writeFileSync(tmpPath, "garbage that does not match any marker");

        const r = executeDoctorRepair({ acceptOld: true }, env);
        expect(r.settingsRecovery).toBe("restored-old");
        expect(r.sweptTmps).toContain(tmpPath);
        expect(existsSync(tmpPath)).toBe(false);
    });

    test("dry-run reports the plan without writing", () => {
        induceStep4Interruption(fakeKindle);
        const r = executeDoctorRepair({ dryRun: true, acceptOld: true }, env);
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

// Round-6 GG closures. Each fix gets a focused test that exercises the
// attack vector pre-fix and asserts the new gate fires.
describe("round 6 GG: doctor --repair hardening", () => {
    test("S2126: missing marker without --accept-old refuses with DOCTOR_REPAIR_REJECTED", () => {
        // Fresh-install plant attack: attacker drops a single .old file
        // on a device that never had main+marker. Pre-fix `--repair`
        // adopted it as canonical settings.
        induceStep4Interruption(fakeKindle);
        let err: KindlyError | null = null;
        try { executeDoctorRepair({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("DOCTOR_REPAIR_REJECTED");
        // .old still on disk; main still absent. No mutation occurred.
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(oldPath)).toBe(true);
    });

    test("S2126: marker referencing settingsPath allows repair without --accept-old", () => {
        // Provenance signal: a kindly apply wrote a marker before the
        // SIGKILL that produced step-4 state. Repair adopts the .old
        // because the marker proves it came from an interrupted apply.
        induceStep4Interruption(fakeKindle);
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "apply-7-z.json"), JSON.stringify({
            cmd: "apply",
            started_at: "2026-04-25T11:00:00Z",
            pid: 7,
            settings_path: settingsPath,
        }));
        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("restored-old");
    });

    test("S2112: malformed-Lua .old refuses adoption with DOCTOR_REPAIR_REJECTED", () => {
        // Attacker stages bytes that aren't parseable Lua at .old. The
        // missing-marker gate already protects this case; pass --accept-old
        // to reach the parse gate underneath.
        induceStep4Interruption(fakeKindle);
        writeFileSync(oldPath, "-- ATTACKER_PAYLOAD_NOT_LUA\nthis_is_not_valid_lua\x00");
        let err: KindlyError | null = null;
        try { executeDoctorRepair({ acceptOld: true }, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("DOCTOR_REPAIR_REJECTED");
        // No mutation: main still absent.
        expect(existsSync(settingsPath)).toBe(false);
        expect(existsSync(oldPath)).toBe(true);
    });

    test("S2113: control-byte-laden SECRET in .old refuses adoption", () => {
        // .old parses as Lua but `kosync.username` (SECRET) carries a
        // CR byte — same renderer-injection chain the apply-side gate
        // refuses. Pre-fix repair restored these bytes verbatim onto
        // settings.reader.lua.
        induceStep4Interruption(fakeKindle);
        writeFileSync(oldPath,
            'return {\n' +
            '  ["kosync"] = { ["username"] = "alice\\rinjected" },\n' +
            '  ["avoid_flashing_ui"] = true,\n' +
            '}\n');
        let err: KindlyError | null = null;
        try { executeDoctorRepair({ acceptOld: true }, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("DOCTOR_REPAIR_REJECTED");
        expect(err!.message).toContain("control bytes");
    });

    test("S2125: --promote-tmp validates parsed bytes; malformed tmp refuses", () => {
        // Hash match alone proved only that the bytes match the marker's
        // claim — not that they parse. Pre-fix repair promoted any bytes
        // that hashed against a forged marker.
        induceStep4Interruption(fakeKindle);
        const evilBytes = "\x00\x01\x02malformed not lua at all" + "x".repeat(50);
        const tmpPath = settingsPath + ".tmp." + process.pid + ".cafef00d";
        writeFileSync(tmpPath, evilBytes);
        const wantHash = createHash("sha256").update(evilBytes).digest("hex");
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "evil.json"), JSON.stringify({
            cmd: "apply",
            pid: 4242,
            started_at: "2026-04-25T11:00:00Z",
            settings_path: settingsPath,
            intended_sha256: wantHash,
        }));
        let err: KindlyError | null = null;
        try {
            executeDoctorRepair({ promoteTmp: true }, env);
        } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("DOCTOR_REPAIR_REJECTED");
        // tmp still on disk: gate fired before any rename.
        expect(existsSync(tmpPath)).toBe(true);
    });

    test("S2123: partial-fingerprint marker rejected even when the one set field matches", () => {
        // Forged marker mount has only device_version (matching the
        // fake), the other two anchors null. Pre-fix
        // `compareFingerprints` treated nulls as "no signal" and the
        // gate let it through. Post-fix: partial fingerprints require
        // --force-mount.
        induceStep4Interruption(fakeKindle);
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "forged.json"), JSON.stringify({
            cmd: "apply",
            pid: 9999,
            started_at: "2026-04-25T11:00:00Z",
            settings_path: settingsPath,
            mount: {
                device_version: "Kindle 5.16.2.1",  // matches the fake
                koreader_version: null,
                anchor_mtime_iso: null,
            },
        }));
        let err: KindlyError | null = null;
        try { executeDoctorRepair({}, env); } catch (e) { err = e as KindlyError; }
        expect(err).toBeInstanceOf(KindlyError);
        expect(err!.code).toBe("MOUNT_FINGERPRINT_MISMATCH");
        // --force-mount still gives an explicit override.
        const r = executeDoctorRepair({ forceMount: true }, env);
        expect(r.mode).toBe("repaired");
    });

    test("S2122/S2114: history entry uses cmd 'doctor:repair' with recovered_from + recovered_sha256", () => {
        induceStep4Interruption(fakeKindle);
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "apply-7-z.json"), JSON.stringify({
            cmd: "apply",
            started_at: "2026-04-25T11:00:00Z",
            pid: 7,
            settings_path: settingsPath,
        }));
        const oldBytes = readFileSync(oldPath);
        const expectedSha = createHash("sha256").update(oldBytes).digest("hex");
        const r = executeDoctorRepair({}, env);
        expect(r.settingsRecovery).toBe("restored-old");

        const histLines = readFileSync(
            join(workdir, ".kindly", "history.jsonl"),
            "utf8",
        ).split("\n").filter(Boolean);
        const entry = JSON.parse(histLines[0]!);
        expect(entry.cmd).toBe("doctor:repair");
        expect(entry.summary.recovered_from).toBe(oldPath);
        expect(entry.summary.recovered_sha256).toBe(`sha256:${expectedSha}`);
        expect(entry.summary.settings_recovery).toBe("restored-old");
        // Old shape (snapshot_dir = settings.lua) must be gone — it was
        // a misuse of the rollback summary that broke `rollback --to N`.
        expect(entry.summary.snapshot_dir).toBeUndefined();
    });

    test("S2118: --repair sweeps stale .doctor-mw-* / .doctor-probe-* leftovers", () => {
        // Simulate prior doctor invocations that crashed between
        // mkdtempSync and rmSync, leaving probe dirs on the mount.
        const koreader = join(fakeKindle, "koreader");
        const leftovers = [
            join(koreader, ".doctor-mw-AAAAAA"),
            join(koreader, ".doctor-mw-BBBBBB"),
            join(koreader, ".doctor-probe-CCCC"),
        ];
        for (const p of leftovers) mkdirSync(p);

        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("repaired");
        for (const p of leftovers) {
            expect(existsSync(p)).toBe(false);
            expect(r.sweptTmps).toContain(p);
        }
    });

    // S2127 (red-team round-7 review followup): marker path comparison
    // was exact string equality. macOS /Volumes/Kindle is HFS+
    // case-insensitive AND can be reached via symlink (/Volumes/Kindle
    // → /private/var/...). A marker stored when the mount was reached
    // one way wouldn't string-match a runtime resolve through another,
    // defeating S2126 cold-install protection on the actual deployment
    // substrate. Both paths now go through realpathSync.
    test("S2127: symlinked mount path matches marker after canonicalization", () => {
        induceStep4Interruption(fakeKindle);

        // Build a symlink that points at the real Kindle root. Tests
        // run on macOS or Linux; both support fs.symlink. The marker
        // records the canonical (realpath) settings path; the mount
        // is resolved through the symlink.
        const { symlinkSync } = require("node:fs");
        const linkRoot = mkdtempSync(join(tmpdir(), "kindly-s2127-link-"));
        const linkedKindle = join(linkRoot, "linked-kindle");
        symlinkSync(fakeKindle, linkedKindle);

        // Marker references the symlinked path representation. Pre-S2127,
        // doctorRepair compared this exact string against settingsPath
        // resolved through the same mountOverride — but if the *marker
        // writer* used a different but equivalent path (e.g., resolved
        // through a different symlink), the strings wouldn't match.
        const linkedSettings = join(linkedKindle, "koreader", "settings.reader.lua");
        const markerDir = join(workdir, ".kindly", "in-progress");
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(join(markerDir, "apply-77777-s2127.json"), JSON.stringify({
            cmd: "apply",
            started_at: "2026-04-27T11:59:00Z",
            pid: 77777,
            settings_path: linkedSettings,  // marker uses the symlink form
        }));

        // Operate against the canonical (non-symlinked) mount path. Pre-S2127,
        // the marker's symlinked-form settings_path wouldn't match the
        // canonical settingsPath via string equality → cold-install gate
        // fires → DOCTOR_REPAIR_REJECTED. Post-S2127, both paths
        // canonicalize through realpath → match → repair proceeds.
        const r = executeDoctorRepair({}, env);
        expect(r.mode).toBe("repaired");
        expect(r.settingsRecovery).toBe("restored-old");
        expect(existsSync(settingsPath)).toBe(true);

        rmSync(linkRoot, { recursive: true, force: true });
    });
});
