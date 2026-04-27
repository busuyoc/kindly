import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

// ============================================================================
// Apply gate activation (Step 12). Verifies YAML_SHAPE_NORMAL fires on
// the apply boundary — the S89 fix site. The import-side coverage lives
// in tests/gates/yamlShape.test.ts + the existing setup import suites.
// ============================================================================

function makeFakeKindle(luaBody: string): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-apply-k-"));
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
            now: () => new Date("2026-04-24T12:00:00Z"),
        },
        out,
        err,
    };
}

const DEVICE_LUA = `return {
    ["refresh_rate"] = 2,
    ["zlibrary_password"] = "hunter2",
    ["kosync"] = {
        ["auto_sync"] = true,
        ["userkey"] = "SECRET_TOKEN",
        ["username"] = "alice",
    },
}
`;

let workdir: string;
let kindle: ReturnType<typeof makeFakeKindle>;
let env: CliEnv;
let out: StringWriter;
let err: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-apply-gates-"));
    kindle = makeFakeKindle(DEVICE_LUA);
    const e = makeEnv(workdir, kindle.root);
    env = e.env;
    out = e.out;
    err = e.err;
});

function writeYaml(content: string): string {
    const p = join(workdir, "kindly.yaml");
    writeFileSync(p, content);
    return p;
}

