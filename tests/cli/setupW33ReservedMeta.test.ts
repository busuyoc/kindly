// W33 — reserved meta fields + anti-anchor-trust display.
//
// Contract: docs/91-reserved-meta-fields-spec.md.
//   §2    — schema migration (source_url, version, author_key_id, supersedes)
//   §3.1  — text mode: identity claims render with `(UNVERIFIED)`
//   §3.2  — JSON mode: identity claims wrapped `{ value, verified: false }`
//   §4    — text ordering: SENSITIVE block before author block
//   §5    — supersedes rendering (0 / 1 / N)
//   §7    — test inventory

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import {
    parseManifest, SetupSchemaError, type SetupManifest,
} from "../../src/setup/schema.ts";

const HASH_A = "sha256:" + "a".repeat(64);
const HASH_B = "sha256:" + "b".repeat(64);

function makeFakeKindle(): { root: string; settingsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "kindly-w33-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, `return {
    ["refresh_rate"] = 8,
    ["night_mode"] = false,
}
`);
    return { root, settingsPath };
}

function makeManifest(metaExtra: Record<string, unknown>, rest: Partial<Record<string, unknown>> = {}): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: {
            name: "w33-test",
            created_at: "2026-04-23T12:00:00Z",
            ...metaExtra,
        },
        apply_mode: "additive",
        ...rest,
    });
}

function writeManifestFile(path: string, m: SetupManifest): void {
    writeFileSync(path, canonicalizeManifest(m));
}

let workdir: string;
let setupsDir: string;
let manifestPath: string;
let kindle: { root: string; settingsPath: string };
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "kindly-w33-w-"));
    setupsDir = mkdtempSync(join(tmpdir(), "kindly-w33-s-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    kindle = makeFakeKindle();
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-23T12:00:00Z"),
        setupsDir,
    };
});

// ---- §2 schema acceptance --------------------------------------------------

describe("W33 schema — §2", () => {
    test("all new fields populated → parses", () => {
        const m = makeManifest({
            author: "Alice",
            source_url: "https://alice.dev/setups",
            version: "2",
            author_key_id: "RWT1234567890",
            supersedes: [HASH_A, HASH_B],
        });
        expect(m.meta.author).toBe("Alice");
        expect(m.meta.source_url).toBe("https://alice.dev/setups");
        expect(m.meta.version).toBe("2");
        expect(m.meta.author_key_id).toBe("RWT1234567890");
        expect(m.meta.supersedes).toEqual([HASH_A, HASH_B]);
    });

    test("pre-W33 manifest (no new fields) → parses", () => {
        const m = makeManifest({ author: "legacy" });
        expect(m.meta.source_url).toBeUndefined();
        expect(m.meta.version).toBeUndefined();
        expect(m.meta.author_key_id).toBeUndefined();
        expect(m.meta.supersedes).toBeUndefined();
    });

    test("each new field individually → parses", () => {
        expect(makeManifest({ source_url: "https://x.test/s" }).meta.source_url).toBe("https://x.test/s");
        expect(makeManifest({ version: "v2.1" }).meta.version).toBe("v2.1");
        expect(makeManifest({ author_key_id: "RWT..." }).meta.author_key_id).toBe("RWT...");
        expect(makeManifest({ supersedes: [HASH_A] }).meta.supersedes).toEqual([HASH_A]);
    });

    test("source_url not a URL → SetupSchemaError", () => {
        expect(() => makeManifest({ source_url: "not-a-url" })).toThrow(SetupSchemaError);
    });

    test("supersedes entry not sha256 → SetupSchemaError", () => {
        expect(() => makeManifest({ supersedes: ["deadbeef"] })).toThrow(SetupSchemaError);
        // Uppercase hex not allowed (regex pins lowercase).
        expect(() => makeManifest({ supersedes: ["sha256:" + "A".repeat(64)] })).toThrow(SetupSchemaError);
    });

    test("supersedes: [] → accepted", () => {
        const m = makeManifest({ supersedes: [] });
        expect(m.meta.supersedes).toEqual([]);
    });

    test("author_key_id as arbitrary string → accepted (W39 validates format)", () => {
        expect(makeManifest({ author_key_id: "" }).meta.author_key_id).toBe("");
        expect(makeManifest({ author_key_id: "literally anything goes here" }).meta.author_key_id)
            .toBe("literally anything goes here");
    });
});

// ---- §3.1 text mode display ------------------------------------------------

describe("W33 text mode — §3.1 UNVERIFIED suffix", () => {
    test("setup inspect with meta.author → shows (UNVERIFIED)", async () => {
        writeManifestFile(manifestPath, makeManifest({ author: "Alice" }));
        const code = await main(["setup", "inspect", manifestPath], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("author:");
        expect(stdout.value).toContain("Alice");
        expect(stdout.value).toContain("(UNVERIFIED)");
    });

    test("setup inspect with meta.source_url → shows (UNVERIFIED)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            source_url: "https://alice.dev/setups",
        }));
        await main(["setup", "inspect", manifestPath], env);
        expect(stdout.value).toContain("source:");
        expect(stdout.value).toContain("https://alice.dev/setups");
        // one (UNVERIFIED) per identity claim — here only source, so exactly one.
        const matches = stdout.value.match(/\(UNVERIFIED\)/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test("setup inspect with meta.author_key_id → shows (UNVERIFIED)", async () => {
        writeManifestFile(manifestPath, makeManifest({ author_key_id: "RWT123" }));
        await main(["setup", "inspect", manifestPath], env);
        expect(stdout.value).toContain("author_key:");
        expect(stdout.value).toContain("RWT123");
        expect(stdout.value).toContain("(UNVERIFIED)");
    });

    test("setup inspect with meta.version → bare (no UNVERIFIED on that line)", async () => {
        writeManifestFile(manifestPath, makeManifest({ version: "2.1" }));
        await main(["setup", "inspect", manifestPath], env);
        const line = stdout.value.split("\n").find((l) => l.includes("version:"));
        expect(line).toBeDefined();
        expect(line).toContain("2.1");
        expect(line).not.toContain("UNVERIFIED");
    });

    test("setup inspect without meta.author → no author line, no UNVERIFIED", async () => {
        writeManifestFile(manifestPath, makeManifest({}));
        await main(["setup", "inspect", manifestPath], env);
        expect(stdout.value).not.toMatch(/^\s*author:/m);
        expect(stdout.value).not.toContain("UNVERIFIED");
    });

    test("setup import --dry-run with supersedes → supersedes line has (UNVERIFIED)", async () => {
        writeManifestFile(manifestPath, makeManifest(
            { supersedes: [HASH_A] },
            { settings: { night_mode: true } },
        ));
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("supersedes:");
        expect(stdout.value).toContain("UNVERIFIED");
        expect(stdout.value).toContain(HASH_A);
    });
});

// ---- §3.2 JSON mode wrapping -----------------------------------------------

describe("W33 JSON mode — §3.2 identity-claim wrapper", () => {
    test("setup inspect --json: author wrapped { value, verified: false }", async () => {
        writeManifestFile(manifestPath, makeManifest({ author: "Alice" }));
        const code = await main(["setup", "inspect", manifestPath, "--json"], env);
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.author).toEqual({ value: "Alice", verified: false });
    });

    test("setup inspect --json: source_url wrapped", async () => {
        writeManifestFile(manifestPath, makeManifest({
            source_url: "https://alice.dev/s",
        }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.sourceUrl).toEqual({
            value: "https://alice.dev/s", verified: false,
        });
    });

    test("setup inspect --json: author_key_id wrapped", async () => {
        writeManifestFile(manifestPath, makeManifest({ author_key_id: "RWT1" }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.authorKeyId).toEqual({ value: "RWT1", verified: false });
    });

    test("setup inspect --json: supersedes wrapped with array value", async () => {
        writeManifestFile(manifestPath, makeManifest({
            supersedes: [HASH_A, HASH_B],
        }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.supersedes).toEqual({
            value: [HASH_A, HASH_B], verified: false,
        });
    });

    test("setup inspect --json: version stays bare (content field)", async () => {
        writeManifestFile(manifestPath, makeManifest({ version: "2.1" }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.version).toBe("2.1");
    });

    test("setup inspect --json: description stays bare (content field)", async () => {
        writeManifestFile(manifestPath, makeManifest({ description: "a desc" }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.description).toBe("a desc");
    });

    test("setup inspect --json: omitted identity fields stay omitted (not wrapped)", async () => {
        writeManifestFile(manifestPath, makeManifest({ author: "Alice" }));
        await main(["setup", "inspect", manifestPath, "--json"], env);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.sourceUrl).toBeUndefined();
        expect(payload.data.authorKeyId).toBeUndefined();
        expect(payload.data.supersedes).toBeUndefined();
    });

    test("setup import --json --dry-run: identity claims wrapped in envelope", async () => {
        writeManifestFile(manifestPath, makeManifest(
            { author: "Alice", source_url: "https://alice.dev/s", supersedes: [HASH_A] },
            { settings: { night_mode: true } },
        ));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--json"],
            env,
        );
        expect(code).toBe(0);
        const payload = JSON.parse(stdout.value);
        expect(payload.data.author).toEqual({ value: "Alice", verified: false });
        expect(payload.data.sourceUrl).toEqual({
            value: "https://alice.dev/s", verified: false,
        });
        expect(payload.data.supersedes).toEqual({
            value: [HASH_A], verified: false,
        });
    });
});

// ---- §4 anti-anchor-trust ordering -----------------------------------------

describe("W33 anti-anchor-trust — §4", () => {
    test("dry-run with both SENSITIVE + author → SENSITIVE block before author line", async () => {
        writeManifestFile(manifestPath, makeManifest(
            { author: "Alice" },
            { settings: { home_dir: "/mnt/evil", night_mode: true } },
        ));
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(4);
        const idxSensitive = stdout.value.indexOf("security-sensitive");
        const idxAuthor = stdout.value.indexOf("Alice");
        expect(idxSensitive).toBeGreaterThanOrEqual(0);
        expect(idxAuthor).toBeGreaterThanOrEqual(0);
        expect(idxSensitive).toBeLessThan(idxAuthor);
    });

    test("empty SENSITIVE case → no SENSITIVE header, author still renders", async () => {
        writeManifestFile(manifestPath, makeManifest(
            { author: "Alice" },
            { settings: { night_mode: true } },
        ));
        const code = await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).not.toContain("security-sensitive");
        expect(stdout.value).toContain("Alice");
        expect(stdout.value).toContain("UNVERIFIED");
    });
});

// ---- §5 supersedes rendering -----------------------------------------------

describe("W33 supersedes — §5", () => {
    test("supersedes: [] → line omitted from text output", async () => {
        writeManifestFile(manifestPath, makeManifest({ supersedes: [] }));
        await main(["setup", "inspect", manifestPath], env);
        expect(stdout.value).not.toContain("supersedes:");
    });

    test("supersedes: [one] → one hash rendered", async () => {
        writeManifestFile(manifestPath, makeManifest({ supersedes: [HASH_A] }));
        await main(["setup", "inspect", manifestPath], env);
        expect(stdout.value).toContain("supersedes:");
        expect(stdout.value).toContain(HASH_A);
        expect(stdout.value).not.toContain(HASH_B);
    });

    test("supersedes: [N] → every hash on its own line", async () => {
        writeManifestFile(manifestPath, makeManifest({
            supersedes: [HASH_A, HASH_B],
        }));
        await main(["setup", "inspect", manifestPath], env);
        const lines = stdout.value.split("\n");
        const aLine = lines.find((l) => l.includes(HASH_A));
        const bLine = lines.find((l) => l.includes(HASH_B));
        expect(aLine).toBeDefined();
        expect(bLine).toBeDefined();
        expect(aLine).not.toBe(bLine);
    });
});
