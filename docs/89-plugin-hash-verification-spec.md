# 89 — Plugin file hash verification: implementation spec
### *Contract for W32. Rationale in 87-security-matrices.md §2.2 A3/A5.*

Date: 2026-04-23.
Status: spec (code will cite this file).

---

## 1. Problem

Fat Setups ship plugin files (`plugins/*.koplugin/**`). The unpack
pipeline verifies that archive contents match the manifest's per-file
SHA256 hashes — but nothing checks whether those hashes correspond to
*known-good* KOReader plugin code. A tampered `statistics.koplugin` or
novel `evil.koplugin` passes unpacking without a single warning.

W32 adds a second verification layer: compare incoming plugin files
against a catalog of known hashes, so import can distinguish "stock
KOReader plugin" from "modified" from "unknown."

---

## 2. Catalog format change

`data/catalog/plugins.bundled.v1.json` gains an optional
`known_hashes` field per plugin entry.

### Schema addition (Zod)

```typescript
export const KnownHashesSchema = z.record(
    z.string(),           // path relative to plugin folder, e.g. "main.lua"
    z.string().regex(/^sha256:[a-f0-9]{64}$/)
);

// Add to PluginEntrySchema:
known_hashes: KnownHashesSchema.nullable().optional(),
koreader_hash_version: z.string().nullable().optional(),
```

### Example

```json
{
  "name": "SSH",
  "folder": "SSH.koplugin",
  ...
  "koreader_hash_version": "v2026.03",
  "known_hashes": {
    "main.lua": "sha256:a1b2c3...",
    "_meta.lua": "sha256:d4e5f6...",
    "settings.lua": "sha256:789abc..."
  }
}
```

### Why per-file, not per-directory

A single directory hash (hash of the tar of the dir) breaks on any
repackaging: tar header differences, file ordering, metadata. Per-file
SHA256 is portable, diffable, and tells the user *which file* was
tampered.

### Why `koreader_hash_version`

Hashes are valid for one KOReader version. When upstream ships a new
release, plugin files may change. `koreader_hash_version` records which
version the hashes were computed from. If the device runs a different
version, the comparison is advisory ("catalog hashes are from vX; your
device runs vY") rather than authoritative.

---

## 3. Hash generation (`scripts/extract-plugin-meta.ts`)

The existing extractor walks KOReader source and produces catalog
entries. Extend it:

1. For each `*.koplugin/` directory, walk all files (same filter as
   `collectPluginDirs` in `src/setup/files.ts`: skip dotfiles).
2. Hash each file's raw bytes with SHA256 (`hashBytes` from
   `src/setup/canonical.ts`).
3. Record `known_hashes` as `{ relative_path: hash }`.
4. Record `koreader_hash_version` from the source tree's `git-rev`.

Output is the same `plugins.bundled.v1.json`, with the new fields
populated. Existing `.passthrough()` on `PluginEntrySchema` means old
code ignores them; new code reads them.

### Hash normalization policy

**Rule: hash raw bytes. No normalization.**

- `readFileSync(path)` → `hashBytes(buf)`. No line-ending conversion,
  no BOM stripping, no encoding normalization.
- Both the extractor (reading from KOReader source tree) and the
  archive verifier (reading from unpacked fat Setup) use the same
  `hashBytes` function on the same raw bytes. Match is guaranteed
  when the file content is identical.
- KOReader source uses Unix line endings (LF). Plugin files on Kindle
  (ext4/vfat) preserve bytes as written. No platform introduces
  CRLF conversion in the pipeline.

**When MISMATCH is noise, not tampering:**

- KOReader upstream ships a new release → plugin files change →
  catalog hashes are stale. This is version skew (§4.5), not
  normalization failure. Advisory text explains it.
- User edits a plugin file on-device (e.g. custom tweak to
  `statistics.koplugin/main.lua`). This IS a real MISMATCH and
  should be surfaced — the user should know their device diverges
  from stock.
