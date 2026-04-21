# 12 — Prior Art Research

Scope: does a tool like `korea` already exist? If yes, why isn't it enough? If no, why not? What adjacent work informs the design?

Date: 2026-04-21.

---

## Part 1 — Direct competitors (KOReader-specific)

### 1.1 KOReader built-in "Profiles"

- **What:** Built into KOReader. Saves a snapshot of bottom-menu settings + font as a named profile. With 200+ actions now accessible, profiles have become more powerful and support triggers (app start, book open, collection, etc.).
- **URL:** https://github.com/koreader/koreader/wiki/Profiles
- **Status:** Active, core feature.
- **Relevant because:** It is the closest in-app thing to what korea proposes. Profiles are stored in `profiles.lua` and are user-editable.
- **Why it's not enough:**
  - Profiles are a per-device concept, scoped to *reading* settings (bottom menu + font). They don't cover: which plugins are installed, plugin configs, SimpleUI layout, gestures, dispatcher actions, defaults, patches, styletweaks.
  - No share primitive: no export to file, no import-from-URL, no diff. You can manually edit `profiles.lua` but that is lua, specific to one device layout, and not documented as a shareable artifact.
  - No notion of a "factory reset safe" baseline — profiles live inside the install that you are trying to wipe.
- **What we'd copy:** The trigger/action vocabulary is rich. Any declarative format should be able to reference the same 200+ actions so we don't reinvent them.
- **What we'd avoid:** Storing the source of truth *on the device* in Lua. korea wants host-side YAML/TOML.

### 1.2 `kurokeita/koreader-configs` (GitHub)

- **What:** Personal dotfiles-style repo. Contains `icons/`, `patches/`, `plugins/` (bookends.koplugin, projecttitle.koplugin). Not a tool — a dump meant to be copied to the device by hand.
- **URL:** https://github.com/kurokeita/koreader-configs
- **Status:** Active (last commit 2026-04).
- **Relevant because:** Demonstrates the exact pattern korea replaces — a human-curated file tree that another human mirrors onto a device manually. No automation, no schema, no diff, no applier.
- **What we'd copy:** Nothing. It's evidence of demand, not prior art on solution.

### 1.3 `vyleung/koreader-config`

- **URL:** https://github.com/vyleung/koreader-config
- **Contents:** README + `bluetooth-page-turner/` (karabiner-elements.json + index.md) + `scriptlets/KOReader.sh`. Personal notes + one scriptlet. Even less than kurokeita's.
- **Status:** Active (Nov 2025).
- **Relevant because:** Again, demand pattern. Users want to capture their setup in git, but the best they can do is prose + a few raw files.

### 1.4 `koreader/koreader-sync-server` + the kosync plugin

- **What:** Self-hostable server + client plugin syncing **reading progress only** (where you are in a book). Not settings.
- **URL:** https://github.com/koreader/koreader-sync-server
- **Status:** Active, official.
- **Relevant because:** Often confused with "settings sync." It is not. It's the book-position analog of Kindle Whispersync.
- **What we'd avoid:** The name. Users search "koreader sync" and land here; any korea docs must clearly say "not progress sync."

### 1.5 `jasonchoimtt/koreader-syncthing` and `arthurrump/syncthing.koplugin`

