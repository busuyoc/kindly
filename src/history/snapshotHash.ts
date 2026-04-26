// Round-3 snapshot integrity hash-binding.
//
// Predicted-stamp + path-subtype validation (round-3 F1, F3) closes the
// directory-redirect side of tampered snapshots. This module closes the
// remaining gap: an attacker with write access to `.kindly/pre-import/<stamp>/`
// (same bucket the writer chose) could swap the on-disk bytes of
// `settings.reader.lua` or `plugins-patches.tar.gz` between original
// write and `kindly rollback --to <N>`. Without content-binding, the
// rollback re-applies the swapped bytes — they parse fine, gates fire
// against snapshot content (catching gross malformations), but a subtle
// swap (`avoid_flashing_ui = false → true`, or `kosync.password` mutated)
// flows through.
//
// Bind by hashing the directory contents at write time, recording the
// hash in the history entry, and verifying at read time before rollback
// trusts the bytes.
//
// Algorithm:
//   1. Walk the dir top-level only (snapshots are 1-2 files: settings + optional fat tar).
//   2. Sort entries by filename (deterministic across Bun/Node/macOS/Linux).
//   3. For each entry: build a line `<sha256-of-bytes>  <filename>\n`.
//   4. Final hash = sha256 of the concatenated manifest, prefixed `sha256:`.
//
// The same shape as `git ls-tree`-style content addressing: file order
// is fixed, file content is hashed once, the manifest is hashed last.
// Renaming a file or swapping its bytes both flip the manifest hash.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Compute the deterministic content hash of a snapshot directory.
 *
 *  Throws if `dir` is not a directory or contains non-regular-file
 *  entries (snapshots only carry plain files; subdirs / symlinks /
 *  device nodes don't belong and would defeat the deterministic walk). */
export function hashSnapshotDir(dir: string): string {
    const st = lstatSync(dir);
    if (!st.isDirectory()) {
        throw new Error(`hashSnapshotDir: not a directory: ${dir}`);
    }

    const entries = readdirSync(dir).sort();
    const lines: string[] = [];
    for (const name of entries) {
        const full = join(dir, name);
        // lstat — must not follow symlinks. A symlink in a snapshot dir
        // is a tampering signal; reject loudly so the caller can surface
        // SNAPSHOT_INVALID instead of silently following. Same applies
        // to the snapshot dir itself: a symlinked snapshot dir would
        // hash whatever the link currently points at, defeating the
        // binding.
        const fst = lstatSync(full);
        if (!fst.isFile()) {
            throw new Error(
                `hashSnapshotDir: ${full} is not a regular file (snapshots must be flat)`,
            );
        }
        const fileHash = createHash("sha256").update(readFileSync(full)).digest("hex");
        lines.push(`${fileHash}  ${name}`);
    }
    const manifest = lines.join("\n") + "\n";
    return "sha256:" + createHash("sha256").update(manifest).digest("hex");
}
