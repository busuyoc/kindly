# 82 — JSON API Contract (`--json`)

**Audience:** anyone scripting against `kindly` or building a UI on top of it
(the v1.0 GUI, external automation, future `kindly serve` IPC). Humans using
the CLI interactively read the text renderer — this doc covers the machine
surface.

**Status:** v0.6. `$schema_version: 1`. Fields listed as *stable* won't change
shape within this major. Fields listed as *additive* may get new keys (JSON
consumers MUST ignore unknown keys). Error codes are append-only — existing
codes never get renumbered or dropped.

**Source of truth:**
- Envelope: [`src/cli/json.ts`](../src/cli/json.ts)
- Result types: [`src/types/results.ts`](../src/types/results.ts)
- Error codes: [`src/types/errors.ts`](../src/types/errors.ts)

If this doc disagrees with the code, the code wins — file a bug to update the
doc.

---

## 1. Envelope

Every `--json` invocation emits exactly **one** JSON object followed by a
newline. Success goes to **stdout**; errors go to **stderr**. Exit code is
still the primary success/fail signal (`0` = ok, `1` = runtime error, `2` =
argument error).

### 1.1 Success envelope (stdout)

```json
{
  "$schema_version": 1,
  "kindly_version": "0.3.0",
  "generated_at": "2026-04-22T12:00:00.000Z",
  "command": "pull",
  "status": "ok",
  "data": { ... command-specific shape ... },
  "warnings": []
}
```

| Field | Type | Notes |
|---|---|---|
| `$schema_version` | `number` | Bumps on breaking envelope changes. `1` for v0.6+. |
| `kindly_version` | `string` | `package.json` version at invocation. Informational — don't gate logic on it; gate on `$schema_version`. |
| `generated_at` | `string` (ISO-8601 UTC) | From `env.now()` — tests inject a fixed clock. |
| `command` | `string` | Subcommand identifier (`"pull"`, `"setup inspect"`, etc. — see §3). |
| `status` | `"ok"` | Discriminator. |
| `data` | `object` | Per-command typed payload (see §3). |
| `warnings` | `string[]` | Non-fatal warnings. Currently always `[]`; reserved. |

### 1.2 Error envelope (stderr)

