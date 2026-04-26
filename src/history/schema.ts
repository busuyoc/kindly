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

// Round 3 history-rendering F4/F5: cap path-string and identity fields
// at read time so a forged entry can't expand into multi-MB stdout
// floods on `kindly history --json` or `history show <N>`. Legitimate
// emissions stay well under these caps:
//   - paths max ~PATH_MAX (4096 on POSIX); 8192 leaves slack for tmpfs +
//     long stamp dirs without crossing into "this is an attack" territory
//   - setup_id is the 48-bit shortId → exactly 12 lowercase hex chars
//   - kindly_version is package.json#version (~5-12 chars in practice);
//     64 gives 5x headroom and still bounds the worst case
//   - label is user-provided via --label; cap at 240 to match
//     failed_reason and the GUI's reasonable single-line render budget
const PATH_MAX_BYTES = 8 * 1024;
const SETUP_ID_RE = /^[a-f0-9]{12}$/;

export const historySummarySchema = z.object({
    settings_delta_n: z.number().optional(),
    plugins_delta: z.object({
        installed_files: z.number().optional(),
        installed_patches: z.number().optional(),
        skipped_files: z.number().optional(),
        skipped_patches: z.number().optional(),
        disabled_count: z.number().optional(),
    }).strict().optional(),
    backup_path: z.string().max(PATH_MAX_BYTES).optional(),
    pre_import_path: z.string().max(PATH_MAX_BYTES).optional(),
    pre_restore_path: z.string().max(PATH_MAX_BYTES).optional(),
    pre_rollback_path: z.string().max(PATH_MAX_BYTES).optional(),
    archive_path: z.string().max(PATH_MAX_BYTES).optional(),
    output_path: z.string().max(PATH_MAX_BYTES).optional(),
    setup_id: z.string().regex(SETUP_ID_RE, "setup_id must be 12 lowercase hex chars (48-bit shortId)").optional(),
    snapshot_dir: z.string().max(PATH_MAX_BYTES).optional(),
    /** M1 / Lead 18 — set when the mutation failed mid-flight and we
     *  auto-rolled back from a safety snapshot. The writer added this
     *  field in round 2 but the reader schema wasn't updated, so failure
     *  rows were silently dropped (round 3 history-rendering F2 HIGH).
     *  Schema bound to ≤240 chars to match the writer's truncation cap
     *  and to bound the worst-case row size for downstream renderers. */
    failed_reason: z.string().max(240).optional(),
    /** Round-3 snapshot integrity binding. Hash of the per-entry safety
     *  snapshot directory contents at write time (`hashSnapshotDir`),
     *  prefixed `sha256:`. Verified before rollback re-applies the
     *  bytes; a mismatch indicates tampering between original write
     *  and rollback read and aborts with SNAPSHOT_HASH_MISMATCH.
     *  Optional for backward-compat with pre-round-3 history entries
     *  (which have no hash and bypass the check). */
    snapshot_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/, "snapshot_sha256 must be sha256:<64 lowercase hex>").optional(),
}).strict();

// Round 3 history-rendering F3 (S362 sibling): ts is also used for
// `since` filtering (`e.ts >= since` lex compare) and for display.
// `monthKey` already regex-validates the slice before treating ts as
// a path segment, but until now the rest of the pipeline accepted any
// string. A forged ts like `"99-99-99"` or `"-\x01"` could
// poison since-filtering (entries either always-pass or always-skip)
// or render as terminal-injection bait if the renderer ever emitted
// it raw. ISO-8601 form (Date#toISOString output) is what every kindly
// writer emits — enforce that shape at read time. Forged entries with
// malformed ts now fall into the malformed bucket alongside other
// schema violations.
const ISO_TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const historyEntrySchema = z.object({
    ts: z.string().regex(ISO_TS_REGEX, "ts must be ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ)"),
    cmd: historyCommandSchema,
    // F4 cap: --label is user-provided, but it surfaces in the formatted
    // list view (truncated to LABEL_COL_WIDTH) AND in `--json` output
    // (full string). 240 bytes matches the failed_reason cap and the
    // GUI's single-row render budget.
    label: z.string().max(240).optional(),
    // F4 cap: kindly_version is package.json#version, single-digit-major
    // semver in practice. 64 bytes is generous; anything longer is a
    // forged entry, fall into the malformed bucket.
    kindly_version: z.string().max(64),
    index: z.number().optional(),
    mount: mountFingerprintSchema.optional(),
    summary: historySummarySchema,
}).strict();
