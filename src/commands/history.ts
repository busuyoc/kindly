// `kindly history` — list mutations from .kindly/history.jsonl.
//
// Reverse-chronological. Default limit 20. `--since <ISO>` narrows to recent
// activity. `--json` returns the typed HistoryResult inside the standard
// envelope; W18's `kindly history show <N>` will show one entry in detail
// (with diff). Numeric indexing is stable across rotations (W17): index 1
// is the OLDEST entry currently in the active file.
//
// Empty file (or no .kindly/) is a normal first-run state, not an error.

import { ArgError, parseArgs, type FlagSpecs } from "../cli/args.ts";
import type { CliEnv } from "../cli/env.ts";
import { dim, info } from "../cli/log.ts";
import { emitJson } from "../cli/json.ts";
import { readHistoryFile, type HistoryEntryWithIndex } from "../history/reader.ts";
import type { HistoryResult } from "../types/results.ts";

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

function formatLine(e: HistoryEntryWithIndex, indexW: number): string {
    const idx = `#${String(e.index).padStart(indexW)}`;
    const ts = e.ts.replace("T", " ").replace(/\.\d+Z$/, "Z").slice(0, 19);
    const cmd = e.cmd.padEnd(13);
    const label = e.label ?? "";
    const labelCol = label.padEnd(20);
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

export async function runHistory(argv: readonly string[], env: CliEnv): Promise<number> {
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

usage: kindly history [--limit N] [--since <ISO>] [--json]

  --limit N      max entries to show (default: 20; 0 = unlimited)
  --since <ISO>  only show entries at or after this timestamp
  --json         JSON envelope on stdout

Display is reverse-chronological. The numeric index (#N) counts from the
OLDEST entry — that's the stable handle \`rollback --to N\` resolves
against.

Tracked commands: apply, snapshot, restore, rollback, setup:import,
setup:export. No-op and dry-run runs are not logged.
`.trim();
