import { existsSync, readdirSync, rmSync } from "node:fs";

export const DEFAULT_KEEP_N = 20;

export type RotationResult = {
    kept: string[];
    removed: string[];
};

export function rotateBackups(dir: string, keepN: number = DEFAULT_KEEP_N): RotationResult {
    if (!existsSync(dir)) return { kept: [], removed: [] };

    const entries = readdirSync(dir)
        .filter((name) => !name.startsWith("."))
        .sort();

    if (entries.length <= keepN) return { kept: entries, removed: [] };

    const kept = keepN > 0 ? entries.slice(-keepN) : [];
    const removed = keepN > 0 ? entries.slice(0, entries.length - keepN) : [...entries];

    for (const name of removed) {
        rmSync(`${dir}/${name}`, { recursive: true, force: true });
    }

    return { kept, removed };
}
