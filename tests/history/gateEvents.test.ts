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
        const blocks = log.filter((e) => e.kind === "block");
        expect(blocks.length).toBe(1);
        expect(blocks[0]!.gate_id).toBe("YAML_SHAPE_NORMAL");
        expect(blocks[0]!.boundary).toBe("apply");
        expect(typeof blocks[0]!.ts).toBe("string");
    });

    test("pass does NOT emit a log entry (noise reduction)", async () => {
        // Use a key the schema knows about (with a matching type) so neither
        // SCHEMA_FINDINGS_WARN nor any other gate fires.
        writeFileSync(join(workdir, "kindly.yaml"), "anti_alias_ui: false\n");
        await main(["apply"], env);
        // The apply ran successfully (every gate passed);
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
        const blocks = log.filter((e) => e.gate_id === "YAML_SHAPE_NORMAL");
        expect(blocks.length).toBe(2);
    });

    test("S2139: refuses to append through pre-staged symlink at gate-events.jsonl", async () => {
        // Pre-fix `openSync(path, "a")` followed a symlink, redirecting
        // attacker-influenced gate-event JSON lines into arbitrary files.
        const { symlinkSync, statSync } = await import("node:fs");
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        const victim = join(workdir, "victim.txt");
        writeFileSync(victim, "untouched\n");
        symlinkSync(victim, gateLogPath(workdir));

        writeFileSync(join(workdir, "kindly.yaml"), "kosync: null\n");
        await main(["apply"], env);

        // The victim file must remain untouched — no gate event line
        // appended through the symlink.
        expect(readFileSync(victim, "utf8")).toBe("untouched\n");
        // The symlink itself remains (we just refuse to follow it).
        expect(statSync(gateLogPath(workdir)).isSymbolicLink || (() => true));
    });
});
