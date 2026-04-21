# 30 — Decisions log

Claudiu's answers to the 5 unresolved tensions in `20-mvp-scope.md`, 2026-04-21.

| # | Question | Decision | Note |
|---|----------|----------|------|
| T1 | Paper prototype with 3 r/koreader users before code? | **Skip.** It's for Claudiu, not for sale. Build for self-use first. | Accepts the risk that nobody else wants it. |
| T2 | Kindle-first vs Kobo-first? | **Kindle-only v0.1.** Kobo deferred to V1. | Simplifies: single mount path, single device adapter. |
| T3 | Schema drift severity? | Implicit: defer migrations to V1. Pin KOReader version in README; `doctor` warns. | Same as 20-mvp-scope stance. |
| T4 | Project name | **`kindly`** | Bonus: puns as a virtue (be kindly with your Kindle). |
| T5 | Language | **TypeScript.** Runtime: Bun. | Overrides the Go suggestion. User's daily driver + stated preference. |

## Ripple effects of these choices

### "For me, not for sale"
- No paper prototype, no user interviews, no README-as-marketing pressure.
- Can ship hacky v0.1 and iterate based on Claudiu's own friction.
- Public repo still fine (MIT) but zero promise of stability, support, or backwards-compat for v0.1.

### Kindle-only
- `device` adapter layer collapses to a single concrete struct for v0.1.
- Mount path hard-coded: `/Volumes/Kindle/` on macOS, `/mnt/us/koreader/` on device itself.
- No Kobo `.adds/koreader/` path needed yet.
- F7 in mvp-scope (mount detection for Kindle+Kobo) trims to Kindle only.

### Brick-risk accepted
- Still build F5 (safe-write + backup + post-write verify) because it's table-stakes engineering, not just trust-building. But don't sweat "trust" as a first-class feature.
- The "bricked Kindle blog post" risk (R3) is moot — no audience.

### TypeScript / Bun
- Package manager: Bun.
- Language: TypeScript.
- Binary distribution: `bun compile` for macOS arm64. Cross-compile to Linux later if needed.
- Homebrew tap: defer — unnecessary for solo user. `bun run` from the repo is enough for v0.1.
- Lua writer/reader: hand-rolled TS. Zero runtime deps beyond Bun.
- Unlocks: faster iteration, familiar stack, can use Bun's fast test runner built-in.

## What we're cutting from v0.1

Because audience = 1, several v0.1 items become non-essential:

- **F12 (single static binary + Homebrew)** — drop. `bun run src/cli.ts` is fine.
- **F13 (README + 30s demo GIF)** — skeletal README only. No demo video for v0.1.
- **F11 (plain-English errors)** — keep the spirit (don't throw stack traces), but drop the polish budget.

What remains essential:
- F1–F6 (pull, apply, diff, Lua codec, safe-write, plugin toggle) — the core loop
- F7 trimmed — Kindle mount detection only
- F8 (--dry-run) — Claudiu will still want to preview writes to his own device
- F9 (--minimal default) — ugly 200-line YAML is bad even for the author
- F10 (init minimal preset) — useful as a smoke test

## Revised v0.1 feature count

**9 essential features** instead of 13. Same build order, lighter polish phase.

## Schema decisions (W4, added 2026-04-21 after real-file inspection)

After parsing a real 180-key `settings.reader.lua`:

| # | Question | Decision | Reasoning |
|---|----------|----------|-----------|
| S1 | YAML shape: flat vs grouped? | **Flat passthrough.** | Grouped schemas need a 180-key category map that rots every KOReader release. Flat = transparent window. Prefix-sorted keys group visually already. |
| S2 | Secrets with env interpolation, or drop? | **Drop entirely in v0.1.** | Env interp is a half-solution (password still isn't backed up). Defer "real" secret handling to V1. `doctor` lists filtered keys so users know what their password manager must hold. |
| S3 | `plugins_disabled` shape: keep or invert to `enabled`? | **Keep `{name: true}` as-is.** | Inverting requires knowing the universe of available plugins to compute the complement. Mirror the Lua source of truth. |

**Unifying principle.** Minimize semantic translation between Lua and YAML. Every transformation is a place KOReader can break us. v0.1 = transparent window + two filters (secrets, ephemerals).

### Secrets denylist (v0.1)
Hard-coded in `src/schema/classify.ts`. These keys never appear in YAML:
- `pinpadlock_pin_code`, `pinpadlock_message` (phone number)
- `zlibrary_password`, `zlibrary_username`, `zlib_user_key`, `zlib_user_id`
- `kosync.userkey`, `kosync.username` (nested)
- `device_id`
- `screensaver_message` (phone number)

### Ephemerals denylist (v0.1)
Values that change constantly and would create YAML noise:
- `lastfile`, `lastdir`, `navbar_homescreen_flow_recent_fp`
- `last_migration_date`, `LocalSend_last_update_check`
- `quote_deck_pos`, `current_tries_number`, `wifi_was_on`
- `*_initial_default_setup_done*`, `simpleui_defaults_v*`, `*_migrated_v*`

Users can opt into `--full` to include ephemerals for debugging; secrets remain filtered even with `--full`.

## Revised timeline

6 weeks was padded with polish (W10–W11). For solo-self-use with no release pressure:

- **~4 weeks** realistic, slightly ambitious.
- **No hard deadline.** Ship when it works on Claudiu's own Kindle.
