// Inert-toggle warning at setup import.
//
// Field-finding #3 from 2026-04-22 hardware test: a manifest toggling
// `calendar` on a device without calendar.koplugin silently stored the
// toggle with nothing to toggle. This test reproduces the scenario and
// confirms the import now warns.

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

function makeFakeKindle(pluginDirs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-inert-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["night_mode"] = false,
}
`);
    const pluginsDir = join(kor, "plugins");
    mkdirSync(pluginsDir);
    mkdirSync(join(kor, "patches"));
    for (const name of pluginDirs) {
        mkdirSync(join(pluginsDir, name), { recursive: true });
        writeFileSync(join(pluginsDir, name, "main.lua"), "-- stub\n");
    }
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
            now: () => new Date("2026-04-22T12:00:00Z"),
            setupsDir,
        },
        out, err,
    };
}

function writeManifest(path: string, disabled: string[]): void {
    const parsed = parseManifest({
        kindly_setup: "v1",
        meta: { name: "inert-test", created_at: "2026-04-22T12:00:00Z" },
        apply_mode: "additive",
        plugins: { disabled },
    } as unknown as Parameters<typeof parseManifest>[0]);
    writeFileSync(path, canonicalizeManifest(parsed));
}

let workdir: string;
let setupsDir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-inert-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-inert-s-"));
});

describe("setup import — inert plugin toggles", () => {
    test("toggling a plugin not on device → warn, import still proceeds", async () => {
        const root = makeFakeKindle(["SSH.koplugin"]);
        const { env, err } = makeEnv(workdir, root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["calendar"]);

        // plugins_disabled is sensitive-service (S960), so import emits a
        // SENSITIVE warning even in dry-run — exit 4 rather than 0.
        const code = await main(
            ["setup", "import", p, "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(4);
        expect(err.value).toMatch(/toggle.*inert/i);
        expect(err.value).toContain("calendar");
        expect(err.value).toContain("calendar.koplugin");
    });

    test("toggles for installed plugins → no warning", async () => {
        const root = makeFakeKindle(["SSH.koplugin", "calendar.koplugin"]);
        const { env, err } = makeEnv(workdir, root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["SSH", "calendar"]);

        const code = await main(
            ["setup", "import", p, "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(4);
        expect(err.value).not.toMatch(/inert/i);
    });

    test("mix of installed and inert → only inert listed", async () => {
        const root = makeFakeKindle(["SSH.koplugin"]);
        const { env, err } = makeEnv(workdir, root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, ["SSH", "calendar", "hello"]);

        const code = await main(
            ["setup", "import", p, "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(4);
        expect(err.value).toContain("calendar");
        expect(err.value).toContain("hello");
        // SSH is installed — should not be flagged.
        const inertBlock = err.value.split(/inert:?/i)[1] ?? "";
        expect(inertBlock).not.toContain("SSH");
    });

    test("no plugin toggles → no warning at all", async () => {
        const root = makeFakeKindle([]);
        const { env, err } = makeEnv(workdir, root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        // Write a settings-only manifest (no plugins block).
        const parsed = parseManifest({
            kindly_setup: "v1",
            meta: { name: "no-toggles", created_at: "2026-04-22T12:00:00Z" },
            apply_mode: "additive",
            settings: { night_mode: true },
        } as unknown as Parameters<typeof parseManifest>[0]);
        writeFileSync(p, canonicalizeManifest(parsed));

        const code = await main(["setup", "import", p, "--dry-run"], env);
        expect(code).toBe(0);
        expect(err.value).not.toMatch(/inert/i);
    });
});
