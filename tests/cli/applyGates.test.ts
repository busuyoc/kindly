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
