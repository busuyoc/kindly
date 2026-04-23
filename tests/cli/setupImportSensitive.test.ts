// Integration tests for `kindly setup import` SENSITIVE gate (W31).
//
// Contract: docs/88-sensitive-keys-spec.md.
// The gate fires on step 10 of the canonical import pipeline (88 §3.0) when
// a change touches a SENSITIVE-class key or nested path. --accept-sensitive
// accepts all; --accept-key=<a,b,c> accepts listed keys only; --dry-run
// skips the throw but retains hits for preview markers.

import { describe, test, expect, beforeEach } from "bun:test";
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import { StringWriter, type CliEnv } from "../../src/cli/env.ts";
import { executeSetupImport } from "../../src/commands/setup.ts";
import { canonicalizeManifest } from "../../src/setup/canonical.ts";
import { parseManifest, type SetupManifest } from "../../src/setup/schema.ts";

const DEFAULT_LUA = `return {
    ["refresh_rate"] = 8,
    ["night_mode"] = false,
}
`;

function makeFakeKindle(initial?: string): {
    root: string; settingsPath: string;
} {
    const root = mkdtempSync(join(tmpdir(), "kindly-s31-k-"));
    const kor = join(root, "koreader");
    mkdirSync(kor);
    const settingsPath = join(kor, "settings.reader.lua");
    writeFileSync(settingsPath, initial ?? DEFAULT_LUA);
    return { root, settingsPath };
}

function makeManifest(raw: Partial<Record<string, unknown>>): SetupManifest {
    return parseManifest({
        kindly_setup: "v1",
        meta: { name: "s31-test", created_at: "2026-04-23T12:00:00Z" },
        apply_mode: "additive",
        ...raw,
    });
}

function writeManifestFile(path: string, m: SetupManifest): void {
    writeFileSync(path, canonicalizeManifest(m));
}

let kindle: { root: string; settingsPath: string };
let workdir: string;
let manifestPath: string;
let env: CliEnv;
let stdout: StringWriter;
let stderr: StringWriter;

beforeEach(() => {
    kindle = makeFakeKindle();
    workdir = mkdtempSync(join(tmpdir(), "kindly-s31-w-"));
    manifestPath = join(workdir, "setup.kset.yaml");
    stdout = new StringWriter();
    stderr = new StringWriter();
    env = {
        cwd: workdir,
        stdout, stderr,
        color: false,
        mountOverride: kindle.root,
        now: () => new Date("2026-04-23T12:00:00Z"),
    };
});

describe("setup import — SENSITIVE gate blocks", () => {
    test("top-level SENSITIVE add (home_dir) → blocks with SENSITIVE_REQUIRES_ACK", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { home_dir: "/mnt/evil" },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("security-sensitive");
        expect(stderr.value).toContain("home_dir");
        expect(stderr.value).toContain("[directory]");
        // No write.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(DEFAULT_LUA);
    });

    test("multiple SENSITIVE changes → all listed in error", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: {
                SSH_port: 2222,
                debug: true,
                night_mode: true,  // USER — not listed
            },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("SSH_port");
        expect(stderr.value).toContain("[ssh]");
        expect(stderr.value).toContain("debug");
        expect(stderr.value).toContain("[debug]");
        // USER key shouldn't appear in the warning list line prefixes.
        expect(stderr.value).toContain("modifies 2 security-sensitive");
    });

    test("--force does NOT bypass the SENSITIVE gate (88 §3.6)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--force"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("security-sensitive");
    });
});