describe("apply — YAML_SHAPE_NORMAL blocks crafted wipe-YAML", () => {
    test("kosync: null blocks with YAML_SHAPE_BLOCKED", async () => {
        writeYaml("kosync: null\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toMatch(/YAML input would damage/i);
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain("SECRET_TOKEN");  // device secret preserved
    });

    test("kosync: [] blocks (non-object at secret-parent)", async () => {
        writeYaml("kosync: []\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toMatch(/YAML input would damage/i);
    });

    test("kosync.userkey: ~ blocks (null at nested secret)", async () => {
        writeYaml("kosync:\n  userkey: ~\n  auto_sync: true\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("kosync.userkey");
    });

    test("zlibrary_password: ~ blocks (top-level SECRET — apply-only V7 leg)", async () => {
        writeYaml("zlibrary_password: null\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("zlibrary_password");
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain("hunter2");  // actual password preserved
    });

    test("--dry-run still blocks (firesIn: 'always')", async () => {
        writeYaml("kosync: null\n");
        const code = await main(["apply", "--dry-run"], env);
        expect(code).toBe(3);
        expect(err.value).toMatch(/YAML input would damage/i);
    });

    test("legitimate YAML passes through", async () => {
        writeYaml("refresh_rate: 5\nkosync:\n  auto_sync: false\n  pages_before_update: 1\n");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain("SECRET_TOKEN");
        expect(after).toContain("hunter2");
    });
});

describe("apply — CODE_EXEC_ADJACENT_REQUIRES_ACK (C1a)", () => {
    test("SSH_port change blocks without --accept-code-exec", async () => {
        writeYaml("SSH_port: 2222\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("SSH_port");
        expect(err.value).toMatch(/os\.execute|os\.remove|shell/);
        expect(err.value).toContain("--accept-code-exec");
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).not.toContain("2222");
    });

    test("httpinspector_port change blocks without --accept-code-exec", async () => {
        writeYaml("httpinspector_port: \"9999\"\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("httpinspector_port");
    });

    test("cover_image_path change blocks without --accept-code-exec", async () => {
        writeYaml("cover_image_path: \"/mnt/us/attacker\"\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("cover_image_path");
    });

    test("--accept-code-exec + --accept-sensitive allows the change through", async () => {
        // SSH_port is both code-exec-adjacent AND SENSITIVE-class, so the
        // promoted (Lead 7) SENSITIVE gate also fires — both bypasses needed.
        writeYaml("SSH_port: 2222\n");
        const code = await main(
            ["apply", "--accept-code-exec", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(0);
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain("2222");
    });

    test("--dry-run bypasses CODE_EXEC gate (firesIn: non-dry-run)", async () => {
        writeYaml("SSH_port: 2222\n");
        const code = await main(["apply", "--dry-run"], env);
        expect(code).toBe(0);
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).not.toContain("2222");
    });

    test("plain USER-only key is unaffected", async () => {
        writeYaml("refresh_rate: 10\n");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
    });

    test("no-op (value unchanged) does not fire the gate", async () => {
        writeYaml("refresh_rate: 2\n");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
    });
});

// ============================================================================
// Lead 7 / S600 closure: SENSITIVE_REQUIRES_ACK + DESTRUCTIVE_YAML_SHAPE
// fire on every apply (no --untrusted-yaml gating). The pull → apply
// round-trip stays silent because pull writes the device's own bytes
// (no SENSITIVE diff to consent to).
// ============================================================================

describe("apply — SENSITIVE_REQUIRES_ACK on apply (always-on)", () => {
    test("ota_server change BLOCKS by default", async () => {
        writeYaml("ota_server: \"https://attacker.example/koreader\"\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("ota_server");
        expect(err.value).toContain("security-sensitive");
    });

    test("--accept-sensitive lets it through", async () => {
        writeYaml("ota_server: \"https://attacker.example/koreader\"\n");
        const code = await main(["apply", "--accept-sensitive"], env);
        expect(code).toBe(0);
    });

    test("--accept-key=ota_server lets it through", async () => {
        writeYaml("ota_server: \"https://attacker.example/koreader\"\n");
        const code = await main(["apply", "--accept-key=ota_server"], env);
        expect(code).toBe(0);
    });

    test("--dry-run does not block (firesIn: non-dry-run)", async () => {
        writeYaml("ota_server: \"https://attacker.example/koreader\"\n");
        const code = await main(["apply", "--dry-run"], env);
        expect(code).toBe(0);
    });

    test("plain USER-only edit does not trip the gate", async () => {
        writeYaml("refresh_rate: 8\n");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
    });
});

// ============================================================================
// S1300 (Round 4 narrow audit, 2026-04-26 evening): EXTRA_PLUGIN_PATHS_DUAL
// (W31a) was previously appliesAt: ["import"], so apply skipped the gate
// entirely. --accept-sensitive alone cleared a `kindly apply` setting
// extra_plugin_paths, collapsing the W31a "AND" contract to one flag.
// Closure widened appliesAt to ["import", "apply", "restore"] and added
// the gate to apply's registry. Both --accept-sensitive AND
// --accept-plugins are now required at apply.
// ============================================================================

describe("apply — EXTRA_PLUGIN_PATHS_DUAL (W31a) (S1300 closure)", () => {
    test("blocks by default", async () => {
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(["apply"], env);
        expect(code).toBe(3);
    });

    test("--accept-sensitive ALONE still blocks (W31a AND-contract)", async () => {
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(["apply", "--accept-sensitive"], env);
        expect(code).toBe(3);
        expect(err.value).toContain("extra_plugin_paths");
        expect(err.value).toContain("--accept-plugins");
    });

    test("--accept-plugins ALONE still blocks (SENSITIVE half not cleared)", async () => {
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(["apply", "--accept-plugins"], env);
        expect(code).toBe(3);
    });

    test("--accept-sensitive + --accept-plugins lets it through", async () => {
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(
            ["apply", "--accept-sensitive", "--accept-plugins"],
            env,
        );
        expect(code).toBe(0);
        const after = readFileSync(kindle.settingsPath, "utf8");
        expect(after).toContain("/tmp/attacker-plugins");
    });

    test("--accept-key=extra_plugin_paths + --accept-plugins also lets it through", async () => {
        // Per-key SENSITIVE consent + plugins consent = same AND result.
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(
            ["apply", "--accept-key=extra_plugin_paths", "--accept-plugins"],
            env,
        );
        expect(code).toBe(0);
    });

    test("--dry-run does not enforce DUAL (firesIn: non-dry-run)", async () => {
        writeYaml("extra_plugin_paths: [\"/tmp/attacker-plugins\"]\n");
        const code = await main(["apply", "--dry-run", "--accept-sensitive"], env);
        expect(code).toBe(0);
    });
});

describe("apply — DESTRUCTIVE_YAML_SHAPE (always-on)", () => {
    test("does NOT fire on a small change", async () => {
        writeYaml("refresh_rate: 5\n");
        const code = await main(["apply"], env);
        expect(code).toBe(0);
    });

    test("plain user-edit YAML adding many keys is NOT destructive (only removals count)", async () => {
        // Additions never count toward the cap; only `removed` does. The
        // test guards the semantic — gate is for mass-removal, not mass-
        // change. All keys are USER-class so SENSITIVE_REQUIRES_ACK is
        // also silent.
        writeYaml(
            "refresh_rate: 5\n" +
            "page_overlap_pixels: 24\n" +
            "show_hidden: true\n" +
            "auto_save_paused_counter_minute: 30\n" +
            "screen_warmth: 60\n",
        );
        const code = await main(["apply"], env);
        expect(code).toBe(0);
    });
});
