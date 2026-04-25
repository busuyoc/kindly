import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
    symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packSetup, SetupPackError } from "../../src/setup/pack.ts";
import { unpackSetup, SetupUnpackError } from "../../src/setup/unpack.ts";
import { hashBytes, canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";
import { collectPluginDirs, collectPatches } from "../../src/setup/files.ts";

// ---- fixtures --------------------------------------------------------------

function makeManifest(raw: unknown): SetupManifest {
    return parseManifest(raw);
}

function sshPluginBytes(): Buffer {
    return Buffer.from("-- SSH plugin stub\nreturn { name = 'SSH' }\n", "utf8");
}

function patchBytes(): Buffer {
    return Buffer.from("-- autoflash patch\nUIManager.fullRefresh()\n", "utf8");
}

function fatManifest(): SetupManifest {
    const ssh = sshPluginBytes();
    const patch = patchBytes();
    return makeManifest({
        kindly_setup: "v1",
        meta: { name: "Fat Test", created_at: "2026-04-21T12:00:00Z" },
        apply_mode: "additive",
        plugins: {
            files: [
                {
                    path: "SSH.koplugin/main.lua",
                    hash: hashBytes(ssh),
                    bytes: ssh.length,
                },
            ],
        },
        patches: [
            {
                path: "2-autoflash.lua",
                hash: hashBytes(patch),
                bytes: patch.length,
            },
        ],
    });
}

function fatFiles(): Map<string, Buffer> {
    return new Map<string, Buffer>([
        ["SSH.koplugin/main.lua", sshPluginBytes()],
        ["2-autoflash.lua", patchBytes()],
    ]);
}

// ---- test dir lifecycle ----------------------------------------------------

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kindly-packtest-"));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

// ---- pack / unpack round-trip ---------------------------------------------

describe("unpack — NFD-vs-NFC tolerance (S900 / Angle C)", () => {
    test("manifest declares NFC path, tar lists NFD form → unpack succeeds", () => {
        // macOS APFS + system tar emit NFD on `tar -tzf` for filenames
        // with combining marks. Manifests come from `readdir` which yields
        // NFC. Pre-S900, the NFC manifest path missed the NFD tar entry
        // → `archive contains undeclared file`. unpackSetup now NFC-
        // normalizes both sides for the membership check and reads back
        // by the original disk-side form for form-strict filesystems.
        const nfc = "ä.lua";          // ä as single codepoint
        const nfd = "ä.lua";         // a + combining diaeresis
        // Self-check that we actually built distinct byte sequences.
        expect(Buffer.from(nfc, "utf8").length).not.toBe(Buffer.from(nfd, "utf8").length);

        const patch = patchBytes();
        const m = makeManifest({
            kindly_setup: "v1",
            meta: { name: "Accented", created_at: "2026-04-21T12:00:00Z" },
            apply_mode: "additive",
            patches: [
                { path: nfc, hash: hashBytes(patch), bytes: patch.length },
            ],
        });

        // Stage a fake fat-archive layout, but write the patch file with
        // the NFD-form name. Then tar from stage — the resulting archive
        // entry retains the NFD bytes (APFS form-preserving + GNU/BSD tar
        // pass-through).
        const stage = join(workDir, "nfd-stage");
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "patches", nfd), patch);
        const archive = join(workDir, "nfd.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "patches",
        ]);
        expect(r.status).toBe(0);

        const unpacked = unpackSetup(archive);
        // Returned files map keyed by NFC path (manifest form).
        expect(unpacked.files.size).toBe(1);
        expect(unpacked.files.has(nfc)).toBe(true);
        expect(unpacked.files.get(nfc)!.equals(patch)).toBe(true);
    });
});

