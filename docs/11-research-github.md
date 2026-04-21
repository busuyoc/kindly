# GitHub research — KOReader ecosystem

Research date: 2026-04-21. Scope: feature requests, pain points, recurring themes in GitHub issues / PRs across the KOReader ecosystem, to inform the `korea` project. Depth over breadth. Primary repo `koreader/koreader` (26.4k stars, 1,245 open issues, 1,681 forks — heavy traffic).

All issue references are to `koreader/koreader` unless otherwise noted.

---

## Q1. Feature requests about settings/config management (sync, export/import, profiles)

**Core theme: users repeatedly ask for a way to move/sync settings across devices; KOReader maintainers treat this as unsupported and dangerous.**

Key issues:

- **[#4780](https://github.com/koreader/koreader/issues/4780) — "[FR]: Sync all koreader settings from device to device"** (OPEN, 2019, still active in 2026, 5 👍). Opening user has KOReader on Kindle PW4, Android tablet, and Pixel phone; wants default margins, ignore publisher margins, status bar, fonts, dictionary, frontlight to travel. **Crucial quote from @NiLuJe (core maintainer, 2025):** *"Reminder that we do not guarantee cross device settings portability. In fact, we guarantee that this will break shit in fun and interesting ways ;)"* This is a standing position, not a one-off.
- **[#14920](https://github.com/koreader/koreader/issues/14920) — "FR: Ability to sync things like settings, highlights, and vocab builder words between devices"** (OPEN, 2026). Contributor @jonnyl2 confirms: *"Syncing settings is currently not possible unless you create your own script."* Points to #11882 and #13762 as the long-term plan.
- **[#11882](https://github.com/koreader/koreader/issues/11882) — "FR: simplify backups procedures"** (OPEN, 5 👍). Detailed user complaint: current backup guidance is buried in user guide troubleshooting, filenames differ across versions (`defaults.custom.lua`, `defaults.persistent.lua`), scary for non-devs. Explicit ask: one-click UI action producing a restorable zip. The framing is *backup/restore*, not declarative.
- **[#13762](https://github.com/koreader/koreader/pull/13762) — "KOReader settings: back up / restore"** — OPEN PR, not merged. Zip-file based backup. Excludes: SQLite DBs, fonts, dictionaries, user patches. This is the community's current best answer and it has been stuck.
- **[#13698](https://github.com/koreader/koreader/issues/13698) — "FR: `$HOME$` in directory defaults/folder shortcuts/profile path"** (OPEN). User with KOReader on multiple devices needs variable substitution for paths because Android SD volume IDs differ per device. Direct overlap with `korea`'s "profile applies to many devices" concept.
- **[#11155](https://github.com/koreader/koreader/issues/11155) — "Q: Any (more) caveats when migrating between systems?"** (CLOSED, 2023). User manually moved config Kindle↔Android; had to strip Android-specific keys (`android_ignore_volume_keys`, `android_screen_timeout`, `extra_plugin_paths`), rewrite all `/storage/emulated/0/` paths to `/mnt/us`. @NiLuJe response: *"While it's generally perfectly harmless to swap between devices from the same platform/port, the further away you move from the initial platform, the worse it gets. And, of course, Android takes the cake, so, you're still technically in 'here be dragons' territory."*
- **[#4951](https://github.com/koreader/koreader/issues/4951) — "[Discussion] Redesign config and metadata handling"** (CLOSED). Long architectural discussion from 2019 proposing TOML/SQLite. Notable @Frenzie (maintainer) quote: *"I find YAML pretty terrible as a format: human readable: eh, but human writable: nope."* and *"TOML looks much saner, though ;)."* Strongly prefer Lua-as-config over YAML from inside the project. Implications for `korea`'s surface format.
- **[#9265](https://github.com/koreader/koreader/issues/9265) — "FR: Centralized Sidecar directories"** (CLOSED, 4 👍). Asks for `.sdr` folders to live in one central config dir rather than beside each book — useful for backups.
- **[#10892](https://github.com/koreader/koreader/pull/10945) — "Hash-based metadata storage"** — MERGED. Metadata can optionally be keyed by file hash rather than path, mitigating (but not solving) the path-differs-per-device problem.

**Profile sub-theme** (KOReader already has a built-in "Profiles" plugin, scope = set of settings toggled by gesture):

- [#15166](https://github.com/koreader/koreader/issues/15166) — "FR: 'update' option for profiles." (OPEN)
- [#11002](https://github.com/koreader/koreader/issues/11002) — "FR: Update a profile with current document settings" (OPEN)
- [#8976](https://github.com/koreader/koreader/issues/8976) — "Not all settings in profile applied when switch the profile" (OPEN) — the current Profiles plugin cannot capture all settings, specifically margins/L/R/T/B don't apply.

**Takeaway:** strong, multi-year, recurring demand for cross-device settings sync. Core maintainers actively *decline* to guarantee it. An external tool that owns the portability story fills a gap the upstream project explicitly will not fill.

---

## Q2. Plugin management: too many defaults, can't disable easily, conflicts

- **[#15293](https://github.com/koreader/koreader/issues/15293) — "FR: sane plugin selection on 1st launch"** (OPEN, April 2026 — 1 day old at research time). Direct quote: *"People get a cluttered 1st impression of KO since everything is enabled. 70% of the plugins don't need to be enabled for every user on every 1st install."* Maintainer pushback (@Frenzie): a wizard or simple-vs-all split is acceptable. @poire-z (contributor) proposes adding `default_disabled = true` to plugin `_meta.lua` files. Community contributor @mergen3107: *"Most frequently asked question 'What is this?' is the Perception expander plugin :D"*. This is a direct acknowledgement from the core team that the default plugin surface is a UX problem.
- **[#15242](https://github.com/koreader/koreader/issues/15242) — "FR: Separate list for external plugins"** (OPEN). Hard to tell built-in from community plugins in the plugin manager; debugging advice ("disable external plugins") is hard to act on.
- **[#9638](https://github.com/koreader/koreader/issues/9638) — "[RFC] Main menu 'Tools' and 'More tools'"** (OPEN). Proposal to collapse the split menu; user friction enabling/placing plugins.
- **[#7745](https://github.com/koreader/koreader/issues/7745) — "Cannot move plugins from 'More tools' menu to 'Tools'"** (OPEN). User hand-edits `settings/reader_menu_order.lua` to rearrange, doesn't work cleanly.
- **[#12647](https://github.com/koreader/koreader/issues/12647) — "RFC: make tools menu stackable"** (OPEN)
- **[#12770](https://github.com/koreader/koreader/issues/12770) — "[Plugin Manager] 'Enabled' Plugins in settings file are not checked on KOReader init"** (CLOSED). If you copy `settings.reader.lua` to a device that lacks the hardware (e.g., no frontlight), disabled-plugin entries for missing features persist and show up in UI. Direct consequence of cross-device settings copying.
- **[#14758](https://github.com/koreader/koreader/issues/14758) — "Add third option for menu activate or allow disable of defaults"** (CLOSED)
- **[#15150](https://github.com/koreader/koreader/pull/15150) — "Cloud storage+"**, **[PR #15096](https://github.com/koreader/koreader/pull/15096) — "PluginLoader: use directory name for enabled/disabled, deprecate metadata name"** — OPEN. Active schema change: enable/disable keying moves from plugin's internal name to directory name. This is a live breaking change for the `plugins_disabled` keys in `settings.reader.lua`. Cross-plugin identity conflict discussed: the ProjectTitle plugin impersonates the built-in `coverbrowser` directory because core KOReader hard-codes `ui.coverbrowser` lookups. Plugins collide on name.
- **Prior art: [JoeBumm/Koreader-Menu-customizer](https://github.com/JoeBumm/Koreader-Menu-customizer)** — "Hide menus. Hide plugins. Focus on reading." 88 stars. In-device UI tool, not a desktop config tool. Confirms the pain point has a real audience.
- **[omer-faruq/appstore.koplugin](https://github.com/omer-faruq/appstore.koplugin)** — 202 stars. Discover/install/update community plugins inside KOReader. Overlaps with `korea`'s install story but is interactive/on-device.

**Takeaway:** plugin bloat / defaults curation is an acknowledged pain. There is currently no way to express plugin selection as data that travels with a setup. The internal enabled-list format is also mid-migration (#15096), which is a risk for any tool.

---

## Q3. Stability of `settings.reader.lua` — format, breaking changes, renames

**Format:** `settings.reader.lua` is a Lua file that `return`s a table; it is read by `pcall(dofile, path)` and written via `dump(self.data, nil, true)` from `frontend/luasettings.lua` (lines 21–48, 270–280). That is:
- Reading = full Lua execution. Arbitrary code could run; in practice tables only.
- Writing = `dump()` (pretty Lua-literal serializer from `frontend/dump.lua`).
- There is a `.old` fallback: on flush, the previous file is renamed to `settings.reader.lua.old` if older than 60 s — native crash-safety.
- Plugin enablement: `plugins_disabled = {[name]=true, ...}` (see `frontend/pluginloader.lua` lines 133–174).
- `extra_plugin_paths` = string or list of strings, extra plugin search roots.

**Stability:** not guaranteed, but changes are mostly additive. Core confirms portability is "here be dragons" (#11155, #4780 above). Known recent / ongoing schema churn:

- **[PR #15096](https://github.com/koreader/koreader/pull/15096)** (2026-03, open) — `plugins_disabled` keys: shift from plugin metadata `name` to directory name. Example: ProjectTitle uses directory `coverbrowser/` and metadata name `coverbrowser` today; future work may decouple them. Any tool that writes `plugins_disabled` must track which key scheme applies to the target version.
- **[PR #10149](https://github.com/koreader/koreader/pull/10149) — "DocSettings: fix and migration"** (MERGED 2023). Shows that schema migrations do land occasionally; `DocSettings` was refactored with explicit migration code.
- **[PR #10945](https://github.com/koreader/koreader/pull/10945) — "hash-based metadata storage"** (MERGED). Added new metadata identity mode alongside path-based.
- **[PR #9546](https://github.com/koreader/koreader/pull/9546) — "Misc: Get rid of the legacy defaults.lua globals"** (MERGED). `defaults.lua` semantics changed; older configs might reference removed globals.
- **[PR #13774](https://github.com/koreader/koreader/pull/13774) — "[Presets] add new presets.lua module and dictionary presets"** (MERGED 2025-06). Introduced a new generic `Presets` module in `frontend/ui/presets.lua` intended to be reused across modules (footer, dictionary, more). This is KOReader's own internal "presets" concept, distinct from top-level config.
- **[PR #13689](https://github.com/koreader/koreader/pull/13689)** — status bar presets (MERGED). Same trend.
- **[#15071](https://github.com/koreader/koreader/issues/15071) — "How to persist settings on patches/plugins?"** (CLOSED). User reports `LuaSettings` not flushing for non-main setting files; exposes that the flush/close lifecycle is finicky for third-party usage.

**Renames observed / potential landmines:** no systematic rename table is published. Example hazards surfaced in #11155: `android_ignore_volume_keys`, `android_screen_timeout`, `extra_plugin_paths` (must strip Android paths), device-specific keys that silently have no UI on another platform.

**Takeaway:** format is simple and stable enough for text-manipulation (Lua table literal → parse / regenerate), but semantic stability of keys is weaker. The hidden set of state files is larger than `settings.reader.lua`: also `settings/gestures.lua`, `defaults.custom.lua`, `defaults.persistent.lua`, `directory_defaults.lua`, `reader_menu_order.lua`, `.sdr` sidecars per book, SQLite DBs for stats/vocab, patches in `patches/`, fonts/dictionaries as blob trees.

---

## Q4. What does the community ask of SimpleUI that isn't shipped

Issues in `doctorhetfield-cmd/simpleui.koplugin` (624 stars, 43 open issues):

- [#257](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/257) Folder covers in list view
- [#255](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/255) QuickRSS + Anna's Archive as navbar options
- [#254](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/254) Same options in "To be Read" as in "Recent Books"
- [#253/#252](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/252) Rounded covers that survive non-white backgrounds
- [#249](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/249) Pull icons from `.adds/Koreader/Icons`
- [#246](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/246) Flat library view
- [#239](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/239) Filter by author/series/calibre tags within a folder
- [#234](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/234) Background patch
- [#231/#230](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/231) Series index overlay / back button in virtual series folders
- [#216](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/216) Custom icons displaying blank
- [#215](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/215) Resizable homescreen modules

**No issue found** in SimpleUI asking for preset/share/export/config sync. Search queries `preset`, `share`, `backup`, `config`, `export` returned empty. Plenty of **icon/layout/background customization** requests — the "artifacts" of a SimpleUI setup (icons, backgrounds, custom images) are deeply personal and not just settings. A `korea` preset for SimpleUI would need to include these asset blobs or reference them.

**Takeaway:** the SimpleUI community asks for *more knobs*, not for ways to share knobs. The sharing gap is latent, not voiced. There is significant non-settings state (icons, cover packs, custom backgrounds) tied up in a SimpleUI "look".

---

## Q5. Any existing config/profile tools?

Targeted repo search yielded:

- **[kurokeita/koreader-configs](https://github.com/kurokeita/koreader-configs)** — 0 stars, no README, last push 2026-04-08. Personal dotfiles.
- **[vyleung/koreader-config](https://github.com/vyleung/koreader-config)** — 1 star. README: *"My configurations for Koreader on my Kindle (currently using the Kindle Voyage)"*. Personal dotfiles.
- **[JoeBumm/Koreader-Menu-customizer](https://github.com/JoeBumm/Koreader-Menu-customizer)** — 88 stars. On-device UI only, hides menus/plugins. Not a declarative config tool.
- **[omer-faruq/appstore.koplugin](https://github.com/omer-faruq/appstore.koplugin)** — 202 stars. On-device plugin installer/updater driven by GitHub topic search (`koreader-plugin`, `koreader-user-patch`). Closest thing to a plugin-manager-as-a-plugin.
- Sync servers abound (kosync variants: 10+ repos) but they sync *reading progress*, not settings.
- Cross-device highlight sync plugins exist (`highlightsync.koplugin`, `AnnotationSync.koplugin`) — 159/69 stars — solve a narrow slice.

**No tool exists that:**
1. Runs on the desktop
2. Reads a declarative profile (YAML/TOML)
3. Materializes `settings.reader.lua`, `plugins_disabled`, plugin configs, SimpleUI assets onto a mounted device
4. Supports pull/diff/share

**Takeaway:** the space is empty. Personal dotfile repos show latent demand; the sync-server ecosystem shows willingness-to-self-host among power users.

---

## Q6. Do upgrades break custom setups?

**Common, but usually not catastrophic.** Sample:

- [#15268](https://github.com/koreader/koreader/issues/15268) "Koreader dont work after update" (CLOSED)
- [#15156](https://github.com/koreader/koreader/issues/15156) "On PocketBook Era crashes at startup after double update" (CLOSED)
- [#15164](https://github.com/koreader/koreader/issues/15164) "Stylus/touch pen stopped working after upgrading to v2026.03" (OPEN)
- [#14524](https://github.com/koreader/koreader/issues/14524) "Updating from 2025-04 to nightly causes a startup crash" (CLOSED)
- [#12167](https://github.com/koreader/koreader/issues/12167) "Crash opening almost any EPUB after July update" (CLOSED)
- [#11318](https://github.com/koreader/koreader/issues/11318) "The statistics of old read books have been reset" (OPEN) — silent data loss across upgrade
- [#14740](https://github.com/koreader/koreader/issues/14740) "FR: Add a --safe-mode on KOReader crash" (OPEN) — implies setup-related breakage is frequent enough to warrant a fallback boot mode
- [#15054](https://github.com/koreader/koreader/issues/15054) "How to debug instability caused by patches" (CLOSED) — user-patch fragility is a recurring theme, exacerbated by KOReader refactors
- [#14797](https://github.com/koreader/koreader/issues/14797) "FR: reset settings to 'factory defaults'" (OPEN). Quote: *"the menu item for (alternate and) status bar settings has vanished on my InkPadX Pocketbook device. Re-installation/update of Koreader didn't help."*

**Pattern:** most "upgrade broke X" issues are platform/firmware-specific (Pocketbook FW updates, Kobo hardware drivers), not pure config-schema regressions. Config-schema regressions do occur but are usually caught by maintainers. User-patches break far more often than settings do — patches target internal Lua APIs that move freely (see the [sebdelsol self-updating patch mechanism](https://github.com/sebdelsol/KOReader.patches) noted in awesome-koreader as a workaround).

**Takeaway:** upgrades break setups often enough that `korea diff`-after-upgrade and `korea apply` for easy recovery have clear value. Patches in particular need a re-application story.

---

## Q7. Device support by issue volume (title mentions)

`gh api search/issues q=repo:koreader/koreader+<device>+in:title`:

| Device      | Issues |
|-------------|--------|
| Android     | 681    |
| Kobo        | 611    |
| Kindle      | 491    |
| Pocketbook  | 315    |
| reMarkable  | 104    |
| Boox        | 58     |

Caveats:
- "Android" overlaps with Boox/Meebook/Onyx/Mobiscribe — many Boox users file under Android.
- These are title mentions only; bodies would shift numbers.
- Kobo is overrepresented in the maintainer-base; Frenzie/NiLuJe work heavily on Kobo.

**Takeaway:** for `korea apply --device`, the priority mount handling is Kobo (single FAT volume, `/mnt/onboard/.adds/koreader/` on devices with KOReader installed), Kindle (`/mnt/us/koreader/`), then Android (path chaos: `/storage/emulated/0/koreader/` vs SD card UUIDs vs scoped storage). reMarkable and Boox are long-tail. Android is the highest-risk target for path portability (see #11155, #13698).

---

## Q8. Built-in vs community plugins

**Built-in (shipped with KOReader, from `/tmp/koreader-src/plugins/`):**

archiveviewer, autodim, autostandby, autosuspend, autoturn, autowarmth, batterystat, bookshortcuts, calibre, cloudstorage, coverbrowser, coverimage, docsettingtweak, exporter, externalkeyboard, gestures, hello, hotkeys, httpinspector, japanese, keepalive, kosync, movetoarchive, newsdownloader, opds, perceptionexpander, profiles, qrclipboard, readtimer, SSH, statistics, systemstat, terminal, texteditor, timesync, vocabbuilder, wallabag.

= **37 built-in plugins**. Note: beeminder and wallabag are documented in awesome-koreader as built-in; beeminder not in current `master/plugins/` tree so may be removed.

**Community plugins in `koreader/contrib`** (submodules in `.gitmodules`, 45+ entries) — partial list:

weather, crossword, dictionarymode, pocketbooksync, gemini, crashlog, hardcoverapp, provider-webdav-highlights, digitalclock, filebrowser, readingruler, kochess, review, airplanemode, copytoxochitl, AnnotationSync, assistant, comicreader, comicmeta, wordreference, zzz-readermenuredesign, webbrowser, filebrowserplus, rssreader, screenlockpin, memobook, stopwatchtimer, clock, sudoku, wordsearch, tbrplanner, nonogram, ankiviewer, appstore, solitaire, readingstreak, koassistant, localsend, sleeplogger, homeassistant, highlightsync, maximum, notificationlistener, phrasedeck, applauncher, instapaper, kagi-news, HighlightImport, quickrss, webdavfetcher, incognito, simpleui, customisablesleepscreen, filesync, bookends, appearance, shortcutstoolbar, game2048, fastdictlookup.

**Fully external** (not in contrib, listed in awesome-koreader):

ProjectTitle (high stars — "High" per awesome list), simpleui (624★), assistant.koplugin (442★), zlibrary.koplugin [ZlibraryKO] (320★), zlibrary.koplugin [OctoNezd] (193★), appstore.koplugin (202★), rakuyomi (221★), anki.koplugin (179★), legado.koplugin (166★), highlightsync.koplugin (159★), zotero.koplugin (130★), localsend.koplugin (104★), kobo.koplugin (79★), readeck.koplugin (63★), miniflux.koplugin (63★), comicreader.koplugin (60★), koassistant.koplugin (59★), opds_plus.koplugin (57★), webbrowser.koplugin (58★), hardcoverapp, homeassistant, readingruler, weather, sleeplogger, appearance, shortcutstoolbar, many others.

User patches live in `koreader/patches/<N>-name.lua`, curated collections: SeriousHornet, sebdelsol, joshuacant, loeffner, jmanteau, advokatb, omer-faruq, zenixlabs.

**Takeaway:** ~37 built-ins, ~60 in contrib, and a long tail of 100+ external plugins. For `korea`, a curated plugin catalog is a meaningful deliverable — even a simple "which of these 37 built-ins should a new user disable" opinion would address #15293.

---

## Signals — ranked by frequency of mention / acknowledged pain

1. **Cross-device settings portability is a recurring ask but an upstream non-goal.** Repeated issues over 6+ years (#4780, #11155, #13698, #14920), explicit maintainer stance ("we guarantee this will break shit"). External tool ownership of this problem is uncontested.
2. **Backup/restore is the closest upstream equivalent and it's stuck.** PR #13762 open and not merged; FR #11882 open. Users want one-click; maintainers are wary.
3. **Default plugin selection is too noisy, but nobody agrees on how to fix it.** #15293, #15242, #9638, #7745, #12647. Actively debated in April 2026. Plugin identity itself is mid-refactor (#15096).
4. **`settings.reader.lua` is a simple Lua-literal table with `.old` fallback** — textually parseable and editable; no need for a Lua interpreter for read-only operation. Plain-text round-trip via an existing Lua-literal parser is viable.
5. **Multi-device ownership is real and under-served.** Users explicitly call out having 2+ devices (Kindle + Boox + Phone: #4780; 4+ Android devices with SD UUIDs: #13698; Kobo + Boox migration: #11155).
6. **Path portability is the hidden difficulty.** Per-device SD UUIDs, Android `/storage/emulated/0/` vs Kindle `/mnt/us/` vs Kobo `/mnt/onboard/` — users patch config by hand. `$HOME$` substitution is formally requested in #13698.
7. **KOReader's built-in "Profiles" feature is limited.** Doesn't capture all settings (#8976), updating profiles is manual (#11002, #15166). Not a replacement for a generalized profile tool; leaves room.
8. **Icons/assets/backgrounds matter for SimpleUI and ProjectTitle setups.** Community asks a lot about cover packs, icons, custom backgrounds — these are blob state, not key-value config.
9. **User patches break on upgrades far more often than settings do.** Active workarounds (sebdelsol's self-updating patch mechanism) show appetite for a patch-update story.
10. **Android is the worst portability target.** Core maintainer labels it "here be dragons." If `korea` starts with Kobo+Kindle and treats Android as tier-2, that matches the reality.
11. **Community infrastructure is a plugin-ecosystem (GitHub topic `koreader-plugin`), not a config-ecosystem.** Appstore plugin (202★) resolves install; nobody resolves "a complete setup."
12. **Format debate: TOML > YAML among KOReader maintainers** (#4951, Frenzie). If `korea` ever submits upstream hints or integrates with KOReader devs, TOML will land better than YAML. Note this contradicts `korea/README.md`'s current YAML framing — worth reconsidering.
13. **KOSync ecosystem is crowded.** 10+ sync-server forks show willingness to run infra, but nobody sync'es settings — only position/highlights/stats.
14. **Plugin identity is currently in flux.** PR #15096 changes how `plugins_disabled` is keyed. A `korea` tool writing that map needs version-aware logic or it will mis-disable plugins after KOReader upgrades.

## Gaps / unanswered

- **GitHub Discussions** have a URL but `gh api repos/koreader/koreader/discussions` returns raw JSON paginated heavily; I didn't mine them fully. They may contain more setup-sharing conversations than issues do (issues skew bug-ish). Worth a dedicated pass.
- **MobileRead forums** not covered — historically where old KOReader setup lore lives. Out of scope for this GitHub-only research.
- **Download/adoption numbers** — KOReader doesn't publish them; proxies are stars (26.4k), SimpleUI stars (624), ProjectTitle star count not queried.
- **Actual Reddit setup-share frequency** — not in scope (this doc is GitHub-only; see `docs/05-research-plan.md` for the wider plan).

## Code references (KOReader `master` @ 2026-04-21 shallow clone)

- Settings serialization: `/tmp/koreader-src/frontend/luasettings.lua` (open at L21, flush at L270).
- Plugin loading / `plugins_disabled`: `/tmp/koreader-src/frontend/pluginloader.lua` (L133–L174 read, L285–L319 save).
- Built-in plugin tree: `/tmp/koreader-src/plugins/*.koplugin/`.
- Dump function (Lua-literal serializer): `frontend/dump.lua` (not read; referenced from `luasettings.lua`).
- New Presets module (internal, not the same as a profile tool): `frontend/ui/presets.lua` introduced in PR #13774.
