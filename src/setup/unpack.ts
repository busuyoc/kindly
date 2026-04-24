// Unpack a .kset archive into { manifest, files }, verifying integrity.
//
// The archive comes from a stranger; every byte is attack surface.
// Acceptance rules (in order):
//   1. Archive extracts cleanly via tar.
//   2. Every entry path is a safe relative POSIX path (no "..", absolute,
//      backslashes, null bytes).
//   3. Exactly one manifest.yaml at the archive root.
//   4. Every non-manifest entry is under plugins/ or patches/ AND is
//      declared in the manifest.
//   5. Manifest parses as valid SetupManifest (Zod).
//   6. Every declared file exists in the archive with matching byte
//      count and sha256.
//   7. No declared file is missing.
//
// Any failure → throw SetupUnpackError with a specific message. Don't
// leak partial state to the caller.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parseYamlSafe } from "../fs/yamlSafe.ts";
import { extractTarGz, listTarGz } from "../fs/archive.ts";
import { exists, readBytes, statNoFollow } from "../fs/safeRead.ts";
import { hashBytes } from "./canonical.ts";
import { isSafeRelativePath, parseManifest, type SetupManifest } from "./schema.ts";

export type UnpackedSetup = {
    manifest: SetupManifest;
    /** Raw manifest bytes as they appeared in the archive — caller can
     *  hash these directly for identity verification without
     *  re-canonicalizing (bytes-on-disk are identity). */
    manifestBytes: Buffer;
    /** path (as declared in manifest) → file bytes. Hashes already
     *  verified against declarations. */
    files: Map<string, Buffer>;
};

export class SetupUnpackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SetupUnpackError";
    }
}

export function unpackSetup(archivePath: string): UnpackedSetup {
    if (!exists(archivePath, "user-provided")) {
        throw new SetupUnpackError(`archive not found: ${archivePath}`);
    }

    // Pre-scan entry list for path-safety BEFORE extracting. We don't
    // want tar to lay down a file outside destRoot even for an instant.
    let listed: string[];
    try {
        listed = listTarGz(archivePath);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new SetupUnpackError(`archive unreadable: ${msg}`);
    }

    // Collect the file entries (ignore directory entries — tar lists
    // them with a trailing "/" and we don't need them in the files map).
    const fileEntries = listed.filter((p) => !p.endsWith("/"));

    // Path-safety sweep.
    for (const entry of fileEntries) {
        if (!isSafeRelativePath(entry)) {
            throw new SetupUnpackError(`archive contains unsafe path: ${entry}`);
        }
    }

    // Exactly one manifest.yaml at root.
    const manifestEntries = fileEntries.filter((p) => p === "manifest.yaml");
    if (manifestEntries.length === 0) {
        throw new SetupUnpackError("archive is missing manifest.yaml at the root");
    }
    if (manifestEntries.length > 1) {
        throw new SetupUnpackError("archive contains multiple manifest.yaml entries");
    }

    // Extract to a throwaway dir, read everything, clean up.
    const stage = mkdtempSync(join(tmpdir(), "kindly-unpack-"));
    try {
        extractTarGz({ archivePath, destRoot: stage });

        const manifestAbs = join(stage, "manifest.yaml");
        // statNoFollow + readBytes with "extracted-archive" provenance
        // together enforce symlink rejection inside safeRead, replacing
        // the previous inline lstatSync check at this site.
        try {
            statNoFollow(manifestAbs, "extracted-archive");
        } catch (e) {
            if (e instanceof Error && /symlink/.test(e.message)) {
                throw new SetupUnpackError("manifest.yaml is a symlink");
            }
            throw e;
        }
        const manifestBytes = readBytes(manifestAbs, "extracted-archive");
        let manifest: SetupManifest;
        try {
            const raw = parseYamlSafe(manifestBytes.toString("utf8"));
            manifest = parseManifest(raw);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new SetupUnpackError(`manifest.yaml invalid: ${msg}`);
        }

        // Build the set of entries the manifest accounts for, keyed by
        // the FULL in-archive path (plugins/... or patches/...).
        const declared = new Map<string, { path: string; hash: string; bytes: number }>();
        for (const f of manifest.plugins?.files ?? []) {
            declared.set(`plugins/${f.path}`, { path: f.path, hash: f.hash, bytes: f.bytes });
        }
        for (const f of manifest.patches ?? []) {
            declared.set(`patches/${f.path}`, { path: f.path, hash: f.hash, bytes: f.bytes });
        }

        // Every non-manifest file must be declared.
        for (const entry of fileEntries) {
            if (entry === "manifest.yaml") continue;
            if (!declared.has(entry)) {
                throw new SetupUnpackError(`archive contains undeclared file: ${entry}`);
            }
        }

        // Every declared file must exist on disk, with matching size + hash.
        // The "extracted-archive" provenance routed through safeRead rejects
        // symlinks centrally — a malicious archive can't plant one to read
        // arbitrary host files.
        const files = new Map<string, Buffer>();
        for (const [fullPath, d] of declared.entries()) {
            const abs = join(stage, fullPath.split("/").join(sep));
            if (!exists(abs, "extracted-archive")) {
                throw new SetupUnpackError(`manifest declares ${fullPath} but archive doesn't contain it`);
            }
            let st;
            try {
                st = statNoFollow(abs, "extracted-archive");
            } catch (e) {
                if (e instanceof Error && /symlink/.test(e.message)) {
                    throw new SetupUnpackError(`archive contains symlink: ${fullPath}`);
                }
                throw e;
            }
            if (!st.isFile()) {
                throw new SetupUnpackError(`archive entry is not a regular file: ${fullPath}`);
            }
            if (st.size !== d.bytes) {
                throw new SetupUnpackError(
                    `${fullPath}: declared bytes=${d.bytes}, actual=${st.size}`
                );
            }
            const buf = readBytes(abs, "extracted-archive");
            const actualHash = hashBytes(buf);
            if (actualHash !== d.hash) {
                throw new SetupUnpackError(
                    `${fullPath}: declared hash=${d.hash}, actual=${actualHash}`
                );
            }
            files.set(d.path, buf);
        }

        return { manifest, manifestBytes, files };
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