- Git autocrlf or similar tool munges line endings before archiving.
  This is a **bug in the archive creation pipeline**, not in kindly.
  Don't normalize to hide it — surface the mismatch so the author
  fixes their build.

### File role derivation

File role (used by W34 doctor to escalate severity per `90` §5.5) is
derived from extension, not stored in the catalog:

```
*.lua           → code    (tamper = error severity in doctor)
everything else → asset   (tamper = warning severity in doctor)
```

This covers KOReader's plugin structure: all executable logic is in
`.lua` files. Assets (translations, images, JSON configs) are
non-executable. No schema extension needed — derivation is
deterministic and the rule lives in the shared comparison function.

---

## 4. Verification on import

### 4.1 Where it runs

**Step 5 in the canonical import pipeline — see `88-sensitive-keys-spec.md`
§3.0.** Runs after `FAT_REQUIRES_ACK` (step 3) and mount detection
(step 4), before compat check (step 6).

Data dependencies driving this position:
- Archive files + catalog: available after step 1 (`loadSetup`).
- Device KOReader version: needed for the version-skew advisory
  (§4.5, report's `deviceVersion` field). This is populated by
  `readKoreaderVersion(mount)` at step 4. Hash verification must
  therefore run AFTER step 4, not before.
- Device settings parsing (step 8) and diff (step 9) are NOT needed
  — hash verification is purely archive-vs-catalog.

If `--skip-plugins` was passed, hash verification is skipped entirely
(no plugins will be installed, so there's nothing to verify). If
`--accept-plugins` was passed, the hash check runs and surfaces
warnings; the user has already consented to plugin installation.

The fat archive's `files` map is available (verified against manifest
hashes by `loadSetup`). The catalog is loaded and cross-referenced.

### 4.2 Algorithm

**Prerequisite — `.koplugin` segment requirement:**

`EmbeddedFile.path` is any safe relative POSIX path; the schema
doesn't enforce `*.koplugin/*` structure. But hash verification
requires grouping files by plugin directory. Rule: the first path
segment of every plugin file MUST end in `.koplugin`. If it doesn't,
the file is not recognizable as belonging to a catalogued plugin.

- At verification time: files whose first segment does not end in
  `.koplugin` are grouped under a synthetic `MALFORMED_STRUCTURE`
  verdict (see §4.3) with a note: "file path `foo/bar.lua` does not
  follow the `<name>.koplugin/<file>` convention — cannot verify
  against catalog." This is a warning in default mode, block in
  `--strict-imports`.
- At manifest parse time (future tightening): consider adding a Zod
  refinement to `plugins.files[].path` requiring the first segment
  to match `*.koplugin`. Deferred — would break any existing fat
  Setups with non-standard paths. The verification-time check is
  sufficient for W32.

```
for each top-level plugin dir in the fat archive's declared files:
    first_segment = d.path.split("/")[0]
    if first_segment does not end in ".koplugin":
        verdict = MALFORMED_STRUCTURE (warn)
        continue
    strip ".koplugin" suffix → plugin name
    look up plugin name in catalog

    if NOT in catalog:
        verdict = UNCATALOGUED

    else if catalog entry has no known_hashes:
        verdict = UNVERIFIED (catalog predates hash collection)

    else:
        compare archive files against catalog known_hashes:
            files in both with matching hash   → ok
            files in both with mismatching hash → MODIFIED (list files)
            files in archive but not in catalog → EXTRA (list files)
            files in catalog but not in archive → MISSING (list files)

        if all ok → MATCH
        else      → MISMATCH (with details)

collect all verdicts into PluginHashReport
```

### 4.3 Report shape

```typescript
type PluginFileVerdict =
    | { status: "match" }
    | { status: "modified"; file: string; expected: string; actual: string }
    | { status: "extra"; file: string; actual: string }
    | { status: "missing"; file: string; expected: string };

type PluginVerdict =
    | { status: "MATCH"; name: string }
    | { status: "MISMATCH"; name: string; files: PluginFileVerdict[] }
    | { status: "UNCATALOGUED"; name: string }
    | { status: "UNVERIFIED"; name: string }
    | { status: "MALFORMED_STRUCTURE"; paths: string[] };

type PluginHashReport = {
    verdicts: PluginVerdict[];
    catalogVersion: string | null;   // koreader_hash_version from catalog
    deviceVersion: string | null;    // KOReader version on mounted device
    versionMatch: boolean;           // catalogVersion == deviceVersion
};
```

### 4.4 Behavior per verdict

| Verdict | Default mode | `--strict-imports` |
|---------|-------------|-------------------|
| MATCH | Silent | Silent |
| MISMATCH | Warn (file-by-file diff of hashes). Print but proceed. | Block. Exit non-zero. |
| UNCATALOGUED | Warn: "plugin `X` is not in the bundled catalog — cannot verify." | Block. |
| UNVERIFIED | Info: "catalog entry for `X` has no hashes (catalog predates W32)." | Warn (non-blocking). |
| MALFORMED_STRUCTURE | Warn: "file paths don't follow `<name>.koplugin/<file>` convention." | Block. |

### 4.5 Version skew advisory

If `catalogVersion !== deviceVersion`, prepend to the warning:

```
Note: catalog hashes are from KOReader v2026.03; your device runs
v2026.05. Mismatches may reflect upstream changes, not tampering.
Regenerate the catalog with scripts/extract-plugin-meta.ts against
your version's source.
```

This is informational, not blocking. Even with version skew, a
MISMATCH is worth surfacing — the user can decide if it's benign.

---

## 5. Edge cases

### 5.1 Plugin exists on device but not in Setup

W32 only verifies plugins *shipped in the fat archive*. Plugins
already on the device are not hashed or compared during import. Device
plugin health is a doctor concern (W34), not an import concern.

### 5.2 Setup ships plugin not in catalog

UNCATALOGUED verdict. The import proceeds with a warning (default
mode). This covers:

- Third-party plugins the kindly catalog hasn't curated.
- Custom user plugins.
- Plugins from a newer KOReader version not yet in our catalog.

The warning text: "Plugin `X` is not in the bundled catalog.
kindly cannot verify its integrity. Review the plugin code
manually before accepting."

### 5.3 Multiple KOReader versions in the wild

The catalog stores one set of hashes (`koreader_hash_version`). Users
may run older or newer KOReader versions. The version-skew advisory
(§4.5) handles this. We do NOT store multiple hash sets per version —
the catalog is curated from one reference source tree.

If this becomes a real pain point (many false-positive mismatches), a
future catalog version could store `{ version: hashes }` per plugin.
That's a v2 catalog concern, not W32.

### 5.4 Fat Setup ships only some files of a plugin

The manifest might ship a subset of a plugin's files (e.g. only
`main.lua`, not `_meta.lua`). This is unusual but schema-legal.
Comparison logic:

