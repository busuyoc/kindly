// Step 15 — doctor surfaces gate registry inventory + recent-bypass
// cadence from .kindly/gate-events.jsonl.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDoctor } from "../../src/lib/doctor.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-drg-k-"));
    mkdirSync(join(root, "koreader"));
    const settingsPath = join(root, "koreader", "settings.reader.lua");
    writeFileSync(settingsPath, `return { ["refresh_rate"] = 2 }\n`);
    return { root, settingsPath };
}

let workdir: string;
let kindle: ReturnType<typeof makeFakeKindle>;
let env: CliEnv;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-drg-w-"));
    kindle = makeFakeKindle();
    env = {
        cwd: workdir,
        stdout: new StringWriter(),
        stderr: new StringWriter(),
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-24T12:00:00Z"),
    };
});

function findCheck(
    checks: ReturnType<typeof executeDoctor>["checks"],
    id: string,
) {
    const c = checks.find((x) => x.id === id);
    if (!c) throw new Error(`expected check ${id} not found`);
    return c;
}

describe("doctor gates.registered", () => {
    test("reports the total count + per-boundary breakdown", () => {
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.registered");
        expect(c.category).toBe("gates");
        expect(c.severity).toBe("info");
        expect((c.data as { total: number }).total).toBeGreaterThan(0);
        expect(Array.isArray((c.data as { import: string[] }).import)).toBe(true);
        expect(Array.isArray((c.data as { apply: string[] }).apply)).toBe(true);
        // YAML_SHAPE_NORMAL appears on BOTH boundaries after Step 12.
        const imp = (c.data as { import: string[] }).import;
        const app = (c.data as { apply: string[] }).apply;
        expect(imp).toContain("YAML_SHAPE_NORMAL");
        expect(app).toContain("YAML_SHAPE_NORMAL");
    });
});

describe("doctor gates.recent_bypasses — empty log", () => {
    test("reports zero bypasses when no log file exists", () => {
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.recent_bypasses");
        expect(c.severity).toBe("info");
        expect((c.data as { bypass_count: number }).bypass_count).toBe(0);
        expect(c.label).toMatch(/no policy bypasses/i);
    });
});

describe("doctor gates.recent_bypasses — under threshold", () => {
    test("1 recent bypass → info severity", () => {
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        writeFileSync(
            join(workdir, ".kindly", "gate-events.jsonl"),
            JSON.stringify({
                ts: "2026-04-20T10:00:00Z",
                gate_id: "SENSITIVE_REQUIRES_ACK",
                boundary: "import",
                kind: "bypass",
                bypass_flag: "--accept-sensitive",
            }) + "\n",
        );
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.recent_bypasses");
        expect(c.severity).toBe("info");
        expect((c.data as { bypass_count: number }).bypass_count).toBe(1);
    });
});

describe("doctor gates.recent_bypasses — above threshold", () => {
    test("5 recent bypasses → warning severity + remediation", () => {
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        const lines = Array.from({ length: 5 }, (_, i) =>
            JSON.stringify({
                ts: `2026-04-${(20 - i).toString().padStart(2, "0")}T10:00:00Z`,
                gate_id: "SENSITIVE_REQUIRES_ACK",
                boundary: "import",
                kind: "bypass",
                bypass_flag: "--accept-sensitive",
            }),
        ).join("\n") + "\n";
        writeFileSync(join(workdir, ".kindly", "gate-events.jsonl"), lines);
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.recent_bypasses");
        expect(c.severity).toBe("warning");
        expect((c.data as { bypass_count: number }).bypass_count).toBe(5);
        expect(c.remediation).toBeDefined();
        expect(c.remediation!.length).toBeGreaterThan(0);
    });
});

describe("doctor gates.recent_bypasses — outside window", () => {
    test("bypasses older than 30d are excluded", () => {
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        // 60 days before env.now
        writeFileSync(
            join(workdir, ".kindly", "gate-events.jsonl"),
            JSON.stringify({
                ts: "2026-02-20T10:00:00Z",
                gate_id: "SENSITIVE_REQUIRES_ACK",
                boundary: "import",
                kind: "bypass",
                bypass_flag: "--accept-sensitive",
            }) + "\n",
        );
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.recent_bypasses");
        expect((c.data as { bypass_count: number }).bypass_count).toBe(0);
    });
});

describe("doctor gates.recent_bypasses — malformed lines tolerated", () => {
    test("bad JSON increments malformed_lines but doesn't crash", () => {
        mkdirSync(join(workdir, ".kindly"), { recursive: true });
        writeFileSync(
            join(workdir, ".kindly", "gate-events.jsonl"),
            "not json\n"
            + JSON.stringify({
                ts: "2026-04-20T10:00:00Z",
                gate_id: "X",
                boundary: "apply",
                kind: "bypass",
            }) + "\n",
        );
        const r = executeDoctor(env);
        const c = findCheck(r.checks, "gates.recent_bypasses");
        expect((c.data as { bypass_count: number }).bypass_count).toBe(1);
        expect((c.data as { malformed_lines: number }).malformed_lines).toBe(1);
    });
});
