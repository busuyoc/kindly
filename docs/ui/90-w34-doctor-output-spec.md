# 90 — `kindly doctor` expanded output: finding schema and exit policy
### *Contract for W34. Rationale in 87-security-matrices.md.*

Date: 2026-04-23.
Status: spec (code will cite this file).

Sibling specs: `88-sensitive-keys-spec.md` (W31 classification),
`89-plugin-hash-verification-spec.md` (W32 catalog hashes — this spec consumes
its output). Roadmap reference: `80-v0.6-plus-roadmap.md` §v0.11 W34.

---

## 0. What this spec fixes

`kindly doctor` today (`src/commands/doctor.ts`,
`src/types/results.ts:91-110`) has four shipped checks and a binary
`ok: boolean`. Every non-pass → exit 1. That was right for v0.5
(format integrity only), but v0.11 adds six checks whose severity is
genuinely variable:

| New check | Fatal? | Advisory? |
|-----------|--------|-----------|
| Outdated schema version | No | Yes — user can keep using kindly |
| Outdated plugin catalog | No | Yes |
| Unverified plugin hashes on device | No | Maybe — depends on count + context |
| `.kindly/` write permissions | **Yes** | No — kindly can't function |
| Free disk space on device | Conditional | Yes if low, fatal if < 1MB |
| Backup directory size | No | Yes |

Binary pass/fail collapses that spectrum. This spec introduces
**severity** and **category** as first-class fields, keeps the stable
`id`-per-check pattern already shipped, and fixes the exit policy.

## 1. Scope boundaries (base KOReader only)

This spec assumes:
- Schema and catalog cover base KOReader's ~557 keys and ~37 bundled
  plugins (per `data/schemas/settings.reader.lua.v1.json`,
  `data/catalog/plugins.bundled.v1.json`).
- Third-party plugins are **out of scope** for W34. A user-installed
  plugin absent from the catalog produces an `UNCATALOGUED` finding at
  `info` severity, not `warning`. Rationale: reclassifying every niche
  community plugin would turn doctor into noise; we only audit what we
  own.
- Device compatibility is Kindle. Other device families produce an
  `info` finding ("device family not yet characterised") rather than a
  pass or fail — doctor runs but its catalog/hash checks are
  advisory-only on unknown hardware.

Anything beyond base KOReader lives behind future W# items or in
`89-plugin-hash-verification-spec.md` §uncatalogued-policy.

---

## 2. Severity taxonomy

Four levels, enumerated. New levels require a spec revision; consumers
(scripts, GUI) switch exhaustively on these four.

| Severity | Meaning | Exit code contribution |
|----------|---------|------------------------|
| `fatal` | kindly cannot function. Mount missing, settings file missing/unreadable/unparseable, `.kindly/` unwritable. | **1** |
| `error` | User state is broken but kindly itself is fine. `.old` corrupted, plugin hash catastrophically mismatched on a known-code-path file. | **1** |
| `warning` | State works; something is out of date, risky, or approaching a threshold. Stale catalog/schema, low disk, unverified plugin hashes. | **0** (exit 0, but human should notice) |
| `info` | Advisory. Not a problem; surfaces inventory or context. N secret keys detected, uncatalogued plugin installed, backup dir size. | **0** |

**Exit policy:** exit 1 iff any finding is `fatal` or `error`.
Warnings and info alone → exit 0. This replaces the current
"any-non-pass → exit 1" rule.

Rationale for demoting warnings: doctor is run eagerly by nervous
users (personas U3, U5 in `81`). Exiting non-zero on a stale catalog
would make every "check my setup" invocation red. Reserve red for
state that actually needs fixing before the next `apply`.

---

## 3. Category taxonomy

Enumerated but extensible: new categories are additive, never rename.
v0.11 categories:

| Category | Purpose | Example ids |
|----------|---------|-------------|
| `mount` | Device detection, KOReader presence | `mount.detected`, `mount.koreader_root` |
| `settings` | `settings.reader.lua` integrity | `settings.present`, `settings.parseable`, `settings.old_parseable` |
| `schema` | Schema version + coverage | `schema.version`, `schema.uncurated_keys` |
| `catalog` | Plugin catalog freshness + coverage | `catalog.version`, `catalog.matches_koreader_version` |
| `plugins` | Installed plugins vs catalog hashes | `plugins.hashes_verified`, `plugins.uncatalogued`, `plugins.tampered` |
| `disk` | Free space, `.kindly/` state | `disk.free_space`, `disk.kindly_writable`, `disk.backups_size` |
| `secrets` | On-device secret inventory | `secrets.present_count`, `secrets.rescue_list` |