describe("setup import — SENSITIVE subtree carriers (88 §4.7)", () => {
    test("Case A: parent absent → nested SENSITIVE surfaces as kosync.custom_server", async () => {
        // Device has no `kosync` table at all.
        writeManifestFile(manifestPath, makeManifest({
            settings: {
                kosync: { custom_server: "https://evil.example/kosync" },
            },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("security-sensitive");
        expect(stderr.value).toContain("kosync.custom_server");
        expect(stderr.value).toContain("[network]");
    });

    test("Case B: replace mode removes kosync subtree → SENSITIVE fires on the removal", async () => {
        const withKosync = `return {
    ["refresh_rate"] = 8,
    ["kosync"] = {
        ["custom_server"] = "http://my-server",
        ["auto_sync"] = true,
    },
}
`;
        const k2 = makeFakeKindle(withKosync);
        env.mountOverride = k2.root;

        writeManifestFile(manifestPath, makeManifest({
            apply_mode: "replace",
            settings: { refresh_rate: 8 },  // omits kosync → removal
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(1);
        expect(stderr.value).toContain("security-sensitive");
        expect(stderr.value).toContain("kosync.custom_server");
    });

    test("non-trigger: USER nested under parent-add does NOT fire gate", async () => {
        // Device has no kosync; manifest adds kosync with only USER keys.
        writeManifestFile(manifestPath, makeManifest({
            settings: {
                kosync: { auto_sync: true, sync_forward_on_close: false },
            },
        }));
        const code = await main(
            ["setup", "import", manifestPath],
            env,
        );
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("security-sensitive");
    });
});

describe("setup import — acceptance flags", () => {
    test("--accept-sensitive → proceeds past gate", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-sensitive"],
            env,
        );
        expect(code).toBe(0);
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("SSH_port");
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("debug");
    });

    test("--accept-key=<single> covers exactly one key", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-key=SSH_port"],
            env,
        );
        expect(code).toBe(0);
    });

    test("--accept-key=<partial> still blocks on un-listed SENSITIVE hits", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-key=SSH_port"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("debug");
        // Only the unaccepted key is listed as blocking.
        expect(stderr.value).toContain("modifies 1 security-sensitive");
    });

    test("--accept-key=<multi> covers both listed keys", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-key=SSH_port,debug"],
            env,
        );
        expect(code).toBe(0);
    });

    test("--accept-key=<nested> accepts dotted paths (kosync.custom_server)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: {
                kosync: { custom_server: "https://my-server.example" },
            },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-key=kosync.custom_server"],
            env,
        );
        expect(code).toBe(0);
    });

    test("--accept-key=<unknown> → ArgError (exit 2), not silent acceptance", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-key=not_a_sensitive_key"],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--accept-key");
        expect(stderr.value).toContain("not_a_sensitive_key");
    });

    test("--accept-key=<typo> on known key prefix still ArgErrors", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--accept-key=ssh_port"],  // lowercase — wrong
            env,
        );
        expect(code).toBe(2);
    });
});

describe("setup import — dry-run interaction (88 §3.5)", () => {
    test("--dry-run with SENSITIVE change → exits 0 without acceptance", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run"],
            env,
        );
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("security-sensitive");
    });

    test("--dry-run text mode shows [SENSITIVE] prefix on affected changes", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, night_mode: true },
        }));
        await main(["setup", "import", manifestPath, "--dry-run"], env);
        expect(stdout.value).toContain("[SENSITIVE]");
        expect(stdout.value).toContain("SSH_port");
        // night_mode line exists but has no SENSITIVE marker.
        const lines = stdout.value.split("\n").filter((l) => l.includes("night_mode"));
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.every((l) => !l.includes("[SENSITIVE]"))).toBe(true);
    });

    test("--dry-run JSON mode populates sensitiveHits in result", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        await main(
            ["setup", "import", manifestPath, "--dry-run", "--json"],
            env,
        );
        const payload = JSON.parse(stdout.value);
        expect(payload.status).toBe("ok");
        expect(payload.data.sensitiveHits).toEqual(["SSH_port"]);
    });

    test("--dry-run + --accept-sensitive → no-op (gate already skipped)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--dry-run", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(0);
    });
});

describe("setup import — no-trigger edge cases", () => {
    test("SENSITIVE key with same value on device → no change → no gate", async () => {
        const withSSH = `return {
    ["refresh_rate"] = 8,
    ["SSH_port"] = 2222,
}
`;
        const k2 = makeFakeKindle(withSSH);
        env.mountOverride = k2.root;

        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },  // same value
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("security-sensitive");
    });

    test("manifest with only USER keys → no gate", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { night_mode: true, refresh_rate: 4 },
        }));
        const code = await main(["setup", "import", manifestPath], env);
        expect(code).toBe(0);
    });

    test("--accept-key for a key that isn't actually changing → silently ignored (88 §4.6)", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { night_mode: true },  // no SENSITIVE change
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--accept-key=SSH_port"],
            env,
        );
        expect(code).toBe(0);
    });
});

