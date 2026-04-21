import { describe, test, expect } from "bun:test";
import { computeChanges } from "../../src/schema/diff.ts";
import type { LuaValue } from "../../src/lua/writer.ts";

describe("computeChanges", () => {
    test("no changes when YAML matches device", () => {
        const same = { a: 1, b: "x" } as Record<string, LuaValue>;
        expect(computeChanges(same, { ...same })).toEqual([]);
    });

    test("added key", () => {
        const changes = computeChanges({}, { a: 1 });
        expect(changes).toEqual([{ kind: "added", path: ["a"], next: 1 }]);
    });

    test("changed scalar", () => {
        const changes = computeChanges({ a: 1 }, { a: 2 });
        expect(changes).toEqual([{ kind: "changed", path: ["a"], prev: 1, next: 2 }]);
    });

    test("changes are sorted by key", () => {
        const changes = computeChanges({}, { zed: 1, alpha: 2 });
        expect(changes.map((c) => c.path[0])).toEqual(["alpha", "zed"]);
    });

    test("device-only keys are NOT reported (apply is non-destructive)", () => {
        const changes = computeChanges({ onlyOnDevice: 1, shared: 2 }, { shared: 2 });
        expect(changes).toEqual([]);
    });

    test("nested change: only the changed leaf is reported", () => {
        const changes = computeChanges(
            { footer: { align: "left", battery: true } as any },
            { footer: { align: "center", battery: true } as any }
        );
        expect(changes).toEqual([
            { kind: "changed", path: ["footer", "align"], prev: "left", next: "center" },
        ]);
    });

    test("nested added: new leaf in existing object", () => {
        const changes = computeChanges(
            { footer: { align: "left" } as any },
            { footer: { align: "left", battery: true } as any }
        );
        expect(changes).toEqual([
            { kind: "added", path: ["footer", "battery"], next: true },
        ]);
    });

    test("array equality by element value", () => {
        expect(
            computeChanges({ list: [1, 2, 3] as any }, { list: [1, 2, 3] as any })
        ).toEqual([]);
        expect(
            computeChanges({ list: [1, 2, 3] as any }, { list: [1, 2, 4] as any })
        ).toHaveLength(1);
    });
});
