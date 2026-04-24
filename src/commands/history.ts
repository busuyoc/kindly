// `kindly history` — list mutations from .kindly/history.jsonl.
//
// Reverse-chronological. Default limit 20. `--since <ISO>` narrows to recent
// activity. `--json` returns the typed HistoryResult inside the standard
// envelope.
//
// Subcommand `kindly history show <N>` (W18) prints one entry in detail and,
// when possible, the settings diff introduced by that mutation (reconstructed
// from the entry's pre-state backup vs the next settings-mutation's pre-state).
//
// Numeric indexing is stable across rotations (W17): each entry carries its
// own `index` field, monotonically increasing.
//
// Empty file (or no .kindly/) is a normal first-run state, not an error.

import { join } from "node:path";
import { exists, readText, statFollow } from "../fs/safeRead.ts";

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, heading, info } from "../cli/log.ts";
import { emitJson } from "../cli/json.ts";
import {
    countAllHistory,
    findHistoryEntryByIndex,
    iterateAllEntries,
    readHistoryFile,
    type HistoryEntryWithIndex,
} from "../history/reader.ts";
import type { HistoryCommand } from "../history/writer.ts";
import { parseSettingsFile } from "../lua/reader.ts";
import type { LuaValue } from "../lua/writer.ts";
import { computeChanges, type Change } from "../schema/diff.ts";
import { groupChanges } from "../taxonomy/group.ts";
import type { HistoryResult, HistoryShowResult } from "../types/results.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

const DEFAULT_LIMIT = 20;

const FLAGS = {
    limit: {
        type: "string",
        description: "max entries to show (default: 20; 0 = unlimited)",
    },
    since: {
        type: "string",
        description: "ISO timestamp; only show entries at or after this time",
    },
} as const satisfies FlagSpecs;

export interface HistoryOptions {
    limit?: number;
    since?: string;
}

export function executeHistory(opts: HistoryOptions, env: CliEnv): HistoryResult {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const r = readHistoryFile({
        cwd: env.cwd,
        ...(opts.since ? { since: opts.since } : {}),
        limit,
    });
    return {
        entries: r.entries,
        matched: r.matched,
        total: r.total,
        malformed: r.malformed,
        historyPath: r.path,
        limit,
        hasArchives: r.hasArchives,
        ...(opts.since ? { since: opts.since } : {}),
    };
}

export function renderHistory(result: HistoryResult, env: CliEnv): void {
    if (result.total === 0) {
        info(env, "no history yet — run `kindly apply`, `snapshot`, or `setup import` to log a mutation.");
        info(env, dim(env, `  (history is at ${result.historyPath})`));
        return;
    }

    if (result.entries.length === 0) {
        // Total > 0, matched = 0 → --since filtered everything out.
        info(env, `no entries since ${result.since}.`);
        info(env, dim(env, `  ${result.total} total entries in history`));
        return;
    }

    const indexW = String(result.entries[0]!.index).length;
    for (const e of result.entries) {
        env.stdout.write(formatLine(e, indexW) + "\n");
    }

    if (result.malformed > 0) {
        info(env, dim(env, `  (skipped ${result.malformed} malformed line(s) — likely an interrupted write)`));
    }
    if (result.matched > result.entries.length) {
        const more = result.matched - result.entries.length;
        info(env, dim(env, `  ... ${more} older entr${more === 1 ? "y" : "ies"} not shown (raise --limit to see)`));
    }
    if (result.hasArchives) {
        info(env, dim(env, `  (older rotated entries live under .kindly/history-archive/; still addressable via \`rollback --to N\`)`));
    }
}

const LABEL_COL_WIDTH = 20;

