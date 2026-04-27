# Hub Strategy & Feature Roadmap

**Date:** 2026-04-26 (post v0.13 red-team round 2 in progress)
**Status:** Living doc — synthesis of round-1 + round-2 community research and feature brainstorm. Iterate freely.

---

## 1. Identity: kindly is a hub, not a tool

The visible surface ("declarative backup/restore for KOReader settings") undersells the project. The actual surface:

> **Every interesting thing you can do with KOReader state from a host computer, built on a shared safety + provenance + recovery layer.**

The plumbing is the project. Features are demonstrations of what the plumbing enables.

### The desktop-side advantage

Native KOReader features run on the e-ink device itself: slow CPU, bad input, can't be scripted, every change triggers a screen flash. Kindly runs on a real computer. That's not a feature — that's the entire reason the product exists in a different category.

**Pitch line for the README:** "configure your Kindle from your laptop without making your Kindle blink."

The wizard, the diff, the strict-apply mode, the highlight aggregator — all of these are only practical because we're not running on a 1GHz e-ink device. Lean into this. Anything that requires the device to do more work is off-strategy.

---

## 2. The substrate (what's already built)

Each of these is a real engineering primitive. Together they're the "shared safety layer" that makes feature additions cheap.

- **Atomic safeWrite** (6-step pipeline: archive → tmp → fsync → rename → verify)
- **Byte-exact Lua roundtrip** (23 commits of correctness work)
- **Classify taxonomy** (SECRET / SENSITIVE / EPHEMERAL / USER, NFC-normalized)
- **Gates architecture** (12 active gates: consent, destruction, identity)
- **Setup format** (`.kset`, manifest-hashed, plugin-bytes-bundled)
- **Ed25519 signing + built-in keyring + local trust roster**
- **Hash-bound built-in publisher registry** (CI-gated)
- **History (audit log + snapshot machinery + rollback)**
- **Mount fingerprinting** (cross-Kindle protection)
- **Doctor + doctor --repair** (health checks, SIGKILL recovery)
- **Reproducible build harness** (W46)

When evaluating new features, the test is: **does this consume existing substrate, or does it require new substrate?** The first is in-scope. The second is a different project.

---

## 3. Feature buffet (composes with substrate)

Tagged by user reaction during the 2026-04-26 brainstorm.

### Strong yes / aligned with vision

- **WHY debugger** — `kindly explain <key>` cross-references settings + plugins + KOReader source. Addresses the recurring r/koreader pattern of "why does my Kindle do X." Nobody has the full picture in one view today.
- **Stranger-config compatibility check** — `kindly inspect <kset>` against your device says: "this needs Zen UI you don't have, references fonts you don't have, here's what would actually apply." A dependency resolver for shared configs. Already partially present in `setup inspect`; promote and harden.
- **Plugin integrity timeline** — hash every plugin file, store in history, alert on diff. Catches firmware tampering, accidental edits, silent self-updates. Pairs with classify + signing. Will surface real HIGHs.
- **Fast desktop wizard** — 4-question first-run that previews 100 configs in a second on the host without touching the device. NOT a marketplace, NOT a publishing platform. Just hand-curated example YAMLs in the repo with a thin wrapper.

### Strong yes, needs scoping

- **Reading data extraction (Spotify Wrapped style)** — pull statistics SQLite + per-book pacing histograms + highlight timeline. Risk: scope creep into "analytics product." Mitigation: ship two layers — (a) raw extraction primitive (`kindly highlights export`, `kindly stats export`); (b) one opinionated `kindly review --year=2026` static-HTML page on top. Layer (a) is the substrate; layer (b) is one demo.
- **Highlight timeline / corpus aggregation** — chronological "things you marked, ordered across books." Differentiates from native exporter (per-book, on-device, on-demand). Resonates with Obsidian/Notion users. **Needs separate research** on canonical import formats before building.

### Conditional yes

- **Restoration "to-spec" mode** — `kindly apply --strict` removes keys not in YAML (Terraform-style). Currently apply is additive. Useful for "factory reset to my golden config." Risky, gated, but pitchable as a deliberate mode.
- **Per-genre auto-switching as portable rules** — manga → RTL+spread, textbook → two-column. KOReader profiles plugin can do this on-device but the rules aren't portable. YAML-as-source-of-truth makes them shareable.
- **Per-book pacing analyzer** — "books that gripped you" list (reading speed normalized per book). Genuinely novel, no prior art surfaced. Possible HN-traction feature. Lives inside the reading-data extraction branch.

