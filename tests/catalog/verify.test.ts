// Unit tests for the pure `verifyPluginAgainstCatalog` + `fileRole` helpers.
//
// Contract: docs/89-plugin-hash-verification-spec.md §4, §8.
// These are the shared comparison functions called by both the import
// pipeline (W32) and the doctor check (W34). The property test at the
// bottom locks in that identical inputs yield identical verdicts
// regardless of the calling path.

import { describe, test, expect } from "bun:test";

import { hashBytes } from "../../src/setup/canonical.ts";
import type { PluginCatalog, PluginEntry } from "../../src/catalog/reader.ts";
import {
    fileRole,
    groupArchivePluginFiles,
    verifyPluginAgainstCatalog,
} from "../../src/catalog/verify.ts";

function stubEntry(overrides: Partial<PluginEntry> & { name: string }): PluginEntry {
    return {
        fullname: overrides.name,
        folder: `${overrides.name}.koplugin`,
        category: "dev",
        ship_default_on: "always",
        ship_default_rationale: "",
        description: "",
        curation_opinion: "niche",
        community_sentiment: "",
        kindle_notes: "",
        references: [],
        deprecated: null,
        computed: false,
        warnings: [],
        known_hashes: null,
        koreader_hash_version: null,
        ...overrides,
    };
}

function stubCatalog(plugins: PluginEntry[]): PluginCatalog {
    return {
        catalog_version: "v1" as const,
        license: "MIT",
        curated_at: "2026-04-23",
        koreader_source: "koreader-src",
        plugin_count: plugins.length,
        plugins,
    };
}

function bufs(pairs: Record<string, string>): Map<string, Uint8Array> {
    const m = new Map<string, Uint8Array>();
    for (const [k, v] of Object.entries(pairs)) {
        m.set(k, Buffer.from(v, "utf8"));
    }
    return m;
}

// ---- verifyPluginAgainstCatalog --------------------------------------------

describe("verifyPluginAgainstCatalog — verdicts (89 §4.2)", () => {
    test("MATCH: all files match catalog hashes", () => {
        const mainBytes = Buffer.from("-- main\n");
        const metaBytes = Buffer.from("-- meta\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: {
                "main.lua": hashBytes(mainBytes),
                "_meta.lua": hashBytes(metaBytes),
            },
        })]);
        const v = verifyPluginAgainstCatalog("SSH", new Map([
            ["main.lua", mainBytes],
            ["_meta.lua", metaBytes],
        ]), catalog);
        expect(v).toEqual({ status: "MATCH", name: "SSH" });
    });

    test("MISMATCH — modified: one file has different bytes", () => {
        const mainBytes = Buffer.from("-- original\n");
        const evilBytes = Buffer.from("-- evil\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(mainBytes) },
        })]);
        const v = verifyPluginAgainstCatalog("SSH", bufs({
            "main.lua": "-- evil\n",
        }), catalog);
        expect(v.status).toBe("MISMATCH");
        if (v.status !== "MISMATCH") throw new Error();
        expect(v.files.length).toBe(1);
        expect(v.files[0]).toEqual({
            status: "modified", file: "main.lua",
            expected: hashBytes(mainBytes),
            actual: hashBytes(evilBytes),
        });
    });

    test("MISMATCH — extra file: archive has file not in catalog", () => {
        const mainBytes = Buffer.from("-- main\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(mainBytes) },
        })]);
        const v = verifyPluginAgainstCatalog("SSH", bufs({
            "main.lua": "-- main\n",
            "backdoor.lua": "-- pwn\n",
        }), catalog);
        expect(v.status).toBe("MISMATCH");
        if (v.status !== "MISMATCH") throw new Error();
        expect(v.files).toEqual([{
            status: "extra", file: "backdoor.lua",
            actual: hashBytes(Buffer.from("-- pwn\n")),
        }]);
    });

    test("MISMATCH — missing (full mode): catalog file not in archive", () => {
        const mainBytes = Buffer.from("-- main\n");
        const metaBytes = Buffer.from("-- meta\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: {
                "main.lua": hashBytes(mainBytes),
                "_meta.lua": hashBytes(metaBytes),
            },
        })]);
        const v = verifyPluginAgainstCatalog("SSH", bufs({
            "main.lua": "-- main\n",
        }), catalog, "full");
        expect(v.status).toBe("MISMATCH");
        if (v.status !== "MISMATCH") throw new Error();
        expect(v.files).toEqual([{
            status: "missing", file: "_meta.lua",
            expected: hashBytes(metaBytes),
        }]);
    });

    test("MISMATCH — mixed: modified + extra in same plugin", () => {
        const mainBytes = Buffer.from("-- main\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(mainBytes) },
        })]);
        const v = verifyPluginAgainstCatalog("SSH", bufs({
            "main.lua": "-- tampered\n",
            "extra.lua": "x",
        }), catalog);
        expect(v.status).toBe("MISMATCH");
        if (v.status !== "MISMATCH") throw new Error();
        const kinds = v.files.map((f) => f.status).sort();
        expect(kinds).toEqual(["extra", "modified"]);
    });

    test("UNCATALOGUED: plugin name not in catalog", () => {
        const catalog = stubCatalog([stubEntry({ name: "SSH", known_hashes: {} })]);
        const v = verifyPluginAgainstCatalog("evilplugin", bufs({ "main.lua": "x" }), catalog);
        expect(v).toEqual({ status: "UNCATALOGUED", name: "evilplugin" });
    });

    test("UNVERIFIED: catalog entry has known_hashes: null", () => {
        const catalog = stubCatalog([stubEntry({ name: "SSH", known_hashes: null })]);
        const v = verifyPluginAgainstCatalog("SSH", bufs({ "main.lua": "x" }), catalog);
        expect(v).toEqual({ status: "UNVERIFIED", name: "SSH" });
    });

    test("subset mode: catalog-only files are NOT reported as missing (89 §5.4)", () => {
        const mainBytes = Buffer.from("-- main\n");
        const metaBytes = Buffer.from("-- meta\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: {
                "main.lua": hashBytes(mainBytes),
                "_meta.lua": hashBytes(metaBytes),
            },
        })]);
        // Archive ships only main.lua; catalog has both. Subset → MATCH.
        const v = verifyPluginAgainstCatalog("SSH", new Map([
            ["main.lua", mainBytes],
        ]), catalog, "subset");
        expect(v).toEqual({ status: "MATCH", name: "SSH" });
    });
});

