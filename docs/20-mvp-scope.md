# 20 — MVP Scope (v0.1)

Synthesis of a 4-lens brainstorm (Technical, Product, UX-Research, Business)
across 3 rounds on the question: **what does korea v0.1 ship?**

Source inputs: `docs/00-vision.md`, `docs/01-profile-schema.md`,
`docs/03-architecture.md` (partially superseded by 13), `docs/10-research-reddit.md`,
`docs/11-research-github.md`, `docs/12-research-prior-art.md`,
`docs/13-research-technical.md`. Methodology from
`mategenius/.claude/memory/planner-brain.md` §Brainstorming multi-lens.

Date: 2026-04-21.

---

## TL;DR — the big pivot

**The README and 01-profile-schema are pitched share-first ("Reddit setups
become YAML"). The research is unanimous that the actual Tier-1 pain is
backup/restore after factory reset / firmware update / device swap — not
sharing with strangers.** Every lens independently arrived at the same pivot
in Round 1, and cross-critique confirmed it in Round 2.

v0.1 therefore targets **a single user on a single device doing
pull → edit → apply, with a verifiable backup trail** — not gists, not
inheritance, not secrets resolution. Sharing is V1+; Reddit-grade
collaboration is V2+.

Secondary unlocks from technical research (13-research §9):
- **Embedded Lua interpreter is NOT needed** (03-architecture.md:44-48
  was overkill). ~80 LoC pure-data parser / writer suffices.
- Order preservation is irrelevant — KOReader re-sorts on every flush via
  `orderedPairs` (13-research §1).
- `_meta.lua` sometimes executes code (`autowarmth` calls `require("device")`) —
  do not `dofile` plugin metadata; grep string literals instead.

---

## 1. v0.1 feature list (Must)

Each feature has a rationale + the lens(es) that flagged it as Must.

| # | Feature | Rationale | Lens |
|---|---------|-----------|------|
| F1 | **`korea pull`** — read mounted device → emit `korea.yaml` | First "wow." Makes the invisible visible. Solo demo works day 1. | Product, UX-R, Tech |
| F2 | **`korea apply <file>` (Kindle + Kobo)** | Reverse of pull. Without it korea is a viewer. Android is explicit V2. | All |
| F3 | **`korea diff`** — show YAML-level delta between device state and profile | Unique. Nothing else offers this. Users currently compare by eye on e-ink. | Product, UX-R |
| F4 | **Lua-literal parser + writer** for `settings.reader.lua`, byte-faithful to KOReader's `dump.lua` output (incl. `%q` string escapes, alphabetical key order, 4-space indent, bracket-quoted keys) | Engine of everything. Per 13-research §9: no Lua interpreter needed; ~200-400 LoC. Must round-trip identically or KOReader silently falls back to `.old`. | Tech |
| F5 | **Atomic safe-write pipeline** — write to `.tmp`, fsync, rename, backup prior file to `.korea/backups/<ts>.lua` **before** overwriting, **and re-parse post-write to verify**. On verify-mismatch: restore backup, fail loudly. | Anti-horror-story move. Tier-1 pain in 10-research is silent data loss (#5562, #5577, #11882, #13875, #1612). Product added the post-write verify in Round 2. | Tech + Product |
| F6 | **Plugin enable/disable** via `plugins_disabled` map — toggle only, no install/fetch | Folder-install is a separate concern (V1). Toggling is trivial (13-research §2) and covers the top 10-research complaints (`perceptionexpander`, `zsync`, `evernote`, `calibrecompanion`). Schema treats `enabled` as a *request* — self-disabled plugins (13 of 36, e.g. `SSH` on Kindle) get a `doctor` warning, not a silent failure. | Tech + Product |
| F7 | **Mount detection for Kindle + Kobo** with explicit per-device path table (Kindle: `/mnt/us/koreader/`, Kobo: `/mnt/onboard/.adds/koreader/`) | 11-research §Q7: Kindle + Kobo account for ~1100 of ~1650 tracked issues. Android is explicitly deferred ("here be dragons" — NiLuJe). | Tech + UX-R |
| F8 | **`korea apply --dry-run`** — show exact writes before committing | First-run trust. Without this, nobody runs `apply` a second time. | Product + UX-R |
| F9 | **`korea pull --minimal` (and default to it)** — emit only keys that differ from KOReader ship defaults + known-interesting keys | Unfiltered pull = 200-line YAML on a power user's device = terrible first impression. UX-R pushed this in cross-critique; all lenses accept. | UX-R + Product |
| F10 | **`korea init minimal`** — one curated preset: disables `perceptionexpander`, `zsync`, `evernote`, `calibrecompanion`, `backgroundrunner`, `japanese`, `newsdownloader`, `wallabag`, `autoturn` (+ any self-disabling plugins redundantly listed so `doctor` is informative). Sets a conservative `font_size`, `night_mode: false` default. | Business upgraded this from Nice→Must in Round 2. Addresses 10-research Tier-1 signal #3 (plugin bloat / spaceship cockpit). Demo-able. SEO artifact ("the opinionated minimal KOReader"). | Business + Product |
| F11 | **Clear, plain-English error messages** + `korea doctor` (v0.1 scope: "is device mounted?", "is KOReader running?", "are listed plugins capability-gated?") | App-caching risk (13-research §what's hard) — writes get clobbered if KOReader is still running on the device. Must detect + refuse. | Tech + Product |
| F12 | **Single static binary** — Homebrew tap + GH release prebuilt binaries for macOS + Linux | Zero-friction install is table-stakes for the power-user audience (10-research: jailbreakers who already install .koplugin zips manually). | Business |
| F13 | **README + 30s demo GIF** — hero GIF shows pull → edit → apply → reboot; emotional framing is "restore your settings after factory reset", not "share your setup" | The demo IS the marketing. Aligns with 10-research backup-pain positioning. | Business + Product |

**13 Must items.** Every Must has an explicit lens owner; nothing floats.

### Explicitly NOT Must (common-asked, deferred)

- `secrets:` block (env substitution, 1Password, SOPS). v0.1 writes plain
  values; document "don't share a file with credentials." (Schema still
  reserves the keys but resolution is inert.)
- `extends:` inheritance. No preset ecosystem exists (12-prior-art §Part 4),
  inheriting from nothing is dead syntax.
- SimpleUI typed schema (the `simpleui:` nested tree from 01-profile-schema).
  Pass-through raw `navbar_*` / `simpleui_*` keys for v0.1. Typed schema is
  V1.1 once SimpleUI 1.4→1.5→1.6 key-rename pattern is better mapped.
- Plugin folder installer (fetch `.koplugin` zips from curated registry).
- `share` / gist publishing.
- Rollback command (just `korea apply <older-backup>.yaml` manually in v0.1).

---

## 2. Thin-slice demo that proves core value

**The factory-reset recovery demo.**

30 seconds, no audio:

1. Mount Kindle. `korea pull` → `korea.yaml` appears (10 lines, minimal mode).
2. Factory reset the Kindle (on-screen text: "Wipe device").
3. Reinstall KOReader, fresh. Mount.
4. `korea apply korea.yaml`. One line of output: "backup saved to `.korea/backups/20260421-…`, applied 14 key changes + 6 plugin toggles."
5. Boot Kindle. Settings restored. Night mode, font size, disabled plugins —
   all there.

**Why this slice:**

- Single user, single device, zero dependency on an audience.
- Hits Tier-1 pain (10-research §Top signals) head-on: 6 converging issues
  about exactly this flow.
- Demonstrates all 4 Must-feature primitives (`pull`, `apply`, backup, plugin
  toggle) in one narrative.
- Does NOT require any share primitive, secrets handling, preset, or SimpleUI
  codec — all Nice/V1 scope, correctly excluded.
- Emotionally resonant. The tweet writes itself: "I factory-reset my Kindle.
  Got my KOReader back in 30 seconds with one command."

**Why not the "alice shares her setup" demo:** requires a second user, a gist
backend, and trust. Better for V1 launch, not v0.1 reveal.

---

## 3. What research changes vs 01-profile-schema.md

The schema draft predates 10/11/12/13 research. What flips:

| Field in schema | v0.1 status | Source |
|-----------------|-------------|--------|
| `name`, `description` | keep | — |
| `extends` | **drop from v0.1** — no preset ecosystem yet | 12-prior-art §Part 4 |
| `device: {model, mount_hint}` | keep; `model` restricted to `kindle`/`kobo`/`generic` in v0.1 | 11-research §Q7 |
| `plugins: {enabled, disabled}` | keep enable/disable; **drop per-plugin configs** (`zlibrary:{email,password}`) — plugin-specific config is a per-plugin story. v0.1 only toggles. | 13-research §2 + 11-research §Q3 |
| `koreader: {…}` nested tree | keep as the primary user-facing surface; map to flat `settings.reader.lua` keys | 13-research §1 |
| `simpleui: {…}` typed nested tree | **defer to V1.1.** SimpleUI stores flat keys (`navbar_*`, `simpleui_*`) not nested subtables (03-architecture.md:62 was wrong). v0.1: pass-through raw keys. | 11-research §Q4, 13-research §5 |
| `secrets: {source: env|file|op}` | **drop resolution; keep warn-on-detect.** v0.1 tells users "don't commit this file to a public repo; these fields look like credentials." | Lens convergence |
| Profile format: YAML | **keep YAML.** Frenzie/#4951 prefers TOML for KOReader internals but (a) our users aren't KOReader maintainers, (b) SimpleUI-nested modules are ugly in TOML, (c) r/koreader prose is indentation-based, YAML reads similarly. | 11-research §12 vs lens convergence |
| `schema_version` pin per profile | **keep and require** from v0.1 to enable future migrations | 04-open-questions §2 |
| `koreader_version` pin per profile | **add** — new field not in original schema. Needed so future korea can migrate keys via a `onetime_migration.lua`-paralleling rules table. | 11-research §Q3, 13-research §6 |

### What 03-architecture.md got wrong (confirmed in 13-research §"What docs/03-architecture.md got wrong")

- Order preservation: not needed. KOReader re-sorts on every flush.
- Embedded Lua interpreter: not needed for the common case. A hand-rolled
  recursive-descent parser over the `dump.lua` output grammar (~10 rules)
  suffices. Embedded Lua becomes V2 fallback for user-hand-edited files
  with expressions.
- "SimpleUI stores as nested subtable" — false. Flat keys with prefixes.
- Plugin enable has a third gate: the plugin's own `main.lua` can return
  `{disabled = true}`. v0.1 treats `enabled:` as a *request*, not a guarantee,
  and `doctor` warns on self-gated plugins.
- `_meta.lua` extraction cannot assume pure data — `autowarmth/_meta.lua`
  executes `require("device"):hasNaturalLight()`. Grep string literals for
  `fullname`/`description` instead.

---

## 4. Risks (triaged by severity)

### HIGH

| ID | Risk | Mitigation | Lens |
|----|------|------------|------|
| R1 | **Valueing assumption untested.** "Users want declarative YAML config" could be wrong; they may want zip-backup. 7 years of open issues could mean unsolved pain OR insufficient pain. | **1-day paper prototype with 3 r/koreader setup-sharers (DM via archived posts).** Show mocked `korea.yaml` + the factory-reset demo flow; gauge willingness-to-use. Blocks only if 3/3 reject; one-sided validation is enough to proceed. | UX-R, Business |
| R2 | **Silent data loss via `%q` escape mismatch.** One off-by-one byte → KOReader's `pcall(dofile)` fails → silent fallback to `.old` → user thinks apply succeeded, it didn't. | Fuzz tests against real `dump.lua` output for strings containing `\n`, `\"`, `\\`, `\0`, high-bit UTF-8. F5's post-write re-parse + verify is the runtime backstop. | Tech |
| R3 | **User trust after one bricked setup.** A single early blog post "korea ate my Kindle config" kills adoption for months. | F5 (backup + verify + restore on mismatch), F8 (dry-run default-suggested on first use), F13 (README sets expectations: alpha, backs up every write, here's how to restore). | Product, Business |

### MEDIUM

| ID | Risk | Mitigation | Lens |
|----|------|------------|------|
| R4 | **KOReader upstream ships built-in backup (PR #13762) and swallows the oxygen.** | korea's value compounds beyond export: diff, apply-to-multiple-devices, presets, a plugin-schema registry. A one-shot zip-backup feature doesn't replicate. If #13762 merges, korea's README repositions: "uses KOReader's own export as an input, adds the rest." | Business |
| R5 | **KOReader app running during apply** — in-memory settings cache overwrites our write on next flush. | Pre-flight check: refuse to apply if device appears mounted *and* KOReader appears active (heuristic: `settings.reader.lua` mtime within last 60s → suspicious). F11 covers. | Tech |
| R6 | **Schema drift across KOReader versions** (1–2 key renames/year per `onetime_migration.lua`). v0.1 is pinned to a specific KOReader version; user upgrades KOReader, next `apply` may mis-set renamed keys. | **v0.1: pin to KOReader 2026.03 in docs + schema version; doctor warns on version mismatch.** Migration rules table = V1. Don't over-engineer on day 1, but don't pretend the risk is zero. Tension resolved: Tech said overthink, UX-R said medium — compromise on docs-only warning. | Tech vs UX-R |
| R7 | **Name "korea" is SEO-hostile + ambiguous** with the country. Can't rename after Homebrew tap is public. | **Decide before v0.1 public launch.** Candidates: `koread`, `konfig`, `kindly`, `korea-studio`. Not a technical blocker; a business one. | Business |
| R8 | **First-run `pull` produces ugly 200-line YAML.** Kills first-impression. | F9 `--minimal` default + curated "interesting keys" list. | Product, UX-R |
| R9 | **PR #15096 (plugin enable keyed by directory name, not metadata name) lands mid-v0.1.** | Monitor the PR; if it merges, add a compatibility shim. Not built in day 1. | Tech |

### LOW (flagged, not mitigated in v0.1)

- Licensing thicket if korea ever bundles plugin binaries. Mitigation: v0.1
  doesn't bundle; fetches on demand (or leaves install to the user).
- Telemetry temptation. Resolution: no telemetry. Ever.
- `_meta.lua` code-execution footgun. Resolution: grep extraction only.
- Secondary settings files (`settings/opds.lua`, `defaults.custom.lua`,
  `.sdr` sidecars) — out of scope; document.

---

## 5. Anti-features (things users will ask, we refuse at v0.1)

Explicit won't-build list. Say "no" with reasoning, not "maybe someday":

| Ask | Verdict | Why |
|-----|---------|-----|
| "Sync my reading progress across devices" | Refuse forever | kosync exists. Different product. |
| "Sync my highlights/annotations" | Refuse v0.1 | KoHighlights exists. Separate surface. |
| "Auto-apply when I plug in my device" | Refuse | Explicit command only. Auto-sync → the issue #1612 footgun. |
| "Run as a daemon watching my device folder" | Refuse | Syncthing exists, users hate it for this. |
| "Give me a GUI" | Refuse v0.1 | CLI only. |
| "Manage KOReader user-patches (code patches)" | Refuse | Patches = Lua source. Different tool (joshuacant/patches). |
| "Bundle SimpleUI in the install" | Refuse | Licensing + freshness + scope. Fetch on demand in V1. |
| "Encrypt my secrets with SOPS/age" | Refuse v0.1 | Document "don't share files with creds"; V2. |
| "Telemetry / usage analytics" | Refuse forever | Audience will revolt. |
| "Schedule backups for me" | Refuse | `cron + korea pull + git commit` is one line. User's job. |
| "Android support" | Refuse v0.1 | Per NiLuJe: "here be dragons." Path chaos, SD UUIDs, scoped storage. V1+. |
| "Per-book `.sdr` reading-state sync" | Refuse v0.1 | Explicitly out of scope per 00-vision §Non-goals. |
| "A web-hosted preset marketplace" | Refuse v0.1 | V2+. Start with git/gists. |
| "Inheritance / `extends: some-preset`" | Refuse v0.1 | No preset ecosystem yet; dead syntax without content. |
| "Roll back my profile to a previous version" | Partial refuse | v0.1 ships `.korea/backups/` you can `korea apply` manually. First-class `rollback` command = V1. |

---

## 6. Stack + format decisions

### Format: **YAML**, with `schema_version` required from v0.1

**Decision justified:**
- SimpleUI nested module tree is ugly in TOML (01-profile-schema.md open
  question §2; confirmed by 13-research §5 showing a pass-through path
  works either way, and Product lens: r/koreader prose is indentation-based).
- Frenzie/#4951 prefers TOML for KOReader internals, but korea's users are
  not KOReader maintainers. Different audience.
- YAML's comment support matters for user-authored share files — TOML has
  them too but YAML's sectioning reads more like a config guide.
- Not a two-way door: TOML migration is a mechanical transform if we flip
  later. Safe default.

**Unresolved sub-decision:** accept YAML anchors? v0.1: **no** — users rarely
write them; avoids ambiguity. Revisit in V1.

### Language: **Go** (not Rust, not Bun/TS)

**Tension in Round 1** (Tech leaned Bun/TS for iteration speed; Business
leaned Go for single-binary packaging). **Round 2 resolution toward Go:**

- Single static binary: Go trivially; Rust trivially; Bun via `bun compile`
  feasible but a weekly-churn surface.
- Lua `%q` fidelity: no language has an edge; it's ~80 lines of pure logic.
  Test suite is the protection.
- Claudiu's stack lean is TS — but Bun compile for macOS + Linux + Windows
  binaries is a week of packaging fiddle that Go does in one `GOOS=… GOARCH=…`
  pass. For a solo project optimizing for ship-speed, Go wins the total
  time-to-binary.
- Rust `mlua` is the best fallback *if* we decide embedded Lua matters —
  but 13-research §9 concludes we don't need it for v0.1. That removes
  Rust's biggest comparative advantage.
- Go has `gopher-lua` if embedded fallback becomes needed in V2. Covered.

**Decision logged:** Go for v0.1. Revisit at V1 if Lua fidelity turns out
painful or if Claudiu's day-to-day Go comfort is actually worse than he
thinks. Reversal is contained — the profile schema is language-agnostic.

### Lua interpreter: **NOT needed for v0.1** (validated per 13-research §9)

- Writer: port `dump.lua` (~80 LoC) with alphabetical key sort + `%q`
  escape fidelity. Test suite against real KOReader dump output.
- Reader: recursive-descent parser over the dump subset. ~200-400 LoC. No
  operators, no variables, no concat — pure data grammar.
- Fallback for hand-edited files with expressions: v0.1 **errors clearly**
  ("file is not in KOReader dump format"). Embedded Lua is V2.

### Distribution: Homebrew tap + GH release prebuilt (macOS arm64/x64, Linux amd64/arm64) from day 1

- `curl | sh` also supported (download-from-release-URL pattern).
- No npm/cargo/pip — audience doesn't expect language-specific installers.

### Target KOReader version pin: **2026.03** for v0.1

- Documented in README + validated at `doctor`-time.
- If user runs KOReader 2025.x or 2026.05+, doctor warns.
- Formal migration rules = V1.

---

## 7. Build order + dependencies

Solo greenfield, so "sprint = scoped work items." No user stories in the
Jira sense.

Ordered because each depends on the prior:

```
Week 0: 1-day paper prototype + 3-user validation (R1 mitigation)
  ↓ go / no-go
Week 1: W1. Lua-literal writer (port of dump.lua) + test suite
        vs real KOReader output
  ↓
Week 1-2: W2. Lua-literal reader (recursive-descent parser) + test
          suite for real-world settings.reader.lua samples
  ↓  F4 complete
Week 2: W3. Device mount detection (Kindle + Kobo) + path table + safe
        write pipeline (.tmp, fsync, rename, .korea/backups, post-write
        verify)  ← F5, F7
  ↓
Week 2-3: W4. Profile schema v1 (YAML) + parser + validator (required
          fields: name, schema_version, koreader_version; optional:
          device, koreader, plugins)
  ↓
Week 3: W5. `korea pull` — device read → profile write, with
        --minimal default (known-interesting-keys list)  ← F1, F9
  ↓  first demoable primitive
Week 3-4: W6. `korea apply` — profile → device write, with --dry-run,
          plugin enable/disable toggles + self-gating warning  ← F2, F6, F8
  ↓  end-to-end loop closed
Week 4: W7. `korea diff`  ← F3
  ↓
Week 4-5: W8. `korea init minimal` — the single curated preset  ← F10
  ↓
Week 5: W9. `korea doctor` — mount check, app-running heuristic,
        capability-gate warnings, version pin check  ← F11
  ↓
Week 5-6: W10. CLI polish, plain-English errors, README + 30s
           demo GIF  ← F13
  ↓
Week 6: W11. Homebrew tap + GH release binary pipeline  ← F12
  ↓
Week 6: ship v0.1 tag
```

**Total estimate: ~6 weeks solo.** Each phase has a natural checkpoint
(demo-able sub-slice).

**Why this order:**
- W1 → W2: writer before reader, so round-trip tests work both directions
  as soon as reader lands.
- W3 before W4: filesystem plumbing before profile semantics. Decouples.
- W5 (pull) before W6 (apply): pull is safer (read-only). Build confidence
  first.
- W6 before W7: diff is trivially mostly implemented once pull + apply exist
  (compare the internal models).
- W10 before W11: don't cut binaries with bad error messages.

---

## 8. V1 backlog (post-v0.1, not now)

Ordered by likely priority based on post-launch feedback:

1. **Gist / GitHub URL share** — `korea init github:alice/my-kindle`,
   `korea init gist:...`. Chezmoi-pattern.
2. **Plugin folder installer** — curated registry for SimpleUI, zlibrary,
   localsend, projecttitle. Fetch-on-demand, never bundled.
3. **SimpleUI typed schema** — top ~15 `navbar_*`/`simpleui_*` keys mapped
   to the original 01-profile-schema.md `simpleui:` tree. Versioned shim.
4. **`korea rollback`** — first-class, not just "apply an older file."
5. **Secrets resolution** — env-var substitution + companion file. SOPS/age
   = V2.
6. **Migration rules table** paralleling `onetime_migration.lua` — handle
   cross-KOReader-version key renames at `apply` time.
7. **Android (tier-2) support** — path abstraction, SD UUIDs, scoped storage.
   Mark as best-effort.
8. **`korea apply --prune`** — opt-in plugin folder deletion for unlisted
   plugins.
9. **Curated preset gallery** — `korea init simpleui-mosaic`, `korea init
   pdf-academic`, `korea init minimal` (already v0.1).
10. **Per-plugin config blocks** — `- zlibrary: {email: …}` style, once
    we have a plugin schema registry.
11. **Device-class adaptation** — Kobo-authored profile warned-apply-able
    on Kindle (path translation).

## 9. Never-build list (V∞)

- GUI
- Cloud backend owned by korea
- Telemetry
- Paid tier
- Reading-progress sync (kosync's job)
- Highlight sync (KoHighlights' job)
- User-patch (code) management (joshuacant/patches' job)
- A daemon watching device folder (Syncthing's job, badly)
- Modifying KOReader source
- Bundled plugin binaries

---

## 10. Unresolved tensions (explicit, per planner-brain.md §Anti-patterns)

Do not paper these over. Claudiu decides:

| # | Tension | Sides | Current stance |
|---|---------|-------|----------------|
| T1 | **Pre-code validation gate** | UX-R: 5 conversations first. Product/Business: ship rough, iterate. | Compromise: 1-day paper prototype with 3 r/koreader setup-sharers, then code. Budget 2-3 days for DM + conversations. |
| T2 | **Kindle-first vs Kobo-first launch** | Business: Kobo (higher issue volume, cleaner fs). Tech: agnostic. Product/UX-R: silent. | Both on day 1 — device adapter table is small enough. If scheduling slips, Kobo wins the cut. |
| T3 | **Schema drift severity** | Tech: overthink for v0.1. UX-R: medium. | Compromise: README pin to KOReader 2026.03 + `doctor` version warning. No migration rules in code yet. |
| T4 | **Project name** | Business: urgent (Homebrew tap commits us). Others: neutral. | **Blocker before public launch.** Candidates: koread / konfig / kindly / korea-studio. Not a technical blocker, but cannot be punted past W11. |
| T5 | **Bun/TS fallback option** | Tech (R1): lean Bun for iter speed. Business: Go for packaging. | Resolved toward Go in R2 critique. Re-open if Claudiu's Go comfort is actually worse than assumed; reversal cost is contained (schema is language-agnostic). |

---

## 11. Cross-check table (per planner-brain.md: each lens story → v0.1 slot)

| Lens item | v0.1 disposition |
|-----------|------------------|
| Tech-1 Lua parser/writer | F4 |
| Tech-2 mount + safe-write | F5, F7 |
| Tech-3 apply/pull/diff | F1, F2, F3 |
| Tech-4 plugins_disabled toggle | F6 |
| Tech-5 device profile table | F7 |
| Tech-Nice init preset | F10 (upgraded to Must) |
| Tech-Nice SimpleUI typed | V1 backlog #3 |
| Tech-Nice doctor | F11 (upgraded to Must) |
| Tech-Nice plugin installer | V1 backlog #2 |
| Product-1 pull | F1 |
| Product-2 apply | F2 |
| Product-3 diff | F3 |
| Product-4 backup+restore visibility | F5 |
| Product-5 plain-English errors + dry-run | F8, F11 |
| UX-R-1 backup/restore canonical | F5 |
| UX-R-2 simple first-run | F9 |
| UX-R-3 human-scannable diff | F3 |
| UX-R-4 Kindle + Kobo | F7 |
| UX-R-5 dry-run/backup visibility | F5, F8 |
| Business-1 backup-first positioning | F13 |
| Business-2 Homebrew + GH release | F12 |
| Business-3 demo video | F13 |
| Business-4 MIT + public repo | (assumed, not a feature) |
| Business-5 init minimal | F10 |

**13 Must features; 25 lens-level items. Every item mapped. No drift.**

---

# Lens lessons (suggested appends)

New principles surfaced by this brainstorm that are **framework-level, not
korea-specific**. Do NOT modify the lens files; Claudiu decides which (if
any) to accept.

### Suggested for `planner-brain.md`

**"Deep research can invalidate schema assumptions mid-design."**
> When a design document (EPIC / schema / architecture) is written before
> deep technical research, re-brainstorm after the research lands. 01-profile-
> schema.md was drafted pre-13-research; three of its core decisions (embed
> Lua, preserve order, SimpleUI as nested subtable) were falsified by a
> later source-code read. The schema-drafting pass is not wasted — it
> frames the research — but the scope lock must wait until research is done.

**"In solo greenfield, 'build MVP thin slice → show 3 users' replaces 'ship
sprint → demo.'"**
> The multi-lens brainstorm was invented for team sprints where stories
> flow to Jira. It works just as well for solo greenfield if "stories" are
> renamed "scoped work items" and the sprint demo is replaced by a 3-user
> paper prototype. The Round-2 critique remains the quality-forcing step;
> it doesn't care how small the team is.

### Suggested for `planner-lens-ux-research.md`

**"Pre-code paper prototype (1 day, 3 users) > 5-user survey."**
> For greenfield where the value assumption is the biggest risk, a
> 1-day paper-or-mock prototype with 3 users gives enough signal to
> proceed/pivot. 5 is a ceiling, not a floor. The budget question
> (what if I can't find 5 users in a week?) is solved by aiming at 3
> and accepting asymmetric signal: 3/3 reject = stop; 2/3 or 3/3 accept =
> proceed with caveats.

### Suggested for `planner-lens-business.md`

**"In OSS greenfield, the thin-slice demo IS the marketing."**
> For solo OSS products with no revenue intent at v0.1, the 30-second
> demo GIF in the README is the single most important marketing artifact.
> It must be producible from the thin-slice scope alone. If the slice
> needs props (a second user, a gist backend, a made-up preset) to demo
> compellingly, it's not the right slice.

**"Naming is a v0.1 blocker, not a v1 polish item, when distribution is
via package managers."**
> Homebrew taps, cargo crates, npm names, docker image names all become
> public commitments at first release. Rename = broken links forever.
> Business lens flags: naming decisions that would otherwise be "V1 polish"
> graduate to v0.1 blockers specifically when the distribution channel
> commits you.

### Suggested for `planner-lens-technical.md`

**"Validate each 'we need X' claim against source code before scoping X."**
> 03-architecture.md recommended embedded Lua (weeks of scope). 13-research
> §9 read the KOReader source and concluded a hand-rolled ~80-line parser
> suffices. Validating "we need a Lua interpreter" against the actual
> grammar emitted by `dump.lua` saved significant scope. Principle: when
> architecture claims "we need [big thing]" for [reason], read the source
> of [reason] before accepting the scope. This is cheap when the source
> is public.
