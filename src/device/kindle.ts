// Kindle mount detection.
//
// v0.1 is Kindle-only (see docs/30-decisions.md). We support two scenarios:
//   - macOS host: Kindle mounts at /Volumes/Kindle
//   - on-device (koreader shell): /mnt/us is the user partition
//
// A "mount" is valid if it contains a koreader/ directory. We don't try to
// guess based on volume names alone — a Kobo or a random USB drive at
// /Volumes/Kindle would fool that check.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type KindleMount = {
    root: string;              // e.g. /Volumes/Kindle
    koreaderRoot: string;      // <root>/koreader
    settingsPath: string;      // <root>/koreader/settings.reader.lua
    pluginsDir: string;        // <root>/koreader/plugins
};

const CANDIDATES_DARWIN = ["/Volumes/Kindle"];
const CANDIDATES_LINUX = ["/mnt/us"];

export function candidateMounts(platform: NodeJS.Platform = process.platform): string[] {
    if (platform === "darwin") return CANDIDATES_DARWIN;
    if (platform === "linux") return CANDIDATES_LINUX;
    return [];
}

export function isKindleMount(root: string): boolean {
    try {
        const koreader = join(root, "koreader");
        return statSync(koreader).isDirectory();
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
