// S602 — classify-aware path-content heuristic producer + gate.
// Warn-tier per S605: traversal (`..`) and absolute-out-of-/mnt/us/.

import { describe, test, expect } from "bun:test";
import {
    classifyPathContent,
    pathContentHits,
} from "../../src/gates/producers/pathContentHits.ts";
import { PATH_CONTENT_HEURISTIC } from "../../src/gates/definitions/shape.ts";
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

describe("classifyPathContent — predicate", () => {
    test("traversal: `..` segment", () => {
        expect(classifyPathContent("/mnt/us/../etc/passwd")).toBe("traversal");
        expect(classifyPathContent("../../escape")).toBe("traversal");
        expect(classifyPathContent("a/../b")).toBe("traversal");
    });

    test("out-of-tree: absolute path not under /mnt/us/", () => {
        expect(classifyPathContent("/etc/passwd")).toBe("out-of-tree");
        expect(classifyPathContent("/proc/self/environ")).toBe("out-of-tree");
        expect(classifyPathContent("/var/log/messages")).toBe("out-of-tree");
    });

    test("benign: under /mnt/us/", () => {
        expect(classifyPathContent("/mnt/us/koreader/plugins")).toBeNull();
        expect(classifyPathContent("/mnt/us/documents/book.epub")).toBeNull();
        expect(classifyPathContent("/mnt/us/screenshots")).toBeNull();
    });

    test("benign: relative path without `..`", () => {
        expect(classifyPathContent("plugins/extra")).toBeNull();
        expect(classifyPathContent("./local")).toBeNull();
        expect(classifyPathContent("foo.png")).toBeNull();
    });

    test("benign: empty string", () => {
        expect(classifyPathContent("")).toBeNull();
    });

    test("substring `..` inside a segment is NOT traversal", () => {
        // Only a literal `..` segment counts — `foo..bar` as a filename is
        // weird but not a traversal.
        expect(classifyPathContent("/mnt/us/foo..bar")).toBeNull();
    });
});

describe("pathContentHits — classification scope", () => {
    test("flags `..` traversal in extra_plugin_paths element", () => {
        const r = pathContentHits(ctxWith({
            extra_plugin_paths: ["/mnt/us/koreader/plugins/../../etc"],
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("extra_plugin_paths[0]");
        expect(r.hits[0]!.kind).toBe("traversal");
    });

    test("flags absolute-out-of-tree in cover_image_path", () => {
        const r = pathContentHits(ctxWith({
            cover_image_path: "/etc/passwd",
        }));
        expect(r.hits.length).toBe(1);
        expect(r.hits[0]!.path).toBe("cover_image_path");
        expect(r.hits[0]!.kind).toBe("out-of-tree");
    });

    test("ignores benign /mnt/us/ paths at sensitive-fs keys", () => {
        const r = pathContentHits(ctxWith({
            cover_image_path: "/mnt/us/cover.png",
            extra_plugin_paths: ["/mnt/us/koreader/plugins/extra"],
        }));
        expect(r.hits).toEqual([]);
    });

    test("ignores path-content at USER-class keys (no false positives)", () => {
        // last_page is USER-class (changeClass=none) — even though the
        // value looks like a path, the gate only fires at sensitive-fs /
        // sensitive-code-exec keys.
        const r = pathContentHits(ctxWith({
            last_page: "/etc",
        }));
        expect(r.hits).toEqual([]);
    });

    test("non-string values are skipped", () => {
        const r = pathContentHits(ctxWith({
            extra_plugin_paths: [42, true, null],
        }));
        expect(r.hits).toEqual([]);
    });

    test("multiple hits across keys reported in walk order", () => {
        const r = pathContentHits(ctxWith({
            extra_plugin_paths: ["../escape", "/etc/foo"],
        }));
        expect(r.hits.length).toBe(2);
        expect(r.hits.map((h) => h.kind)).toEqual(["traversal", "out-of-tree"]);
    });
});

describe("pathContentHits — shape robustness", () => {
    test("empty yamlSettings → no hits", () => {
        expect(pathContentHits(ctxWith({})).hits).toEqual([]);
    });

    test("missing yamlSettings → no hits, no throw", () => {
        const r = pathContentHits({
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: {},
        });
        expect(r.hits).toEqual([]);
    });
});

describe("PATH_CONTENT_HEURISTIC gate", () => {
    test("passes when producer yields no hits", () => {
        const ctx: GateContext = {
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: { pathContentHits: { hits: [] } },
        };
        expect(PATH_CONTENT_HEURISTIC.check(ctx)).toEqual({ kind: "pass" });
    });

    test("warns when producer yields hits", () => {
        const ctx: GateContext = {
            boundary: "apply",
            dryRun: false,
            strictImports: false,
            opts: {},
            producers: {
                pathContentHits: {
                    hits: [
                        { path: "cover_image_path", kind: "out-of-tree", value: "/etc/passwd" },
                    ],
                },
            },
        };
        const r = PATH_CONTENT_HEURISTIC.check(ctx);
        expect(r.kind).toBe("warn");
        if (r.kind === "warn") {
            expect(r.message).toContain("out-of-tree");
            expect(r.message).toContain("cover_image_path");
        }
    });

    test("non-bypassable — empty bypassFlags (warn-tier contract)", () => {
        expect(PATH_CONTENT_HEURISTIC.bypassFlags).toEqual([]);
    });

    test("fires on import + apply + restore", () => {
        expect(PATH_CONTENT_HEURISTIC.appliesAt).toEqual(["import", "apply", "restore"]);
    });

    test("fires always (including --dry-run)", () => {
        expect(PATH_CONTENT_HEURISTIC.firesIn).toBe("always");
    });
});
