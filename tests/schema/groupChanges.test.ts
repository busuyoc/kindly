// W24 — plugins_bundled unification in groupChanges.
//
// `plugins_disabled.<name>` entries in a Change[] stream get catalog-aware
// labels, severity from curation_opinion, and human "enabled/disabled" hints.
// A whole-dict `added` change on `plugins_disabled` decomposes into per-plugin
// rows so fresh-install diffs render the same way.

import { describe, test, expect, beforeEach } from "bun:test";

import { groupChanges } from "../../src/taxonomy/group.ts";
import type { Change } from "../../src/schema/diff.ts";
import type { Taxonomy } from "../../src/taxonomy/mapper.ts";
import { loadPluginCatalog, reloadPluginCatalog } from "../../src/catalog/reader.ts";

const FIXTURE_TAX: Taxonomy = {
    $schema_version: 1,
    generated_at: "2026-04-22T00:00:00.000Z",
    source: { schema: "x", categories: "y" },
    stats: { total_keys: 1, uncategorized_count: 0, by_category: {}, by_control_hint: {} },
    categories: ["plugins_bundled", "reading"],
    keys: {
        plugins_disabled: { category: "plugins_bundled", label: "Plugins disabled", control_hint: "structured" },
        avoid_flashing_ui: { category: "reading", label: "Avoid flashing UI", control_hint: "toggle" },
    },
};

beforeEach(() => reloadPluginCatalog());

describe("groupChanges — plugins_disabled per-plugin rows", () => {
    test("uses catalog fullname + opinion as label", () => {
        const catalog = loadPluginCatalog();
        const changes: Change[] = [
            { kind: "added", path: ["plugins_disabled", "SSH"], next: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, catalog);
        const bucket = grouped["plugins_bundled"]!;
        expect(bucket).toHaveLength(1);
        const e = bucket[0]!;
        const ssh = catalog.plugins.find((p) => p.name === "SSH")!;
        expect(e.label).toBe(`${ssh.fullname} (${ssh.curation_opinion})`);
    });

    test("severity maps from curation_opinion", () => {
        const catalog = loadPluginCatalog();
        // Pick one plugin per opinion from the real catalog so the test
        // survives curation shuffles as long as each bucket is non-empty.
        const pickByOpinion = (o: "recommended" | "debloat" | "niche") =>
            catalog.plugins.find((p) => p.curation_opinion === o)!.name;

        const rec = pickByOpinion("recommended");
        const deb = pickByOpinion("debloat");
        const nic = pickByOpinion("niche");

        const changes: Change[] = [
            { kind: "added", path: ["plugins_disabled", rec], next: true },
            { kind: "added", path: ["plugins_disabled", deb], next: true },
            { kind: "added", path: ["plugins_disabled", nic], next: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, catalog);
        const bySeverity = Object.fromEntries(
            grouped["plugins_bundled"]!.map((e) => [e.key.split(".")[1], e.severity]),
        );
        expect(bySeverity[rec]).toBe("breaking");
        expect(bySeverity[deb]).toBe("trivial");
        expect(bySeverity[nic]).toBe("functional");
    });

    test("hint is 'disabled' for added=true, 'enabled' for removed", () => {
        const catalog = loadPluginCatalog();
        const changes: Change[] = [
            { kind: "added",   path: ["plugins_disabled", "SSH"], next: true },
            { kind: "removed", path: ["plugins_disabled", "SSH"], prev: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, catalog);
        const hints = grouped["plugins_bundled"]!.map((e) => e.hint);
        expect(hints).toEqual(["disabled", "enabled"]);
    });

    test("unknown plugin (not in catalog) falls back with marker + breaking", () => {
        const catalog = loadPluginCatalog();
        const changes: Change[] = [
            { kind: "added", path: ["plugins_disabled", "ThirdPartyXYZ"], next: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, catalog);
        const e = grouped["plugins_bundled"]![0]!;
        expect(e.label).toBe("ThirdPartyXYZ (unknown plugin)");
        expect(e.severity).toBe("breaking");
    });

    test("whole-dict added plugins_disabled is decomposed into per-plugin rows", () => {
        const catalog = loadPluginCatalog();
        const changes: Change[] = [
            {
                kind: "added",
                path: ["plugins_disabled"],
                next: { SSH: true, hello: true } as never,
            },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, catalog);
        const keys = grouped["plugins_bundled"]!.map((e) => e.key).sort();
        expect(keys).toEqual(["plugins_disabled.SSH", "plugins_disabled.hello"]);
        // And each got a per-plugin label, not the generic one.
        for (const e of grouped["plugins_bundled"]!) {
            expect(e.label).not.toBe("Plugins disabled");
        }
    });

    test("non-plugin keys are unaffected", () => {
        const changes: Change[] = [
            { kind: "added", path: ["avoid_flashing_ui"], next: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, null);
        const e = grouped["reading"]![0]!;
        expect(e.label).toBe("Avoid flashing UI");
        expect(e.hint).toBe("added");
    });

    test("catalog unavailable (null) → fallback labels for plugin toggles", () => {
        const changes: Change[] = [
            { kind: "added", path: ["plugins_disabled", "SSH"], next: true },
        ];
        const grouped = groupChanges(changes, FIXTURE_TAX, null);
        const e = grouped["plugins_bundled"]![0]!;
        expect(e.label).toBe("SSH (unknown plugin)");
        expect(e.severity).toBe("breaking");
    });
});
