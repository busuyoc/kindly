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

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parse as yamlParse } from "yaml";
import { extractTarGz, listTarGz } from "../fs/archive.ts";
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
    if (!existsSync(archivePath)) {
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

        const manifestBytes = readFileSync(join(stage, "manifest.yaml"));
        let manifest: SetupManifest;
        try {
            const raw = yamlParse(manifestBytes.toString("utf8"));
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
        const files = new Map<string, Buffer>();
        for (const [fullPath, d] of declared.entries()) {
            const abs = join(stage, fullPath.split("/").join(sep));
            if (!existsSync(abs)) {
                throw new SetupUnpackError(`manifest declares ${fullPath} but archive doesn't contain it`);
            }
            const actualBytes = statSync(abs).size;
            if (actualBytes !== d.bytes) {
                throw new SetupUnpackError(
                    `${fullPath}: declared bytes=${d.bytes}, actual=${actualBytes}`
                );
            }
            const buf = readFileSync(abs);
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