function formatLine(e: HistoryEntryWithIndex, indexW: number): string {
    const idx = `#${String(e.index).padStart(indexW)}`;
    const ts = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
    const cmd = e.cmd.padEnd(13);
    const label = e.label ?? "";
    // Truncate to keep the summary column aligned regardless of label length.
    const labelCol = label.length > LABEL_COL_WIDTH
        ? label.slice(0, LABEL_COL_WIDTH - 1) + "…"
        : label.padEnd(LABEL_COL_WIDTH);
    return `${idx}  ${ts}  ${cmd}  ${labelCol}  ${formatSummary(e)}`.trimEnd();
}

function formatSummary(e: HistoryEntryWithIndex): string {
    const s = e.summary;
    const bits: string[] = [];
    if (typeof s.settings_delta_n === "number" && s.settings_delta_n > 0) {
        bits.push(`${s.settings_delta_n} setting${s.settings_delta_n === 1 ? "" : "s"}`);
    }
    if (s.plugins_delta) {
        const pd = s.plugins_delta;
        const installed = (pd.installed_files ?? 0) + (pd.installed_patches ?? 0);
        if (installed > 0) bits.push(`+${installed} file${installed === 1 ? "" : "s"}`);
        if (pd.disabled_count) bits.push(`disabled ${pd.disabled_count}`);
    }
    if (s.archive_path) bits.push("archive");
    if (s.snapshot_dir) bits.push("from-snapshot");
    if (s.setup_id && e.cmd === "setup:export") bits.push(s.setup_id);
    return bits.join(" · ");
}

// Commands that produce a settings pre-state (a standalone settings.reader.lua
// we can diff against). restore's pre_restore_path is a whole-tree tarball,
// so it's excluded — we'd need to extract before diffing, out of scope for W18.
const SETTINGS_PRE_STATE_CMDS = new Set<HistoryCommand>([
    "apply", "setup:import", "rollback",
]);

function settingsPreStatePath(entry: HistoryEntryWithIndex): string | null {
    const s = entry.summary;
    if (entry.cmd === "apply" && s.backup_path) return s.backup_path;
    if (entry.cmd === "setup:import" && s.pre_import_path) {
        return join(s.pre_import_path, "settings.reader.lua");
    }
    if (entry.cmd === "rollback" && s.pre_rollback_path) {
        return join(s.pre_rollback_path, "settings.reader.lua");
    }
    return null;
}

// Scan active + archives and return the entry with the SMALLEST index
// strictly greater than `afterIndex` whose cmd carries a settings
// pre-state AND whose pre-state file is still on disk. This is the
// "next settings mutation" whose pre-state serves as the post-state
// proxy for the entry we're diffing.
function findNextWithPreState(
    cwd: string,
    afterIndex: number,
): HistoryEntryWithIndex | null {
    const seen = new Set<number>();
    let best: HistoryEntryWithIndex | null = null;
    for (const e of iterateAllEntries(cwd)) {
        if (seen.has(e.index)) continue;
        seen.add(e.index);
        if (e.index <= afterIndex) continue;
        if (!SETTINGS_PRE_STATE_CMDS.has(e.cmd)) continue;
        const p = settingsPreStatePath(e);
        if (!p || !exists(p, "derived-from-cwd")) continue;
        if (best === null || e.index < best.index) best = e;
    }
    return best;
}

