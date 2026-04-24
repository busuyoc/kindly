# 91 — Reserved meta fields and anti-anchor-trust display
### *Contract for W33. Rationale in 87-security-matrices.md §2.2 A6/A8, §3 N1, §4 T3.*

Date: 2026-04-23.
Status: spec (code will cite this file).

Sibling specs: `88-sensitive-keys-spec.md` (W31), `89-plugin-hash-verification-spec.md` (W32),
`90-w34-doctor-output-spec.md` (W34). Roadmap: `80-v0.6-plus-roadmap.md` §v0.11 W33.

---

## 1. Problem

`meta.author` is free text anyone can set. A lean Setup claiming
`author: "KOReader Community"` looks authoritative in the preview but
carries zero provenance. Persona N1 in `87` §3 reads that string and
trusts it. W39 (v0.11.1) adds minisign signature verification; W33
reserves the fields W39 needs and ensures the preview never anchors
trust on unsigned strings in the meantime.

---

## 2. Schema migration

### Current MetaSchema (`src/setup/schema.ts:99-107`)

```typescript
export const MetaSchema = z.object({
    name: z.string().min(1, "meta.name is required"),
    author: z.string().optional(),
    description: z.string().optional(),
    created_at: z.iso.datetime({ offset: true }),
    tags: z.array(z.string()).optional(),
}).strict();
```

### Delta

```typescript
export const MetaSchema = z.object({
    name: z.string().min(1, "meta.name is required"),
    author: z.string().optional(),
    description: z.string().optional(),
    created_at: z.iso.datetime({ offset: true }),
    tags: z.array(z.string()).optional(),
    // W33 reserved fields — accepted, displayed, never verified until W39.
    source_url: z.string().url().optional(),
    version: z.string().optional(),
    author_key_id: z.string().optional(),
    supersedes: z.array(
        z.string().regex(/^sha256:[a-f0-9]{64}$/)
    ).optional(),
}).strict();
```

**Additive.** `.strict()` stays — unknown fields still rejected.
Existing lean/fat Setups that omit the new fields parse unchanged.
Setups that include them parse and validate; invalid `source_url`
(not a URL) or `supersedes` entry (not a sha256 hash) fails at Zod
with the existing `SETUP_INVALID` error code.

No new error codes. Schema validation errors surface through
`SetupSchemaError` as today.

---

## 3. Trust-display contract

**Rule until W39 ships:** every author-provided meta field is
presented as unverified. Never render bare `by Alice` — always
`by Alice (UNVERIFIED)`.

### 3.1 Text mode

```
importing Night Reading  (abc1234)
  from:         alice-night.kset.yaml
  author:       Alice (UNVERIFIED)
  source:       https://alice.dev/setups (UNVERIFIED)
  version:      2
  supersedes:   sha256:def456... (UNVERIFIED — no chain validation)
  description:  Warm night reading config for Kindle PW5
```

Every field the author controls gets the `(UNVERIFIED)` suffix.
`name` and `description` are exempt — they're content, not identity
claims. `version` is exempt — it's an opaque label with no trust
implication.

### 3.2 JSON mode

```json
{
  "meta": {
    "name": "Night Reading",
    "author": { "value": "Alice", "verified": false },
    "source_url": { "value": "https://alice.dev/setups", "verified": false },
    "version": "2",
    "author_key_id": { "value": "RWT...", "verified": false },
    "supersedes": { "value": ["sha256:def456..."], "verified": false },
    "description": "Warm night reading config for Kindle PW5",
    "created_at": "2026-04-23T12:00:00Z",
    "tags": ["night", "kindle-pw5"]
  }
}
```

Identity-claim fields (`author`, `source_url`, `author_key_id`,
`supersedes`) are wrapped in `{ value, verified }`. For scalar fields
`value` is a string; for `supersedes`, `value` is `string[]`. Wrapper
shape is stable across cardinality — consumers dispatch on field name,
not on shape. Content fields (`name`, `description`, `version`,
`created_at`, `tags`) are bare values.

**W39 handoff:** when minisign verification lands, `verified` flips
to `true` for fields whose signature checks out, and the text prefix
changes from `(UNVERIFIED)` to `(verified, key: RWT...)`. The JSON
shape is stable — only the boolean changes.

---

## 4. Anti-anchor-trust display ordering (N1 mitigation)

`87` §3 N1: a naive user reads "by KOReader Community" and trusts
the Setup before noticing it redirects `ota_server`. Display order
must prevent this.

**Rule (text mode):** in both `setup inspect` and `setup import`
preview, the **SENSITIVE-change block** (88) renders BEFORE the
**author identity block**. The user reads what the Setup *does*
before they read who *claims* to have made it.

### Text mode ordering

```
importing Night Reading  (abc1234)
  from:   alice-night.kset.yaml

⚠ This Setup modifies 2 security-sensitive settings:
  [network]   kosync.custom_server: (added) → "https://example.com"
  [network]   ota_server: (added) → "https://example.com/ota"
Pass --accept-sensitive to proceed.

  author:       Alice (UNVERIFIED)
  source:       https://alice.dev/setups (UNVERIFIED)
  description:  Warm night reading config for Kindle PW5

  changes (4):
    ...
```