### Tricky to present, save for later

- **Targeted templates** (a11y / child-mode / travel-mode / academic). Cool, low-effort, but presentation as "templates" implies catalog/marketplace politics. Better framing: ship them as `examples/*.kindly.yaml` in the repo. Documentation that doubles as functionality.

### Already done / in flight

- **"Safe to share" filter** — already largely covered by classify. Just needs a `kindly share` wrapper that strips per-device residue (device_id, lastfile, paths-with-username) on top of the existing secret filtering.
- **Setup compatibility resolution** — partially in place via `setup inspect --vs-device`. Promote and harden as the catalog vision materializes.

---

## 4. Integration vectors (the hub thesis)

Because kindly runs on a host computer, it composes with other host-side tools natively. Each of these is a thin adapter, not a rewrite.

- **Calibre** — Calibre runs on desktop, manages the book library. Kindly runs on desktop, manages the device config. Combined: bidirectional metadata sync ("kindly knows you read this book to 47%, Calibre knows the book exists, can we close the loop"). Basic level: a `kindly calibre` adapter that reads/writes Calibre's metadata.db format. Out-of-scope: full Calibre replacement.
- **Obsidian / Notion** — highlight timeline + statistics export emit Markdown / JSON / frontmatter formats those tools eat natively. Adapter pattern: `kindly highlights export --format=obsidian-daily-notes`.
- **Local AI assistants** (Ollama, LM Studio, etc.) — kindly extracts your highlights as a corpus → local LLM ingests → "what books mentioned X," "summarize my margin notes from October." All local, no cloud. Especially interesting given kindly's existing privacy posture (everything stays on your machine; no telemetry; no cloud upload).
- **Readwise** — competitor in the highlight-aggregation space. Cloud-based, paid. Kindly's local-first, FOSS angle is the differentiator. Don't integrate; coexist.
- **Dotfile managers** (chezmoi, yadm, GNU Stow) — kindly's YAML files are git-trackable. Already composes with these via filesystem; no special integration needed but worth documenting in a "use kindly with chezmoi" example.

The shared property of every viable integration: **kindly is the upstream extractor / authority; the integrating tool is the downstream consumer.** Don't accept inputs from other tools — emit outputs they can use.

---

## 5. Out of scope (don't go here)

These break the "host-side, declarative, no new substrate" rule. Each is a legitimate project but a different one.

- **Daemon mode / time-based auto-apply** — needs background process model
- **P2P sync between devices without a host** — kindly's USB-mediated model is the moat; abandoning it abandons the niche
- **Cloud upload service / hosted catalog** — auth, storage, billing, moderation; not a 1-engineer project
- **Native KOReader plugin / on-device features** — different language (Lua), different runtime, different community, different security model
- **Marketplace governance** (curated catalog with submissions) — moderation overhead grows linearly with users; the FOSS community has hostility to "official" curation in this space
- **Replacing existing tools** (Calibre, Readwise, sync server) — coexist, don't compete

---

## 6. Strategic context (round-1 + round-2 research)

Three findings that shape sequencing.

### 6.1 Competitive position

**KOReader PR #13762** ("native zip-style backup", `hius07`) has been open since May 2025. Polite indefinite hold — maintainer pazos asked for cross-device safety, author conceded "fix as bugs come in," 8 months of dead air. CI green, author active on 30 other PRs but not this one.

- Merge probability: 15% in 6mo, 25-30% in 12mo, 35-40% in 18mo
- **Runway: 12-18 months baseline**

Even if it merges, kindly stays in a different category. Eight durable gaps survive: SECRET filtering, declarative diff, real multi-device reconciliation, gates/audit/rollback, plugin-bytes bundling, curated catalog, CLI/automation, GUI preview.

**Smoking gun for kindly's docs:** #13762 restores via `loadstring()` — arbitrary Lua execution from any backup zip. Also ships kosync passwords + cloud creds + PINs in plaintext. Cite this as a security delta in the README without engaging the thread.

**Action:** stay silent on the upstream thread. Reference it constructively only after kindly v1.0.

### 6.2 Distribution channels (smaller than round-1 implied)