export function executeHistoryShow(index: number, env: CliEnv): HistoryShowResult {
    const entry = findHistoryEntryByIndex(env.cwd, index);
    if (!entry) {
        const total = countAllHistory(env.cwd);
        if (total === 0) {
            throw new KindlyError(
                ErrorCodes.SNAPSHOT_INVALID,
                `no history yet — nothing to show.`,
                [{ text: "Run `kindly apply`, `snapshot`, or `setup import` to log a mutation." }],
            );
        }
        throw new KindlyError(
            ErrorCodes.SNAPSHOT_INVALID,
            `no history entry #${index} (history has ${total} entries, valid range 1..${total}).`,
            [{ text: "Run `kindly history` to see available indexes.", command: "kindly history" }],
        );
    }

    const result: HistoryShowResult = { entry };

    if (!SETTINGS_PRE_STATE_CMDS.has(entry.cmd)) {
        result.diffUnavailable = `\`${entry.cmd}\` does not capture a settings pre-state — nothing to diff.`;
        return result;
    }

    const fromPath = settingsPreStatePath(entry);
    if (!fromPath) {
        result.diffUnavailable = `entry has no recorded pre-state path (was it run with --no-safety-snapshot?).`;
        return result;
    }
    if (!exists(fromPath, "derived-from-cwd") || !statFollow(fromPath, "derived-from-cwd").isFile()) {
        result.diffUnavailable = `pre-state file no longer on disk: ${fromPath}`;
        return result;
    }

    const next = findNextWithPreState(env.cwd, entry.index);
    if (!next) {
        result.diffUnavailable = `no later mutation with a pre-state — this is the most recent settings change. Use \`kindly diff\` for current on-device delta.`;
        return result;
    }
    const toPath = settingsPreStatePath(next)!;

    const beforeRaw = parseSettingsFile(readText(fromPath, "derived-from-cwd"));
    const afterRaw = parseSettingsFile(readText(toPath, "derived-from-cwd"));
    if (!isPlainRecord(beforeRaw) || !isPlainRecord(afterRaw)) {
        result.diffUnavailable = `pre-state file did not parse to a settings table: ${fromPath}`;
        return result;
    }
    const before = beforeRaw as Record<string, LuaValue>;
    const after = afterRaw as Record<string, LuaValue>;

    // computeChanges iterates keys in `after` (it's designed for apply's
    // additive semantics). Pick up additions + changes from it, then
    // backfill keys present in `before` but not `after` as removals.
    const changes: Change[] = computeChanges(before, after);
    for (const k of Object.keys(before).sort()) {
        if (!(k in after)) {
            changes.push({ kind: "removed", path: [k], prev: before[k] as LuaValue });
        }
    }

    result.diff = {
        fromPath,
        toPath,
        toIndex: next.index,
        changes,
        grouped: groupChanges(changes),
    };
    return result;
}

export function renderHistoryShow(result: HistoryShowResult, env: CliEnv): void {
    const e = result.entry;
    heading(env, `entry #${e.index}  ${e.cmd}${e.label ? `  "${e.label}"` : ""}`);
    info(env, `  ts:             ${e.ts}`);
    info(env, `  kindly version: ${e.kindly_version}`);

    const s = e.summary;
    const rows: Array<[string, string]> = [];
    if (typeof s.settings_delta_n === "number") rows.push(["settings changed", String(s.settings_delta_n)]);
    if (s.plugins_delta) {
        const pd = s.plugins_delta;
        const parts: string[] = [];
        if (pd.installed_files) parts.push(`+${pd.installed_files} plugin file(s)`);
        if (pd.installed_patches) parts.push(`+${pd.installed_patches} patch(es)`);
        if (pd.skipped_files) parts.push(`${pd.skipped_files} skipped`);
        if (pd.disabled_count) parts.push(`disabled ${pd.disabled_count}`);
        if (parts.length) rows.push(["plugins", parts.join(", ")]);
    }
    if (s.backup_path)       rows.push(["backup", s.backup_path]);
    if (s.pre_import_path)   rows.push(["pre-import", s.pre_import_path]);
    if (s.pre_restore_path)  rows.push(["pre-restore", s.pre_restore_path]);
    if (s.pre_rollback_path) rows.push(["pre-rollback", s.pre_rollback_path]);
    if (s.archive_path)      rows.push(["archive", s.archive_path]);
    if (s.output_path)       rows.push(["output", s.output_path]);
    if (s.snapshot_dir)      rows.push(["source snapshot", s.snapshot_dir]);
    if (s.setup_id)          rows.push(["setup id", s.setup_id]);
    for (const [k, v] of rows) info(env, `  ${k.padEnd(16)}${v}`);

    env.stdout.write("\n");
    if (result.diff) {
        heading(env, `changes between #${e.index} and #${result.diff.toIndex}  (${result.diff.changes.length} total)`);
        for (const [cat, bucket] of Object.entries(result.diff.grouped)) {
            info(env, dim(env, `  [${cat}]`));
            for (const g of bucket) {
                const marker = g.kind === "added" ? "+" : g.kind === "removed" ? "-" : "~";
                const val = g.hint ?? `${format(g.before)} → ${format(g.after)}`;
                info(env, `    ${marker} ${g.label}  ${dim(env, val)}`);
            }
        }
    } else if (result.diffUnavailable) {
        info(env, dim(env, `(diff not shown: ${result.diffUnavailable})`));
    }
}