describe("W46 — canonical-hash reproducibility across authoring forms", () => {
    // The §2-Layer-4 invariant for T2: identical logical content must
    // produce identical canonical manifest hashes regardless of which
    // Unicode form the authoring filesystem hands us at readdir time.
    // Without it, signed `.kset` artifacts (W39) cannot be rebuilt by an
    // auditor on a different OS / filesystem.
    //
    // Drives the full pipeline used in production: collect → pack →
    // manifestHash. Two builds with on-disk filenames in NFD vs NFC must
    // yield the same hash. The archive bytes themselves are allowed to
    // differ (Q1 = canonical-tree, Q3 = canonical-hash-identical).
    function buildAndPack(
        formName: "NFC" | "NFD",
        rootDir: string,
        outputPath: string,
    ): { manifestHash: string; archiveBytes: Buffer } {
        const nfc = "Café.koplugin";
        const fileNfc = "máin.lua";
        const pluginName = formName === "NFC" ? nfc.normalize("NFC") : nfc.normalize("NFD");
        const fileName = formName === "NFC" ? fileNfc.normalize("NFC") : fileNfc.normalize("NFD");

        const pluginsRoot = join(rootDir, "plugins");
        const patchesRoot = join(rootDir, "patches");
        mkdirSync(join(pluginsRoot, pluginName), { recursive: true });
        mkdirSync(patchesRoot, { recursive: true });
        writeFileSync(join(pluginsRoot, pluginName, fileName), "main\n");
        writeFileSync(join(pluginsRoot, pluginName, "z.lua"), "z\n");
        writeFileSync(join(patchesRoot, "1-tweak.lua"), "tweak\n");

        const pluginCollect = collectPluginDirs(pluginsRoot);
        const patchCollect = collectPatches(patchesRoot);

        const manifest = makeManifest({
            kindly_setup: "v1",
            meta: { name: "Repro", created_at: "2026-04-25T00:00:00Z" },
            apply_mode: "additive",
            plugins: { files: pluginCollect.declared },
            patches: patchCollect.declared,
        });
        const files = new Map<string, Buffer>();
        for (const [k, v] of pluginCollect.files) files.set(k, v);
        for (const [k, v] of patchCollect.files) files.set(k, v);

        const result = packSetup({ manifest, files }, outputPath);
        return {
            manifestHash: result.manifestHash,
            archiveBytes: readFileSync(outputPath),
        };
    }

    test("on-disk NFD vs NFC → identical canonical manifest hash", () => {
        const rootA = join(workDir, "build-nfd");
        const rootB = join(workDir, "build-nfc");
        const outA = join(workDir, "nfd.kset");
        const outB = join(workDir, "nfc.kset");

        const a = buildAndPack("NFD", rootA, outA);
        const b = buildAndPack("NFC", rootB, outB);

        // Canonical identity invariant.
        expect(a.manifestHash).toBe(b.manifestHash);

        // Both archives must round-trip through unpackSetup with the
        // same declared content — guards the lower half of the T2 trust
        // primitive (verifier sees the same tree no matter who packed).
        const ua = unpackSetup(outA);
        const ub = unpackSetup(outB);
        expect(ua.manifest).toEqual(ub.manifest);
        expect([...ua.files.keys()].sort()).toEqual([...ub.files.keys()].sort());
        for (const k of ua.files.keys()) {
            expect(ua.files.get(k)!.equals(ub.files.get(k)!)).toBe(true);
        }
    });
});

describe("packSetup + unpackSetup round-trip", () => {
    test("preserves manifest and files", () => {
        const m = fatManifest();
        const files = fatFiles();
        const out = join(workDir, "test.kset");

        const packed = packSetup({ manifest: m, files }, out);
        expect(existsSync(out)).toBe(true);
        expect(packed.bytesWritten).toBeGreaterThan(0);
        expect(packed.manifestHash).toMatch(/^sha256:[a-f0-9]{64}$/);

        const unpacked = unpackSetup(out);
        // manifest deep-equals
        expect(unpacked.manifest).toEqual(m);
        // files survived bit-for-bit
        expect(unpacked.files.size).toBe(2);
        expect(unpacked.files.get("SSH.koplugin/main.lua")!.equals(sshPluginBytes())).toBe(true);
        expect(unpacked.files.get("2-autoflash.lua")!.equals(patchBytes())).toBe(true);
    });

    test("manifest bytes at archive root match canonical encoding", () => {
        const m = fatManifest();
        const out = join(workDir, "test.kset");
        packSetup({ manifest: m, files: fatFiles() }, out);

        const unpacked = unpackSetup(out);
        expect(unpacked.manifestBytes.toString("utf8")).toBe(canonicalizeManifest(m));
    });
});

// ---- pack-time validation --------------------------------------------------

