// Tests for --json output mode on pull and diff.
//
// The contract these tests lock in:
//   - `--json` at any argv position triggers JSON mode.
//   - Successful commands emit a single JSON object on stdout, stderr empty.
//   - Failing commands emit a structured error envelope on stderr, stdout empty.
//   - Envelope carries $schema_version, kindly_version, generated_at,
//     command, status, data|error, warnings.
//   - Typed result shapes (from W1) appear verbatim under `data`.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";
import pkg from "../../package.json" with { type: "json" };

const KINDLY_VERSION = pkg.version;

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initialData: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initialData, "./settings.reader.lua"),
    );
    return root;
}

beforeEach(() => {
    fakeKindle = makeFakeKindle({
        avoid_flashing_ui: true,
        back_to_exit: "prompt",
        zlibrary_password: "hunter2",
        lastfile: "/mnt/us/Books/a.epub",
    });
    workdir = mkdtempSync(join(tmpdir(), "kindly-work-"));
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout,
        stderr,
        color: false,
        mountOverride: fakeKindle,
        now: () => new Date("2026-04-22T12:00:00Z"),
    };
});

describe("pull --json", () => {
    test("emits envelope to stdout, nothing to stderr", async () => {
        const code = await main(["pull", "--json"], env);
        expect(code).toBe(0);

        const payload = JSON.parse(stdout.value);
        expect(payload.$schema_version).toBe(1);
        expect(payload.kindly_version).toBe(KINDLY_VERSION);
        expect(payload.generated_at).toBe("2026-04-22T12:00:00.000Z");
        expect(payload.command).toBe("pull");
        expect(payload.status).toBe("ok");
        expect(payload.warnings).toEqual([]);

        // Stderr must be empty on success — piping stdout to jq stays clean.
        expect(stderr.value).toBe("");
    });

    test("data field contains the typed PullResult", async () => {
        await main(["pull", "--json"], env);
        const { data } = JSON.parse(stdout.value);

        expect(data.mode).toBe("minimal");
        expect(data.settingsPath).toBe(join(fakeKindle, "koreader", "settings.reader.lua"));
        expect(data.outputPath).toBe(join(workdir, "kindly.yaml"));
        expect(typeof data.bytes).toBe("number");
        expect(typeof data.lines).toBe("number");
        expect(data.droppedSecrets).toContain("zlibrary_password");
        expect(data.droppedEphemerals).toContain("lastfile");
    });

    test("output is a single line of newline-terminated JSON", async () => {
        await main(["pull", "--json"], env);
        // Exactly one object, ending in one newline. This is the `kindly serve`
        // (v0.10) precondition: JSONL framing requires one object per line.
        expect(stdout.value.endsWith("\n")).toBe(true);
        const trimmed = stdout.value.trimEnd();
        expect(trimmed.split("\n")).toHaveLength(1);
    });

    test("--json after positionals also works (any position)", async () => {
        await main(["pull", "--output", "custom.yaml", "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.outputPath).toBe(join(workdir, "custom.yaml"));
    });

    test("--full flag propagates into JSON result", async () => {
        await main(["pull", "--full", "--json"], env);
        const { data } = JSON.parse(stdout.value);
        expect(data.mode).toBe("full");
        expect(data.droppedEphemerals).toEqual([]);
    });
});

describe("diff --json", () => {
    test("no-diff case emits ok envelope with empty changes array", async () => {
        await main(["pull"], env);
        stdout.reset();
        stderr.reset();

        const code = await main(["diff", "--json"], env);
        expect(code).toBe(0);

        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.command).toBe("diff");
        expect(payload.data.changes).toEqual([]);
        expect(stderr.value).toBe("");
    });

    test("diff case emits ok envelope, exit 1, with structured changes", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("avoid_flashing_ui: true", "avoid_flashing_ui: false"),
        );
        stdout.reset();
        stderr.reset();

        const code = await main(["diff", "--json"], env);
        expect(code).toBe(1);

        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.changes).toHaveLength(1);
        expect(payload.data.changes[0].kind).toBe("changed");
        expect(payload.data.changes[0].path).toEqual(["avoid_flashing_ui"]);
        expect(payload.data.changes[0].prev).toBe(true);
        expect(payload.data.changes[0].next).toBe(false);
        expect(stderr.value).toBe("");
    });

    test("untrackedKeys reported in JSON data", async () => {
        await main(["pull"], env);
        stdout.reset();

        await main(["diff", "--json"], env);
        const { data } = JSON.parse(stdout.value);
        // Secrets/ephemerals that --minimal dropped appear here because
        // they're on device but not in the YAML.
        expect(data.untrackedKeys).toContain("lastfile");
        expect(data.untrackedKeys).toContain("zlibrary_password");
    });
});

describe("--json error envelope", () => {
    test("YAML_NOT_FOUND emits structured error on stderr, nothing on stdout", async () => {
        const code = await main(["diff", "--json"], env);
        expect(code).toBe(1);
        // Stdout is empty; all machine-readable detail is on stderr.
        expect(stdout.value).toBe("");

        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.command).toBe("diff");
        expect(payload.error.code).toBe("YAML_NOT_FOUND");
        expect(payload.error.message).toContain("not found");
        expect(payload.error.remediation[0].command).toBe("kindly pull");
    });

    test("OUTPUT_EXISTS error carries multiple remediations", async () => {
        writeFileSync(join(workdir, "kindly.yaml"), "already here");
        const code = await main(["pull", "--json"], env);
        expect(code).toBe(1);

        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("OUTPUT_EXISTS");
        expect(payload.error.remediation).toHaveLength(2);
        expect(payload.error.remediation[0].command).toContain("--force");
    });

    test("MOUNT_INVALID error from bad --mount path", async () => {
        const bad: CliEnv = {
            ...env,
            mountOverride: "/nonexistent/mount",
            stdout: new StringWriter(),
            stderr: new StringWriter(),
        };
        const code = await main(["pull", "--json"], bad);
        expect(code).toBe(1);
        const payload = JSON.parse((bad.stderr as StringWriter).value);
        expect(payload.error.code).toBe("MOUNT_INVALID");
    });

    test("ArgError in json mode still exits 2 but is structured", async () => {
        const code = await main(["pull", "--json", "--bogus"], env);
        expect(code).toBe(2);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("ARG_INVALID");
    });

    test("envelope has same top-level shape for ok and error", async () => {
        // Error path
        const errCode = await main(["diff", "--json"], env);
        expect(errCode).toBe(1);
        const err = JSON.parse(stderr.value);
        stdout.reset();
        stderr.reset();

        // Ok path
        await main(["pull", "--json"], env);
        const ok = JSON.parse(stdout.value);

        // Consumer should never have to branch on shape to find metadata.
        for (const key of ["$schema_version", "kindly_version", "generated_at", "command", "status"]) {
            expect(err).toHaveProperty(key);
            expect(ok).toHaveProperty(key);
        }
    });
});

describe("--json mode suppresses text rendering", () => {
    test("pull --json produces no human-readable 'wrote' line on stdout", async () => {
        await main(["pull", "--json"], env);
        // Only JSON on stdout — no "wrote /path/kindly.yaml" text.
        expect(stdout.value).not.toContain("wrote");
        expect(stdout.value).not.toContain("reading");
    });

    test("diff --json produces no 'no differences' or 'change(s)' text", async () => {
        await main(["pull"], env);
        stdout.reset();

        await main(["diff", "--json"], env);
        expect(stdout.value).not.toContain("no differences");
        expect(stdout.value).not.toContain("change(s)");
    });
});
