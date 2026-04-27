// R4 (review hardening): tmpdir lifecycle helper for tests.
//
// Without this, tests scattered across the suite create mkdtempSync dirs
// in beforeEach without paired afterEach cleanup. They don't fail (macOS
// /private/var/folders and Linux /tmp both auto-clean periodically), but
// the suite leaves growing artifacts during long dev sessions.
//
// Usage:
//
//   import { useTmpDir } from "../helpers/tmpdir.ts";
//
//   describe("...", () => {
//     const tmp = useTmpDir("kindly-foo-");
//     test("...", () => {
//       const file = join(tmp(), "x.txt");
//       // ...
//     });
//   });
//
// `tmp()` returns the current tmpdir for this test. A fresh dir is
// created in beforeEach; afterEach removes it recursively.

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Hooks into bun:test's beforeEach/afterEach to create + clean a fresh
 *  tmpdir per test. Returns a getter — call `tmp()` inside a test to get
 *  the path. The getter throws if called before beforeEach has run. */
export function useTmpDir(prefix: string): () => string {
    let current: string | null = null;
    beforeEach(() => {
        current = mkdtempSync(join(tmpdir(), prefix));
    });
    afterEach(() => {
        if (current !== null) {
            rmSync(current, { recursive: true, force: true });
            current = null;
        }
    });
    return () => {
        if (current === null) {
            throw new Error("useTmpDir(): tmp() called outside a test (no active beforeEach)");
        }
        return current;
    };
}
