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
```

Sharing setups (Reddit-style) and SimpleUI typed schemas come later. v0.1–v0.2 is about not losing your config.

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

## Status

v0.2. Kindle-only. Solo project. 207 tests: byte-identical round-trip on a
real 180-key `settings.reader.lua`, plus tar create/extract/list and full
snapshot→mutate→restore→rollback coverage. See `docs/` for design notes.
