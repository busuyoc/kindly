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
//
// Round 3 follow-up (live probe 2026-04-26): the original regex only
// validated digit count, so a forged `"2026-04-26T19:99:99.999Z"`
// passed schema and rendered as a valid row. Tighten to enforce
// semantic value bounds (month 01-12, day 01-31, hour 00-23,
// minute/second 00-59) — exactly the shape `Date#toISOString()`
// emits. JS Date never emits invalid wall-clock values; legitimate
// writers always pass, only forged ones fail.
//
// Post-round-3 audit batch AA (live probe 2026-04-26 evening): the
// digit-count regex still admits invalid calendar dates — `"2026-04-31"`
// (April has 30 days), `"2026-02-30"`, etc. Lex-compare `--since`
// filtering is then skewed (Apr 31 sorts between Apr 30 and May 1) and
// `new Date()` auto-advances silently. Defense: round-trip through
// `Date#toISOString` — the canonical form every writer emits — which
// never produces invalid calendar values. Mismatch flags the forge.
const ISO_TS_REGEX =
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function isCalendarValidIsoTs(s: string): boolean {
    const d = new Date(s);
    return !Number.isNaN(d.getTime()) && d.toISOString() === s;
}

// Post-round-3 audit batch AC (live probe 2026-04-26 evening): the
// snapshot integrity binding rejected drift in committed bytes but
// accepted MISSING `snapshot_sha256` for backward-compat with
// pre-round-3 entries. A forged entry authored on round-3-or-later
// kindly can pretend to be pre-round-3 by simply omitting the field,
// bypassing hash verification at `rollback --to N` and restoring
// attacker-chosen bytes. Defense: require the field for entries
// whose `kindly_version` is at-or-after the round-3 cutoff (0.13.0)
// AND that have a rollable snapshot path. Pre-0.13 entries with no
// hash legitimately bypass; a forged round-3 entry with no hash is
// dropped to the malformed bucket and not resolvable via `--to`.
const HASH_REQUIRED_AT_VERSION = "0.13.0";

function parseSemver(v: string): [number, number, number] | null {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGte(a: string, b: string): boolean {
    const ap = parseSemver(a);
    const bp = parseSemver(b);
    if (!ap) return true;
    if (!bp) return false;
    for (let i = 0; i < 3; i++) {
        if (ap[i]! > bp[i]!) return true;
        if (ap[i]! < bp[i]!) return false;
    }
    return true;
}

function hasRollableSnapshotPath(summary: {
    backup_path?: string;
    pre_import_path?: string;
    pre_restore_path?: string;
    pre_rollback_path?: string;
}): boolean {
    return Boolean(
        summary.backup_path
        || summary.pre_import_path
        || summary.pre_restore_path
        || summary.pre_rollback_path,
    );
}

export const historyEntrySchema = z.object({
    ts: z.string()
        .regex(ISO_TS_REGEX, "ts must be ISO-8601 (YYYY-MM-DDTHH:MM:SS.sssZ)")
        .refine(isCalendarValidIsoTs, "ts must be a calendar-valid date (April has 30 days, February 28/29)"),
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
    // Round-3 follow-up (live probe 2026-04-26): bound index to the
    // safe-integer range. JSON.parse coerces large numeric literals
    // (e.g. `99999999999999999999`) to f64, which silently rounds to
    // a value >2^53-1. The writer's `highestIndexOf` then increments,
    // hits the same f64-rounding wall, and emits subsequent legit
    // entries with the same index — collapsing monotonic ordering and
    // breaking `rollback --to N`. Reject anything past MAX_SAFE_INTEGER
    // (or fractional, or negative) so a tampered active/archive file
    // can't poison the counter the next time `kindly history` reads it.
    index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    mount: mountFingerprintSchema.optional(),
    summary: historySummarySchema,
}).strict().superRefine((data, ctx) => {
    if (data.summary.snapshot_sha256) return;
    if (!semverGte(data.kindly_version, HASH_REQUIRED_AT_VERSION)) return;
    if (!hasRollableSnapshotPath(data.summary)) return;
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "snapshot_sha256"],
        message: `entry from kindly_version ${data.kindly_version} (round-3+) with a rollable snapshot path must include snapshot_sha256`,
    });
});
