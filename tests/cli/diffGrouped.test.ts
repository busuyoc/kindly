// W10: `kindly diff` emits changes bucketed by taxonomy category, with
// per-entry severity + hint sourced from the W9 mapper. Covers the exit-code
// contract and deterministic category ordering so GUI/JSON consumers can
// consume the shape directly.

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
    // Pick keys that span multiple taxonomy categories so we can assert
    // grouping isn't a single-bucket accident:
    //   - night_mode           → display   (functional)
    //   - cre_font             → fonts     (visual)
    //   - inertial_scroll      → gestures  (functional)
    //   - reader_footer_mode   → status_bar (visual)
    fakeKindle = makeFakeKindle({
        night_mode: false,
        cre_font: "Noto Sans",
        inertial_scroll: true,
        reader_footer_mode: 1,
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

describe("diff — grouped shape (executeDiff)", () => {
    test("no changes → grouped is an empty object", async () => {
        await main(["pull"], env);
        const result = executeDiff({}, env);
        expect(result.changes).toEqual([]);
        expect(result.grouped).toEqual({});
    });

    test("changes across multiple categories are bucketed", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        const yaml = readFileSync(yamlPath, "utf8")
            .replace("night_mode: false", "night_mode: true")
            .replace("cre_font: Noto Sans", "cre_font: DejaVu Sans")
            .replace("inertial_scroll: true", "inertial_scroll: false");
        writeFileSync(yamlPath, yaml);

        const result = executeDiff({}, env);
        expect(Object.keys(result.grouped).sort()).toEqual(
            ["display", "fonts", "gestures"].sort(),
        );
        expect(result.grouped.display).toHaveLength(1);
        expect(result.grouped.fonts).toHaveLength(1);
        expect(result.grouped.gestures).toHaveLength(1);
    });

    test("entry carries label, severity, hint, kind, before/after", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8").replace("night_mode: false", "night_mode: true"),
        );

        const result = executeDiff({}, env);
        const entry = result.grouped.display![0]!;
        expect(entry.key).toBe("night_mode");
        expect(entry.label).toBe("Night mode");
        expect(entry.before).toBe(false);
        expect(entry.after).toBe(true);
        expect(entry.kind).toBe("changed");
        expect(entry.severity).toBe("functional");
        expect(entry.hint).toBe("enabled");
    });

    test("category order follows taxonomy declaration (fonts before gestures before display)", async () => {
        // Taxonomy declares: reading, fonts, status_bar, menu, progress,
        // screensaver, gestures, display, plugins_bundled, ephemeral.
        // So `fonts` must come before `gestures`, and `gestures` before
        // `display` — regardless of input ordering.
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8")
                .replace("night_mode: false", "night_mode: true")
                .replace("cre_font: Noto Sans", "cre_font: DejaVu Sans")
                .replace("inertial_scroll: true", "inertial_scroll: false"),
        );
        const result = executeDiff({}, env);
        expect(Object.keys(result.grouped)).toEqual(["fonts", "gestures", "display"]);
    });

    test("nested path uses top-level key's category", async () => {
        // footer is status_bar per taxonomy. Change a nested sub-key —
        // the entry should land under status_bar with key="footer.align".
        const nestedKindle = makeFakeKindle({
            footer: { align: "left", battery: true } as any,
        });
        const nestedEnv = { ...env, mountOverride: nestedKindle };
        await main(["pull"], nestedEnv);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8").replace("align: left", "align: center"),
        );

        const result = executeDiff({}, nestedEnv);
        expect(Object.keys(result.grouped)).toEqual(["status_bar"]);
        const entry = result.grouped.status_bar![0]!;
        expect(entry.key).toBe("footer.align");
        expect(entry.severity).toBe("visual");
    });
});

describe("diff --json — grouped shape on the wire", () => {
    test("JSON envelope data includes grouped alongside changes", async () => {
        await main(["pull"], env);
        const yamlPath = join(workdir, "kindly.yaml");
        writeFileSync(
            yamlPath,
            readFileSync(yamlPath, "utf8").replace("cre_font: Noto Sans", "cre_font: DejaVu Sans"),
        );
        stdout.reset();
        stderr.reset();

        const code = await main(["diff", "--json"], env);
        expect(code).toBe(1);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.grouped.fonts).toHaveLength(1);
        const entry = payload.data.grouped.fonts[0];
        expect(entry.key).toBe("cre_font");
        expect(entry.severity).toBe("visual");
        expect(entry.kind).toBe("changed");
        expect(entry.before).toBe("Noto Sans");
        expect(entry.after).toBe("DejaVu Sans");
    });
});
