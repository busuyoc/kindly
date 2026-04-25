import { describe, test, expect, beforeEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "kindly-snap-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    writeFileSync(join(kor, "settings.reader.lua"), "return { a = 1 }\n");
    writeFileSync(join(kor, "settings.reader.lua.old"), "return { a = 0 }\n");
    writeFileSync(join(kor, "history.lua"), "return {}\n");
    mkdirSync(join(kor, "patches"));
    writeFileSync(join(kor, "patches", "user.lua"), "-- my patch\n");
    mkdirSync(join(kor, "plugins", "zlibrary.koplugin"), { recursive: true });
    writeFileSync(join(kor, "plugins", "zlibrary.koplugin", "main.lua"), "-- plugin\n");
    return root;
}

function makeEnv(cwd: string, mountOverride: string): { env: CliEnv; out: StringWriter; err: StringWriter } {
    const out = new StringWriter();
    const err = new StringWriter();
    return {
        env: {
            cwd,
            stdout: out,
            stderr: err,
            color: false,
            mountOverride,
            now: () => new Date("2026-04-21T12:00:00Z"),
        },
        out,
        err,
    };
}

let fakeKindle: string;
let workdir: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    fakeKindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-snap-w-"));
    ({ env, out: stdout, err: stderr } = makeEnv(workdir, fakeKindle));
});

describe("snapshot", () => {
    test("writes a tar.gz containing the expected files", async () => {
        const code = await main(["snapshot"], env);
        expect(code).toBe(0);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        expect(archives.length).toBe(1);
        expect(stdout.value).toContain("settings.reader.lua");
        expect(stdout.value).toContain("patches");
        expect(stdout.value).toContain("plugins");
    });

    test("warns about secrets in output", async () => {
        await main(["snapshot"], env);
        expect(stderr.value.toLowerCase()).toContain("plaintext");
    });

    test("--output redirects archive path", async () => {
        const target = join(workdir, "custom.tar.gz");
        await main(["snapshot", "--output", target], env);
        expect(existsSync(target)).toBe(true);
    });

    test("fails cleanly when the koreader dir is empty of known files", async () => {
        const bareRoot = mkdtempSync(join(tmpdir(), "kindly-snap-bare-"));
        mkdirSync(join(bareRoot, "koreader"));  // mount is valid…
        // …but contains no known user-state files.
        const { env: bareEnv, err: bareErr } = makeEnv(workdir, bareRoot);
        const code = await main(["snapshot"], bareEnv);
        expect(code).toBe(1);
        expect(bareErr.value).toContain("empty archive");
    });
});