Future categories (out of W34 scope, listed so reviewers know what the
axis is for):
- `signatures` (W39 minisign state): `signatures.author_key_known`
- `network` (W40+ fetch): `network.last_fetch_age`
- `supply_chain` (W43-W45): `supply_chain.binary_sig_verified`

**Rule:** a check's category is part of its `id` as the prefix. The
`id` is the stable sort key across versions; category is derived.

---

## 4. Finding schema

### 4.1 Backwards-compatible extension of `DoctorCheck`

Current shape (`src/types/results.ts:91-100`) keeps all four fields.
New optional fields layer on; existing consumers keep working:

```typescript
export interface DoctorCheck {
    /** Stable, category-prefixed. e.g. "plugins.tampered". NEVER rename. */
    id: string;
    /** Human label. Free to iterate. */
    label: string;
    /** Kept for back-compat with v0.5 consumers. Derived from severity:
     *  fatal/error → false, warning/info → true. */
    ok: boolean;
    /** NEW: one of "fatal" | "error" | "warning" | "info". Required for
     *  new checks. Legacy checks without an explicit severity default
     *  to fatal-on-fail / info-on-pass. */
    severity: "fatal" | "error" | "warning" | "info";
    /** NEW: category prefix from §3. Derived from `id` but duplicated
     *  for consumers that don't want to parse the id. */
    category: string;
    /** Extra context string. Kept for text rendering. */
    detail?: string;
    /** NEW: structured data. Shape is keyed by `id` — consumers that
     *  want to machine-read a specific finding key off `id` and cast
     *  `data` to the per-id type. Unknown ids: consumers ignore `data`. */
    data?: Record<string, unknown>;
    /** NEW: zero or more remediation hints, same shape as KindlyError. */
    remediation?: Array<{ text: string; command?: string }>;
}
```

### 4.2 `DoctorResult` unchanged in shape, refined in semantics

```typescript
export interface DoctorResult {
    checks: DoctorCheck[];
    secretsPresent: string[];   // unchanged — sorted dotted keys
    /** True iff no finding is severity `fatal` or `error`. Replaces the
     *  previous "all ok" semantics. */
    ok: boolean;
}
```

`checks` is ordered by `(severity desc, category, id)` — fatals first,
then errors, warnings, info. This is the rendering order AND the JSON
serialization order.

### 4.3 Per-id `data` types

Not exhaustive here (extensibility point), but W34's six new checks
define these:

| id | `data` shape |
|----|--------------|
| `schema.version` | `{ declared: string; current: string; age_days: number }` |
| `schema.uncurated_keys` | `{ count: number; sample: string[] }` (sample ≤ 5) |
| `catalog.version` | `{ declared: string; current: string; age_days: number }` |
| `catalog.matches_koreader_version` | `{ catalog_for: string; device_has: string | null }` |
| `plugins.hashes_verified` | `{ verified: number; tampered: number; uncatalogued: number }` |
| `plugins.tampered` | `{ plugin: string; file: string; expected: string; actual: string }` (one finding per tampered file) |
| `plugins.uncatalogued` | `{ plugins: string[] }` |
| `disk.free_space` | `{ bytes_free: number; bytes_needed_for_apply: number | null }` |
| `disk.kindly_writable` | `{ path: string; writable: boolean }` |
| `disk.backups_size` | `{ bytes: number; file_count: number; oldest_iso: string }` |
| `secrets.present_count` | `{ count: number }` (sorted list stays in `DoctorResult.secretsPresent`) |

Shapes are stable per id. Adding a field to an existing shape is
forbidden if it would change meaning; add a new `id` instead.

---

## 5. W34 findings in detail

Six new checks. Each lists: severity policy, when each level fires,
data, remediation.

### 5.1 `schema.version` — schema freshness

- `info` if bundled schema version matches the version the user's
  binary shipped against AND `age_days` < 90.