- Files in archive + catalog with matching hash → ok.
- Files in archive + catalog with mismatched hash → MODIFIED.
- Files in archive but not in catalog → EXTRA.
- Files in catalog but NOT in archive → NOT reported as MISSING.

The last point: the Setup is shipping a subset, not claiming to ship
the full plugin. Missing files are only an error if the archive
claims to be a full plugin but isn't — and that's an install-time
concern, not a hash concern. KOReader will fail to load an incomplete
plugin, which is its own signal.

### 5.5 Catalog has hashes but plugin entry has `known_hashes: null`

Plugin was curated before hash collection, or the extractor couldn't
walk its directory (e.g. binary blobs, symlinks). Verdict: UNVERIFIED.
Same as a catalog entry with no `known_hashes` field at all.

### 5.6 `installPluginFiles` wipes before writing — data-loss boundary

`files.ts:156-160` does `rmSync(target, { recursive: true })` before
writing new files. The hash check runs BEFORE this wipe. But once the
user proceeds past a MISMATCH warning, the original plugin directory
is deleted and replaced. The on-device plugin state is only
recoverable from the safety snapshot (`pre-import/` tarball).

**Implication for the warning text:** When a MISMATCH verdict exists
AND the import would install plugins (not `--skip-plugins`), the
warning must include: "Proceeding will permanently replace the
existing plugin files on your device. The originals are preserved in
the safety snapshot." This makes the data-loss consequence explicit
at the decision point.

