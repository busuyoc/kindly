// Integration tests for `kindly setup import` (lean / additive).
//
// These run against a fake Kindle mount — a tmpdir with a
// koreader/settings.reader.lua that we parse/modify/re-read to verify.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";

function makeFakeKindle(luaBody: string): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-import-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, luaBody);
    return { root, settingsPath };
}

function makeEnv(
    cwd: string,
    mountOverride: string,
): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride,
            now: () => new Date("2026-04-21T12:00:00Z"),
        },
        out,
        err,
    };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "test", created_at: "2026-04-21T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

function writeManifestFile(path: string, m: SetupManifest): void {
    writeFileSync(path, canonicalizeManifest(m));
}

// Read the on-device settings and return the parsed record for assertions.
function onDevice(settingsPath: string): Record<string, unknown> {
    return parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["avoid_flashing_ui"] = false,
    ["zlibrary_password"] = "hunter2",
    ["lastfile"] = "/mnt/us/documents/book.epub",
    ["plugins_disabled"] = {
        ["coverbrowser"] = true,
    },
}
`;

let kindle: { root: string; settingsPath: string };
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;
let manifestPath: string;

beforeEach(() => {
    kindle = makeFakeKindle(DEFAULT_LUA);
    workdir = mkdtempSync(join(tmpdir(), "kindly-import-w-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root));
    manifestPath = join(workdir, "setup.kset.yaml");
});

describe("setup import — happy path", () => {
    test("applies a minimal manifest additively and preserves on-device keys", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2, screen_warmth: 50 },
        }));

        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        expect(after.refresh_rate).toBe(2);                // changed
        expect(after.screen_warmth).toBe(50);              // added
        expect(after.avoid_flashing_ui).toBe(false);       // untouched
        expect(after.zlibrary_password).toBe("hunter2");   // SECRET preserved
        expect(after.lastfile).toBe("/mnt/us/documents/book.epub"); // untouched
    });

    test("reverse-lifts plugins.disabled into plugins_disabled map", async () => {
        writeManifestFile(manifestPath, makeManifest({
            plugins: { disabled: ["SSH", "calibre"] },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        const pd = after.plugins_disabled as Record<string, unknown>;
        expect(pd.SSH).toBe(true);
        expect(pd.calibre).toBe(true);
        expect(pd.coverbrowser).toBe(true); // merged with existing
    });

    test("prints human-readable diff summary with + added and ~ changed markers", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2, screen_warmth: 50 },
        }));
        await main(["setup", "import", manifestPath], env);
        expect(stdout.value).toContain("2 change(s) to apply");
        expect(stdout.value).toMatch(/\+ screen_warmth/);
        expect(stdout.value).toMatch(/~ refresh_rate/);
    });

    test("writes a pre-write safety backup into .kindly/pre-import/", async () => {
        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        await main(["setup", "import", manifestPath], env);

        const bdir = join(workdir, ".kindly", "pre-import");
        expect(existsSync(bdir)).toBe(true);
        const stamps = readdirSync(bdir);
        expect(stamps.length).toBe(1);
        const snap = join(bdir, stamps[0]!, "settings.reader.lua");
        expect(existsSync(snap)).toBe(true);
        // Backup is the PRE-write file.
        expect(readFileSync(snap, "utf8")).toBe(DEFAULT_LUA);
        expect(stdout.value).toContain("safety backup");
    });

    test("restart warning is printed on success", async () => {
        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        await main(["setup", "import", manifestPath], env);
        expect(stderr.value).toMatch(/restart KOReader/i);
    });
});

describe("setup import — no-op when identical", () => {
    test("no changes needed → exit 0, no write, no snapshot", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 8, avoid_flashing_ui: false },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no changes needed");

        // File unchanged
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
        // No backup dir created
        expect(existsSync(join(workdir, ".kindly", "pre-import"))).toBe(false);
    });
});

describe("setup import — dry-run", () => {
    test("--dry-run shows changes but writes nothing, no backup", async () => {
        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).toMatch(/dry-run/);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
        expect(existsSync(join(workdir, ".kindly", "pre-import"))).toBe(false);
    });
});

describe("setup import — secret-denylist at import boundary", () => {
    test("secret-named keys in the manifest are refused and never written", async () => {
        // A hostile manifest would never pass our export, but we accept any
        // .kset.yaml and must defend against it regardless.
        // parseManifest allows arbitrary setting keys (matches KOReader's
        // open-ended schema) — the denylist applies at import only.
        writeManifestFile(manifestPath, makeManifest({
            settings: {
                refresh_rate: 2,
                pinpadlock_pin_code: "0000",
                zlibrary_password: "NEW-PWD",
            },
        }));

        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        expect(after.refresh_rate).toBe(2);                  // legit change
        expect(after.zlibrary_password).toBe("hunter2");     // NOT overwritten
        expect(after.pinpadlock_pin_code).toBeUndefined();   // NOT written

        expect(stderr.value).toMatch(/refused.*secret/i);
        expect(stderr.value).toContain("zlibrary_password");
        expect(stderr.value).toContain("pinpadlock_pin_code");
    });

    test("manifest with ONLY secret keys becomes a no-op", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { pinpadlock_pin_code: "0000" },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no changes needed");
        expect(stdout.value).toMatch(/secret.*refused/i);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });
});

describe("setup import — compat is shown, not verified", () => {
    test("prints the compat block and an explicit 'NOT verified' note", async () => {
        writeManifestFile(manifestPath, makeManifest({
            compat: { koreader_version_min: "2024.03", device: ["kindle-pw5"] },
            settings: { refresh_rate: 2 },
        }));
        await main(["setup", "import", manifestPath], env);
        expect(stdout.value).toContain("koreader >= 2024.03");
        expect(stdout.value).toContain("kindle-pw5");
        expect(stdout.value).toMatch(/NOT verified/);
    });

    test("does not refuse import when compat is set, even if we can't check it", async () => {
        writeManifestFile(manifestPath, makeManifest({
            compat: { koreader_version_min: "3000.01", device: ["imaginary-device"] },
            settings: { refresh_rate: 2 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
        expect((onDevice(kindle.settingsPath) as Record<string, unknown>).refresh_rate).toBe(2);
    });
});

describe("setup import — out-of-scope guards", () => {
    test("refuses fat manifest (plugin files) with a clear message", async () => {
        writeManifestFile(manifestPath, makeManifest({
            plugins: {
                disabled: [],
                files: [{
                    path: "coverbrowser.koplugin/main.lua",
                    hash: "sha256:" + "0".repeat(64),
                    bytes: 100,
                }],
            },
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toMatch(/fat setup/i);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("refuses fat manifest (patches) with a clear message", async () => {
        writeManifestFile(manifestPath, makeManifest({
            patches: [{
                path: "2-custom.lua",
                hash: "sha256:" + "0".repeat(64),
                bytes: 50,
            }],
            settings: { refresh_rate: 2 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toMatch(/fat setup/i);
    });
});

describe("setup import — --no-safety-snapshot", () => {
    test("skips the pre-import archive but still writes + keeps .old sibling", async () => {
        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        const code = await main(
            ["setup", "import", manifestPath, "--no-safety-snapshot"],
            env,
        );
        expect(code).toBe(0);
        // Archive dir should NOT exist.
        expect(existsSync(join(workdir, ".kindly", "pre-import"))).toBe(false);
        // But the .old sibling (KOReader's own fallback) must still be there.
        expect(existsSync(kindle.settingsPath + ".old")).toBe(true);
        // And the new value is on device.
        expect((onDevice(kindle.settingsPath) as Record<string, unknown>).refresh_rate).toBe(2);
        expect(stdout.value).toContain("safety backup skipped");
    });
});

describe("setup import — usage/errors", () => {
    test("requires a <file> argument", async () => {
        const code = await main(["setup", "import"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("usage: kindly setup import");
    });

    test("errors on missing manifest file", async () => {
        const code = await main(["setup", "import", join(workdir, "nope.kset.yaml")], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not found");
    });

    test("errors when manifest is invalid", async () => {
        writeFileSync(manifestPath, "kindly_setup: v2\napply_mode: additive\nmeta:\n  name: x\n");
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("not a valid Setup manifest");
    });

    test("errors cleanly when koreader/settings.reader.lua is missing", async () => {
        // Remove the settings file; mount still looks like a Kindle via koreader/
        const settingsPath = kindle.settingsPath;
        // Overwrite with nothing by deleting — use unlinkSync
        const { unlinkSync } = await import("node:fs");
        unlinkSync(settingsPath);

        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toMatch(/doesn't exist|KOReader installed/i);
    });

    test("rejects extra positional args", async () => {
        writeManifestFile(manifestPath, makeManifest({ settings: { refresh_rate: 2 } }));
        const code = await main(["setup", "import", manifestPath, "junk"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unexpected extra argument");
    });
});

describe("setup import — idempotence", () => {
    test("running import twice yields identical device state after second run", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { refresh_rate: 2, screen_warmth: 50 },
            plugins: { disabled: ["SSH"] },
        }));

        expect(await main(["setup", "import", manifestPath], env)).toBe(0);
        const afterFirst = readFileSync(kindle.settingsPath, "utf8");

        // Fresh stdout/stderr so we can check "no changes".
        const out2 = new StringWriter();
        const err2 = new StringWriter();
        const env2 = { ...env, stdout: out2, stderr: err2 };
        expect(await main(["setup", "import", manifestPath], env2)).toBe(0);
        expect(out2.value).toContain("no changes needed");
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(afterFirst);
    });
});

describe("setup import — dispatcher help", () => {
    test("top-level setup help lists import", async () => {
        await main(["setup"], env);
        expect(stdout.value).toContain("import");
    });
    test("`kindly setup import --help` prints import help", async () => {
        const code = await main(["setup", "import", "--help"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("--dry-run");
        expect(stdout.value).toContain("--no-safety-snapshot");
    });
});
