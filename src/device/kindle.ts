// Kindle mount detection.
//
// v0.1 is Kindle-only (see docs/30-decisions.md). We support two scenarios:
//   - macOS host: Kindle mounts at /Volumes/Kindle
//   - on-device (koreader shell): /mnt/us is the user partition
//
// A "mount" is valid if it contains a koreader/ directory. We don't try to
// guess based on volume names alone — a Kobo or a random USB drive at
// /Volumes/Kindle would fool that check.

import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { statFollow } from "../fs/safeRead.ts";

export type KindleMount = {
    root: string;              // e.g. /Volumes/Kindle
    koreaderRoot: string;      // <root>/koreader
    settingsPath: string;      // <root>/koreader/settings.reader.lua
    pluginsDir: string;        // <root>/koreader/plugins
    patchesDir: string;        // <root>/koreader/patches
};

const CANDIDATES_DARWIN = ["/Volumes/Kindle"];
const CANDIDATES_LINUX = ["/mnt/us"];

// R3 (review hardening): per-candidate stat timeout. A statSync against a
// stuck NFS share or dead FUSE provider at /Volumes/Kindle would block
// the main thread indefinitely; setTimeout() can't preempt a blocked
// syscall because libuv timers run on the same thread. Forking a
// `test -d` subprocess lets the kernel's SIGTERM-after-timeout enforce
// a bound. 3s is generous for a healthy USB-mounted Kindle (typical
// statSync is sub-millisecond) and bounds total mount-detection time
// at ~3s × 1 candidate per platform.
const STAT_TIMEOUT_MS = 3000;

export function candidateMounts(platform: NodeJS.Platform = process.platform): string[] {
    if (platform === "darwin") return CANDIDATES_DARWIN;
    if (platform === "linux") return CANDIDATES_LINUX;
    return [];
}

/** R3: subprocess-bounded liveness probe. Confirms the kernel can stat
 *  `<root>/koreader` within STAT_TIMEOUT_MS — a guard against stuck NFS
 *  or dead FUSE providers that would otherwise hang `statSync` on the
 *  main thread.
 *
 *  Why subprocess: setTimeout-based watchdogs can't fire while the main
 *  thread is in a blocking syscall (libuv timers run on the same thread),
 *  so the only way to enforce a bound on a sync stat is to delegate to a
 *  child process the kernel can SIGTERM. Windows has no POSIX `test`
 *  builtin and kindly doesn't officially support Windows hosts in v0.x;
 *  fall through to the sync statFollow there. */
function probeReachable(path: string): boolean {
    if (process.platform === "win32") return true;
    const r = spawnSync("test", ["-e", path], { timeout: STAT_TIMEOUT_MS });
    return !r.signal && r.status === 0;
}

export function isKindleMount(root: string): boolean {
    const koreader = join(root, "koreader");
    // Subprocess probes for kernel liveness. If it times out or the path
    // doesn't exist, no Kindle. If it returns successfully, the kernel
    // is responsive and the subsequent statFollow won't hang.
    if (!probeReachable(koreader)) return false;
    try {
        // statFollow applies "derived-from-mount" symlink rejection so a
        // planted symlink at <mount>/koreader doesn't trigger a false
        // positive here. (Reads downstream go through readText which
        // applies the same rule.)
        return statFollow(koreader, "derived-from-mount").isDirectory();
    } catch {
        return false;
    }
}

export function detectKindleMount(): KindleMount | null {
    for (const c of candidateMounts()) {
        if (isKindleMount(c)) return kindleMountAt(c);
    }
    return null;
}

export function kindleMountAt(root: string): KindleMount {
    const koreaderRoot = join(root, "koreader");
    return {
        root,
        koreaderRoot,
        settingsPath: join(koreaderRoot, "settings.reader.lua"),
        pluginsDir: join(koreaderRoot, "plugins"),
        patchesDir: join(koreaderRoot, "patches"),
    };
}

export function requireKindleMount(): KindleMount {
    const m = detectKindleMount();
    if (!m) {
        const tried = candidateMounts().join(", ") || "(none — unsupported platform)";
        throw new Error(
            `No Kindle mount found. Tried: ${tried}. ` +
            `Plug in the Kindle and make sure it mounted as a disk.`
        );
    }
    return m;
}