**Implication for `--no-safety-snapshot`:** If the user passes both
`--accept-plugins` and `--no-safety-snapshot`, and a MISMATCH exists,
the wipe is truly irreversible. The import flow should refuse this
combination when MISMATCH verdicts are present — or at minimum
escalate the warning to include "no safety snapshot will be taken;
original files will be permanently lost."

### 5.7 Built-in plugin overwrite detection

A fat Setup can ship `statistics.koplugin` — a built-in. The hash
check catches this via MISMATCH (if hashes differ) or MATCH (if
identical to the catalog). Additionally, the import renderer should
surface "REPLACES existing built-in plugin: statistics" for any
catalogued plugin being installed, even on MATCH. This is a
disclosure concern (N3 in 87), not a hash concern, but the same
catalog lookup powers both.

---

## 6. Error codes

No new error code for W32. Hash mismatches are warnings in default
mode (no throw). In `--strict-imports` mode (W34e), they trigger:

```typescript
throw new KindlyError(
    ErrorCodes.SETUP_INVALID,
    `plugin hash verification failed:\n${details}`,
    [{ text: "Review: kindly setup inspect <file>" }],
);
```

`SETUP_INVALID` already exists and covers "Setup is structurally valid
but fails a policy check." Adding a new code is warranted only if
callers need to distinguish hash failure from other SETUP_INVALID
causes — defer that to when `--strict-imports` is actually built
(W34e). If needed then, add `PLUGIN_HASH_MISMATCH`.

---

## 7. Display contract

### Text mode (stderr warnings)

```
⚠ Plugin hash verification:
  SSH.koplugin: MISMATCH
    modified: main.lua
      expected: sha256:a1b2c3... (catalog, KOReader v2026.03)
      actual:   sha256:x9y8z7... (Setup archive)
    extra: backdoor.lua (not in catalog)
  evilplugin.koplugin: UNCATALOGUED

  Note: catalog hashes are from KOReader v2026.03; device runs v2026.05.
```

### JSON mode (`--json`)

```json
{
  "plugin_hash_report": {
    "catalog_version": "v2026.03",
    "device_version": "v2026.05",
    "version_match": false,
    "verdicts": [
      {
        "status": "MISMATCH",
        "name": "SSH",
        "files": [
          { "status": "modified", "file": "main.lua",
            "expected": "sha256:a1b2c3...", "actual": "sha256:x9y8z7..." },
          { "status": "extra", "file": "backdoor.lua",
            "actual": "sha256:..." }
        ]
      },
      { "status": "UNCATALOGUED", "name": "evilplugin" }
    ]
  }
}
```

### `setup inspect` integration

`kindly setup inspect file.kset --verbose` includes the hash report
in its output. This is the U1 audit surface (T1/T7 in 87).

---

## 8. Doctor integration (W34 cross-reference)

W34 expands `kindly doctor` to check on-device plugin health. That
check uses the same catalog lookup + hash comparison, but against
files on the mounted device rather than files in a fat archive.
The report shape is identical (`PluginHashReport`). The
implementation should share the comparison logic as a pure function:

```typescript
function verifyPluginAgainstCatalog(
    pluginName: string,
    files: Map<string, Buffer>,        // path relative to koplugin dir → bytes
    catalog: PluginCatalog,
): PluginVerdict
```

