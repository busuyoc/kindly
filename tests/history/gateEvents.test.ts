import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { gateLogPath } from "../../src/history/gateLog.ts";

// ============================================================================
// Step 14 — gate events log (.kindly/gate-events.jsonl).
// Verifies orchestrator emits structured entries on bypass/block but
// NOT on pass (noise reduction).
// ============================================================================

function makeFakeKindle(luaBody: string): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-gev-k-"));
    mkdirSync(join(root, "koreader"));
    const settingsPath = join(root, "koreader", "settings.reader.lua");
    writeFileSync(settingsPath, luaBody);
    return { root, settingsPath };
}

function makeEnv(cwd: string, mountOverride: string) {
    const out = new StringWriter();
    const err = new StringWriter();
    const env: CliEnv = {
        cwd,
        stdout: out,
        stderr: err,
        color: false,
        mountOverride,
        now: () => new Date("2026-04-24T12:00:00Z"),
    };
    return { env, out, err };
}

function readGateLog(cwd: string): Array<Record<string, unknown>> {
    const p = gateLogPath(cwd);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
}

let workdir: string;
let kindle: ReturnType<typeof makeFakeKindle>;
let env: CliEnv;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-gev-w-"));
    kindle = makeFakeKindle(`return {
    ["refresh_rate"] = 2,
    ["zlibrary_password"] = "hunter2",
    ["kosync"] = { ["userkey"] = "SECRET", ["auto_sync"] = true },
}
`);
    env = makeEnv(workdir, kindle.root).env;
});

describe("gate events — apply", () => {
    test("block fires → log entry kind='block'", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "kosync: null\n");
        await main(["apply"], env);
        const log = readGateLog(workdir);
        expect(log.length).toBe(1);
        expect(log[0].gate_id).toBe("YAML_SHAPE_NORMAL");
        expect(log[0].boundary).toBe("apply");
        expect(log[0].kind).toBe("block");
        expect(typeof log[0].ts).toBe("string");
    });

    test("pass does NOT emit a log entry (noise reduction)", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "refresh_rate: 5\n");
        await main(["apply"], env);
        // The apply ran successfully (YAML_SHAPE_NORMAL passed);
        // no gate-event file should exist (or it should be empty).
        const log = readGateLog(workdir);
        expect(log).toEqual([]);
    });
});

describe("gate events — file format", () => {
    test("each line is valid JSON with ts/gate_id/boundary/kind", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "zlibrary_password: null\n");
        await main(["apply"], env);
        const rawLines = readFileSync(gateLogPath(workdir), "utf8")
            .split("\n")
            .filter((l) => l.length > 0);
        for (const line of rawLines) {
            const parsed = JSON.parse(line);
            expect(parsed).toHaveProperty("ts");
            expect(parsed).toHaveProperty("gate_id");
            expect(parsed).toHaveProperty("boundary");
            expect(parsed).toHaveProperty("kind");
        }
    });

    test("appends (doesn't overwrite) across multiple applies", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "kosync: null\n");
        await main(["apply"], env);
        writeFileSync(join(workdir, "kindly.yaml"), "zlibrary_password: null\n");
        await main(["apply"], env);
        const log = readGateLog(workdir);
        expect(log.length).toBe(2);
        expect(log[0].gate_id).toBe("YAML_SHAPE_NORMAL");
        expect(log[1].gate_id).toBe("YAML_SHAPE_NORMAL");
    });
});
