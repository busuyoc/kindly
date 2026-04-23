// W36/W37: scanPipeline unit tests — catalog suppression correctness.
//
// The pipeline's load-bearing behavior is that MATCH suppresses, everything
// else doesn't. Test that directly with synthetic inputs.

import { describe, test, expect } from "bun:test";
import {
    scanShippedLuaFiles,
    PATCH_SENTINEL,
} from "../../src/catalog/scanPipeline.ts";
import { hashBytes } from "../../src/setup/canonical.ts";
import type { EmbeddedFile } from "../../src/setup/schema.ts";
import type { PluginHashReport, PluginVerdict } from "../../src/catalog/verify.ts";

function embed(path: string, bytes: Buffer): EmbeddedFile {
    return {
        path,
        hash: `sha256:${hashBytes(bytes as unknown as Uint8Array)}`,
        bytes: bytes.length,
    };
}

function buf(s: string): Buffer {
    return Buffer.from(s, "utf8");
}

function report(verdicts: PluginVerdict[]): PluginHashReport {
    return {
        verdicts,
        catalogVersion: "v2026.03",
        deviceVersion: "v2026.03",
        versionMatch: true,
    };
}

describe("scanShippedLuaFiles — catalog suppression", () => {
    test("MATCH verdict suppresses findings for that plugin", () => {
        const src = `os.execute("rm -rf /tmp/x")`;
        const files = new Map<string, Buffer>([
            ["statistics.koplugin/main.lua", buf(src)],
        ]);
        const plugins: EmbeddedFile[] = [
            embed("statistics.koplugin/main.lua", buf(src)),
        ];

        const out = scanShippedLuaFiles({
            shippedPlugins: plugins,
            shippedPatches: [],
            files,
            hashReport: report([{ status: "MATCH", name: "statistics" }]),
        });

        expect(out.findings).toEqual([]);
        expect(out.suppressedByCatalog).toBe(1);
        expect(out.filesScanned).toBe(0);
    });

    test("MISMATCH verdict does NOT suppress", () => {
        const src = `os.execute("rm -rf /tmp/x")`;
        const files = new Map<string, Buffer>([
            ["statistics.koplugin/main.lua", buf(src)],
        ]);
        const plugins: EmbeddedFile[] = [
            embed("statistics.koplugin/main.lua", buf(src)),
        ];

        const out = scanShippedLuaFiles({
            shippedPlugins: plugins,
            shippedPatches: [],
            files,
            hashReport: report([
                { status: "MISMATCH", name: "statistics", files: [] },
            ]),
        });

        expect(out.findings).toHaveLength(1);
        expect(out.findings[0]!.category).toBe("shell");
        expect(out.suppressedByCatalog).toBe(0);
    });

    test("UNCATALOGUED does NOT suppress", () => {
        const src = `local s = require("socket")`;
        const files = new Map<string, Buffer>([
            ["evil.koplugin/main.lua", buf(src)],
        ]);
        const plugins: EmbeddedFile[] = [
            embed("evil.koplugin/main.lua", buf(src)),
        ];

        const out = scanShippedLuaFiles({
            shippedPlugins: plugins,
            shippedPatches: [],
            files,
            hashReport: report([{ status: "UNCATALOGUED", name: "evil" }]),
        });

        expect(out.findings).toHaveLength(1);
        expect(out.findings[0]!.plugin).toBe("evil");
        expect(out.findings[0]!.category).toBe("network");
    });

    test("null hashReport scans everything (no suppression)", () => {
        const src = `os.execute("x")`;
        const files = new Map<string, Buffer>([
            ["novel.koplugin/main.lua", buf(src)],
        ]);
        const out = scanShippedLuaFiles({
            shippedPlugins: [embed("novel.koplugin/main.lua", buf(src))],
            shippedPatches: [],
            files,
            hashReport: null,
        });
        expect(out.findings).toHaveLength(1);
        expect(out.filesScanned).toBe(1);
    });
});

describe("scanShippedLuaFiles — patches", () => {
    test("patches always scan (no catalog coverage)", () => {
        const src = `os.execute("patch code")`;
        const files = new Map<string, Buffer>([
            ["patches/1-override.lua", buf(src)],
        ]);
        const out = scanShippedLuaFiles({
            shippedPlugins: [],
            shippedPatches: [embed("patches/1-override.lua", buf(src))],
            files,
            hashReport: null,
        });

        expect(out.findings).toHaveLength(1);
        expect(out.findings[0]!.plugin).toBe(PATCH_SENTINEL);
        expect(out.findings[0]!.file).toBe("1-override.lua");
    });
});

describe("scanShippedLuaFiles — multi-file and sorting", () => {
    test("multiple findings sorted by (plugin, file, line)", () => {
        const a = Buffer.from(`os.execute("x")`, "utf8");
        const b = Buffer.from(`\nrequire("ffi")`, "utf8");
        const files = new Map<string, Buffer>([
            ["alpha.koplugin/main.lua", a],
            ["beta.koplugin/main.lua", b],
        ]);
        const out = scanShippedLuaFiles({
            shippedPlugins: [
                embed("alpha.koplugin/main.lua", a),
                embed("beta.koplugin/main.lua", b),
            ],
            shippedPatches: [],
            files,
            hashReport: null,
        });
        expect(out.findings.map((f) => f.plugin)).toEqual(["alpha", "beta"]);
        expect(out.filesScanned).toBe(2);
        expect(out.bytesScanned).toBe(a.length + b.length);
    });

    test("non-.lua files skipped (assets/fonts)", () => {
        const asset = Buffer.from("binary blob", "utf8");
        const files = new Map<string, Buffer>([
            ["pkg.koplugin/icon.png", asset],
        ]);
        const out = scanShippedLuaFiles({
            shippedPlugins: [embed("pkg.koplugin/icon.png", asset)],
            shippedPatches: [],
            files,
            hashReport: null,
        });
        expect(out.filesScanned).toBe(0);
        expect(out.findings).toEqual([]);
    });
});

describe("scanShippedLuaFiles — localsend-style demonstration", () => {
    // Per docs/93 §9: the heaviest user of dangerous calls in the field
    // survey. Whole plugin is uncatalogued → every finding surfaces.
    test("uncatalogued plugin with multiple categories", () => {
        const src = [
            `os.execute("iptables -A INPUT -p tcp --dport 53317 -j ACCEPT")`,
            `local p = io.popen("curl -s " .. url)`,
            `local s = require("socket")`,
        ].join("\n");
        const files = new Map<string, Buffer>([
            ["localsend.koplugin/main.lua", buf(src)],
        ]);
        const out = scanShippedLuaFiles({
            shippedPlugins: [embed("localsend.koplugin/main.lua", buf(src))],
            shippedPatches: [],
            files,
            hashReport: report([{ status: "UNCATALOGUED", name: "localsend" }]),
        });
        const categories = out.findings.map((f) => f.category).sort();
        expect(categories).toEqual(["network", "shell", "shell"]);
    });
});