```json
{
  "$schema_version": 1,
  "kindly_version": "0.3.0",
  "generated_at": "2026-04-22T12:00:00.000Z",
  "command": "restore",
  "status": "error",
  "error": {
    "code": "ARCHIVE_NOT_FOUND",
    "message": "archive not found: /nowhere/nope.tar.gz",
    "remediation": [
      { "text": "Check the path or run `kindly snapshot` first." }
    ]
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `error.code` | `string` | One of §2. `"UNKNOWN"` if a non-`KindlyError` escaped — treat as a bug. |
| `error.message` | `string` | Human-readable; not guaranteed stable across versions. Don't regex it. |
| `error.remediation` | `Remediation[]` | Zero or more `{ text, command? }` hints. `command` is a shell string safe to surface as a "Run this" button. |

### 1.3 Consumer contract

- Read stdout on exit `0`; read stderr on non-zero.
- Branch on `status`. Never assume stdout parses on failure or stderr on success.
- Ignore unknown fields. The envelope and every `data` shape are additive.
- Pin to a `$schema_version`. When it bumps, re-validate your consumer.
- `--json` implies non-interactive. Commands that would prompt (e.g., overwrite
  confirmations) must be given `--yes` or an equivalent; otherwise they error
  with an actionable code rather than stalling on stdin.

---

## 2. Error codes

All codes live in `ErrorCodes` in [`src/types/errors.ts`](../src/types/errors.ts).
Append-only registry. Never renumbered, never reused.

| Code | Exit | Meaning |
|---|---|---|
| `ARG_INVALID` | 2 | CLI argument error (missing positional, unknown flag, mutually-exclusive flags, etc). Raised by `ArgError`. |
| `MOUNT_NOT_FOUND` | 1 | No Kindle mount found and `--mount` not given. |
| `MOUNT_INVALID` | 1 | `--mount` path exists but doesn't look like a Kindle (missing `koreader/`). |
| `SETTINGS_NOT_FOUND` | 1 | `<mount>/koreader/settings.reader.lua` missing. |
| `LUA_PARSE_FAILED` | 1 | Lua file present but unparseable. `message` includes filename + line. |
| `OUTPUT_EXISTS` | 1 | `pull` / `setup export` would overwrite an existing file and `--force` wasn't passed. |
| `YAML_NOT_FOUND` | 1 | `diff` / `apply` couldn't find the YAML file. |
| `ARCHIVE_NOT_FOUND` | 1 | `restore` couldn't find the tarball. |
| `SNAPSHOT_INVALID` | 1 | `rollback` directory missing, not a directory, or empty (no `settings.reader.lua` or `plugins-patches.tar.gz`). |
| `SCHEMA_VIOLATION` | 1 | `setup export --strict` / `setup import --strict` found unknown keys or type mismatches in settings. |
| `COMPAT_INCOMPATIBLE` | 1 | `setup import` manifest declares compat constraints that don't match this device; pass `--force` to override. |
| `FAT_REQUIRES_ACK` | 1 | `setup import` of a fat `.kset` (plugin files / patches) without `--accept-plugins` / `--accept-patches` (or `--skip-*`). |
| `SETUP_INVALID` | 1 | `.kset` / `.kset.yaml` is malformed or not a valid Setup manifest (reserved — not yet emitted at every parse site). |
| `UNKNOWN` | 1 | Internal error; a non-`KindlyError` exception leaked. Please file a bug. |

---

## 3. Per-command reference

Each entry lists: the command identifier (the `command` field), the `data`
shape (with a link to the TypeScript type), notable input flags that change
the shape, and the error codes it can raise.

### 3.1 `pull`

Read device → write `kindly.yaml`.

- **Command id:** `"pull"`
- **Data:** `PullResult` — [`src/types/results.ts:14`](../src/types/results.ts)
  ```ts
  {
    mode: "minimal" | "full",
    settingsPath: string,       // absolute
    outputPath: string,         // absolute
    bytes: number,              // bytes written
    lines: number,              // lines written
    droppedSecrets: string[],   // sorted; dotted paths for nested
    droppedEphemerals: string[] // sorted; [] in "full" mode
  }
  ```
- **Flags affecting shape:** `--full` sets `mode: "full"` and empties `droppedEphemerals`. `--output <path>` changes `outputPath`.
- **Errors:** `MOUNT_NOT_FOUND`, `MOUNT_INVALID`, `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`, `OUTPUT_EXISTS`, `ARG_INVALID`.

### 3.2 `diff`

Preview what `apply` would do. No device writes.

- **Command id:** `"diff"`
- **Data:** `DiffResult`
  ```ts
  {
    yamlPath: string,           // absolute
    settingsPath: string,       // absolute
    changes: Change[],          // see §4
    grouped: Record<           // changes bucketed by taxonomy category
      string,                  // category name, in taxonomy-declared order
      DiffGroupEntry[]
    >,
    untrackedKeys: string[],    // on-device top-level keys not in YAML
    filteredBy?: string         // category name when --category <name> was passed
  }

  // DiffGroupEntry enriches each change with taxonomy-sourced metadata so
  // GUI consumers don't need to re-apply the mapper themselves.
  type DiffGroupEntry = {
    key: string,                // joined dotted path, e.g. "footer.align"
    label: string,              // human label from taxonomy
    before: LuaValue | undefined, // undefined for kind="added"
    after:  LuaValue | undefined, // undefined for kind="removed"
    severity: "trivial" | "visual" | "functional" | "breaking",
    hint?: string,              // short human summary ("enabled", "18 → 22 (+22%)")
    kind: "added" | "changed" | "removed"
  }
  ```
  Empty categories are omitted. Nested paths (e.g. `footer.align`) inherit
  the category/label of their top-level key (`footer`).
- **Flags affecting shape:** `--category <name>` narrows `changes`,
  `grouped`, and `untrackedKeys` to a single taxonomy bucket and sets
  `filteredBy`. Unknown category names yield `ARG_INVALID`.
- **Errors:** `YAML_NOT_FOUND`, `MOUNT_*`, `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`, `ARG_INVALID`.

### 3.3 `apply`

Write YAML → device with safe-write + backup.

- **Command id:** `"apply"`
- **Data:** `ApplyResult`
  ```ts
  {
    mode: "no-op" | "dry-run" | "applied",
    yamlPath: string,
    settingsPath: string,
    changes: Change[],
    backupPath: string | null,  // null on no-op/dry-run
    oldPath: string | null,     // .old sibling; null on no-op/dry-run
    bytesWritten: number        // 0 on no-op/dry-run
  }
  ```
- **Flags affecting shape:** `--dry-run` forces `mode: "dry-run"`. If device already matches YAML → `mode: "no-op"`.
- **Errors:** `YAML_NOT_FOUND`, `MOUNT_*`, `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`, `ARG_INVALID`.

### 3.4 `doctor`

Run health checks. Never throws — infra failures become check entries so the
shape is stable every invocation.

- **Command id:** `"doctor"`
- **Status:** always `"ok"` (even when `data.ok` is `false`).
- **Data:** `DoctorResult`
  ```ts
  {
    checks: DoctorCheck[],
    secretsPresent: string[],   // sorted, dotted for nested
    ok: boolean                 // true iff every check.ok is true
  }
  // DoctorCheck: { id: string, label: string, ok: boolean, detail?: string }
  ```
- **Stable check `id`s:** `"mount"`, `"settings_present"`, `"settings_parseable"`, `"old_parseable"`. Additive — new ids may appear; consumers key by `id`, not array index.
- **Errors:** none in normal operation. `ARG_INVALID` if called with bad flags.

### 3.5 `snapshot`

Whole-tree backup of `koreader/` subpaths to a tar.gz.

- **Command id:** `"snapshot"`
- **Data:** `SnapshotResult`
  ```ts
  {
    archivePath: string,        // absolute
    bytesWritten: number,
    includedPaths: string[],    // relative to koreader/
    skippedPaths: string[]      // requested but not on device
  }
  ```
- **Errors:** `MOUNT_*`; also exit 1 if no known paths exist on device (empty archive refused).

### 3.6 `restore`

Extract a tar.gz archive onto the device.

- **Command id:** `"restore"`
- **Data:** `RestoreResult`
  ```ts
  {
    mode: "dry-run" | "restored",
    archivePath: string,
    destRoot: string,           // <mount>/koreader/
    entries: string[],          // all tar entries
    fileCount: number,          // 0 on dry-run
    safetySnapshotPath: string | null
  }
  ```
- **Flags affecting shape:** `--dry-run` → `mode: "dry-run"`, `fileCount: 0`. `--no-safety-snapshot` → `safetySnapshotPath: null`.
- **Errors:** `ARCHIVE_NOT_FOUND`, `MOUNT_*`, `ARG_INVALID`.

### 3.7 `rollback`

Copy a pre-import / pre-apply safety snapshot dir back onto the device.

- **Command id:** `"rollback"`
- **Data:** `RollbackResult`
  ```ts
  {
    mode: "dry-run" | "rolled-back",
    snapshotDir: string,
    settingsRestored: boolean,
    fatRestored: boolean,
    fatEntries: string[],       // from plugins-patches.tar.gz if present
    fatFileCount: number,
    preRollbackDir: string | null
  }
  ```
- **Errors:** `SNAPSHOT_INVALID`, `MOUNT_*`, `ARG_INVALID`.

### 3.8 `setup inspect`

Read a `.kset` / `.kset.yaml` manifest, return metadata + counts. No device
touch unless `--vs-device` is passed.

- **Command id:** `"setup inspect"`
- **Data:** `SetupInspectResult`
  ```ts
  {
    filePath: string,
    id: string,                 // short hash, 12 hex
    hash: string,               // "sha256:<64 hex>"
    name: string,
    isFat: boolean,
    fileSize: number,
    manifestBytes: number,
    applyMode: "additive" | "replace",
    createdAt: string,
    author?: string,
    description?: string,
    tags: string[],
    compat?: {
      koreaderVersionMin?: string,
      koreaderVersionMax?: string,
      device?: string[]
    },
    settingsCount: number,
    pluginsDisabledCount: number,
    pluginFilesCount: number,
    patchesCount: number,
    isCanonical: boolean,
    canonicalHash?: string,     // only set when isCanonical === false
    preview?: {                 // present when --vs-device or --vs-default
      mode: "vs-device" | "vs-default",
      settingsPath?: string,    // set only when mode === "vs-device"
      changes: Change[],        // see §4
      grouped: Record<string, DiffGroupEntry[]>   // same shape as diff (§3.2)
    }
  }
  ```
- **Flags affecting shape:** `--vs-device` (requires mount) or `--vs-default`
  (empty-config baseline) attach `preview`. The two flags are mutually
  exclusive; passing both yields `ARG_INVALID`. `--vs-default` needs no
  mount — useful for answering "what does this setup do to a fresh device?"
- **Errors:** `ARG_INVALID`; `MOUNT_*`, `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`
  when `--vs-device` can't read the device; generic `1` for malformed YAML
  / schema failure (no dedicated code yet — see §5).

### 3.9 `setup export`

Build a Setup manifest from live device settings (or a bundled template) and
write a `.kset.yaml` (lean) or `.kset` (fat tar.gz) to disk.

- **Command id:** `"setup export"`
- **Data:** `SetupExportResult` (defined in
  [`src/types/results.ts`](../src/types/results.ts))
  ```ts
  {
    mode: "dry-run" | "exported",
    outputPath: string,
    bytesWritten: number,          // 0 on dry-run
    id: string,                    // short hash, 12 hex
    hash: string,                  // "sha256:<64 hex>"
    name: string,
    isFat: boolean,
    applyMode: "additive" | "replace",
    settingsCount: number,
    pluginsDisabledCount: number,
    pluginFilesCount: number,      // fat only
    patchesCount: number,          // fat only
    sourceMode: "device" | "template",
    templateId?: string,           // set when sourceMode === "template"
    droppedSecrets: string[],      // sorted
    droppedEphemerals: string[],   // sorted
    skippedKeys: number            // --keys entries requested but not found
  }
  ```
- **Flags that change shape:** `--dry-run` flips `mode`, sets
  `bytesWritten: 0`, and leaves no file on disk.
- **Errors:** `ARG_INVALID`, `MOUNT_NOT_FOUND`, `MOUNT_INVALID`,
  `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`, `OUTPUT_EXISTS`,
  `SCHEMA_VIOLATION` (with `--strict`).

### 3.10 `setup import`

Apply a Setup manifest to the device: merge settings, optionally install
plugin files / patches, and write a pre-import safety snapshot.

- **Command id:** `"setup import"`
- **Data:** `SetupImportResult` (defined in
  [`src/types/results.ts`](../src/types/results.ts))
  ```ts
  {
    mode: "no-op" | "dry-run" | "imported",
    setupFile: string,
    id: string,
    name: string,
    applyMode: "additive" | "replace",
    settingsPath: string,
    changes: Change[],             // see §4.1
    installedPluginFiles: number,  // 0 on dry-run / --skip-plugins
    installedPatches: number,
    skippedPluginFiles: number,
    skippedPatches: number,
    inertPluginToggles: string[],  // toggles with no matching folder on device
    refusedSecrets: string[],      // secret-named keys the denylist dropped
    backupPath: string | null,     // null on no-op / dry-run / --no-safety-snapshot
    snapshotDir: string | null,
    fatSnapshotPath: string | null,
    compat: null | {
      declared: { koreaderVersionMin?, koreaderVersionMax?, device? },
      detected: { koreaderVersion: string | null, deviceFamily: string },
      unverifiable: string[],
      blocking: string[],
      forced: boolean
    },
    author?: string,               // from manifest.meta (optional)
    description?: string
  }
  ```
- **Flags that change shape:** `--dry-run` flips `mode` to `"dry-run"` and
  leaves `backupPath` / `snapshotDir` null. An identical on-device state
  produces `mode: "no-op"` with an empty `changes[]` array.
- **Errors:** `ARG_INVALID`, `MOUNT_NOT_FOUND`, `MOUNT_INVALID`,
  `SETTINGS_NOT_FOUND`, `LUA_PARSE_FAILED`, `SCHEMA_VIOLATION` (with
  `--strict`), `COMPAT_INCOMPATIBLE` (without `--force`),
  `FAT_REQUIRES_ACK` (without `--accept-plugins` / `--accept-patches` or
  `--skip-*`).
- **Note:** the fat-disclosure preview text that text mode prints to stdout
  before any gate check is **suppressed in `--json` mode** — the envelope
  is the only thing on stdout on success; gate errors go to stderr as usual.

### 3.11 Not yet typed

These commands run but don't emit `--json` as of v0.6:

- `setup list`, `setup hash`, `setup templates`
- `init`

Tracked as follow-up waves. Until then they print text only; `--json` on them
is either unsupported or passes through without envelope wrapping (treat as
unstable — do not parse).

---

## 4. Shared types

### 4.1 `Change`

Used by `diff.changes` and `apply.changes`. Defined in
[`src/schema/diff.ts`](../src/schema/diff.ts):

```ts
type Change =
  | { kind: "added";   path: string[]; next: LuaValue }
  | { kind: "changed"; path: string[]; prev: LuaValue; next: LuaValue }
  | { kind: "removed"; path: string[]; prev: LuaValue };
