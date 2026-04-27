# kindly

Declarative backup & restore for your KOReader setup. Made mostly for my Kindle.

## The problem

KOReader is powerful but fragile. Factory reset, firmware update, or device swap and you lose every setting, gesture, and plugin toggle you painstakingly tapped in on an e-ink screen. Six years of open GitHub issues converge on this one pain.

## The idea

One YAML file describes your setup. One command backs it up. One command restores it.

```bash
# Device state
kindly pull                              # device → kindly.yaml
kindly apply                             # kindly.yaml → device
kindly diff                              # what's different?

# Bootstrap & health
kindly init minimal                      # start from a curated preset
kindly doctor                            # sanity check
kindly doctor --repair                   # recover an interrupted apply

# Safety net
kindly snapshot                          # tarball of plugins/patches/history
kindly restore <archive>                 # extract a snapshot back to device
kindly rollback --to <N>                 # revert to a per-import safety snapshot
kindly history                           # list mutations from .kindly/history.jsonl

# Shareable Setups
kindly setup export my-config            # make a shareable Setup manifest
kindly setup import my-config.kset       # apply someone's Setup to your device
kindly setup verify my-config.kset       # check signature against your trust roster
kindly setup trust add publisher.pub     # trust a publisher's ed25519 key
kindly setup templates                   # list curated starting points

# Plugin catalog
kindly plugin list                       # browse the curated bundled-plugin catalog
kindly plugin describe <name>            # full entry with references and curation opinion

# Preview (requires Docker)
kindly preview --output preview.png      # render kindly.yaml as a Kindle-screen PNG

# Automation
kindly serve                             # long-running JSON-IPC over stdin/stdout
kindly watch                             # tail -f .kindly/history.jsonl as JSON
```

## Install

