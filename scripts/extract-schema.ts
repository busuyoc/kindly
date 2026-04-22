#!/usr/bin/env bun
// Schema extractor for settings.reader.lua keys.
//
// Walks a KOReader source tree (frontend/ + plugins/), finds every
// G_reader_settings:METHOD("KEY" [, ARG]) call, infers a type per key from
// the method cluster + any literal second-argument, and writes a
// deterministic JSON schema.
//
// Usage:  bun run scripts/extract-schema.ts <koreader-source-root> [output-path]
//
// The output path defaults to data/schemas/settings.reader.lua.v1.json.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { parseSettingsFile } from "../src/lua/reader.ts";

type LiteralType = "number" | "string" | "boolean" | "table";

type MethodCluster = "boolean" | "typed" | "agnostic";

const METHOD_CLUSTER: Record<string, MethodCluster> = {
    isTrue: "boolean",
    isFalse: "boolean",
    nilOrTrue: "boolean",
    nilOrFalse: "boolean",
    makeTrue: "boolean",
    makeFalse: "boolean",
    flipTrue: "boolean",
    flipFalse: "boolean",
    flipNilOrTrue: "boolean",
    flipNilOrFalse: "boolean",
    toggle: "boolean",

    readSetting: "typed",
    saveSetting: "typed",

    has: "agnostic",
    hasNot: "agnostic",
    delSetting: "agnostic",
    child: "agnostic",
    initializeExtSettings: "agnostic",
    saveSettingForExt: "agnostic",
    getSettingForExt: "agnostic",
};

type KeyEvidence = {
    methods: Set<string>;
    literals: Set<LiteralType>;
    observed: Set<LiteralType>;
    callSites: number;
};

type FinalType = "boolean" | "number" | "string" | "table" | "unknown";

type EvidenceSource = "method" | "literal" | "observed";

const CALL_RE = /G_reader_settings\s*:\s*([a-zA-Z]+)\s*\(\s*"([a-zA-Z_][a-zA-Z0-9_]*)"(?:\s*,\s*([^)]*))?/g;

function classifyLiteral(arg: string | undefined): LiteralType | null {
    if (!arg) return null;
    const s = arg.trim();
    if (s === "") return null;
    if (s === "true" || s === "false") return "boolean";
    if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return "number";
    if (/^"([^"\\]|\\.)*"$/.test(s) || /^'([^'\\]|\\.)*'$/.test(s)) return "string";
    if (s.startsWith("{")) return "table";
    return null;
}

function walkLuaFiles(root: string): string[] {
    const out: string[] = [];
    (function rec(p: string) {
        for (const entry of readdirSync(p)) {
            if (entry.startsWith(".")) continue;
            const full = join(p, entry);
            let st;
            try { st = statSync(full); } catch { continue; }
            if (st.isDirectory()) rec(full);
            else if (st.isFile() && entry.endsWith(".lua")) out.push(full);
        }
    })(root);
    return out;
}

function inferType(ev: KeyEvidence): { type: FinalType; source: EvidenceSource | null } {
    for (const m of ev.methods) {
        if (METHOD_CLUSTER[m] === "boolean") return { type: "boolean", source: "method" };
    }
    if (ev.literals.size === 1) {
        const [only] = ev.literals;
        return { type: only as FinalType, source: "literal" };
    }
    if (ev.observed.size === 1) {
        const [only] = ev.observed;
        return { type: only as FinalType, source: "observed" };
    }
    // Conflict between literal sources → unknown (don't lie).
    return { type: "unknown", source: null };
}

function luaValueType(v: unknown): LiteralType | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    if (typeof v === "string") return "string";
    if (typeof v === "object") return "table";
    return null;
}

function ingestObservedSettings(file: string, evidence: Map<string, KeyEvidence>): number {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return 0; }
    let parsed: unknown;
    try { parsed = parseSettingsFile(text); } catch { return 0; }
    if (!parsed || typeof parsed !== "object") return 0;
    let n = 0;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const t = luaValueType(value);
        if (!t) continue;
        const ev = evidence.get(key) ?? {
            methods: new Set(), literals: new Set(), observed: new Set(), callSites: 0,
        };
        ev.observed.add(t);
        evidence.set(key, ev);
        n += 1;
    }
    return n;
}

function readKoreaderVersion(root: string): string | null {
    try {
        const raw = readFileSync(join(root, "git-rev"), "utf8").trim();
        return raw || null;
    } catch {
        return null;
    }
}

