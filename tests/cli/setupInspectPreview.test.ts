// W11: `setup inspect --vs-device` / `--vs-default` attaches a grouped
// settings-preview to SetupInspectResult. Covers both modes, JSON envelope,
// and the "mutually exclusive flags" ArgError.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupInspect } from "../../src/commands/setup.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

function makeFakeKindle(initial: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initial, "./settings.reader.lua"),
    );
    return root;
}

function makeManifest(settings: Record<string, unknown>, overrides: Partial<Record<string, unknown>> = {}): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: {
            name: "preview-fixture",
            created_at: "2026-04-22T12:00:00Z",
        },
        apply_mode: "additive",
        settings,
        ...overrides,
    });
}

let workdir: string;
let setupsDir: string;
let fakeKindle: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-sip-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-sip-d-"));
    // Device has night_mode=false (display); cre_font unset (fonts).
    fakeKindle = makeFakeKindle({
        night_mode: false,
        inertial_scroll: true,
    });
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: fakeKindle,
        setupsDir,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("executeSetupInspect — preview absent by default", () => {
    test("no flags → no preview field on result", () => {
        const m = makeManifest({ night_mode: true });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));
        const r = executeSetupInspect(p, env);
        expect(r.preview).toBeUndefined();
    });
});

describe("executeSetupInspect — vs-device", () => {
    test("diffs manifest.settings against live device, groups by category", () => {
        // Manifest turns night_mode on (device=false), leaves inertial_scroll
        // alone (device=true, manifest=true → no change), and adds cre_font
        // which isn't on device (→ added under fonts).
        const m = makeManifest({
            night_mode: true,
            inertial_scroll: true,
            cre_font: "Noto Sans",
        });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-device" });
        expect(r.preview).toBeDefined();
        expect(r.preview!.mode).toBe("vs-device");
        expect(r.preview!.settingsPath).toContain("settings.reader.lua");

        // 2 changes (night_mode, cre_font). inertial_scroll is equal → omitted.
        expect(r.preview!.changes).toHaveLength(2);
        const grouped = r.preview!.grouped;
        expect(Object.keys(grouped)).toEqual(["fonts", "display"]);
        expect(grouped.display![0]!.key).toBe("night_mode");
        expect(grouped.display![0]!.severity).toBe("functional");
        expect(grouped.display![0]!.hint).toBe("enabled");
        expect(grouped.fonts![0]!.key).toBe("cre_font");
        expect(grouped.fonts![0]!.kind).toBe("added");
    });

    test("device matches manifest → preview has empty changes + grouped", () => {
        // Device already has night_mode=false; manifest asserts the same.
        const m = makeManifest({ night_mode: false });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-device" });
        expect(r.preview!.changes).toEqual([]);
        expect(r.preview!.grouped).toEqual({});
    });
});

describe("executeSetupInspect — vs-default", () => {
    test("diffs against empty config → every manifest key is 'added'", () => {
        const m = makeManifest({
            night_mode: true,
            cre_font: "Noto Sans",
        });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-default" });
        expect(r.preview!.mode).toBe("vs-default");
        expect(r.preview!.settingsPath).toBeUndefined();
        expect(r.preview!.changes).toHaveLength(2);
        // Everything should be "added" because the baseline is empty.
        for (const c of r.preview!.changes) {
            expect(c.kind).toBe("added");
        }
        expect(Object.keys(r.preview!.grouped).sort()).toEqual(["display", "fonts"]);
    });

    test("empty manifest settings → empty preview", () => {
        const m = makeManifest({});
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-default" });
        expect(r.preview!.changes).toEqual([]);
        expect(r.preview!.grouped).toEqual({});
    });
});

