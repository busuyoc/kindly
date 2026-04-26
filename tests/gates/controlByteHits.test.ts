// C11 — classify-aware byte-level input filter producer + gate.
// Closes Batch O S321 / S322 / S324 chain.

import { describe, test, expect } from "bun:test";
import { controlByteHits } from "../../src/gates/producers/controlByteHits.ts";
import { CONTROL_BYTES_IN_VALUE } from "../../src/gates/definitions/shape.ts";
import type { GateContext } from "../../src/gates/types.ts";

function ctxWith(yamlSettings: Record<string, unknown>): GateContext {
    return {
        boundary: "apply",
        dryRun: false,
        strictImports: false,
        opts: { yamlSettings },
        producers: {},
    };
}

describe("controlByteHits — classification scope", () => {
    test("flags ESC byte in extra_plugin_paths array element (S321)", () => {
        const r = controlByteHits(ctxWith({
            extra_plugin_paths: ["/mnt/us/koreader/plugins[31mEVIL[0m"],
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("extra_plugin_paths[0]");
        expect(r.hits[0]!.class).toBe("sensitive");
        expect(r.hits[0]!.bytes).toEqual(["0x1B", "0x1B"]);
    });

    test("flags CR in nested SECRET kosync.username (S324 CRLF smuggle)", () => {
        const r = controlByteHits(ctxWith({
            kosync: { username: "alice\r\nHost: evil" },
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("kosync.username");
        expect(r.hits[0]!.class).toBe("secret");
        // Only CR is rejected; LF is allowed (legitimate in user content).
        // Rejecting CR alone is sufficient to break the CRLF smuggle.
        expect(r.hits[0]!.bytes).toEqual(["0x0D"]);
    });

    test("flags NUL in SSH_port-family code-exec key (cover_image_path)", () => {
        const r = controlByteHits(ctxWith({
            cover_image_path: "/mnt/us/cover.png\x00; rm -rf /",
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("cover_image_path");
        expect(r.hits[0]!.class).toBe("code-exec");
        expect(r.hits[0]!.bytes).toEqual(["0x00"]);
    });

    test("ignores control bytes at USER-class keys (no false positives)", () => {
        // last_page is USER-class (changeClass=none, exfilClass=normal).
        // A user might genuinely paste a tab or weird whitespace in a
        // free-text field; we only block at SENSITIVE/SECRET/code-exec.
        const r = controlByteHits(ctxWith({
            last_page: "page[0m1",
        }));
        expect(r.hits.length).toBe(0);
    });

    test("ignores allowed bytes (TAB, LF) even in SENSITIVE values", () => {
        const r = controlByteHits(ctxWith({
            extra_plugin_paths: ["/path/with\ttab\nand\nnewlines"],
        }));
        expect(r.hits.length).toBe(0);
    });

    test("does not flag DEL (0x7F) at USER keys but does at SENSITIVE", () => {
        const ok = controlByteHits(ctxWith({ last_page: "x\x7Fy" }));
        expect(ok.hits.length).toBe(0);
        const bad = controlByteHits(ctxWith({
            extra_plugin_paths: ["x\x7Fy"],
        }));
        expect(bad.hits.length).toBe(1);
        expect(bad.hits[0]!.bytes).toEqual(["0x7F"]);
    });
});

describe("controlByteHits — shape robustness", () => {
    test("empty yamlSettings → no hits", () => {
        const r = controlByteHits(ctxWith({}));
        expect(r.hits).toEqual([]);
    });

    test("missing yamlSettings → no hits, no throw", () => {
        const r = controlByteHits({
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: {},
        });
        expect(r.hits).toEqual([]);
    });

    test("non-string values are not inspected", () => {
        const r = controlByteHits(ctxWith({
            extra_plugin_paths: [42, true, null],
        }));
        expect(r.hits).toEqual([]);
    });

    test("multiple hits across different keys reported in order", () => {
        const r = controlByteHits(ctxWith({
            extra_plugin_paths: ["a\x1Bb", "c\x07d"],
            kosync: { username: "x\rny" },
        }));
        expect(r.hits.length).toBe(3);
        expect(r.hits.map((h) => h.path)).toEqual([
            "extra_plugin_paths[0]",
            "extra_plugin_paths[1]",
            "kosync.username",
        ]);
    });
});

describe("controlByteHits — S960 key-byte inspection at classified parents", () => {
    test("flags ESC byte in plugins_disabled key (manifest plugins.disabled flatten)", () => {
        // Manifest `plugins: { disabled: ["evil\x1bname"] }` flattens to
        // `plugins_disabled = { "evil\x1bname": true }`. The plugin name
        // is in the KEY of the dict, not the value (value is `true`).
        const r = controlByteHits(ctxWith({
            plugins_disabled: { "evil\x1bname": true },
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("plugins_disabled.evil\x1bname");
        expect(r.hits[0]!.class).toBe("sensitive");
        expect(r.hits[0]!.bytes).toEqual(["0x1B"]);
    });

    test("flags multiple control bytes across multiple keys at classified parent", () => {
        const r = controlByteHits(ctxWith({
            plugins_disabled: {
                "ok": true,
                "bad\x07name": true,
                "another\rname": true,
            },
        }));
        expect(r.hits.length).toBe(2);
        expect(r.hits.map((h) => h.bytes)).toEqual([
            ["0x07"],
            ["0x0D"],
        ]);
    });

    test("does not flag clean keys at classified parent (no FP)", () => {
        const r = controlByteHits(ctxWith({
            plugins_disabled: { SSH: true, kosync: true, calibre: true },
        }));
        expect(r.hits).toEqual([]);
    });

    test("does not flag keys at unclassified parent (top-level user objects)", () => {
        // `cre_header_chunk_marks` is USER-class. Even an ESC in its keys
        // is not gated — no on-device renderer reads CRE chunk-mark dict
        // keys as text.
        const r = controlByteHits(ctxWith({
            cre_header_chunk_marks: { "x\x1by": 1 },
        }));
        expect(r.hits).toEqual([]);
    });
});

describe("CONTROL_BYTES_IN_VALUE gate", () => {
    test("passes when producer yields no hits", () => {
        const ctx: GateContext = {
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: { controlByteHits: { hits: [] } },
        };
        expect(CONTROL_BYTES_IN_VALUE.check(ctx)).toEqual({ kind: "pass" });
    });

    test("blocks when producer yields hits, never echoes raw bytes", () => {
        const ctx: GateContext = {
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: {
                controlByteHits: {
                    hits: [
                        { path: "extra_plugin_paths[0]", class: "sensitive", bytes: ["0x1B"] },
                    ],
                },
            },
        };
        const r = CONTROL_BYTES_IN_VALUE.check(ctx);
        expect(r.kind).toBe("block");
        if (r.kind === "block") {
            // Hex codepoint must appear; raw 0x1B byte must NOT appear.
            expect(r.message).toContain("0x1B");
            expect(r.message).not.toContain("");
        }
    });

    test("non-bypassable — empty bypassFlags", () => {
        expect(CONTROL_BYTES_IN_VALUE.bypassFlags).toEqual([]);
    });

    test("fires on import + apply + restore + rollback boundaries", () => {
        expect(CONTROL_BYTES_IN_VALUE.appliesAt).toEqual(["import", "apply", "restore", "rollback"]);
    });

    test("fires always (including --dry-run) — preview reflects the block", () => {
        expect(CONTROL_BYTES_IN_VALUE.firesIn).toBe("always");
    });
});
