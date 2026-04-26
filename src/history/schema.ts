// Zod runtime schema for `.kindly/history.jsonl` entries.
//
// S1101 (v0.13): the W15 reader previously cast `JSON.parse(line) as
// HistoryEntry` with no validation, so an attacker who could write a line
// (e.g. via the cwd-races at S362, or a future merge between local and
// imported history files) could invent `cmd: "setup:promote"` or unknown
// summary fields. The fields stay dormant in v0.12 but become live the
// moment a legitimate handler with that name ships — at which point the
// attacker's stale entry executes a replay-shaped operation. Validate at
// read time so unknown shapes fall into the malformed bucket.
//
// Strictness:
// - `cmd` must be one of the 6 commands kindly currently emits.
// - Summary fields use `.strict()` — unknown keys are rejected. Adding a
//   new summary field is a deliberate code change, never a quietly-tolerated
//   write.
// - `index` is optional (pre-W17 entries lack it; the reader falls back to
//   positional ordering).
// - `mount` is optional (pre-C10a entries lack it).

import { z } from "zod";

export const historyCommandSchema = z.enum([
    "apply",
    "snapshot",
    "restore",
    "rollback",
    "setup:import",
    "setup:export",
]);

export const mountFingerprintSchema = z.object({
    device_version: z.string().nullable(),
    koreader_version: z.string().nullable(),
    anchor_mtime_iso: z.string().nullable(),
}).strict();

export const historySummarySchema = z.object({
    settings_delta_n: z.number().optional(),
    plugins_delta: z.object({
        installed_files: z.number().optional(),
        installed_patches: z.number().optional(),
        skipped_files: z.number().optional(),
        skipped_patches: z.number().optional(),
        disabled_count: z.number().optional(),
    }).strict().optional(),
    backup_path: z.string().optional(),
    pre_import_path: z.string().optional(),
    pre_restore_path: z.string().optional(),
    pre_rollback_path: z.string().optional(),
    archive_path: z.string().optional(),
    output_path: z.string().optional(),
    setup_id: z.string().optional(),
    snapshot_dir: z.string().optional(),
}).strict();

export const historyEntrySchema = z.object({
    ts: z.string(),
    cmd: historyCommandSchema,
    label: z.string().optional(),
    kindly_version: z.string(),
    index: z.number().optional(),
    mount: mountFingerprintSchema.optional(),
    summary: historySummarySchema,
}).strict();