describe("restore", () => {
    test("--dry-run lists entries without touching device", async () => {
        await main(["snapshot"], env);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        const archive = join(workdir, archives[0]!);

        // Mutate the device so we'd notice a write.
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        writeFileSync(settingsPath, "return { MUTATED = true }\n");

        const code = await main(["restore", archive, "--dry-run"], env);
        expect(code).toBe(0);
        expect(stdout.value).toContain("would extract");
        // Device unchanged
        expect(readFileSync(settingsPath, "utf8")).toBe("return { MUTATED = true }\n");
    });

    test("round-trip: snapshot → mutate → restore → original content back", async () => {
        await main(["snapshot"], env);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        const archive = join(workdir, archives[0]!);

        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        const patchPath = join(fakeKindle, "koreader", "patches", "user.lua");
        writeFileSync(settingsPath, "return { MUTATED = true }\n");
        writeFileSync(patchPath, "-- corrupted\n");

        const code = await main(["restore", archive], env);
        expect(code).toBe(0);
        expect(readFileSync(settingsPath, "utf8")).toBe("return { a = 1 }\n");
        expect(readFileSync(patchPath, "utf8")).toBe("-- my patch\n");
    });

    test("takes a safety snapshot by default", async () => {
        await main(["snapshot"], env);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        const archive = join(workdir, archives[0]!);

        await main(["restore", archive], env);
        const safetyDir = join(workdir, ".kindly", "pre-restore");
        expect(existsSync(safetyDir)).toBe(true);
        expect(readdirSync(safetyDir).filter((f) => f.endsWith(".tar.gz")).length)
            .toBeGreaterThan(0);
    });

    test("--no-safety-snapshot skips the rollback copy", async () => {
        await main(["snapshot"], env);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        const archive = join(workdir, archives[0]!);

        await main(["restore", archive, "--no-safety-snapshot"], env);
        expect(existsSync(join(workdir, ".kindly", "pre-restore"))).toBe(false);
    });

    test("errors when archive doesn't exist", async () => {
        const code = await main(["restore", "/nowhere/nope.tar.gz"], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("archive not found");
    });

    test("rejects archive that trips the compression-bomb guard (A9)", async () => {
        // Build a real gzip-compressed archive and confirm the extractTarGz
        // caps trigger. We craft the archive small but with a highly
        // compressible payload, then use tight custom caps to trip the
        // uncompressed-bytes guard without needing a real GB of data.
        const stage = mkdtempSync(join(tmpdir(), "kindly-bomb-"));
        // 1 MiB of zeros compresses to <2 KiB.
        const bigPayload = Buffer.alloc(1024 * 1024, 0);
        writeFileSync(join(stage, "big.bin"), bigPayload);
        const archive = join(workdir, "bomb.tar.gz");
        const r = spawnSync(
            "tar", ["-czf", archive, "-C", stage, "big.bin"],
            { encoding: "utf8" },
        );
        expect(r.status).toBe(0);

        // Library-level check: low uncompressed cap should trip.
        const { extractTarGz, ArchiveTooLargeError } =
            await import("../../src/fs/archive.ts");
        expect(() => extractTarGz({
            archivePath: archive,
            destRoot: join(workdir, "dest"),
            maxUncompressedBytes: 64 * 1024,   // 64 KiB — payload is 1 MiB
        })).toThrow(ArchiveTooLargeError);
    });

    test("rejects archive with an absolute-path entry before any write (F8)", async () => {
        // Hand-craft a malicious archive: an absolute path entry is one of
        // the traversal vectors isSafeRelativePath rejects. Build via `tar
        // -P` which preserves absolute paths in the archive.
        const stage = mkdtempSync(join(tmpdir(), "kindly-evil-"));
        const payload = join(stage, "pwn.txt");
        writeFileSync(payload, "pwn\n");
        const archive = join(workdir, "evil.tar.gz");
        const r = spawnSync("tar", ["-czPf", archive, payload], { encoding: "utf8" });
        expect(r.status).toBe(0);

        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        const before = readFileSync(settingsPath, "utf8");

        const code = await main(["restore", archive], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("unsafe path");

        // No safety snapshot was taken — we failed before any filesystem work.
        expect(existsSync(join(workdir, ".kindly", "pre-restore"))).toBe(false);
        // Device untouched.
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
    });

    test("errors when no archive positional given", async () => {
        const code = await main(["restore"], env);
        // Exit 2 is the standard "argument error" code across the CLI;
        // matches how pull/diff/apply treat missing flags.
        expect(code).toBe(2);
        expect(stderr.value).toContain("usage");
    });

    test("blocks code-exec-adjacent key (C1b) without --accept-code-exec", async () => {
        // Build an archive whose settings.reader.lua sets SSH_port. The
        // archive's settings file must use the strict KOReader dump format
        // because the gate parses it.
        const stage = mkdtempSync(join(tmpdir(), "kindly-c1b-stage-"));
        writeFileSync(join(stage, "settings.reader.lua"),
            `return {\n    ["SSH_port"] = 2222,\n}\n`);
        const archive = join(workdir, "evil-ssh.tar.gz");
        const r = spawnSync("tar", ["-czf", archive, "-C", stage,
            "settings.reader.lua"], { encoding: "utf8" });
        expect(r.status).toBe(0);

        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        const before = readFileSync(settingsPath, "utf8");

        const code = await main(["restore", archive], env);
        expect(code).toBe(3);
        expect(stderr.value).toContain("SSH_port");
        expect(stderr.value).toContain("--accept-code-exec");
        // No safety snapshot, no extraction — gate fires before any side effects.
        expect(existsSync(join(workdir, ".kindly", "pre-restore"))).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe(before);
    });

    test("--accept-code-exec lets the restore proceed (C1b)", async () => {
        const stage = mkdtempSync(join(tmpdir(), "kindly-c1b-stage-"));
        writeFileSync(join(stage, "settings.reader.lua"),
            `return {\n    ["SSH_port"] = 2222,\n}\n`);
        const archive = join(workdir, "ok-ssh.tar.gz");
        spawnSync("tar", ["-czf", archive, "-C", stage,
            "settings.reader.lua"], { encoding: "utf8" });

        const code = await main(["restore", archive, "--accept-code-exec"], env);
        expect(code).toBe(0);
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        expect(readFileSync(settingsPath, "utf8")).toContain("SSH_port");
    });

    test("--dry-run bypasses C1b gate (firesIn: non-dry-run)", async () => {
        const stage = mkdtempSync(join(tmpdir(), "kindly-c1b-stage-"));
        writeFileSync(join(stage, "settings.reader.lua"),
            `return {\n    ["SSH_port"] = 2222,\n}\n`);
        const archive = join(workdir, "dry-ssh.tar.gz");
        spawnSync("tar", ["-czf", archive, "-C", stage,
            "settings.reader.lua"], { encoding: "utf8" });

        const code = await main(["restore", archive, "--dry-run"], env);
        expect(code).toBe(0);
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        expect(readFileSync(settingsPath, "utf8")).toBe("return { a = 1 }\n");
    });

    test("archive without settings.reader.lua → no C1b fire", async () => {
        const stage = mkdtempSync(join(tmpdir(), "kindly-c1b-stage-"));
        mkdirSync(join(stage, "patches"));
        writeFileSync(join(stage, "patches", "user.lua"), "-- harmless\n");
        const archive = join(workdir, "no-settings.tar.gz");
        spawnSync("tar", ["-czf", archive, "-C", stage, "patches"],
            { encoding: "utf8" });

        const code = await main(["restore", archive], env);
        expect(code).toBe(0);
    });

    test("archive whose settings.reader.lua is unparseable → gate skipped, restore proceeds", async () => {
        // The reader is strict about KOReader's dump format. Archives
        // produced by tooling outside that grammar must not be blocked
        // by the C1b gate (which has no opinion on what it can't parse).
        const stage = mkdtempSync(join(tmpdir(), "kindly-c1b-stage-"));
        writeFileSync(join(stage, "settings.reader.lua"),
            "return { mini = true }\n");
        const archive = join(workdir, "loose-fmt.tar.gz");
        spawnSync("tar", ["-czf", archive, "-C", stage,
            "settings.reader.lua"], { encoding: "utf8" });

        const code = await main(["restore", archive], env);
        expect(code).toBe(0);
    });

    test("safety snapshot can be used to roll back after a bad restore", async () => {
        // Snapshot "good" state.
        await main(["snapshot"], env);
        const archives = readdirSync(workdir).filter((f) => f.endsWith(".tar.gz"));
        const good = join(workdir, archives[0]!);

        // Mutate device to simulate the "current" state we're restoring over.
        const settingsPath = join(fakeKindle, "koreader", "settings.reader.lua");
        const current = "return { DIFFERENT = true }\n";
        writeFileSync(settingsPath, current);

        // Restore the "good" archive (this should take a safety snapshot of
        // the current "DIFFERENT" state).
        await main(["restore", good], env);
        expect(readFileSync(settingsPath, "utf8")).toBe("return { a = 1 }\n");

        // Find the safety snapshot — restore it to roll back.
        const safetyDir = join(workdir, ".kindly", "pre-restore");
        const safety = readdirSync(safetyDir).filter((f) => f.endsWith(".tar.gz"))[0]!;
        await main(["restore", join(safetyDir, safety), "--no-safety-snapshot"], env);
        expect(readFileSync(settingsPath, "utf8")).toBe(current);
    });
});

describe("top-level dispatcher includes snapshot/restore in help", () => {
    test("--help lists the new commands", async () => {
        await main(["--help"], env);
        expect(stdout.value).toContain("snapshot");
        expect(stdout.value).toContain("restore");
    });
});
