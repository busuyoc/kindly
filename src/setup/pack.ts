// Pack an in-memory { manifest, files } into a .kset (tar.gz) archive.
//
// Contract: the manifest is the source of truth. Every file shipped must
// be declared in manifest.plugins.files or manifest.patches with a
// matching sha256 and byte count. Undeclared bytes cannot enter the
// archive; mismatched bytes are refused before we ever touch disk.
//
// The archive is pure transport — its own byte order / timestamps do not
// influence Setup identity. Identity is the canonical manifest hash,
// which embeds every file's hash. See unpack.ts for the verification
// half of the contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTarGz } from "../fs/archive.ts";
import { canonicalizeManifest, hashBytes, manifestHash } from "./canonical.ts";
import {
    isSafeRelativePath,
    type EmbeddedFile,
    type SetupManifest,
} from "./schema.ts";

export type FatSetupInput = {
    manifest: SetupManifest;
    /** path (as declared in manifest) → file bytes. Paths must match
     *  manifest.plugins.files[].path and manifest.patches[].path exactly. */
    files: Map<string, Buffer>;
};

export type PackResult = {
    archivePath: string;
    bytesWritten: number;
    manifestHash: string;
};

export class SetupPackError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SetupPackError";
    }
}

// Collect every declared file entry from the manifest, tagged with its
// in-archive directory prefix.
function declaredEntries(m: SetupManifest): { prefix: "plugins" | "patches"; file: EmbeddedFile }[] {
    const out: { prefix: "plugins" | "patches"; file: EmbeddedFile }[] = [];
    for (const f of m.plugins?.files ?? []) out.push({ prefix: "plugins", file: f });
    for (const f of m.patches ?? []) out.push({ prefix: "patches", file: f });
    return out;
}

export function packSetup(input: FatSetupInput, outputPath: string): PackResult {
    const { manifest, files } = input;
    const declared = declaredEntries(manifest);

    if (declared.length === 0) {
        // Lean setups don't need an archive — ship the canonical YAML
        // directly as .kset.yaml. Forcing callers here to go via
        // packSetup would hide that decision.
        throw new SetupPackError(
            "refusing to pack a lean Setup (no plugins.files, no patches). " +
            "Write the canonical manifest YAML directly instead."
        );
    }

    // Bidirectional check: every Map entry must be declared, every
    // declared entry must be in the Map.
    const declaredPaths = new Set(declared.map((d) => d.file.path));
    for (const p of files.keys()) {
        if (!declaredPaths.has(p)) {
            throw new SetupPackError(`files map contains undeclared path: ${p}`);
        }
    }
    for (const d of declared) {
        if (!files.has(d.file.path)) {
            throw new SetupPackError(`manifest declares ${d.file.path} but files map has no bytes for it`);
        }
    }

    // Per-file hash + length check. We'd rather fail now than produce
    // an archive that unpackSetup will immediately reject.
    for (const d of declared) {
        const bytes = files.get(d.file.path)!;
        if (bytes.length !== d.file.bytes) {
            throw new SetupPackError(
                `${d.file.path}: declared bytes=${d.file.bytes}, actual=${bytes.length}`
            );
        }
        const actual = hashBytes(bytes);
        if (actual !== d.file.hash) {
            throw new SetupPackError(
                `${d.file.path}: declared hash=${d.file.hash}, actual=${actual}`
            );
        }
    }

    // Stage into a tmp dir, then tar it up.
    const stage = mkdtempSync(join(tmpdir(), "kindly-pack-"));
    try {
        const manifestYaml = canonicalizeManifest(manifest);
        writeFileSync(join(stage, "manifest.yaml"), manifestYaml, "utf8");

        const includedPaths: string[] = ["manifest.yaml"];
        for (const d of declared) {
            // Belt-and-suspenders: the schema already rejects unsafe
            // paths, but if someone handcrafted a manifest bypassing
            // Zod we still want a clean error.
            if (!isSafeRelativePath(d.file.path)) {
                throw new SetupPackError(`unsafe path refused at pack time: ${d.file.path}`);
            }
            const relInArchive = `${d.prefix}/${d.file.path}`;
            const abs = join(stage, relInArchive);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, files.get(d.file.path)!);
            includedPaths.push(relInArchive);
        }

        const r = createTarGz({
            cwd: stage,
            paths: includedPaths,
            outputPath,
        });
        return {
            archivePath: r.archivePath,
            bytesWritten: r.bytesWritten,
            manifestHash: manifestHash(manifest),
        };
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}