describe("packSetup refuses invalid input", () => {
    test("refuses lean manifest (no declared files)", () => {
        const lean = makeManifest({
            kindly_setup: "v1",
            meta: { name: "Lean", created_at: "2026-04-21T12:00:00Z" },
            apply_mode: "additive",
            settings: { refresh_rate: 8 },
        });
        expect(() =>
            packSetup({ manifest: lean, files: new Map() }, join(workDir, "x.kset"))
        ).toThrow(SetupPackError);
        expect(() =>
            packSetup({ manifest: lean, files: new Map() }, join(workDir, "x.kset"))
        ).toThrow(/lean Setup/);
    });

    test("refuses when files map has undeclared path", () => {
        const m = fatManifest();
        const files = fatFiles();
        files.set("rogue.lua", Buffer.from("surprise"));
        expect(() =>
            packSetup({ manifest: m, files }, join(workDir, "x.kset"))
        ).toThrow(/undeclared path: rogue\.lua/);
    });

    test("refuses when manifest declares a file the map lacks", () => {
        const m = fatManifest();
        const files = fatFiles();
        files.delete("2-autoflash.lua");
        expect(() =>
            packSetup({ manifest: m, files }, join(workDir, "x.kset"))
        ).toThrow(/manifest declares 2-autoflash\.lua but files map has no bytes/);
    });

    test("refuses when declared byte count mismatches", () => {
        const ssh = sshPluginBytes();
        const m = makeManifest({
            kindly_setup: "v1",
            meta: { name: "Bad", created_at: "2026-04-21T12:00:00Z" },
            apply_mode: "additive",
            plugins: {
                files: [{
                    path: "SSH.koplugin/main.lua",
                    hash: hashBytes(ssh),
                    bytes: ssh.length + 1,   // lies
                }],
            },
        });
        const files = new Map([["SSH.koplugin/main.lua", ssh]]);
        expect(() =>
            packSetup({ manifest: m, files }, join(workDir, "x.kset"))
        ).toThrow(/declared bytes=.*actual=/);
    });

    test("refuses when declared hash mismatches", () => {
        const ssh = sshPluginBytes();
        const m = makeManifest({
            kindly_setup: "v1",
            meta: { name: "Bad", created_at: "2026-04-21T12:00:00Z" },
            apply_mode: "additive",
            plugins: {
                files: [{
                    path: "SSH.koplugin/main.lua",
                    hash: "sha256:" + "0".repeat(64),   // lies
                    bytes: ssh.length,
                }],
            },
        });
        const files = new Map([["SSH.koplugin/main.lua", ssh]]);
        expect(() =>
            packSetup({ manifest: m, files }, join(workDir, "x.kset"))
        ).toThrow(/declared hash=.*actual=/);
    });
});

// ---- unpack rejects malformed archives -------------------------------------