**Compiled binary (recommended for most users)** — download one file
from the latest [GitHub release](https://github.com/busuyoc/kindly/releases),
chmod +x, and run. No Bun, no Docker, no clone required.

```bash
# macOS (Apple Silicon)
curl -L -o kindly https://github.com/busuyoc/kindly/releases/latest/download/kindly-darwin-arm64
chmod +x kindly && ./kindly --help

# macOS (Intel) → kindly-darwin-x64
# Linux x86_64 → kindly-linux-x64
# Windows x86_64 → kindly-windows-x64.exe   (best-effort cross-compile, untested)
```

macOS gatekeeper warns the first time — right-click → Open. No
auto-update; re-download from releases for new versions.

**From source** (contributors, or if you want `kindly preview` /
the harness):

```bash
git clone https://github.com/busuyoc/kindly && cd kindly
bun install
bun run src/cli.ts --help
bun test                                 # 1800+ tests
```

`kindly preview` additionally needs Docker. Build the harness image
once with `harness/koreader/build.sh`.

## How it works

kindly is a **transparent window** onto `settings.reader.lua`. No config
surface of its own — `kindly pull` produces a YAML whose keys match the
Lua file 1:1 (minus secrets and ephemerals, which are filtered by default).
`kindly apply` merges your YAML back in **without deleting** anything it
doesn't know about, so a half-populated YAML can't wipe your zlibrary
password.

Write path:
1. Archive snapshot → `.kindly/backups/<iso>/settings.reader.lua`
2. Write new content to `settings.reader.lua.tmp`, fsync
3. Rotate old file to `settings.reader.lua.old` (KOReader's own fallback)
4. Atomic rename `.tmp` → `.lua`, fsync directory
5. Re-read, re-parse, verify byte-exact; on failure, roll back from `.old`

A clean pull → apply cycle leaves the on-device file byte-identical — even
the trailing header comment KOReader emits is reproduced exactly.

## What's NOT synced

**Secrets** (always filtered): `pinpadlock_pin_code`, `zlibrary_password`,
`kosync.userkey`, `device_id`, phone numbers in screensaver messages, and
a few more. `kindly doctor` lists what's on your device.

**Ephemerals** (filtered with `--minimal`, kept with `--full`): `lastfile`,
migration-done markers, `last_migration_date`, etc.

## Snapshot / restore (v0.2)

YAML covers the 180 keys in `settings.reader.lua`. It does **not** cover
user-installed plugins, hand-written `patches/*.lua`, `history.lua`, or
`defaults.custom.lua`. `kindly snapshot` tarballs those; `kindly restore`
extracts one back.

```bash
kindly snapshot                                   # ./kindly-snapshot-<iso>.tar.gz
kindly restore snap.tar.gz --dry-run              # preview (no writes)
kindly restore snap.tar.gz                        # extracts; takes a pre-restore
                                                  # safety snapshot first
kindly restore snap.tar.gz --no-safety-snapshot   # skip the safety copy
```

Restore is file-by-file overwrite. Files on device that aren't in the
archive are left alone (tar semantics). The safety snapshot lives at
`<cwd>/.kindly/pre-restore/<iso>.tar.gz` — re-extract it to roll back.

**Snapshots contain plaintext secrets** (copy of `settings.reader.lua`) —
don't commit them; `.gitignore` already excludes `*.tar.gz`.

## Setups (v0.3)

`kindly.yaml` is **your device** (full pull, checked into your own repo).
A **Setup** is a curated, shareable slice — "here's my night-reading
config, try it" — with a stable identity and apply semantics.

Two formats:
- **Lean** `foo.kset.yaml` — just settings + optional `plugins.disabled`.
  Diffable, readable, one file.
- **Fat** `foo.kset` (tar.gz) — lean manifest plus user-installed plugin
  directories and/or hand-written `patches/*.lua`. Use `--include-plugin-files`
  and/or `--include-patches` on export.

Apply modes:
- **additive** (default) — merge declared keys, leave everything else alone.
- **replace** — wipe non-declared USER keys, but always preserve secrets
  and ephemerals. Use for a clean "this is the whole config" handoff.

```bash
kindly setup export my-config                  # device → my-config.kset.yaml
kindly setup export my-config --include-plugin-files --include-patches
                                                # → my-config.kset (fat)
kindly setup inspect my-config.kset.yaml        # show id, keys, compat, hash
kindly setup import my-config.kset.yaml         # apply to device (additive)
kindly setup import my-config.kset.yaml --mode replace
kindly setup import my-config.kset --dry-run    # preview fat import
```

**Templates** — pre-authored Setups bundled in the binary; no device
required to export one:

```bash
kindly setup templates                          # list curated starts
kindly setup export my-night --template night-reading
kindly setup export my-min --template minimal-ui --keys reader_footer_mode
```

Current templates: `minimal-ui`, `night-reading`, `distraction-free`.
All additive. CLI flags (`--keys`, `--tags`, `--compat-*`) layer on top.

**Compat metadata** — `--compat-koreader-min/max` and
`--compat-device` are stored in the manifest and **enforced on import**
against the detected KOReader version (`koreader/git-rev`) and device
family (`system/version.txt`). Mismatches block with exit 1; pass
`--force` to convert the block into a warning. When detection fails
(missing files, unparseable version) import warns and proceeds.

Setup identity is a sha256 over the canonicalized manifest bytes —
two exports of the same state produce the same id. Fat archives also
embed per-file hashes so tampering is detectable at import time.

**Schema validation (v0.5)** — every `setup export` and `setup import`
validates its settings block against a **KOReader-derived schema** of
557 keys (extracted from `G_reader_settings:*` call sites in the source
tree, augmented with observed types from a live device). Unknown keys
(typos, or plugin-scoped keys the schema hasn't catalogued) and type
mismatches are warned on stderr by default. `--strict` converts warnings
into a blocking error (exit 1); `--allow-unknown-keys` silences the
unknown-key warning but still surfaces type mismatches.
Regenerate the schema with `bun run scripts/extract-schema.ts <koreader-root>`.

## Status

v0.14.0 released. Kindle-only. Solo project. 1800+ tests covering:
byte-identical round-trip on a real 180-key `settings.reader.lua`,
tar create/extract/list, full snapshot → mutate → restore → rollback
coverage, Setup manifest export/import/verify/trust across lean and
fat formats, compat gating (version window + device family) at the
import boundary with `--force` override, schema validation (typo +
type-mismatch detection) against 557 KOReader settings keys, and a
18-gate policy layer covering SENSITIVE-key consent,
code-exec-adjacent paths, control-byte rejection, destructive-shape
protection, and Ed25519 signature verification with a built-in
keyring + local trust roster.

Other substrate added since v0.5: `kindly serve` (JSON-IPC for a future
GUI), `kindly watch` (history streaming), `kindly history` /
`kindly rollback` (git-style mutation log), `doctor --repair` for
interrupted-apply recovery, mount fingerprinting for cross-Kindle
protection, a hash-bound bundled-plugin catalog, a
KOReader-in-Docker preview harness behind `kindly preview`, and
single-binary distribution via `bun build --compile`.

See `docs/` for design notes — `docs/security/` for the threat model
and red-team hardening log, `docs/infra/` for the roadmap and hub
strategy.