Called by W32 with archive files, called by W34 with on-device files.
Same function, different input source.

**Scope note — `MALFORMED_STRUCTURE` is unreachable from the doctor
path.** That verdict (§4.2) only fires for `EmbeddedFile.path` strings
declared in a manifest whose first segment doesn't end in `.koplugin`.
On-device plugins live in real directories under `plugins/*.koplugin/`
— the path structure is not embedded data, it's the filesystem layout.
The shared function may emit `MALFORMED_STRUCTURE` in principle, but
the W34 caller will never construct inputs that trigger it. W34 tests
should not include a MALFORMED_STRUCTURE case on the doctor side.

Role derivation (§3 "File role derivation") also lives in this shared
module. Doctor's severity escalation (`90` §5.5) calls:

```typescript
function fileRole(path: string): "code" | "asset" {
    return path.endsWith(".lua") ? "code" : "asset";
}
```

**Property that tests must verify:** given identical `(pluginName,
files, catalog)` inputs, `verifyPluginAgainstCatalog` returns the
same `PluginVerdict` regardless of whether it was called from the
import path or the doctor path.

---

## 9. Tests required

Coverage targets — each must exist for W32 to ship:

### Shared function (`verifyPluginAgainstCatalog`)

- **MATCH:** archive plugin files identical to catalog hashes → verdict
  MATCH, empty file list.
- **MISMATCH — modified:** one file has different hash → verdict
  MISMATCH, file list contains one `modified` entry with expected +
  actual hashes.
- **MISMATCH — extra file:** archive has a file not in catalog →
  `extra` entry.
- **MISMATCH — missing file:** catalog has a file not in archive →
  `missing` entry (only when archive ships full plugin; see §5.4 for
  subset semantics).
- **MISMATCH — mixed:** modified + extra in the same plugin → both
  appear in file list.
- **UNCATALOGUED:** plugin name not in catalog → verdict UNCATALOGUED.
- **UNVERIFIED:** plugin in catalog but `known_hashes` is null →
  verdict UNVERIFIED.
- **MALFORMED_STRUCTURE:** file path with first segment not ending in
  `.koplugin` → verdict MALFORMED_STRUCTURE with the offending paths.

### Extractor round-trip

- Run `extract-plugin-meta.ts` on a synthetic koplugin dir. Read back
  the catalog. Run `verifyPluginAgainstCatalog` on the same files →
  MATCH. This proves the extractor and verifier agree on hash
  computation (raw bytes, no normalization).

### Import integration

- Fat Setup with MATCH plugin + `--accept-plugins` → import succeeds,
  no warnings in result.
- Fat Setup with MISMATCH plugin + `--accept-plugins` → import
  succeeds, `plugin_hash_report.verdicts` contains the MISMATCH.
- Fat Setup with UNCATALOGUED plugin + `--accept-plugins` → import
  succeeds with warning.
- Fat Setup with MISMATCH + `--skip-plugins` → hash verification
  skipped entirely, no verdicts in result.
- Fat Setup with MISMATCH + `--strict-imports` (W34e) → exit non-zero,
  no writes.

### Version skew advisory

- Catalog `koreader_hash_version` differs from device version →
  `versionMatch: false` in report, advisory text present in rendered
  output.
- Catalog and device versions match → `versionMatch: true`, no
  advisory.

### Data-loss boundary (§5.6)

- MISMATCH + `--accept-plugins` + `--no-safety-snapshot` → warning
  text includes "no safety snapshot" escalation.

### Identity property (§8)

- Same `(pluginName, files, catalog)` fed through W32 import path and
  W34 doctor path → identical `PluginVerdict`. Property test, not
  snapshot.

### Role derivation

- `fileRole("main.lua")` → `"code"`.
- `fileRole("icon.png")` → `"asset"`.
- `fileRole("translations/en.json")` → `"asset"`.