- **What:** Run Syncthing inside KOReader so a folder of files (typically books + metadata sidecars) stays in sync across devices.
- **URL:** https://github.com/arthurrump/syncthing.koplugin
- **Status:** Active.
- **Relevant because:** The most common community answer to "how do I sync settings?" is: "point Syncthing at the koreader directory." This works for file mirroring but:
  - Conflicts on `settings.reader.lua` are a known footgun (issue #1612 — restoring an old settings.reader.lua gets silently reset).
  - No concept of profiles, presets, or diffs — just raw file mirror.
  - Doesn't solve first-time setup, doesn't solve "share with a friend", doesn't handle device-type differences.
- **What we'd copy:** Nothing structurally. korea is host-driven, not on-device daemon.

### 1.6 `KoHighlights`

- **URL:** https://noembryo.github.io/KoHighlights/
- **What:** Desktop app that merges/exports highlights across connected KOReader devices.
- **Relevant because:** Closest existing *host-side desktop* tool that talks to a mounted KOReader device. Proves the "plug device in, desktop app reads the filesystem" pattern is accepted by the community.
- **What we'd copy:** The host-side, plug-in-device UX. Detect the mount, operate on known paths.
- **What we'd avoid:** Scope is only highlights. Not a template for config management.

### 1.7 Upstream GitHub feature requests — unresolved

Multiple open issues asking for exactly what korea would do, none closed, none with a plan:

- **#4780** (open since 2019): "Sync all koreader settings from device to device." Labeled enhancement, no implementation.
- **#6925**: "import/export settings from paperwhite → android." Open.
- **#11882**: "simplify backups procedures" — asks for one-click zip backup from the UI. Open, not planned.
- **#11936**: "Share profile across different devices." Open. User explicitly tried Syncthing, couldn't find the profile file, no maintainer response.
- **#13280, #13281**: profile auto-exec ideas; "transfer all settings / profile to new Kindle" — the recommended answer is "copy these folders by hand, here's a script that might be outdated."
- **#4951**: "Redesign config and metadata handling" — upstream acknowledgment that config is a mess.

**Takeaway:** The need is documented, persistent (7+ years), unresolved, and the upstream project's answer is "manually copy files." No one is building a tool outside the tree either.

### 1.8 Ecosystem adjacents that aren't competitors

- `KindleForge` / `KindleModding` / KUAL — package installers for Kindle homebrew, not config managers. They install apps; they don't describe app state. Analog: apt vs ansible.
- `KoInsight` — reading stats dashboard.
- `koreader-calibre-plugin` — metadata sync (Calibre ↔ KOReader). Issue #58 in that repo is literally titled "[FEATURE] Managing KOReader lua files," filed and not implemented.
- `SeriousHornet/KOReader.patches`, `joshuacant/KOReader.patches`, `qewer33/koreader-patches`, `sebdelsol/KOReader.patches` — curated lua patch collections. Pattern mirrors korea's "presets" concept, but scope is code patches (monkey-patching KOReader source), not user settings. Worth studying for: how the community already distributes "apply this on top of your install" bundles.

---

## Part 2 — Closest adjacents

### 2.1 NickelMenu (Kobo)

- **URL:** https://github.com/pgaskin/NickelMenu
- **What:** Adds custom menu items to Kobo's stock reader (Nickel). Configuration is plain text files in `.adds/nm/config/`, hot-reloaded without reboot, not touched by firmware updates.
- **Status:** Active, beloved in Kobo community.
- **Why relevant:** The *design philosophy* is exactly what korea should aim for.
  - Plain text config, shareable (gists of NickelMenu configs are everywhere, e.g. `nicoverbruggen/kobo-config`).
  - Non-invasive: touches nothing the device owns.
  - Survives firmware updates.
  - Hot reload.
- **What we'd copy:** Non-invasive model. Single-file config philosophy. "My kobo-config" github repos as a distribution pattern.
- **What we'd avoid:** Its config is a flat DSL (`menu_item :main :label :action`); korea's surface is richer and benefits from structured YAML/TOML.

### 2.2 `nicoverbruggen/kobo-config` and similar personal repos

- **URL:** https://github.com/nicoverbruggen/kobo-config
- **What:** "My personal Kobo Nickel configuration" — screensavers, legibility, scripts. README-driven, copy-paste-style.
- **Relevant because:** Same shape as the KOReader dotfile-dumps but for Kobo/Nickel. This is the baseline UX across e-reader communities and it's bad. korea's pitch is "this repo but actually applied by a tool."

### 2.3 chezmoi

- **URL:** https://www.chezmoi.io
- **Model:** Source of truth in `~/.local/share/chezmoi` (a git repo). Templates for per-machine variation. Secrets via password managers. `chezmoi apply` materializes files.
- **Why loved:** Single binary, no runtime dependencies, works on any OS, templates without being a full language, encrypted secrets, comparison table actively maintained.
- **What we'd copy:**
  - `apply`/`diff`/`init` verb naming — users already know these.
  - Templating for per-device variation (Kindle vs Kobo path differences).
  - "One command bootstraps from a URL" — `chezmoi init <repo>` is a clean pattern for `korea init <gist>`.
- **What we'd avoid:** Chezmoi's implicit mode (modify files via `chezmoi edit`) — too magic for a tool that only runs when you plug in a device.

### 2.4 yadm

- **Model:** Thin wrapper around git. Dotfiles live in-place, yadm is the management CLI.
- **Relevant because:** Shows the "git repo directly, tool is thin" approach. Too thin for korea — we need schema + applier + presets, not just a git wrapper.

### 2.5 home-manager (Nix)

- **Model:** Single declarative file (`home.nix`). Manages not just dotfiles but program installations. Reproducible, atomic, rollback-able.
- **Loved for:** True reproducibility. Atomic `switch`. Rollback.
- **Hated for:** Nix the language. Learning curve. Error messages. Huge mental tax for the benefit. "Migrating from Nix/home-manager to Homebrew+chezmoi" is a common genre of blog post.
- **What we'd copy:** Atomic apply + previous-generation rollback. `korea rollback` should exist.
- **What we'd avoid:** Any DSL that requires learning a language. YAML/TOML is the ceiling.

### 2.6 GNU Stow

- **Model:** Symlink farm. One directory per "package," stow symlinks into `$HOME`.
- **Relevant because:** Simple, opinion-free. Mentioned because many "dotfiles" repos use it — but it doesn't fit korea (the device filesystem is ephemeral, often FAT32 with no symlink support, and we need to transform/merge not mirror).

### 2.7 Mackup

- **URL:** https://github.com/lra/mackup
- **Model:** Knows the settings-file location for ~150 apps. Moves them to Dropbox, symlinks back.
- **Loved for:** Zero-config for known apps. "It just works."
- **Hated for:** Stagnated, stopped getting new app support, symlinks break with some apps.
- **What we'd copy:** The idea of **known-path metadata**. korea should ship a registry of "this plugin stores config here" — mackup style. This becomes the moat that dotfile tools don't have.
- **What we'd avoid:** Symlinking into Dropbox. Not applicable — the device isn't always mounted.

### 2.8 Ansible for personal machines

- **Takeaway from community writing:** Works, but everyone says "too enterprise-y, too much YAML, too much boilerplate." Modules don't cover every app. Desktop/GUI app configuration is where Ansible falls down — exactly korea's territory.
- **Lesson for korea:** Don't let the YAML get Ansible-verbose. Minimal schema, strong defaults, presets do the heavy lifting.

---

## Part 3 — Design inspiration

### 3.1 Nix flakes (the cited analogy)

**Is the analogy sound?** Partially.

What korea takes from flakes that's genuinely useful:
- **Pinned, reproducible input:** a profile is a complete declarative description of a target state. Same input → same device. This is the core flake promise and it maps cleanly.
- **Share-by-reference:** flakes are fetched from URLs/git. korea wants the same (`korea init github:alice/my-kindle`).
- **Lockfile concept:** if a preset references plugin versions, a lockfile pinning SHAs is the flake-inspired move.

Where the analogy breaks down:
- Flakes are a build-system concept, operating on pure functions of inputs → outputs. korea operates on a stateful device whose current state is opaque and sometimes lies (KOReader rewrites settings.reader.lua on quit). Not pure. Not functional. We live in imperative land.
- Flakes have hermetic sandboxing. A user's KOReader install has no such thing.

**Beginner UX of flakes (brief):** Rough. Must enable experimental features. Every command requires git-tracked files. Documentation fragmented. Errors cryptic. Blog post "Flakes aren't real and cannot hurt you" exists as a coping-mechanism genre. The good idea buried under operational friction is what korea should extract; the friction is what korea should emphatically not replicate.

**Verdict on the analogy:** Use it as a pitch line ("declarative like Nix, without the Nix"). Don't use it as an implementation model. Chezmoi + Mackup's app-registry idea is a more honest template.

### 3.2 VSCode Settings Sync

- **Model:** Built-in, account-backed (GitHub/Microsoft), opaque storage. "Turn it on, it syncs." Zero config for the common case.
- **Relevant because:** The default UX is invisible and that's why it wins. Power users wanting git can use the community `Settings-Repository` extension.
- **What we'd copy:** Two tiers — "just share a gist URL" for 90% of users, "clone this git repo of profiles" for the rest.
- **What we'd avoid:** Opaque cloud storage. korea should be file-first, cloud-never.

### 3.3 JetBrains Settings Repository

- **Model:** Primary repo (read/write) + secondary repos (read-only). The secondary-repo concept is subtle and good.
- **What we'd copy:** **Layered profiles.** A user profile layered on top of a community preset, where the preset is read-only and updates can be pulled. This maps directly to korea's "preset + personal overrides" story.

### 3.4 Firefox Sync

- **Model:** End-to-end encrypted, key derived from passphrase, server never sees plaintext. Opt-in per data type (prefs, extensions, etc.).
- **Relevant for korea v2+:** If we ever offer a sync back-end, this is the bar: user-held keys, server-blind. v1 probably skips this entirely (gists/git are enough).

### 3.5 Ninite (named in vision.md)

- **Model:** Pick-boxes of apps → one installer bundle. Zero config, zero prompts.
- **Relevant for korea `init`:** The curated-preset bootstrap story. `korea init minimal` / `korea init simpleui-starter` should feel Ninite-fast.

---

## Part 4 — What's missing (the gap korea would fill)

Concretely, across everything above, here is what does not exist today:

1. **A shareable, human-readable artifact for a full KOReader setup.** Profiles (built-in) cover bottom-menu settings. Patch repos cover lua code. Syncthing covers raw files. Nothing covers "the thing I'd paste into a Reddit post": which plugins, their configs, SimpleUI layout, gestures, defaults — as one file.

2. **A host-side applier.** Every existing path requires the user to either (a) hand-copy files or (b) run a plugin inside KOReader itself. No desktop tool today says "plug in your device, run this, done" for settings. KoHighlights is the only thing in this shape, and its scope is highlights.

3. **Diff.** No tool today answers "what is different between my device and my profile?" Users compare by eye across nested menus on an e-ink screen.

4. **Presets as a primitive.** Patch repos (joshuacant, sebdelsol, qewer33) are the community's approximation: "apply my bundle on top of yours." They distribute code, not configuration. A first-class "preset" concept for *configuration* is absent.

5. **Schema awareness.** Raw-file sync (Syncthing, git) treats `settings.reader.lua` as an opaque blob and loses every time KOReader rewrites it. A tool that *understands the schema* — knows which keys are user intent vs derived state vs volatile — is required to avoid the issue #1612 footgun ("restored my settings.reader.lua, it got reset").

6. **Bootstrap for new users.** KindleForge installs apps; nothing installs *a configuration*. `korea init minimal` has no equivalent.

7. **Per-device-class adaptation.** A profile authored on Kobo should apply to Kindle with path/resolution awareness. Nothing does this today.

---

## Verdict

**There is a real gap. This is not reinventing.**

Evidence:

- Seven-year-old upstream feature request (#4780) still open. Five related open issues. Upstream's position is "copy files manually." A maintainer's custom script is the state of the art and it may be outdated.
- The closest existing community artifacts — `kurokeita/koreader-configs`, `vyleung/koreader-config`, Reddit setup posts — are unstructured dumps. They exist *because* there is no tool. They are demand, not supply.
- Patch-bundle repos (joshuacant, sebdelsol, qewer33) prove the community will adopt "apply a bundle on top of my install" if someone builds it. They've done it for code patches; no one has done it for configuration.
- Analog tools in adjacent ecosystems exist and are well-loved (NickelMenu for Kobo menus, chezmoi for dotfiles, home-manager for Nix). The pattern works where it exists. It does not exist for KOReader.

**Risks to the "real gap" framing:**

- KOReader upstream could ship a built-in export/import tomorrow and swallow most of the oxygen. Issue #11882 is specifically this. A plugin-level "Export profile to JSON" PR could deflate korea's core share story. Mitigation: korea's value compounds *beyond* export — presets, diff, host-side apply, device-class adaptation, a registry of plugin schemas. A JSON export in KOReader becomes an input to korea, not a competitor.
- "Users just use Syncthing" is a real counter-argument. For advanced users with identical device classes it works. For the target audience (r/koreader setup-sharers, new users, multi-device) it fails because of schema conflicts and zero abstraction.
- Community may tolerate the current pain. Seven years of open issues and no one building a tool is either (a) a gap no one has noticed, or (b) a gap that isn't painful enough to motivate building. This is the honest counter-argument and should be probed via the research plan (talk to people, don't assume).

**Net:** gap is real, counter-arguments are addressable, analogy to Nix is marketable but not an implementation guide — chezmoi + Mackup's app-registry + JetBrains' layered-profiles is the more honest design reference stack.

---

## Sources

KOReader-specific:
- https://github.com/koreader/koreader/issues/4780
- https://github.com/koreader/koreader/issues/6925
- https://github.com/koreader/koreader/issues/11882
- https://github.com/koreader/koreader/issues/11936
- https://github.com/koreader/koreader/issues/4951
- https://github.com/koreader/koreader/issues/1612
- https://github.com/koreader/koreader/discussions/8885
- https://github.com/koreader/koreader/discussions/10338
- https://github.com/koreader/koreader/discussions/13280
- https://github.com/koreader/koreader/discussions/13281
- https://github.com/koreader/koreader/wiki/Profiles
- https://github.com/kurokeita/koreader-configs
- https://github.com/vyleung/koreader-config
- https://github.com/koreader/koreader-sync-server
- https://github.com/arthurrump/syncthing.koplugin
- https://noembryo.github.io/KoHighlights/
- https://github.com/harmtemolder/koreader-calibre-plugin/issues/58
- https://github.com/doctorhetfield-cmd/simpleui.koplugin
- https://www.mobileread.com/forums/showthread.php?t=339387

E-reader / modding ecosystem:
- https://pgaskin.net/NickelMenu/
- https://github.com/pgaskin/NickelMenu
- https://github.com/nicoverbruggen/kobo-config
- https://kindlemodding.org/
- https://github.com/KindleModding/KindleForge

Dotfile / config tooling:
- https://www.chezmoi.io/
- https://www.chezmoi.io/comparison-table/
- https://github.com/lra/mackup
- https://www.joshmedeski.com/posts/moving-from-mackup-to-stow/
- https://htdocs.dev/posts/migrating-from-nix-and-home-manager-to-homebrew-and-chezmoi/
- https://dotfiles.github.io/utilities/

Nix flakes UX:
- https://discourse.nixos.org/t/nixos-and-flakes-for-beginners-sucks/62968
- https://jade.fyi/blog/flakes-arent-real/
- https://ianthehenry.com/posts/how-to-learn-nix/flakes/
- https://determinate.systems/blog/nix-flakes-explained/

GUI app settings sync:
- https://www.jetbrains.com/help/idea/sharing-your-ide-settings.html
- https://hacks.mozilla.org/2018/11/firefox-sync-privacy/
- https://github.com/KatsuteDev/Settings-Repository