**Tier 1 — dmpop (Productivity Sauce columnist).** The KOReader Compendium itself is content-frozen (last substantive commit May 2022, 8 stars). PRs do merge though. The real prize is dmpop's recurring *Linux Magazine* column ("Productivity Sauce", still active March 2026) which reaches kindly's exact audience. Path: small chapter PR to compendium → six months later, pitch a column. Lead with CLI; do NOT lead with the GUI.

**Tier 2 — spruceUI/spruceSource.** Ships a `settings.reader.lua` pinned at KOReader v2024.04 with someone's `device_id` and `lastfile=京城十案.epub` baked in. They have the pain; they don't know it. Smallest experiment: one PR converting their settings.reader.lua to a `spruce.kindly.yaml` source-of-truth + 5-line build hook. Surwish (70⭐) cargo-cults spruce, so flow-through is automatic. Quill-OS is a perfect technical fit but maintainer disengaged.

**Tier 3 — MobileRead "essential plugins" thread + r/koreader posts.** Slow-burn organic. Real but unpredictable.

**Closed channel — official KOReader docs / install guides.** Maintainer culture pushed back on the "backup should be one-click" framing in issue #11882; engagement is hostile-shaped. Path is sideways through Tier 1-3, not through official channels.

### 6.3 Validated demand

7-year recurring complaint chain on GitHub: #4780 (2019) → #6925 (2020) → #11132 → #11882 (2024, the angry one) → #13281 (2025) → #14920 (2026). Same complaint every 12 months. Maintainers actively defended manual-copy approach. Demand is real, niche is empty.

Strongest user segments (evidence-backed):
1. **Device upgraders** — bought a new Kindle, want their config back
2. **Multi-device tinkerers** — Kindle + Kobo simultaneously
3. **Crash-recovery users** — KOReader corrupted their settings; they want git-for-koreader

Weakest segment: **fresh-install newbies**. They don't know they need kindly. The "Ninite for KOReader" framing is the wrong pitch. **Pivot to "git for KOReader settings — survives crashes, migrates between devices, ships starter configs."**

---

## 7. Open questions (research debt)

Things web research can't answer that affect v1.0 scope:

- **What % of KOReader users own ≥2 e-readers?** Determines how aggressive multi-device UX should be. Settle with a r/koreader poll once v1.0 has a name.
- **What's the canonical Obsidian/Notion highlight-import format?** Determines if highlight timeline is a clean export or a Readwise-dependency. Specifically: does Obsidian have a Daily Notes / Periodic Notes convention that maps to highlight dates? Does Notion's API accept batch markdown? Are existing tools (Readwise, Reflect, Mem) the canonical importers, or do users still want raw markdown?
- **Does spruceUI's maintainer team actually want external authoring tooling?** Only answerable by sending the PR.
- **Is the FAT32 atomic-rename probe (Lead 18) still pending?** Verify before final v0.13 ship.

---

## 8. Sequencing for the remaining month (post-v0.13 red-team)

Rough order. Adjust as red-team round 2 closes.

1. **Finish v0.13 red-team round 2** (in flight). Commit fixes.
2. **Docker setup + real-Kindle audit + OS checks.** This is the gate before any UI work; the "actually works on a vfat-formatted USB-mounted Kindle" gap.
3. **GUI v1.** React + existing CLI as backend. Rough is fine. The desktop-side advantage thesis demands a visible UI to demonstrate.
4. **README + architecture doc + security model writeup + case study.** Two hours of writing converts existing work into the artifact a hiring manager evaluates. Highest leverage time of the entire month.
5. **Optional: WHY debugger or plugin integrity timeline as a v1.0+ stretch.** Both substrate-reusing, both demoable.

After the month: dmpop chapter PR, spruceUI experiment PR. Not before.

---

## 9. Notes for self

- The hub framing makes scope decisions easier. "Does this reuse substrate?" is the question. If yes, in-scope. If no, separate project.
- The desktop-side framing is the moat against #13762 and against any future on-device tooling. Promote it in marketing.
- Don't engage with KOReader maintainer politics. The community is small and a few key humans hold strong opinions; engaging is net-negative.
- Portfolio impact > adoption impact for the next month. Documentation + case study before catalog + outreach.
- The plumbing is the project. Don't apologize for "just doing plumbing." Senior engineers build infrastructure; juniors build features on top.