describe("setup import — apply is NOT gated (88 §3.2 scope)", () => {
    test("kindly apply with a SENSITIVE change succeeds without --accept-sensitive", async () => {
        writeFileSync(
            join(workdir, "kindly.yaml"),
            "home_dir: /mnt/local/books\n",
        );
        // apply (not setup import) — same SENSITIVE key, different command.
        const code = await main(["apply"], env);
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("security-sensitive");
    });
});

describe("setup import — JSON error envelope", () => {
    test("blocked import emits SENSITIVE_REQUIRES_ACK on stderr with list", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("SENSITIVE_REQUIRES_ACK");
        expect(payload.error.message).toContain("SSH_port");
        expect(payload.error.message).toContain("debug");
        expect(stdout.value).toBe("");
    });
});

describe("setup import — --strict-imports (W34e)", () => {
    test("SENSITIVE change + --strict-imports → STRICT_IMPORT_BLOCKED", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--strict-imports"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("--strict-imports");
        expect(stderr.value).toContain("SSH_port");
        expect(stderr.value).toContain("debug");
        // No write.
        expect(readFileSync(kindle.settingsPath, "utf8")).toBe(DEFAULT_LUA);
    });

    test("--strict-imports JSON envelope uses STRICT_IMPORT_BLOCKED code", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--strict-imports", "--json"],
            env,
        );
        expect(code).toBe(1);
        const payload = JSON.parse(stderr.value);
        expect(payload.status).toBe("error");
        expect(payload.error.code).toBe("STRICT_IMPORT_BLOCKED");
    });

    test("--strict-imports + --accept-sensitive → ArgError exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--strict-imports", "--accept-sensitive"],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--strict-imports");
        expect(stderr.value).toContain("--accept-sensitive");
    });

    test("--strict-imports + --accept-key → ArgError exit 2", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath,
                "--strict-imports", "--accept-key=SSH_port"],
            env,
        );
        expect(code).toBe(2);
        expect(stderr.value).toContain("--strict-imports");
        expect(stderr.value).toContain("--accept-key");
    });

    test("clean USER-only change + --strict-imports → exit 0", async () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { night_mode: true, refresh_rate: 4 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--strict-imports"],
            env,
        );
        expect(code).toBe(0);
        expect(stderr.value).not.toContain("STRICT_IMPORT_BLOCKED");
        expect(readFileSync(kindle.settingsPath, "utf8")).toContain("night_mode");
    });

    test("--dry-run + --strict-imports with SENSITIVE still blocks", async () => {
        // Strict is a CI gate: it must refuse even in dry-run, since a
        // pipeline running `--dry-run --strict-imports` is asking "is this
        // safe to import?" — the answer must be no if SENSITIVE keys are
        // touched.
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const code = await main(
            ["setup", "import", manifestPath, "--dry-run", "--strict-imports"],
            env,
        );
        expect(code).toBe(1);
        expect(stderr.value).toContain("--strict-imports");
        expect(stderr.value).toContain("SSH_port");
    });
});

describe("setup import — CLI / lib layer split", () => {
    // Spec 88 §3.1: --accept-key format validation is a CLI concern. The
    // lib trusts opts.acceptKey is already a Set of valid key names and
    // never throws ArgError.
    test("lib blocks when opts.acceptKey is missing a hit", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222, debug: true },
        }));
        expect(() => executeSetupImport(
            {
                file: manifestPath,
                acceptKey: new Set(["SSH_port"]),
            },
            env,
        )).toThrow(/SENSITIVE|debug/);
    });

    test("lib proceeds when opts.acceptSensitive is true", () => {
        writeManifestFile(manifestPath, makeManifest({
            settings: { SSH_port: 2222 },
        }));
        const result = executeSetupImport(
            { file: manifestPath, acceptSensitive: true, dryRun: true },
            env,
        );
        expect(result.mode).toBe("dry-run");
        expect(result.sensitiveHits).toEqual(["SSH_port"]);
    });
});