The `name` and `from` appear first (the user needs to know which
file they're looking at). Then the SENSITIVE block. Then author/meta.
Then changes.

**Empty SENSITIVE case:** when the Setup has zero SENSITIVE changes,
the block is omitted entirely (no header, no "no changes" line). The
author block renders directly after `from:`. Ordering rule is
vacuously satisfied.

### JSON mode (no ordering contract)

JSON output has no `sections` wrapper. Consumers read fields directly
off the existing shipped envelope: the SENSITIVE-changes block lives
under its own key per `88` §3.3 display contract; the `meta` object
carries identity claims with `verified: false` per §3.2 above. JSON
ordering is the programmatic consumer's concern — the
anti-anchor-trust rule is a rendering concern, and programmatic
consumers are expected to inspect `sensitive_changes` before deciding
how to present `meta`.

---

## 5. `supersedes` semantics

Author declares: "this Setup replaces prior Setups with these content
hashes." Kindly stores the claim but does not validate it in W33.

### What kindly does now (W33)

- Accepts 0..N sha256 hashes in `meta.supersedes`.
- Displays them in preview with `(UNVERIFIED — no chain validation)`.
- Hash strings only — no name resolution against local history.

### What kindly does NOT do (deferred)

- **Resolve hashes to local names.** `.kindly/history.jsonl` stores
  `setup_id` (12-hex short id from `shortId(hashBytes(manifestBytes))`)
  but not the Setup's `meta.name`. Displaying "supersedes `old-name`
  imported 2026-04-20" would require either (a) extending
  `HistorySummary` to persist the name — coupling W33 to the history
  writer — or (b) re-reading the pre-import snapshot for each
  supersedes entry. Neither is justified for the W33 display contract.
  Deferred to v1.0 GUI where name resolution is a UI concern.
- Verify that the author of the superseding Setup is the same as the
  author of the superseded Setup. Requires signatures (W39).
- Block import of a superseded Setup. Users may want older versions.
- Build a DAG of supersedes chains. No graph, just a flat list of
  "this replaces those."

---

## 6. Field-by-field reference

| Field | Type | Trust claim? | Wrapped in JSON? | Text suffix | W39 changes |
|-------|------|-------------|-----------------|-------------|-------------|
| `name` | string (required) | No — content | No | None | None |
| `author` | string (optional) | Yes — identity | `{ value, verified }` | `(UNVERIFIED)` | `verified: true` if signed |
| `description` | string (optional) | No — content | No | None | None |
| `created_at` | ISO datetime | No — metadata | No | None | None |
| `tags` | string[] (optional) | No — content | No | None | None |
| `source_url` | URL string (optional) | Yes — provenance | `{ value, verified }` | `(UNVERIFIED)` | `verified: true` if signed |
| `version` | string (optional) | No — opaque label | No | None | None |
| `author_key_id` | string (optional) | Yes — identity | `{ value, verified }` | `(UNVERIFIED)` | Key matched to `.kset.minisig` |
| `supersedes` | sha256[] (optional) | Yes — chain claim | `{ value: string[], verified }` | `(UNVERIFIED)` | Chain validated if both ends signed |

---

## 7. Tests required

### Schema acceptance

- Manifest with all new fields populated → parses successfully.
- Manifest with no new fields (pre-W33 format) → parses successfully.
- Manifest with each new field individually → parses.
- `source_url` with invalid URL → `SetupSchemaError`.
- `supersedes` with non-sha256 entry → `SetupSchemaError`.
- `supersedes` as empty array → accepted.
- `author_key_id` as arbitrary string → accepted (format validated
  only at W39 verification time).

### Trust display (text mode)

- `setup inspect` of a Setup with `meta.author` → output contains
  `(UNVERIFIED)` after the author string.
- `setup inspect` of a Setup with `meta.source_url` → output
  contains `(UNVERIFIED)` after the URL.
- `setup inspect` of a Setup with no `meta.author` → output shows
  `author: (none)` or omits the line entirely. No `UNVERIFIED`.
- `setup import --dry-run` with `meta.supersedes: [sha256:abc...]` →
  output contains supersedes line with `(UNVERIFIED)`.

### Trust display (JSON mode)

- `setup inspect --json` → `meta.author` is
  `{ "value": "...", "verified": false }`, not a bare string.
- `meta.source_url` → same `{ value, verified }` wrapper.
- `meta.version` → bare string (not wrapped).
- `meta.supersedes` → `{ "value": [...], "verified": false }` (wrapper
  key is `value` regardless of cardinality).

### Anti-anchor-trust ordering

- `setup import --dry-run` of a Setup with both SENSITIVE changes and
  `meta.author` → SENSITIVE block appears before author line in text
  output. Assert by checking string index: `indexOf("SENSITIVE")` <
  `indexOf("UNVERIFIED")`.

### Supersedes rendering

- `supersedes: []` → line omitted from text output.
- `supersedes: ["sha256:abc..."]` → one-line display.
- `supersedes: ["sha256:abc...", "sha256:def..."]` → multi-entry
  display, each hash on its own line.

---

W39 handoff: this spec reserves the fields and locks the display
contract. W39 adds `--verify-key <path>`, flips `verified` to `true`
when the detached `.kset.minisig` checks out, and drops the
`(UNVERIFIED)` prefix. No schema migration needed — the fields are
already here.
