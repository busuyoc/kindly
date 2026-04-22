// v0.4 — compat enforcement at import boundary.
//
// Builds a fake kindle mount with both koreader/git-rev and
// system/version.txt populated, so checkCompat has real inputs. Tests:
//   - happy path (version + family match)
//   - blocking cases (too old, too new, device mismatch)
//   - --force converts block to warning
//   - detection-failure still proceeds (soft path)
//   - error messages carry the offending values

import { describe, test, expect, beforeEach } from "bun:test";
import {
    mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";

type FakeKindle = {
    root: string;
    settingsPath: string;
    pluginsDir: string;
    patchesDir: string;
};

function makeFakeKindle(opts: {
    gitRev?: string | null;        // null → skip writing (simulates missing file)
    versionTxt?: string | null;
} = {}): FakeKindle {
    const { gitRev = "v2026.03\n", versionTxt = "Kindle 5.18.5.0.1 (455681 001)\n" } = opts;
    const root = mkdtempSync(join(tmpdir(), "kindly-enf-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), `return {
    ["refresh_rate"] = 8,
}
`);
    mkdirSync(join(kor, "plugins"));
    mkdirSync(join(kor, "patches"));
    if (gitRev !== null) writeFileSync(join(kor, "git-rev"), gitRev);
    if (versionTxt !== null) {
        mkdirSync(join(root, "system"));
        writeFileSync(join(root, "system", "version.txt"), versionTxt);
    }
    return {
        root,
        settingsPath: join(kor, "settings.reader.lua"),
        pluginsDir: join(kor, "plugins"),
        patchesDir: join(kor, "patches"),
    };
}

function makeEnv(cwd: string, mountOverride: string, setupsDir: string): {
    env: CliEnv; out: StringWriter; err: StringWriter;
} {
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
            setupsDir,
        },
        out,
        err,
    };
}

function writeManifest(path: string, m: Partial<Parameters<typeof parseManifest>[0]> = {}): SetupManifest {
    const parsed = parseManifest({
        kindly_setup: "v1",
        meta: { name: "enf-test", created_at: "2026-04-21T12:00:00Z" },
        apply_mode: "additive",
        settings: { refresh_rate: 2 },
        ...m,
    } as unknown as Parameters<typeof parseManifest>[0]);
    writeFileSync(path, canonicalizeManifest(parsed));
    return parsed;
}

let workdir: string;
let setupsDir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-enf-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-enf-s-"));
});

describe("setup import — compat enforcement (happy path)", () => {
    test("detected version within window + family match → import proceeds", async () => {
        const kindle = makeFakeKindle();
        const { env, out } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, {
            compat: {
                koreader_version_min: "2024.03",
                koreader_version_max: "2027.12",
                device: ["kindle"],
            },
        });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
        expect(out.value).toContain("detected: koreader=v2026.03, device=kindle");
        expect((parseSettings(kindle.settingsPath) as Record<string, unknown>).refresh_rate).toBe(2);
    });

    test("device-family prefix match: manifest 'kindle-pw5' accepts detected 'kindle'", async () => {
        const kindle = makeFakeKindle();
        const { env } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { device: ["kindle-pw5"] } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
    });
});

describe("setup import — compat enforcement (blocking)", () => {
    test("detected version too old → blocks with exit 1 and message", async () => {
        const kindle = makeFakeKindle({ gitRev: "v2024.01\n" });
        const { env, out, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_min: "2026.01" } });

        const before = readFileSync(kindle.settingsPath, "utf8");
        const code = await main(["setup", "import", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("older than required");
        expect(err.value).toContain("--force");
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(before);
    });

    test("detected version too new → blocks", async () => {
        const kindle = makeFakeKindle({ gitRev: "v2026.03\n" });
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_max: "2024.11" } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("newer than required");
    });

    test("device family mismatch → blocks", async () => {
        const kindle = makeFakeKindle();  // family = kindle
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { device: ["kobo-libra2", "kobo-clara"] } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(1);
        expect(err.value).toContain("kobo-libra2");
        expect(err.value).toContain("kindle");
    });

    test("multiple mismatches are all listed", async () => {
        const kindle = makeFakeKindle({ gitRev: "v2024.01\n" });
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, {
            compat: {
                koreader_version_min: "2099.01",
                device: ["kobo-libra2"],
            },
        });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(1);
        expect(err.value).toMatch(/older than required/);
        expect(err.value).toMatch(/kobo-libra2/);
    });

    test("blocking result with --dry-run still blocks (compat check runs first)", async () => {
        const kindle = makeFakeKindle({ gitRev: "v2024.01\n" });
        const { env } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_min: "2099.01" } });

        const code = await main(["setup", "import", p, "--dry-run"], env);
        expect(code).toBe(1);
    });
});

describe("setup import — compat enforcement (--force)", () => {
    test("--force converts block into warning and import proceeds", async () => {
        const kindle = makeFakeKindle({ gitRev: "v2024.01\n" });
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_min: "2099.01" } });

        const code = await main(["setup", "import", p, "--force"], env);
        expect(code).toBe(0);
        expect(err.value).toContain("older than required");
        expect(err.value).toContain("--force");
        expect((parseSettings(kindle.settingsPath) as Record<string, unknown>).refresh_rate).toBe(2);
    });
});

describe("setup import — compat enforcement (unverifiable soft path)", () => {
    test("missing git-rev on device: manifest requires version → warn + proceed", async () => {
        const kindle = makeFakeKindle({ gitRev: null });
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_min: "2024.03" } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
        expect(err.value).toContain("could not read git-rev");
    });

    test("missing version.txt on device: manifest requires device → warn + proceed", async () => {
        const kindle = makeFakeKindle({ versionTxt: null });
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { device: ["kindle"] } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
        expect(err.value).toContain("could not detect device family");
    });

    test("unparseable version in manifest → warn + proceed", async () => {
        const kindle = makeFakeKindle();
        const { env, err } = makeEnv(workdir, kindle.root, setupsDir);
        const p = join(workdir, "m.kset.yaml");
        writeManifest(p, { compat: { koreader_version_min: "not-a-version" } });

        const code = await main(["setup", "import", p], env);
        expect(code).toBe(0);
        expect(err.value).toMatch(/not a parseable KOReader version/);
    });
});

// Helper: parse settings.reader.lua to assert writes landed.
function parseSettings(path: string): unknown {
    const { parseSettingsFile } = require("../../src/lua/reader.ts");
    return parseSettingsFile(readFileSync(path, "utf8"));
}
