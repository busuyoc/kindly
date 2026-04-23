// Integration tests for `kindly setup import` with apply_mode: replace.
//
// Replace mode must:
//   - wipe USER-class on-device keys not declared in the manifest
//   - PRESERVE secrets (pinpadlock_pin_code, zlibrary_password, …)
//   - PRESERVE ephemerals (lastfile, last_migration_date, …)
//   - replace nested maps wholesale, EXCEPT carry over known nested
//     secrets (kosync.userkey, kosync.username)
//   - print - lines in the diff preview for removals
//   - respect --dry-run and --no-safety-snapshot just like additive

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { parseSettingsFile } from "../../src/lua/reader.ts";

function makeFakeKindle(luaBody: string): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-replace-k-"));
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

function makeReplaceManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "replace-test", created_at: "2026-04-21T12:00:00Z" },
        apply_mode: "replace",
        ...raw,
    });
}

function writeManifestFile(path: string, m: SetupManifest): void {
    writeFileSync(path, canonicalizeManifest(m));
}

function onDevice(settingsPath: string): Record<string, unknown> {
    return parseSettingsFile(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

// A device with a mix of classifications: USER, SECRET, EPHEMERAL, and a
// nested map that has a nested secret path.
const RICH_LUA = `return {
    ["refresh_rate"] = 8,
    ["screen_warmth"] = 60,
    ["BookShortcuts_directory_action"] = "FM",
    ["avoid_flashing_ui"] = false,
    ["zlibrary_password"] = "hunter2",
    ["pinpadlock_pin_code"] = "1234",
    ["lastfile"] = "/mnt/us/documents/book.epub",
    ["last_migration_date"] = 20250101,
    ["kosync"] = {
        ["auto_sync"] = false,
        ["server"] = "https://sync.koreader.rocks",
        ["userkey"] = "SECRET_SYNC_KEY",
        ["username"] = "alice",
    },
    ["plugins_disabled"] = {
        ["coverbrowser"] = true,
        ["statistics"] = true,
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
    kindle = makeFakeKindle(RICH_LUA);
    workdir = mkdtempSync(join(tmpdir(), "kindly-replace-w-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, kindle.root));
    manifestPath = join(workdir, "setup.kset.yaml");
});

describe("replace mode — top-level wipe of USER keys", () => {
    test("USER keys not in manifest are removed; declared ones are applied", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2, screen_warmth: 60 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        // Declared keys applied.
        expect(after.refresh_rate).toBe(2);
        expect(after.screen_warmth).toBe(60);
        // Undeclared USER keys removed.
        expect(after.BookShortcuts_directory_action).toBeUndefined();
        expect(after.avoid_flashing_ui).toBeUndefined();
    });

    test("SECRET keys are preserved regardless of manifest", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        expect(after.zlibrary_password).toBe("hunter2");
        expect(after.pinpadlock_pin_code).toBe("1234");
    });

    test("EPHEMERAL keys are preserved regardless of manifest", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        await main(["setup", "import", manifestPath], env);

        const after = onDevice(kindle.settingsPath);
        expect(after.lastfile).toBe("/mnt/us/documents/book.epub");
        expect(after.last_migration_date).toBe(20250101);
    });
});

describe("replace mode — nested maps", () => {
    test("declared nested map is replaced wholesale, with nested secrets carried over", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: {
                kosync: { auto_sync: true },
            },
        }));
        await main(["setup", "import", manifestPath], env);

        const after = onDevice(kindle.settingsPath);
        const k = after.kosync as Record<string, unknown>;
        // Manifest value wins.
        expect(k.auto_sync).toBe(true);
        // Non-secret sub-key in the manifest? No → wiped.
        expect(k.server).toBeUndefined();
        // Nested secrets carried over from pre-import state.
        expect(k.userkey).toBe("SECRET_SYNC_KEY");
        expect(k.username).toBe("alice");
    });

    test("UNdeclared nested map is removed entirely (secrets inside go with it)", async () => {
        // kosync not in manifest at all. It's a USER-class parent key, so
        // the whole thing is removed — including the nested userkey. This
        // is the documented contract.
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        await main(["setup", "import", manifestPath], env);
        const after = onDevice(kindle.settingsPath);
        expect(after.kosync).toBeUndefined();
    });

    test("plugins.disabled replaces plugins_disabled wholesale (no SECRET_PATH exception)", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            plugins: { disabled: ["SSH"] },
        }));
        await main(["setup", "import", manifestPath], env);

        const after = onDevice(kindle.settingsPath);
        const pd = after.plugins_disabled as Record<string, unknown>;
        expect(pd.SSH).toBe(true);
        // Pre-existing toggles are GONE — no shallow-merge in replace.
        expect(pd.coverbrowser).toBeUndefined();
        expect(pd.statistics).toBeUndefined();
    });

    test("no plugins in manifest → on-device plugins_disabled is removed", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        await main(["setup", "import", manifestPath], env);
        expect((onDevice(kindle.settingsPath) as Record<string, unknown>).plugins_disabled).toBeUndefined();
    });
});

describe("replace mode — diff preview", () => {
    test("preview shows + / ~ / - lines and labels replace mode", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2, brand_new_key: "x" },
        }));
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(0);

        expect(stdout.value).toContain("replace mode");
        expect(stdout.value).toMatch(/\+ brand_new_key/);
        expect(stdout.value).toMatch(/~ refresh_rate/);
        expect(stdout.value).toMatch(/- BookShortcuts_directory_action/);
        expect(stdout.value).toMatch(/- avoid_flashing_ui/);
        // Secrets/ephemerals never appear as removals.
        expect(stdout.value).not.toMatch(/- zlibrary_password/);
        expect(stdout.value).not.toMatch(/- lastfile/);
        // Stdout has a disclosure line about secrets/ephemerals surviving.
        expect(stdout.value).toMatch(/secrets and ephemerals are preserved/i);
    });
});

describe("replace mode — secret denylist still applies", () => {
    test("manifest attempting to write a secret is refused AND device secret is preserved", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: {
                refresh_rate: 2,
                zlibrary_password: "hostile-new-password",
            },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        expect(after.refresh_rate).toBe(2);
        expect(after.zlibrary_password).toBe("hunter2"); // device value preserved
        expect(stderr.value).toMatch(/refused.*secret/i);
        expect(stderr.value).toContain("zlibrary_password");
    });
});

describe("replace mode — no-op detection", () => {
    test("when device already matches the manifest exactly, no write", async () => {
        // Narrow device state: only one USER key, kosync absent, secrets
        // + ephemerals stay. A manifest mirroring the single USER key =
        // no diff.
        const narrow = makeFakeKindle(`return {
    ["refresh_rate"] = 2,
    ["zlibrary_password"] = "x",
    ["lastfile"] = "/book.epub",
}
`);
        const workdir2 = mkdtempSync(join(tmpdir(), "kindly-replace-w2-"));
        const { env: env2 } = makeEnv(workdir2, narrow.root);

        const p = join(workdir2, "x.kset.yaml");
        writeManifestFile(p, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(narrow.settingsPath, "utf8");
        const code = await main(["setup", "import", p], env2);
        expect(code).toBe(0);
        expect(readFileSync(narrow.settingsPath, "utf8")).toBe(before);
        expect(existsSync(join(workdir2, ".kindly", "pre-import"))).toBe(false);
    });
});

describe("replace mode — --dry-run does not write", () => {
    test("--dry-run shows removals but writes nothing", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2 },
        }));
        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });
});

describe("replace mode — idempotence", () => {
    test("running replace import twice = no change the second time", async () => {
        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { refresh_rate: 2, screen_warmth: 60 },
        }));
        expect(await main(["setup", "import", manifestPath], env)).toBe(0);
        const afterFirst = readFileSync(kindle.settingsPath, "utf8");

        const out2 = new StringWriter();
        const err2 = new StringWriter();
        const env2 = { ...env, stdout: out2, stderr: err2 };
        expect(await main(["setup", "import", manifestPath], env2)).toBe(0);
        expect(out2.value).toContain("no changes needed");
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(afterFirst);
    });
});

describe("replace mode — empty manifest", () => {
    test("manifest with no settings wipes all USER keys but keeps secrets/ephemerals", async () => {
        // Legit "factory-reset-ish" operation — docs/50 calls this out as
        // allowed. The diff preview shows all the removals; the user
        // consents by not passing --dry-run.
        writeManifestFile(manifestPath, makeReplaceManifest({}));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);

        const after = onDevice(kindle.settingsPath);
        // All USER gone.
        expect(after.refresh_rate).toBeUndefined();
        expect(after.screen_warmth).toBeUndefined();
        expect(after.BookShortcuts_directory_action).toBeUndefined();
        expect(after.kosync).toBeUndefined();
        expect(after.plugins_disabled).toBeUndefined();
        // Secrets + ephemerals intact.
        expect(after.zlibrary_password).toBe("hunter2");
        expect(after.pinpadlock_pin_code).toBe("1234");
        expect(after.lastfile).toBe("/mnt/us/documents/book.epub");
        expect(after.last_migration_date).toBe(20250101);
    });
});

describe("replace mode — W34d large-removal warning", () => {
    function makeBigLua(keyCount: number): string {
        const lines: string[] = ["return {"];
        for (let i = 0; i < keyCount; i++) {
            lines.push(`    ["big_user_key_${i}"] = ${i},`);
        }
        lines.push("}\n");
        return lines.join("\n");
    }

    test("replace wipe > threshold surfaces replaceWarnings in dry-run result", async () => {
        // 60 device keys, manifest keeps 1 → 59 removals
        const k = makeFakeKindle(makeBigLua(60));
        workdir = mkdtempSync(join(tmpdir(), "kindly-w34d-w-"));
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, k.root));
        manifestPath = join(workdir, "setup.kset.yaml");

        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { big_user_key_0: 0 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--json"],
            env,
        );
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.replaceWarnings).toBeDefined();
        expect(payload.data.replaceWarnings.removedUserKeys).toBe(59);
        expect(payload.data.replaceWarnings.threshold).toBe(50);
        expect(payload.data.replaceWarnings.sampleKeys.length).toBe(20);
    });

    test("replace wipe at threshold → no warning", async () => {
        const k = makeFakeKindle(makeBigLua(51));
        workdir = mkdtempSync(join(tmpdir(), "kindly-w34d-edge-"));
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, k.root));
        manifestPath = join(workdir, "setup.kset.yaml");

        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { big_user_key_0: 0 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--json"],
            env,
        );
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.replaceWarnings).toBeNull();
    });

    test("--strict-imports blocks on large replace wipe", async () => {
        const k = makeFakeKindle(makeBigLua(60));
        workdir = mkdtempSync(join(tmpdir(), "kindly-w34d-strict-"));
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, k.root));
        manifestPath = join(workdir, "setup.kset.yaml");

        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { big_user_key_0: 0 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--strict-imports", "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.error.code).toBe("STRICT_IMPORT_BLOCKED");
        expect(payload.error.message).toContain("59");
        expect(payload.error.message).toContain("replace-mode");
        // No write happened.
        expect(readFileSync(k.settingsPath, "utf8")).toBe(makeBigLua(60));
    });

    test("text-mode preview renders the warning banner", async () => {
        const k = makeFakeKindle(makeBigLua(60));
        workdir = mkdtempSync(join(tmpdir(), "kindly-w34d-text-"));
        ({ env, out: stdout, err: stderr } = makeEnv(workdir, k.root));
        manifestPath = join(workdir, "setup.kset.yaml");

        writeManifestFile(manifestPath, makeReplaceManifest({
            settings: { big_user_key_0: 0 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run"],
            env,
        );
        expect(code).toBe(0);
        expect(stderr.value).toContain("remove 59");
        expect(stderr.value).toContain("threshold 50");
    });
});
