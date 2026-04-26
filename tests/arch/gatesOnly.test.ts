// Architecture drift test. The gates refactor's central claim — "every
// policy block goes through the gate registry" — only holds if policy-
// class KindlyError throws come from src/gates/ and nowhere else. This
// test greps the source, scans for POLICY_BLOCK_CODES throws, and fails
// on any site outside src/gates/.
//
// When this fails, either:
//   (a) someone added an inline throw at an unexpected boundary (move
//       it into a registry-backed gate), or
//   (b) a new policy error code was added to POLICY_BLOCK_CODES and the
//       whitelist below needs the relevant gate entry added.
//
// Non-policy codes (YAML_NOT_FOUND, MOUNT_NOT_FOUND, SETTINGS_NOT_FOUND,
// CATALOG_NOT_FOUND, ARCHIVE_UNSAFE_PATH, etc.) can be thrown anywhere —
// they're preconditions/infrastructure, not trust-boundary decisions.

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { POLICY_BLOCK_CODES } from "../../src/types/errors.ts";

const SRC_ROOT = join(__dirname, "..", "..", "src");
const GATES_ROOT = join(SRC_ROOT, "gates");

/** Explicit whitelist of policy-code throws that legitimately live
 *  outside src/gates/. Each entry MUST include a rationale comment —
 *  "this is fine" is not a rationale. If you're tempted to add an
 *  entry here for a trust-boundary decision, migrate to a gate instead. */
const WHITELIST: ReadonlyArray<{ file: string; code: string; reason: string }> = [
    {
        // setupExport writes a local .kset.yaml file. `--strict` schema
        // enforcement here prevents shipping a malformed Setup — but the
        // write target is the user's own disk, not a trust boundary crossing.
        // Adding "export" as a GateBoundary would pull every upstream
        // producer into the export path for one gate; not worth it.
        file: "src/lib/setupExport.ts",
        code: "SCHEMA_VIOLATION",
        reason: "setupExport --strict schema check; local write, not a trust-boundary policy decision",
    },
    {
        // doctor --repair (C10c) compares an on-disk in-progress marker's
        // recorded mount fingerprint against the current mount before
        // restoring/promoting bytes. The shape is identical to rollback's
        // MOUNT_FINGERPRINT_MATCHES gate, but the surface is recovery of
        // bytes ALREADY on the device, not a fresh trust-boundary
        // crossing. Adding a "doctor:repair" GateBoundary just for this
        // one check would route the entire repair flow through the gate
        // orchestrator for no observability benefit; recovery decisions
        // are already audited via the appended rollback history entry.
        file: "src/lib/doctorRepair.ts",
        code: "MOUNT_FINGERPRINT_MISMATCH",
        reason: "doctor --repair refuses cross-device recovery; identical contract to MOUNT_FINGERPRINT_MATCHES gate, applied to on-disk markers (no new trust boundary)",
    },
];

function isWhitelisted(hit: { file: string; code: string }): boolean {
    return WHITELIST.some((w) => w.file === hit.file && w.code === hit.code);
}

function walkTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walkTsFiles(full));
        else if (entry.endsWith(".ts")) out.push(full);
    }
    return out;
}

interface PolicyThrowSite {
    file: string;
    line: number;
    code: string;
    snippet: string;
}

function findPolicyThrows(): PolicyThrowSite[] {
    const hits: PolicyThrowSite[] = [];
    const files = walkTsFiles(SRC_ROOT);
    for (const file of files) {
        // Skip gate-home: policy throws legitimately originate here.
        if (file.startsWith(GATES_ROOT)) continue;
        // Skip errors.ts itself (defines the codes; may reference them
        // in comments or throws as part of KindlyError internals).
        if (file === join(SRC_ROOT, "types", "errors.ts")) continue;

        const lines = readFileSync(file, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Match: `throw new KindlyError(ErrorCodes.X,`
            // or multiline: the next line after `throw new KindlyError(`
            if (line.includes("throw new KindlyError")) {
                // Scan this line + next few for ErrorCodes.X pattern
                const windowText = lines.slice(i, i + 4).join(" ");
                const m = windowText.match(/ErrorCodes\.(\w+)/);
                if (!m) continue;
                const code = m[1];
                if (POLICY_BLOCK_CODES.has(code)) {
                    hits.push({
                        file: file.replace(SRC_ROOT, "src"),
                        line: i + 1,
                        code,
                        snippet: line.trim(),
                    });
                }
            }
        }
    }
    return hits;
}

describe("arch: policy-class throws live in src/gates/ only", () => {
    test("no POLICY_BLOCK_CODES thrown outside src/gates/ (minus whitelist)", () => {
        const hits = findPolicyThrows().filter((h) => !isWhitelisted(h));
        if (hits.length > 0) {
            const report = hits
                .map((h) => `  ${h.file}:${h.line}  (${h.code})  ${h.snippet}`)
                .join("\n");
            throw new Error(
                `Found ${hits.length} policy-class KindlyError throw(s) outside src/gates/.\n` +
                "These must be migrated to registry-backed gate definitions — see " +
                "docs/infra/99-gates-refactor-plan.md for the pattern. If a site is " +
                "legitimately outside the gate model, add an explicit WHITELIST entry " +
                "in tests/arch/gatesOnly.test.ts with a rationale.\n\n" +
                report,
            );
        }
        expect(hits).toEqual([]);
    });

    test("every WHITELIST entry still exists at its claimed location", () => {
        // Guard against bit-rot: a whitelist entry pointing at a deleted
        // file (or a file that no longer throws that code) indicates the
        // whitelist should shrink.
        const allHits = findPolicyThrows();
        for (const entry of WHITELIST) {
            const match = allHits.find(
                (h) => h.file === entry.file && h.code === entry.code,
            );
            expect(match).toBeDefined();
        }
    });

    test("POLICY_BLOCK_CODES is non-empty (sanity)", () => {
        expect(POLICY_BLOCK_CODES.size).toBeGreaterThan(0);
    });

    test("every policy code in POLICY_BLOCK_CODES is referenced by at least one gate", () => {
        // Scan src/gates/definitions/ for errorCode references; compare
        // against POLICY_BLOCK_CODES. Every policy code should have a gate.
        const gateDefs = walkTsFiles(join(GATES_ROOT, "definitions"));
        const referenced = new Set<string>();
        for (const file of gateDefs) {
            const content = readFileSync(file, "utf8");
            for (const code of POLICY_BLOCK_CODES) {
                // errorCode field uses the key name, not the value —
                // but they match by design.
                if (content.includes(`errorCode: "${code}"`)) referenced.add(code);
            }
        }
        const missing = [...POLICY_BLOCK_CODES].filter((c) => !referenced.has(c));
        // Expected: every policy code has at least one gate entry.
        expect(missing).toEqual([]);
    });
});