function format(v: unknown): string {
    if (v === undefined) return "∅";
    if (typeof v === "string") return JSON.stringify(v);
    return String(v);
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function runHistoryShow(rest: readonly string[], env: CliEnv): Promise<number> {
    // Subcommand has no flags today beyond the env-level --json.
    if (rest.length === 0) {
        throw new ArgError("usage: kindly history show <N>");
    }
    if (rest.length > 1) {
        throw new ArgError(`unexpected extra argument: ${rest[1]}`);
    }
    const n = Number(rest[0]);
    if (!Number.isInteger(n) || n < 1) {
        throw new ArgError(`<N> must be a positive integer (got ${JSON.stringify(rest[0])})`);
    }
    const result = executeHistoryShow(n, env);
    if (env.jsonMode) emitJson(env, "history:show", result);
    else renderHistoryShow(result, env);
    return 0;
}

export async function runHistory(argv: readonly string[], env: CliEnv): Promise<number> {
    // Subcommand dispatch: `kindly history show <N>` routes to the detail
    // view; everything else is the list view.
    if (argv[0] === "show") {
        return runHistoryShow(argv.slice(1), env);
    }

    const { flags, positional } = parseArgs(argv, FLAGS);
    if (positional.length > 0) {
        throw new ArgError(`unexpected argument: ${positional[0]}`);
    }

    let limit: number | undefined;
    if (flags.limit !== undefined) {
        const n = Number(flags.limit);
        if (!Number.isInteger(n) || n < 0) {
            throw new ArgError(`--limit must be a non-negative integer (got ${JSON.stringify(flags.limit)})`);
        }
        limit = n === 0 ? Number.POSITIVE_INFINITY : n;
    }

    if (flags.since !== undefined) {
        const d = new Date(flags.since);
        if (Number.isNaN(d.getTime())) {
            throw new ArgError(
                `--since ${JSON.stringify(flags.since)} is not a valid ISO timestamp ` +
                `(use e.g. 2026-04-22T12:00:00Z)`,
            );
        }
    }

    const result = executeHistory({
        ...(limit !== undefined ? { limit } : {}),
        ...(flags.since ? { since: flags.since } : {}),
    }, env);

    if (env.jsonMode) emitJson(env, "history", result);
    else renderHistory(result, env);
    return 0;
}

export const historyHelp = `
kindly history — list mutations from .kindly/history.jsonl.

usage:
  kindly history [--limit N] [--since <ISO>] [--json]
  kindly history show <N> [--json]

list options:
  --limit N      max entries to show (default: 20; 0 = unlimited)
  --since <ISO>  only show entries at or after this timestamp
  --json         JSON envelope on stdout

show:
  \`kindly history show <N>\` prints one entry in detail, plus a settings
  diff introduced by that mutation (reconstructed from the entry's
  pre-state backup vs the next mutation's pre-state). The diff is
  omitted when the entry has no pre-state (snapshot, setup:export,
  restore), when the file is gone, or when it's the most recent
  mutation (use \`kindly diff\` for current on-device delta).

Display is reverse-chronological. The numeric index (#N) is a stable
monotonic counter — it keeps its value even after rotation (W17).

Tracked commands: apply, snapshot, restore, rollback, setup:import,
setup:export. No-op and dry-run runs are not logged.
`.trim();