// ---- groupArchivePluginFiles / MALFORMED_STRUCTURE -------------------------

describe("groupArchivePluginFiles — structure check (89 §4.2)", () => {
    test("well-formed paths → grouped by plugin name (no .koplugin suffix)", () => {
        const bytes = new Map<string, Uint8Array>([
            ["SSH.koplugin/main.lua", Buffer.from("a")],
            ["SSH.koplugin/nested/util.lua", Buffer.from("b")],
            ["calibre.koplugin/main.lua", Buffer.from("c")],
        ]);
        const g = groupArchivePluginFiles(
            [...bytes.keys()].map((path) => ({ path })),
            bytes,
        );
        expect(g.malformed).toEqual([]);
        expect(g.plugins.size).toBe(2);
        expect([...g.plugins.get("SSH")!.keys()].sort())
            .toEqual(["main.lua", "nested/util.lua"]);
        expect([...g.plugins.get("calibre")!.keys()]).toEqual(["main.lua"]);
    });

    test("first segment not ending in .koplugin → malformed", () => {
        const bytes = new Map<string, Uint8Array>([
            ["not_a_plugin/evil.lua", Buffer.from("x")],
            ["SSH.koplugin/main.lua", Buffer.from("y")],
        ]);
        const g = groupArchivePluginFiles(
            [...bytes.keys()].map((path) => ({ path })),
            bytes,
        );
        expect(g.malformed).toEqual(["not_a_plugin/evil.lua"]);
        expect(g.plugins.size).toBe(1);
        expect(g.plugins.has("SSH")).toBe(true);
    });

    test("top-level file (no segment) → malformed", () => {
        const bytes = new Map<string, Uint8Array>([
            ["rootfile.lua", Buffer.from("x")],
        ]);
        const g = groupArchivePluginFiles([{ path: "rootfile.lua" }], bytes);
        expect(g.malformed).toEqual(["rootfile.lua"]);
        expect(g.plugins.size).toBe(0);
    });
});

// ---- fileRole --------------------------------------------------------------

describe("fileRole — 89 §3 file-role derivation", () => {
    test("*.lua → code", () => {
        expect(fileRole("main.lua")).toBe("code");
        expect(fileRole("nested/util.lua")).toBe("code");
    });
    test("assets → asset", () => {
        expect(fileRole("icon.png")).toBe("asset");
        expect(fileRole("translations/en.json")).toBe("asset");
        expect(fileRole("fonts/NotoSerif.ttf")).toBe("asset");
    });
    test("no extension → asset (conservative)", () => {
        expect(fileRole("README")).toBe("asset");
    });
});

// ---- identity property (89 §8) ---------------------------------------------

describe("verifyPluginAgainstCatalog — identity property across call paths", () => {
    test("same (name, files, catalog) → same verdict regardless of caller", () => {
        const mainBytes = Buffer.from("-- main\n");
        const badBytes = Buffer.from("-- bad\n");
        const catalog = stubCatalog([stubEntry({
            name: "SSH",
            known_hashes: { "main.lua": hashBytes(mainBytes) },
        })]);

        // Call "from import path" (subset) and "from doctor path" (full) —
        // as long as the archive matches the catalog, both paths agree.
        // This is the load-bearing property for 89 §8 shared-fn semantics.
        const files = new Map([["main.lua", mainBytes]]);
        expect(verifyPluginAgainstCatalog("SSH", files, catalog, "subset"))
            .toEqual(verifyPluginAgainstCatalog("SSH", files, catalog, "full"));

        // Different bytes → both paths agree it's MISMATCH with the same
        // modified verdict.
        const bad = new Map([["main.lua", badBytes]]);
        const a = verifyPluginAgainstCatalog("SSH", bad, catalog, "subset");
        const b = verifyPluginAgainstCatalog("SSH", bad, catalog, "full");
        expect(a).toEqual(b);
        expect(a.status).toBe("MISMATCH");
    });
});