- `warning` if `age_days` ≥ 90 or the schema file's checksum differs
  from the one in the binary (shouldn't happen; defensive).
- **Never fatal/error.** A stale schema still works; unknown keys
  just surface more often in validation.

Remediation on warning: "Rebuild with `bun run scripts/extract-schema.ts` if you're building kindly locally; otherwise upgrade the binary."

### 5.2 `schema.uncurated_keys` — drift since schema extraction

New KOReader keys observed on device that aren't in the schema at all.
Covers the R11.2 risk (a new network/path key defaults to USER because
it's not classified). Implementation: diff device keys against
`settings.reader.lua.v1.json` at each doctor run.

- `info` if count is 0.
- `warning` if count > 0. Lists up to 5 in `data.sample` for quick
  triage.

Remediation: "Run `bun run scripts/extract-schema.ts` against current
KOReader source. Review the new keys — any network/path additions
need `SENSITIVE_KEYS` updates (see 88-sensitive-keys-spec.md §2)."

### 5.3 `catalog.version` + `catalog.matches_koreader_version`

Two findings, not one. Version freshness is separable from version
match.

`catalog.version`:
- `info` if `age_days` < 90.
- `warning` otherwise.

`catalog.matches_koreader_version`:
- `info` if catalog was generated for exactly the KOReader version
  detected on device.
- `warning` if catalog is for a different minor version (hash
  comparisons are meaningful but may false-positive on assets — this
  is R11.1 from the roadmap).
- `warning` (separate, not `error`) if device KOReader version is
  unreadable — downstream plugins.* checks become advisory.

Remediation on mismatch: "This catalog was built against KOReader vX;
your device reports vY. Hash mismatches may be false positives. Run
plugin hash regeneration or verify by hand."

### 5.4 `plugins.hashes_verified` — summary finding

Aggregate counts from W32's per-plugin scan. One finding per `doctor`
run. Fires alongside per-file `plugins.tampered` and
`plugins.uncatalogued` findings.

- `info` if `tampered == 0 && uncatalogued == 0`.
- `warning` if `tampered > 0 || uncatalogued > 0`.
- **Never `error` from the summary alone.** Per-file `plugins.tampered`
  findings may themselves escalate to `error` — see §5.5.

### 5.5 `plugins.tampered` — per-file escalation

One finding per tampered plugin file. A `plugins.tampered` finding
corresponds to a `modified` file verdict under a `MISMATCH` plugin
verdict in `89-plugin-hash-verification-spec.md` §4.3 — same
underlying data, different presentation layer. `extra` file verdicts
surface under `plugins.uncatalogued` (per-plugin) rather than here;
`missing` file verdicts are advisory-only (see `89` §5.4).

Severity depends on file role, derived from extension (per
`89-plugin-hash-verification-spec.md` §3 "File role derivation"):

```
*.lua           → role = code  → severity = error
everything else → role = asset → severity = warning
```

- `error` if the tampered file is role=`code` (e.g. `main.lua`).
  This is the category users actually care about — tampered Lua is
  code execution risk.
- `warning` if role=`asset` (images, translations, JSON configs).
  Still suspicious but much lower blast radius.

Role is always derivable from the filename — no catalog metadata
needed, no fallback case.

Remediation: "Reinstall the plugin from the KOReader source tree, or
remove the file if not needed. Don't run a Setup that references this
device state."

### 5.6 `disk.free_space`, `disk.kindly_writable`, `disk.backups_size`

Three findings.

`disk.kindly_writable`:
- `fatal` if `.kindly/` is missing AND cannot be created.
- `fatal` if `.kindly/` exists but is not writable.
- `info` otherwise.

`disk.free_space`:
- `fatal` if bytes_free < 1 MiB (apply would fail atomically).
- `warning` if bytes_free < 50 MiB (apply of a fat Setup could fail).
- `info` otherwise.
- `bytes_needed_for_apply`: null when doctor is run standalone; populated
  by callers that also know an apply is pending (integration point for
  the GUI and for `apply --dry-run`-then-`--doctor` flows).

`disk.backups_size`:
- `info` if bytes < 100 MiB.
- `warning` if bytes > 100 MiB OR file_count > 100 (F9 from 87, no
  rotation shipped yet — loud advisory until W34h lands).

---

## 6. Rendering

### 6.1 Text mode (default CLI)

Group by category. Within a category, sort by severity desc.
Category header only printed when ≥ 1 finding exists in that
category. Symbols by severity:

```
● fatal   (red)
✗ error   (red)
⚠ warning (yellow)
✓ info    (green, same as pass today)
```

Secrets inventory block stays as-is — it's rendered from
`secretsPresent`, not from `checks`, and belongs after all category
groups.

Example (happy path, new Kindle, catalog and schema fresh):

```
mount
  ✓ Kindle detected at /Volumes/Kindle
  ✓ koreader/ present

settings
  ✓ settings.reader.lua parseable
  ✓ .old fallback parseable

schema
  ✓ schema 2026-04-01 (22 days old)

catalog
  ✓ plugin catalog v1 (2026-04-22)
  ✓ catalog matches KOReader version on device

plugins
  ✓ 37 bundled plugins verified, 0 tampered, 0 uncatalogued

disk
  ✓ 2.3 GiB free
  ✓ .kindly/ writable
  ✓ backups: 12 MiB, 8 archives

✓ no secret keys detected on device.
```

Example with warnings:

```
catalog
  ⚠ plugin catalog v1 is 127 days old
     Run scripts/extract-plugin-meta.ts to regenerate.
  ⚠ catalog built for KOReader 2024.03, device reports 2024.07
     Hash mismatches below may be false positives.

plugins
  ⚠ 35 verified, 2 tampered, 1 uncatalogued
  ⚠ statistics.koplugin/main.lua: hash mismatch
     expected sha256:abc123...
     actual   sha256:def456...
     Reinstall from KOReader source, or remove.

disk
  ⚠ .kindly/backups: 412 MiB across 147 archives
     Consider pruning; rotation ships in v0.11 (W34h).
```

### 6.2 JSON mode

`emitJson(env, "doctor", result)` — full structured dump. No
rendering choices; strictly the `DoctorResult` shape. Extra fields
on `DoctorCheck` flow through.

Example excerpt:

```json
{
  "ok": true,
  "secretsPresent": ["kosync.username", "pinpadlock_pin_code"],
  "checks": [
    {
      "id": "catalog.version",
      "label": "plugin catalog age",
      "ok": true,
      "severity": "warning",
      "category": "catalog",
      "detail": "plugin catalog v1 is 127 days old",
      "data": { "declared": "v1", "current": "v1", "age_days": 127 },
      "remediation": [
        { "text": "Regenerate from KOReader source",
          "command": "bun run scripts/extract-plugin-meta.ts" }
      ]
    }
  ]
}
```

Note `ok: true` on a `warning` finding — the binary field means "this
check didn't fatally fail" for back-compat. Consumers that care about
severity read `severity`.

---

## 7. Extensibility rules

1. **New checks:** add a new `id` under an existing or new category.
   Never rename an `id`. If a check's meaning changes, ship a new
   `id` and mark the old one deprecated in code (kept firing until
   one minor version passes).
2. **New severities:** not allowed without a spec revision. Four
   levels are the contract.
3. **New categories:** additive. Add to §3 table when introducing.
   Consumers switching exhaustively on category must use a default
   branch to tolerate unknowns.
4. **New `data` fields:** adding a new per-id shape is fine. Adding a
   field to an existing shape is only allowed if consumers can ignore
   it safely. If semantics would shift, make a new `id`.
5. **Remediation:** optional, can appear on any finding. No schema
   rules beyond the `{text, command?}` shape.
6. **Ordering:** stable. `(severity desc, category asc, id asc)`. Don't
   rely on insertion order.

---

## 8. Non-goals for W34

Explicit, so scope creep is easy to reject:

- **Fixing** anything. Doctor is read-only. Remediations are text/
  command hints, not auto-fixers. Future `kindly doctor --fix` is a
  separate W-item.
- **Predicting** the next apply. Doctor is a state snapshot, not a
  simulator. The `bytes_needed_for_apply` field is a caller-provided
  hint, not doctor's own computation.
- **Scanning plugin Lua for dangerous calls.** That's W36 (deferred
  to v0.11.1), a content-inspection task not a state-inspection task.
- **Network calls.** Doctor is offline. Remote hash lookups, signature
  verification, or catalog-update checks all require user consent
  (future W40+).
- **Third-party plugin audit.** §1 scope boundary.

---

## 9. Tests required

Coverage targets — non-exhaustive, but each must exist for W34 to
ship:

- Every new `id` in §3 has at least one test that asserts the full
  finding shape including `data` fields.
- Severity-to-exit-code mapping: one test per severity level verifies
  exit code policy (fatal/error → 1, warning/info → 0).
- Rendering: text mode + JSON mode, both happy path and mixed-severity
  path. Snapshot tests are fine.
- Back-compat: a pre-W34 caller reading only `{id, label, ok, detail}`
  still functions. One test reads the result object with only those
  fields and asserts it still passes.
- Ordering: a mixed-severity result renders in `(severity desc,
  category, id)` order in both text and JSON.
- `schema.uncurated_keys` with a fake device settings file that has
  synthetic unknown keys.
- `plugins.tampered` with a synthetic catalog entry and a mismatching
  file.
