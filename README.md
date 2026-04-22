# kindly

Declarative backup & restore for your KOReader setup. Made mostly for my Kindle.

## The problem

KOReader is powerful but fragile. Factory reset, firmware update, or device swap and you lose every setting, gesture, and plugin toggle you painstakingly tapped in on an e-ink screen. Six years of open GitHub issues converge on this one pain.

## The idea

One YAML file describes your setup. One command backs it up. One command restores it.

```bash
kindly pull                              # device → kindly.yaml
kindly apply                             # kindly.yaml → device
kindly diff                              # what's different?
kindly init minimal                      # start from a curated preset
kindly doctor                            # sanity check
kindly snapshot                          # tarball of plugins/patches/history
kindly restore <archive>                 # extract a snapshot back to device

kindly setup export my-config            # make a shareable Setup manifest
kindly setup import my-config.kset.yaml  # apply someone's Setup to your device
kindly setup templates                   # list curated starting points
```

v0.3 adds shareable Setups (see below). SimpleUI typed schemas still come later.

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
`--compat-device` are stored in the manifest and shown on inspect/import.
They are **informational in v0.3**; enforcement lands in v0.4.

Setup identity is a sha256 over the canonicalized manifest bytes —
two exports of the same state produce the same id. Fat archives also
embed per-file hashes so tampering is detectable at import time.

## Status

v0.3. Kindle-only. Solo project. 442 tests: byte-identical round-trip on a
real 180-key `settings.reader.lua`, tar create/extract/list, full
snapshot→mutate→restore→rollback coverage, plus Setup manifest
export/import/templates/compat across lean and fat formats. See `docs/`
for design notes.