function main() {
    const args = process.argv.slice(2);
    let rawRoot: string | undefined;
    let rawOut: string | undefined;
    const observedPaths: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--observed") {
            observedPaths.push(args[++i]);
        } else if (!rawRoot) {
            rawRoot = a;
        } else if (!rawOut) {
            rawOut = a;
        }
    }
    if (!rawRoot) {
        console.error("usage: bun run scripts/extract-schema.ts <koreader-root> [output.json] [--observed path ...]");
        process.exit(2);
    }
    const root = rawRoot.replace(/\/$/, "");
    const outPath = rawOut ?? join(import.meta.dir, "..", "data", "schemas", "settings.reader.lua.v1.json");
    // If no --observed given and the device mount has a settings.reader.lua, use it.
    if (observedPaths.length === 0) {
        const livePath = join(root, "settings.reader.lua");
        try { statSync(livePath); observedPaths.push(livePath); } catch { /* none */ }
    }

    const frontend = join(root, "frontend");
    const plugins = join(root, "plugins");
    const files = [
        ...walkLuaFiles(frontend),
        ...walkLuaFiles(plugins),
    ];

    const evidence = new Map<string, KeyEvidence>();
    const unknownMethods = new Map<string, number>();

    for (const file of files) {
        const text = readFileSync(file, "utf8");
        CALL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CALL_RE.exec(text)) !== null) {
            const [, method, key, arg] = m;
            const ev = evidence.get(key) ?? {
                methods: new Set(), literals: new Set(), observed: new Set(), callSites: 0,
            };
            ev.methods.add(method);
            ev.callSites += 1;
            if (METHOD_CLUSTER[method] === "typed") {
                const lit = classifyLiteral(arg);
                if (lit) ev.literals.add(lit);
            } else if (!(method in METHOD_CLUSTER)) {
                unknownMethods.set(method, (unknownMethods.get(method) ?? 0) + 1);
            }
            evidence.set(key, ev);
        }
    }

    let observedIngested = 0;
    for (const p of observedPaths) {
        observedIngested += ingestObservedSettings(p, evidence);
    }

    const version = readKoreaderVersion(root);

    const keys: Record<string, unknown> = {};
    const sortedKeys = [...evidence.keys()].sort();
    const typeCounts: Record<FinalType, number> = {
        boolean: 0, number: 0, string: 0, table: 0, unknown: 0,
    };
    const sourceCounts: Record<string, number> = { method: 0, literal: 0, observed: 0, none: 0 };
    for (const k of sortedKeys) {
        const ev = evidence.get(k)!;
        const { type: t, source } = inferType(ev);
        typeCounts[t] += 1;
        sourceCounts[source ?? "none"] += 1;
        keys[k] = {
            type: t,
            evidence: {
                methods: [...ev.methods].sort(),
                literals: [...ev.literals].sort(),
                observed: [...ev.observed].sort(),
                source,
            },
            call_sites: ev.callSites,
        };
    }

    const schema = {
        $schema_version: 1,
        extracted_from: {
            koreader_root: relative(process.cwd(), root) || root,
            koreader_version: version,
            lua_files_scanned: files.length,
        },
        extracted_at: new Date().toISOString(),
        observed_from: observedPaths.map((p) => relative(process.cwd(), p) || p),
        stats: {
            total_keys: sortedKeys.length,
            by_type: typeCounts,
            by_source: sourceCounts,
            observed_keys_ingested: observedIngested,
        },
        keys,
    };

    writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");

    console.log(`Scanned ${files.length} .lua files under ${root}`);
    if (observedPaths.length > 0) {
        console.log(`Ingested ${observedIngested} observed top-level keys from ${observedPaths.length} settings file(s).`);
    }
    console.log(`Extracted ${sortedKeys.length} unique settings keys.`);
    console.log("By inferred type:");
    for (const [t, n] of Object.entries(typeCounts)) {
        console.log(`  ${t.padEnd(8)} ${n}`);
    }
    console.log("By evidence source:");
    for (const [s, n] of Object.entries(sourceCounts)) {
        console.log(`  ${s.padEnd(8)} ${n}`);
    }
    if (unknownMethods.size > 0) {
        console.log("\nUnclassified methods (sanity check):");
        for (const [m, n] of [...unknownMethods].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${m.padEnd(24)} ${n}`);
        }
    }
    console.log(`\nWrote ${outPath}`);
}

main();