```

- `path` — segments from the top-level key down. `["footer", "align"]` reads
  back as `footer.align` in text renderers.
- `LuaValue` — any JSON-representable scalar or nested `Record<string,LuaValue>`.
- Ordering inside the array is deterministic (sorted by `path` then `kind`)
  so two invocations on identical inputs yield byte-identical JSON.

### 4.2 `Remediation`

```ts
{ text: string, command?: string }
```

`command`, when present, is a shell-safe invocation the user can run next
(surfaced in the text renderer as "Try: `<command>`", and in a future GUI as
a clickable "Run" button).

---

## 5. Examples

### 5.1 Success — `kindly pull --json`

```bash
$ kindly pull --json
```
stdout:
```json
{"$schema_version":1,"kindly_version":"0.3.0","generated_at":"2026-04-22T12:00:00.000Z","command":"pull","status":"ok","data":{"mode":"minimal","settingsPath":"/Volumes/Kindle/koreader/settings.reader.lua","outputPath":"/Users/me/kindly.yaml","bytes":4211,"lines":148,"droppedSecrets":["kosync.password","cre.0.password"],"droppedEphemerals":["last_file","reading_stats"]},"warnings":[]}
```

### 5.2 Error — `kindly restore /nowhere.tar.gz --json`

stderr:
```json
{"$schema_version":1,"kindly_version":"0.3.0","generated_at":"2026-04-22T12:00:00.000Z","command":"restore","status":"error","error":{"code":"ARCHIVE_NOT_FOUND","message":"archive not found: /nowhere.tar.gz","remediation":[{"text":"Check the path, or run `kindly snapshot` first to create one."}]}}
```
Exit code: `1`.

### 5.3 Piping

```bash
kindly diff --json | jq '.data.changes | length'
kindly doctor --json | jq '.data.ok'
kindly setup inspect my.kset.yaml --json | jq '.data.settingsCount'
```

---

## 6. Stability and versioning

- **`$schema_version: 1`** covers v0.6.x. A breaking envelope change bumps to
  `2`; old consumers keep working against pinned builds.
- **Additive within a major:** new fields in `data`, new error codes, new
  `DoctorCheck.id`s, new `command` strings. Consumers MUST ignore unknowns.
- **Never within a major:** renaming a field, removing a field, changing the
  type of a field, reusing an error code for a different meaning, changing
  the status routing (success→stdout, error→stderr).
- **Envelope-level invariants** (always true): `status` is `"ok"` or
  `"error"`; `command` is non-empty; `generated_at` is ISO-8601 UTC with
  milliseconds; `data` is an object on success; `error.remediation` is an
  array (possibly empty).

---

## 7. Open questions

Deferred to later waves in the v0.6→v1.0 roadmap ([`80-v0.6-plus-roadmap.md`](./80-v0.6-plus-roadmap.md)):

- **Grouped-diff shape** (W10/W11) — `diff.changes` and `setup inspect`
  preview will gain a taxonomy-grouped variant: `{ fonts: [...], status_bar: [...] }`.
  Additive — the flat `changes[]` will remain available.
- **History envelope** (W13–W18) — `kindly history [--json]` shape once
  `history.jsonl` lands.
- **Long-running IPC** (W26) — `kindly serve` line-framed JSON protocol,
  separate from this one-shot-invocation contract.
- **Structured manifest-validation errors** — `SETUP_INVALID` is registered
  but not yet thrown at every parse site. Today, malformed-YAML and Zod
  validation failures in `setup inspect` / `setup import` / `setup export`
  surface as generic exit-1 text (or an envelope with an `UNKNOWN`-shaped
  error path). A later wave will route all manifest parse failures through
  `SETUP_INVALID` with structured Zod-issue remediation.
