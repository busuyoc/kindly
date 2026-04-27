// R8 (review hardening): TTY-prompt recovery for interrupted-apply state.
// Tests are unit-level — they use a mock InterruptedApplyState and a
// promptInjector to bypass real TTY/stdin. The pull/diff/apply integration
// path is exercised via existing fixture-based tests in tests/cli/.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleInterruptedApply } from "../../src/lib/recoverInterrupted.ts";
import { detectInterruptedApply } from "../../src/fs/interruptedApply.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

let kindle: string;
let workdir: string;

function makeKindle(): string {
    // Build a fake Kindle in the interrupted state: settings.reader.lua
    // missing, .old present and parseable.
    const root = mkdtempSync(join(tmpdir(), "kindly-r8-k-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua.old"),
        '-- ./settings.reader.lua\nreturn {\n    ["a"] = 1,\n}\n',
    );
    return root;
}

/** Round-6 S2126: a real interrupted apply leaves an in-progress marker
 *  on disk before safeWrite step 1 runs. Recovery (R8) requires that
 *  marker to distinguish "kindly apply was running" from "attacker
 *  planted a .old". Tests stage the marker the same way a legit apply
 *  would have. */
function writeInterruptedMarker(workdir: string, settingsPath: string): void {
    const dir = join(workdir, ".kindly", "in-progress");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "apply-1-r8.json"), JSON.stringify({
        cmd: "apply",
        started_at: "2026-04-27T11:59:00Z",
        pid: 1,
        settings_path: settingsPath,
    }));
}

function makeEnv(opts: { tty?: boolean; jsonMode?: boolean } = {}): {
    env: CliEnv;
    out: StringWriter;
    err: StringWriter;
} {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd: workdir,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride: kindle,
            now: () => new Date("2026-04-27T12:00:00Z"),
            tty: opts.tty ?? false,
            jsonMode: opts.jsonMode ?? false,
        },
        out,
        err,
    };
}

beforeEach(() => {
    kindle = makeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-r8-w-"));
});

afterEach(() => {
    rmSync(kindle, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
});

describe("R8: handleInterruptedApply", () => {
    test("autoRepair=true → repairs without prompting", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;
        expect(state).not.toBeNull();
        writeInterruptedMarker(workdir, settingsPath);

        const { env } = makeEnv();
        let prompted = false;
        const decision = handleInterruptedApply(state, env, {
            autoRepair: true,
            promptInjector: () => { prompted = true; return "y"; },
        });
        expect(decision).toBe("repaired");
        expect(prompted).toBe(false);
    });

    test("autoRepair=false → throws without prompting", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;

        const { env } = makeEnv({ tty: true });
        let prompted = false;
        const decision = handleInterruptedApply(state, env, {
            autoRepair: false,
            promptInjector: () => { prompted = true; return "y"; },
        });
        expect(decision).toBe("throw");
        expect(prompted).toBe(false);
    });

    test("non-TTY default → throws without prompting", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;

        const { env } = makeEnv({ tty: false });
        let prompted = false;
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => { prompted = true; return "y"; },
        });
        expect(decision).toBe("throw");
        expect(prompted).toBe(false);
    });

    test("--json mode → throws regardless of TTY", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;

        const { env } = makeEnv({ tty: true, jsonMode: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "y",
        });
        expect(decision).toBe("throw");
    });

    test("TTY + 'y' answer → repaired", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;
        writeInterruptedMarker(workdir, settingsPath);

        const { env } = makeEnv({ tty: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "y",
        });
        expect(decision).toBe("repaired");
    });

    test("TTY + empty answer (Enter pressed) → repaired (Y is default)", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;
        writeInterruptedMarker(workdir, settingsPath);

        const { env } = makeEnv({ tty: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "",
        });
        expect(decision).toBe("repaired");
    });

    test("TTY + 'n' answer → throw", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;

        const { env } = makeEnv({ tty: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "n",
        });
        expect(decision).toBe("throw");
    });

    test("TTY + 'no' answer → throw", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;

        const { env } = makeEnv({ tty: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "no",
        });
        expect(decision).toBe("throw");
    });

    test("TTY + 'YES' (uppercase) → repaired", () => {
        const settingsPath = join(kindle, "koreader", "settings.reader.lua");
        const state = detectInterruptedApply(settingsPath)!;
        writeInterruptedMarker(workdir, settingsPath);

        const { env } = makeEnv({ tty: true });
        const decision = handleInterruptedApply(state, env, {
            promptInjector: () => "YES",
        });
        expect(decision).toBe("repaired");
    });
});