describe("unpackSetup rejects malformed archives", () => {
    test("rejects non-existent archive", () => {
        expect(() => unpackSetup(join(workDir, "nope.kset"))).toThrow(/archive not found/);
    });

    test("rejects a non-tar file", () => {
        const bogus = join(workDir, "bogus.kset");
        writeFileSync(bogus, "this is not a tarball");
        expect(() => unpackSetup(bogus)).toThrow(SetupUnpackError);
    });

    test("rejects archive missing manifest.yaml", () => {
        // Build a tar.gz without a manifest.
        const stage = join(workDir, "no-manifest");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), "x");
        const archive = join(workDir, "no-manifest.kset");
        const r = spawnSync("tar", ["-czf", archive, "-C", stage, "plugins"]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/missing manifest\.yaml/);
    });

    test("rejects archive with multiple manifest.yaml entries", () => {
        // tar happily accepts two files with the same path. We build one
        // by staging the archive via append: `tar -rf` on an existing
        // archive adds a second entry with the same name.
        const stage = join(workDir, "dup");
        mkdirSync(stage, { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), "first");
        const archivePlain = join(workDir, "dup.tar");
        // Create plain tar (so -rf can append — gzip is not appendable).
        const r1 = spawnSync("tar", ["-cf", archivePlain, "-C", stage, "manifest.yaml"]);
        expect(r1.status).toBe(0);
        writeFileSync(join(stage, "manifest.yaml"), "second");
        const r2 = spawnSync("tar", ["-rf", archivePlain, "-C", stage, "manifest.yaml"]);
        expect(r2.status).toBe(0);
        // Gzip it by hand.
        const gzipped = join(workDir, "dup.kset");
        const r3 = spawnSync("sh", ["-c", `gzip -c '${archivePlain}' > '${gzipped}'`]);
        expect(r3.status).toBe(0);
        expect(() => unpackSetup(gzipped)).toThrow(/multiple manifest\.yaml entries/);
    });

    test("rejects archive containing an undeclared file", () => {
        // Pack a valid fat setup, then add an extra file into a fresh
        // archive alongside the canonical contents.
        const m = fatManifest();
        const stage = join(workDir, "stage");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), sshPluginBytes());
        writeFileSync(join(stage, "2-autoflash.lua"), patchBytes());
        // Deliberately misplaced: patch must live under patches/.
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "patches", "2-autoflash.lua"), patchBytes());
        // Extra undeclared file at top level.
        writeFileSync(join(stage, "extra.txt"), "surprise!");
        const archive = join(workDir, "extra.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins", "patches", "extra.txt",
        ]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/undeclared file: extra\.txt/);
    });

    test("rejects archive missing a declared file", () => {
        // Stage manifest + ssh, but omit the declared patch.
        const m = fatManifest();
        const stage = join(workDir, "missing-decl");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), sshPluginBytes());
        const archive = join(workDir, "missing-decl.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins",
        ]);
        expect(r.status).toBe(0);
        // "undeclared file" isn't triggered (no extras); instead the
        // missing-declared check fires.
        expect(() => unpackSetup(archive)).toThrow(/archive doesn't contain it/);
    });

    test("rejects path-traversal entry in archive", () => {
        // Handcraft a tar with an entry that escapes the destination.
        // Easiest portable way: use tar -P (preserve leading /) on a
        // staged path like "../evil". Stage a tree where the nominal
        // member is "../evil" via tar's -s substitution.
        const stage = join(workDir, "trav");
        mkdirSync(stage, { recursive: true });
        writeFileSync(join(stage, "evil.lua"), "bad");
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(fatManifest()));
        const archive = join(workDir, "trav.kset");
        // BSD tar: -s substitution ",^,../,". Rewrite every member path
        // to prefix with ../. On GNU tar this flag is --transform.
        // Try BSD first; fall back to GNU.
        let r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "-s", ",^,../,",
            "evil.lua",
        ]);
        if (r.status !== 0) {
            r = spawnSync("tar", [
                "-czf", archive, "-C", stage,
                "--transform", "s,^,../,",
                "evil.lua",
            ]);
        }
        // If both substitution flavours failed, skip — we still have
        // the schema-level guard and the unsafe-path test below.
        if (r.status !== 0) return;
        const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
        // Only run the assertion if the tar substitution actually
        // produced a traversal entry.
        if (!listed.includes("../")) return;
        expect(() => unpackSetup(archive)).toThrow(/unsafe path/);
    });

    test("rejects archive with an entry outside plugins/ or patches/", () => {
        // Valid manifest but archive has a top-level foo.lua that's
        // nowhere in the declared list.
        const m = fatManifest();
        const stage = join(workDir, "outside");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), sshPluginBytes());
        writeFileSync(join(stage, "patches", "2-autoflash.lua"), patchBytes());
        writeFileSync(join(stage, "foo.lua"), "hmm");
        const archive = join(workDir, "outside.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins", "patches", "foo.lua",
        ]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/undeclared file: foo\.lua/);
    });

    test("rejects bytes-mismatch against declared length", () => {
        // Pack valid, then tamper: rebuild archive with the patch's
        // bytes replaced by a longer buffer.
        const m = fatManifest();
        const stage = join(workDir, "bytes-tamper");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), sshPluginBytes());
        writeFileSync(join(stage, "patches", "2-autoflash.lua"), Buffer.concat([patchBytes(), Buffer.from("extra")]));
        const archive = join(workDir, "bytes-tamper.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins", "patches",
        ]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/declared bytes=.*actual=/);
    });

    test("rejects hash-mismatch against declared sha256", () => {
        // Same bytes length but different content → hash mismatch.
        const m = fatManifest();
        const stage = join(workDir, "hash-tamper");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        writeFileSync(join(stage, "plugins", "SSH.koplugin", "main.lua"), sshPluginBytes());
        // Same length as patchBytes(), different content.
        const orig = patchBytes();
        const tampered = Buffer.alloc(orig.length, 0x41);
        writeFileSync(join(stage, "patches", "2-autoflash.lua"), tampered);
        const archive = join(workDir, "hash-tamper.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins", "patches",
        ]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/declared hash=.*actual=/);
    });

    test("rejects archive containing a symlink", () => {
        const m = fatManifest();
        const stage = join(workDir, "symlink");
        mkdirSync(join(stage, "plugins", "SSH.koplugin"), { recursive: true });
        mkdirSync(join(stage, "patches"), { recursive: true });
        writeFileSync(join(stage, "manifest.yaml"), canonicalizeManifest(m));
        symlinkSync("/etc/passwd", join(stage, "plugins", "SSH.koplugin", "main.lua"));
        writeFileSync(join(stage, "patches", "2-autoflash.lua"), patchBytes());
        const archive = join(workDir, "symlink.kset");
        const r = spawnSync("tar", [
            "-czf", archive, "-C", stage,
            "manifest.yaml", "plugins", "patches",
        ], { encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/symlink/);
    });

    test("rejects archive whose manifest.yaml fails schema validation", () => {
        const stage = join(workDir, "bad-manifest");
        mkdirSync(stage, { recursive: true });
        // Missing required meta.name and meta.created_at.
        writeFileSync(join(stage, "manifest.yaml"), "kindly_setup: v1\napply_mode: additive\n");
        const archive = join(workDir, "bad-manifest.kset");
        const r = spawnSync("tar", ["-czf", archive, "-C", stage, "manifest.yaml"]);
        expect(r.status).toBe(0);
        expect(() => unpackSetup(archive)).toThrow(/manifest\.yaml invalid/);
    });
});
