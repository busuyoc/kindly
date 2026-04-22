// W12: `kindly diff --category <name>` narrows both the text-mode output
// and the JSON `grouped`/`changes`/`untrackedKeys` to one taxonomy bucket.
// Unknown category names throw ArgError (exit 2) so typos aren't silent.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { executeDiff } from "../../src/commands/diff.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { dumpSettingsFile, type LuaTable } from "../../src/lua/writer.ts";

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

function makeFakeKindle(initial: LuaTable): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        dumpSettingsFile(initial, "./settings.reader.lua"),
    );
    return root;
}

beforeEach(() => {
    // Keys spanning 3 categories:
    //   cre_font         → fonts
    //   night_mode       → display
    //   inertial_scroll  → gestures
    fakeKindle = makeFakeKindle({
        cre_font: "Noto Sans",
        night_mode: false,
        inertial_scroll: true,
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

async function pullThenMutateAll(): Promise<string> {
    await main(["pull"], env);
    const yamlPath = join(workdir, "kindly.yaml");
    writeFileSync(
        yamlPath,
        readFileSync(yamlPath, "utf8")
            .replace("cre_font: Noto Sans", "cre_font: DejaVu Sans")
            .replace("night_mode: false", "night_mode: true")
            .replace("inertial_scroll: true", "inertial_scroll: false"),
    );
    return yamlPath;
}

describe("executeDiff — --category filter", () => {
    test("filter keeps only matching changes + sets filteredBy", async () => {
        await pullThenMutateAll();
        const r = executeDiff({ category: "fonts" }, env);
        expect(r.filteredBy).toBe("fonts");
        expect(r.changes).toHaveLength(1);
        expect(r.changes[0]!.path).toEqual(["cre_font"]);
        expect(Object.keys(r.grouped)).toEqual(["fonts"]);
    });

    test("no filter leaves filteredBy undefined + keeps everything", async () => {
        await pullThenMutateAll();
        const r = executeDiff({}, env);
        expect(r.filteredBy).toBeUndefined();
        expect(r.changes).toHaveLength(3);
        expect(Object.keys(r.grouped).sort()).toEqual(["display", "fonts", "gestures"]);
    });

    test("filter narrows untrackedKeys to that category too", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        // Make fonts key untracked by removing it from YAML; the others
        // remain. Expect untrackedKeys=[cre_font] when filtering on fonts.
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .split("\n")
                .filter((line) => !line.startsWith("cre_font"))
                .join("\n"),
        );
        const r = executeDiff({ category: "fonts" }, env);
        expect(r.untrackedKeys).toEqual(["cre_font"]);
        // And under display filter, untrackedKeys should be empty.
        const r2 = executeDiff({ category: "display" }, env);
        expect(r2.untrackedKeys).toEqual([]);
    });

    test("unknown category → ArgError", async () => {
        await pullThenMutateAll();
        expect(() => executeDiff({ category: "typography" }, env)).toThrow(/unknown category/);
    });

    test("valid category with no matching changes → empty result, not an error", async () => {
        await pullThenMutateAll();
        // screensaver is a real category, but no keys on device match it.
        const r = executeDiff({ category: "screensaver" }, env);
        expect(r.filteredBy).toBe("screensaver");
        expect(r.changes).toEqual([]);
        expect(r.grouped).toEqual({});
    });
});

describe("diff --category — CLI text mode", () => {
    test("filtered output mentions the category name", async () => {
        await pullThenMutateAll();
        stdout.reset();

        const code = await main(["diff", "--category", "fonts"], env);
        expect(code).toBe(1);
        expect(stdout.value).toContain("fonts");
        expect(stdout.value).toContain("cre_font");
        // Other changes must NOT leak into the filtered output.
        expect(stdout.value).not.toContain("night_mode");
        expect(stdout.value).not.toContain("inertial_scroll");
    });

    test("filtered no-diff wording mentions category", async () => {
        await main(["pull"], env);
        stdout.reset();

        const code = await main(["diff", "--category", "screensaver"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("no differences in screensaver");
    });

    test("unknown category exits 2 with ArgError", async () => {
        await pullThenMutateAll();
        stdout.reset();
        stderr.reset();

        const code = await main(["diff", "--category", "typography"], env);
        expect(code).toBe(2);
        expect(stderr.value).toContain("unknown category");
    });
});

describe("diff --category --json", () => {
    test("envelope data.filteredBy surfaces the filter", async () => {
        await pullThenMutateAll();
        stdout.reset();

        const code = await main(["diff", "--category", "fonts", "--json"], env);
        expect(code).toBe(1);
        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.filteredBy).toBe("fonts");
        expect(payload.data.changes).toHaveLength(1);
        expect(Object.keys(payload.data.grouped)).toEqual(["fonts"]);
    });

    test("unknown category → JSON ArgError envelope on stderr", async () => {
        await pullThenMutateAll();
        stdout.reset();
        stderr.reset();

        const code = await main(["diff", "--category", "nope", "--json"], env);
        expect(code).toBe(2);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.message).toContain("unknown category");
    });
});