describe("setup inspect --json --vs-device / --vs-default", () => {
    test("--vs-device preview surfaces in JSON envelope data", async () => {
        const m = makeManifest({ night_mode: true, cre_font: "Noto Sans" });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const code = await main(["setup", "inspect", p, "--json", "--vs-device"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.preview.mode).toBe("vs-device");
        expect(payload.data.preview.grouped.display).toHaveLength(1);
        expect(payload.data.preview.grouped.fonts).toHaveLength(1);
    });

    test("--vs-default works without requiring a mount", async () => {
        const m = makeManifest({ night_mode: true });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        // Strip mountOverride — --vs-default must not touch the device.
        const envNoMount: CliEnv = { ...env, mountOverride: undefined };
        envNoMount.stdout = new StringWriter();
        envNoMount.stderr = new StringWriter();

        const code = await main(["setup", "inspect", p, "--json", "--vs-default"], envNoMount);
        expect(code).toBe(0);
        const payload = JSON.parse((envNoMount.stdout as StringWriter).value);
        expect(payload.data.preview.mode).toBe("vs-default");
        expect(payload.data.preview.changes[0].kind).toBe("added");
    });

    test("--vs-device and --vs-default together → ArgError", async () => {
        const m = makeManifest({ night_mode: true });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const code = await main(
            ["setup", "inspect", p, "--json", "--vs-device", "--vs-default"],
            env,
        );
        expect(code).toBe(2);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.message).toContain("mutually exclusive");
    });
});

describe("setup inspect text mode — preview summary", () => {
    test("prints per-category counts when preview is requested", async () => {
        const m = makeManifest({
            night_mode: true,
            cre_font: "Noto Sans",
        });
        const p = join(setupsDir, "a.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const code = await main(["setup", "inspect", p, "--vs-device"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("preview (vs-device)");
        expect(stdout.value).toMatch(/display: 1/);
        expect(stdout.value).toMatch(/fonts: 1/);
    });
});

describe("setup inspect — W34d replace-mode removal warning", () => {
    function makeBigKindle(keyCount: number): string {
        const settings: LuaTable = {};
        for (let i = 0; i < keyCount; i++) {
            settings[`user_key_${i}`] = i;
        }
        return makeFakeKindle(settings);
    }

    test("replace-mode removing >50 USER keys → replaceWarnings populated", () => {
        // Device has 60 USER keys; manifest keeps just 1 → 59 removals.
        env.mountOverride = makeBigKindle(60);

        const m = makeManifest(
            { user_key_0: 0 },
            { apply_mode: "replace" },
        );
        const p = join(setupsDir, "wipe.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-device" });
        expect(r.replaceWarnings).toBeDefined();
        expect(r.replaceWarnings!.removedUserKeys).toBe(59);
        expect(r.replaceWarnings!.threshold).toBe(50);
        expect(r.replaceWarnings!.sampleKeys.length).toBeLessThanOrEqual(20);
    });

    test("replace-mode just under threshold → no warning", () => {
        env.mountOverride = makeBigKindle(51);  // 50 removals = at threshold
        const m = makeManifest(
            { user_key_0: 0 },
            { apply_mode: "replace" },
        );
        const p = join(setupsDir, "edge.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-device" });
        expect(r.replaceWarnings).toBeUndefined();
    });

    test("additive mode large delta → no warning (additive never removes)", () => {
        env.mountOverride = makeBigKindle(100);
        // Additive won't emit any "removed" changes, so count is 0.
        const m = makeManifest({ user_key_0: 0 }, { apply_mode: "additive" });
        const p = join(setupsDir, "additive.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env, { preview: "vs-device" });
        expect(r.replaceWarnings).toBeUndefined();
    });

    test("no --vs-* preview → no warning computed (need baseline)", () => {
        const m = makeManifest(
            { user_key_0: 0 },
            { apply_mode: "replace" },
        );
        const p = join(setupsDir, "noprev.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const r = executeSetupInspect(p, env);
        expect(r.replaceWarnings).toBeUndefined();
    });

    test("text mode shows the warning banner", async () => {
        env.mountOverride = makeBigKindle(60);
        const m = makeManifest(
            { user_key_0: 0 },
            { apply_mode: "replace" },
        );
        const p = join(setupsDir, "banner.kset.yaml");
        writeFileSync(p, canonicalizeManifest(m));

        const code = await main(["setup", "inspect", p, "--vs-device"], env);
        expect(code).toBe(0);
        expect(stderr.value).toContain("remove 59");
        expect(stderr.value).toContain("threshold 50");
    });
});
