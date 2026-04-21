# Research: r/koreader & KOReader community pain points

**Scope note / methodology caveat (read first).**

The research plan called for scraping r/koreader directly. All Reddit surfaces —
`www.reddit.com`, `old.reddit.com`, `redditmedia.com`, and the redlib / libreddit /
safereddit mirrors — were blocked (HTTP 403, ECONNREFUSED, or outright tool
refusal) at the time of this research. Google / Bing / DuckDuckGo site: queries
against reddit returned effectively nothing (anti-bot pages or empty results).
As a result, this report pivots to the *substantive* venues where the same
audience discusses the same problems in long-form:

- KOReader GitHub **issues**, **discussions**, and **PRs**
- **MobileRead forums** (oldest, densest KOReader community)
- **eReadersForum** (newer, more beginner-oriented)
- **GitHub repos** (SimpleUI, ProjectTitle, user-patch collections, awesome-koreader)
- Community **blogs** (thedarnedestthing, KemoNine, svartling)

The Reddit-specific questions (volume of "how do I set up X" posts, format of
"here's my setup" posts, upvote counts) are therefore answered partially or
marked unavailable. The *pain-point* questions are answered well, because the
same users who post on r/koreader open GitHub issues about those same pains,
often with more detail.

Quotes are verbatim unless marked `[paraphrase]`.

---

## Q1. What's the #1 complaint about configuring KOReader?

**Answer: menu depth + breadth. KOReader is not hard, it is *vast*, and the
settings are spread across 4–5 levels of nested menus that most new users give
up trying to memorize.**

Primary evidence:

- thedarnedestthing blog, "grokking koreader": KOReader's menus are
  > "laid out logically enough — just overwhelming in its granularity" … "logical
  > but initially confusing until one is familiar"

  and more colorfully, the menus have

  > "more buttons than a spaceship cockpit."

  The author spent "a day to grok KOReader — to become familiar with the nested
  organization of menus" before they could set sensible global defaults.
  <http://thedarnedestthing.com/grokking%20koreader>

- **Menu-customizer plugin exists specifically to solve this**, tagline "Where
  did all the buttons go?" — 88 stars on GitHub, 4 releases, active as of March
  2026. The README opens with the problem statement of menu bloat.
  <https://github.com/JoeBumm/Koreader-Menu-customizer>

- KOReader issue #2564 ("Reordering menu feature or full personalised menus")
  proposes Simple / Advanced / Personalized modes explicitly because the
  current menu is too deep. Verbatim:

  > "In my personalised mode I would remove all the Language menu entries
  > except Spanish and English"

  Still open, labeled UX enhancement.
  <https://github.com/koreader/koreader/issues/2564>

- KOReader issue #9638 ("[RFC] Main menu 'Tools' and 'More tools'") — the
  maintainers themselves acknowledge the structure is confusing enough to
  warrant an RFC and explicitly weigh the tradeoff:
  > "Disables user's sorting order of the plugins"
  <https://github.com/koreader/koreader/issues/9638>

- Secondary theme inside the #1 complaint: **documentation discoverability**.
  igorsantos07 in issue #11882:
  > "The actual backup procedure is listed under an anchor-less answer on the
  > troubleshooting section, impossible to find unless you use text search."

  > "makes it feel like an incomplete piece of software, instead of a mature
  > and safe-to-use one."

  <https://github.com/koreader/koreader/issues/11882>

Runner-up complaint: **defaults are bad for the device you're on.** PR #12766
(merged 2024-11) had to explicitly disable Autodim / Autofrontlight / Autowarmth
on devices without a frontlight — and even after the PR, they still showed up
in plugin lists when `settings.reader.lua` was copied from another device
("settings being cached from previous devices rather than re-evaluated").
<https://github.com/koreader/koreader/pull/12766>

---

## Q2. How often do "how do I set up X" questions appear? Which X's recur?

Because Reddit is inaccessible, a frequency count on r/koreader is not
possible. However, using MobileRead + eReadersForum + KOReader Discussions as a
proxy, the following `X`'s recur across multiple threads:

- **Cloud storage / Calibre sync** (Dropbox, FTP, WebDAV, OneDrive, Calibre
  OPDS) — every beginner thread asks how to wire their library.
  <https://github.com/koreader/koreader/discussions/9189>
- **Sync reading progress across devices** (Kindle ↔ Kobo ↔ phone ↔ desktop).
  Multi-device sync is by far the most-requested feature.
  <https://github.com/koreader/koreader/discussions/9189>,
  <https://www.mobileread.com/forums/showthread.php?t=363975>
- **Night mode behavior** (invert images y/n, persistence, per-book override).
  nikosan on MobileRead:
  > "is it possible to turn on Night Mode but NOT invert the images?"
  > "Is there a way to have KOReader remember the brightness/warmth settings
  > used in Night Mode?"
  <https://www.mobileread.com/forums/showthread.php?t=346565>
- **Mosaic view customization** — how many thumbnails, custom folder covers,
  what are the little corner icons.
  <https://www.mobileread.com/forums/showthread.php?t=346565>
- **How to install SimpleUI / Project:Title** (see Q5).
- **How to set global defaults** — people struggle to understand long-press vs
  per-document settings, and the `defaults.lua` vs `defaults.custom.lua` vs
  `defaults.persistent.lua` distinction is consistently confused.
  <https://github.com/koreader/koreader/wiki/Change-defaults>
- **Gestures** — the system has 200+ actions and everyone wants to customize,
  but creating them is "cumbersome, and, if complex, difficult to replicate."
  <https://github.com/koreader/koreader/issues/8590>

**Reddit-specific frequency: not measurable from accessible data.**

---

## Q3. Which plugins do people most often want to disable by default?

Direct evidence from the codebase and community:

- **Explicitly disabled by KOReader itself** on non-frontlight devices
  (PR #12766, merged): `autodim`, `autofrontlight`, `autowarmth`.
- **Community-flagged as noise** (MobileRead thread "Disabling Wallabag and
  Other Plugins Through Code"): the canonical snippet people share is
  ```
  ["plugins_disabled"] = {
    ["zsync"] = true,
    ["evernote"] = true,
    ["calibrecompanion"] = true,
  }
  ```
  i.e. `zsync`, `evernote`, `calibrecompanion` surface most often as "I never
  use this and it clutters menus."
  <https://www.mobileread.com/forums/showthread.php?t=359838>
- **`BackgroundRunner`** is flagged in search results as wasteful on most
  devices: "on all other devices it wakes KOReader from its waiting state every
  2 seconds."
- **KemoNine's public config** (a "here's my template" blog post) explicitly
  says "most of the plugins and fancy features turned off" — i.e. the
  minimalist default for power users is to disable almost everything except
  their three or four essentials.
  <https://blog.kemonine.info/blog/2026-03-07-koreader/>

Confidence: medium-high for `zsync`, `evernote`, `calibrecompanion`,
`autofrontlight/dim/warmth`, `backgroundrunner`. Without r/koreader sampling,
the ranking beyond this is uncertain.

---

## Q4. Which plugins do people most often install post-factory-reset?

Sources: awesome-koreader (ruiribeiro04), kindlemodshelf.me, KemoNine's
template, svartling blog, community plugin star counts.

Community favorites with meaningful adoption signal:

- **ProjectTitle** (UI) — 880 ⭐, v3.7 March 2026. The dominant cover-browser
  replacement. <https://github.com/joshuacant/ProjectTitle>
- **SimpleUI** (UI) — 624 ⭐, 39 open issues, MIT. The newer challenger to
  ProjectTitle; adds home screen, bottom nav, top status bar, desktop widgets.
  <https://github.com/doctorhetfield-cmd/simpleui.koplugin>
- **Assistant.koplugin** (AI chat while reading) — 271 ⭐, listed as top of the
  "AI & Assistants" category in awesome-koreader.
- **KoInsight** (self-hosted sync/stats server) — 266 ⭐.
- **AppStore.koplugin** — 202 ⭐. Significant because its *existence* is
  evidence of the pain point: community built a way to "discover, install, and
  update community-created KOReader plugins … without leaving your device."
  <https://github.com/omer-faruq/appstore.koplugin>
- **Z-Library clients** — two forks at 157 ⭐ and 152 ⭐. Clear demand.
- **Anna's Archive plugin** (annas.koplugin) — exists in at least 5 forks,
  directly inspired by the Z-Library plugin; issue #12597 asks for it in core.
- **Anki plugin** — 143 ⭐, Anki card gen from dictionary lookups.
- **koreader-syncthing** — the sync workaround the maintainers explicitly
  decline to ship but tacitly endorse via third-party.
  <https://github.com/jasonchoimtt/koreader-syncthing>
- **Readest plugin** — repeatedly surfaces in eReadersForum tutorials as the
  cross-device sync solution of the moment.
- **Wallabag.koplugin** — built-in, heavily referenced by read-it-later users.

Curated categories in awesome-koreader suggest the long tail: Book Discovery
(6), Reading Services (5), Sync & File Management (7), Highlights (3),
Dictionary (6), UI (5), Comics (3), RSS / Read-It-Later (5), Utilities (17).
<https://github.com/ruiribeiro04/awesome-koreader>

---

## Q5. How much pain is the ProjectTitle → SimpleUI migration causing?

**No direct Reddit migration data**, but indirect signal is strong that this
*is* a live pain vector:

- Both plugins exist in parallel. **ProjectTitle has not been deprecated** (no
  migration notice, still active, v3.7 March 2026, 880 ⭐).
- SimpleUI is growing fast (624 ⭐) and explicitly positions itself as a more
  ambitious redesign (home screen, bottom bar, widgets) — eReadersForum
  review says it:
  > "adds a genuinely approachable layer on top of KOReader's functionality,
  > and it makes KOReader feel like something you'd actually want to use
  > rather than something you tolerate for its features."
  <https://www.ereadersforum.com/threads/koreader-with-the-simple-ui-plugin-is-the-setup-overhead-worth-it-for-kindle-owners.12860/>
- ProjectTitle itself is described (somewhere in the same ecosystem) as
  > "most of what Project:Title has done is described as just a new coat of
  > paint, so if you don't like the color then that's a good reason to give
  > Project:Title a pass."
- **Fragility is the real pain.** Issue #13942 ("Stable Plugin API to Reduce UI
  Component Replacement Dependencies") documents exactly the architectural
  problem that makes migration painful:
  > "To change the title bar, you must pull in the function that creates the
  > title bar. To change the book display, you must pull in the function that
  > creates the file browser, which is used everywhere."

  Summary of pain:
  > "UI plugins become incompatible within single version cycles" … "high
  > maintenance cost" … "no abstraction layer."
  <https://github.com/koreader/koreader/issues/13942>
- Concrete breakage: SimpleUI issue #135 — SimpleUI v1.2.5 + KOReader 2026.03
  + `filemanager-titlebar` user patch = crash.
  <https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/135>
- Concrete breakage: ProjectTitle issue #89 on Kindle PW5, 5.18.3,
  KOReader 2025.08 — "KOReader crashes when launched, forcing the device to
  shut down and return to the original UI," initially worked during setup then
  started crashing.
  <https://github.com/joshuacant/ProjectTitle/issues/89>

**So: the pain isn't a clean migration narrative ("I switched and lost X"),
it's ongoing version-skew thrash — every KOReader release risks breaking
whichever UI plugin you adopted.** Users pick one and accept that they re-fix
their setup a few times a year.

---

## Q6. Factory reset / new device stories — how painful is re-setup? Horror stories?

Yes, concrete horror stories exist:

- **Issue #5562** — Kobo Clara HD, updated to v2019.10, cold reboot:
  > "after full reboot, I had to go again everywhere and set margins, taps,
  > font, status bar configuration, style tweaks — everything!"

  The user had maintained these preferences "for over a year."
  <https://github.com/koreader/koreader/issues/5562>

- **Issue #5577** — Kindle Paperwhite, force power-off during app freeze:
  > "all my cool settings / logins (evernote, progress sync) etc seem to have
  > evaporated."

  The user asked point-blank whether they should be backing up the settings
  folder regularly.
  <https://github.com/koreader/koreader/issues/5577>

- **Issue #13875** (May 2025) — "the koreader folder got deleted from my
  phone, perhaps because of using the system cleaner." Triggered an FR for a
  dedicated backup feature + moving Android app data off external storage.
  <https://github.com/koreader/koreader/issues/13875>

- **Issue #11882** (May 2024) — "I found no way on the UI to create a backup
  for a clean reinstall" … "The backup/restore procedure should be a one-click
  action" … "files to back up may change between versions, and there's no way
  to link the online user guide to the version I'm running."
  <https://github.com/koreader/koreader/issues/11882>

- **Issue #13035** — Kindle 11th gen (2024) factory reset → KOReader fails to
  start with framebuffer init error. The re-setup isn't just tedious, on some
  devices it's *broken*.
  <https://github.com/koreader/koreader/issues/13035>

- **Issue #1612** (closed) — user tried to copy and restore `settings.reader.lua`
  manually:
  > "when I start koreader always delete the restored file and create a new
  > one"

  Core backup/restore story: backup is folklore, not a supported path.
  <https://github.com/koreader/koreader/issues/1612>

- **r/koreader post (only accessible post, via DuckDuckGo snippet):**
  > "After attempting every suggestion I could find in every forum, Google,
  > and AI search; I elected to wipe my library (not factory reset for a third
  > time)..."

  (Book-visibility troubleshooting on Kobo, 2025-04-07.) The aside "(not
  factory reset for a third time)" is telling — users have tried factory reset
  multiple times and still lost books.
  <https://www.redditmedia.com/r/koreader/comments/1jsg7i2/>

- MobileRead: "Koreader crashed, I deleted and reinstalled, it's set up
  exactly as I had it. How?" — this thread is effectively a *survival story*
  where a user was shocked to discover settings survived a reinstall (because
  they happened to be on a device that preserves them), implying that the
  baseline expectation is total loss.

**Emotional register: frustration, disbelief, resignation.** The dominant
coping mechanism is to manually `cp -r` the `koreader` folder before any
firmware or major update. No one is happy about this.

---

## Q7. How common are "here's my setup" posts, and what format?

**r/koreader frequency: not measurable.** But evidence of the shape of
setup-sharing in the broader community:

- **Prose + screenshot + sometimes a patch snippet** is the canonical format.
  Example: Stefan Svartling's "How to Install and Use Project: Title" (blog
  post, Jan 2026) — a long prose walkthrough with screenshots of *his* chosen
  fonts and layout. Users follow it manually.
  <https://www.svartling.net/2026/01/how-to-install-and-use-projecttitle.html>

- **Zip-file-of-the-whole-config** is rare but exists. KemoNine published a
  full template:
  > "use this config as a starting point for your own KOReader config"

  — shipped as a downloadable zip. This is the closest thing to a "dotfiles
  repo" for KOReader in public.
  <https://blog.kemonine.info/blog/2026-03-07-koreader/>

- **GitHub user-patch repos** are common — at least seven public ones found:
  - joshuacant/KOReader.patches (139 ⭐, 17 forks)
  - sebdelsol/KOReader.patches ("A collection of … patches that all work well
    together" — note the word *together*, which hints at the composition
    problem)
  - loeffner/KOReader.patches
  - zenixlabs/koreader-frankenpatches-public (the word "frankenpatches" is
    diagnostic)
  - omer-faruq/koreader-user-patches
  - advokatb/KOReader-Patches
  - ImSoRight/KOReader.patches

  These are *code* repos, not config repos. They patch KOReader's Lua
  internals; they don't declare settings. There's a gap here.

- **Screenshots on eReadersForum / MobileRead tips threads** — users post a
  photo of their reader + paragraph of what they changed. Not reproducible,
  requires manual replication.

- **The "darnedest thing" blog** explicitly documents the author's own
  settings "as a record for rebuilding this custom configuration should it be
  necessary" — literally, a blog post as personal backup because no better
  tool exists. <http://thedarnedestthing.com/koreader%20settings>

**Takeaway:** the community clearly *wants* to share setups and does so in
prose. There is no standard serialized format. The closest analogue to a
shareable config is KemoNine's raw-zip approach, which is brittle (whole
folder, includes device-specific paths, breaks on KOReader version change).

---

## Q8. Do people reference each other's setups? Any dotfile-like repos?

- **AppStore.koplugin (202 ⭐)** is the closest thing to a referential network —
  it auto-discovers GitHub repos tagged `koreader-plugin` or
  `koreader-user-patch`, i.e. there is a nascent decentralized "registry"
  already. Proves the community already thinks in terms of shared/named units.
  <https://github.com/omer-faruq/appstore.koplugin>
- **User-patch repos reference each other** — joshuacant's patches "require
  Project: Title"; loeffner's repo is for "KOReader, Project: Title &
  WeatherLockscreen." Composition is ad-hoc and version-coupled.
- **No public `my-koreader-setup` style dotfile repo** was found in searches.
  Zero. The KemoNine zip is the closest artefact, distributed as a blog
  download rather than a git repo.
- **awesome-koreader** (ruiribeiro04, 3 ⭐, new) is the only curated list; its
  Community section does link r/koreader, MobileRead, and GitHub Discussions,
  confirming those are the three hubs.

**Takeaway:** the referential plumbing exists for plugins and patches. It does
**not** exist for settings. There is no `awesome-koreader-configs`. This is an
identifiable gap.

---

## Q9. How many users own multiple KOReader devices? Do they want parity?

Strong "yes, multi-device is common, parity is wanted, parity is unsolved":

- GitHub Discussion #9189 — reporter reads on "Kindle, Samsung phone, tablet,
  and Boox e-reader" and asks for cross-device progress + highlight sync.
  Maintainer response: not implemented. Third-party workaround: Syncthing.
  <https://github.com/koreader/koreader/discussions/9189>
- MobileRead thread 363975 — user with "iPhone, Windows PC, Linux PC, Kobo
  Clara BW" asks the same. Accepted answer is custom rsync scripts plus
  KOSync. Developer confirms on the thread:
  > "In the next release will appear a new feature … Fire actions on events."
  > "We cannot do anything while the device is sleeping."
  <https://www.mobileread.com/forums/showthread.php?t=363975>
- **Frenzie (maintainer)** on Discussion #8885 explicitly endorses copying
  `settings.reader.lua` and `/settings/` for cross-device transfer — *but*
  warns
  > "you might wish to only manually copy over gestures."

  Even the maintainer admits wholesale transfer is unsafe.
  <https://github.com/koreader/koreader/discussions/8885>
- Multiple third-party solutions exist precisely because the problem is
  widespread: KoInsight (266 ⭐), Readest plugin, Syncthing plugin, KOSync,
  Calibre sync via rsync, Komga integration. **Six separate solutions to the
  same problem is a diagnostic smell.**
- Issue #6925 (2020): "how can I move all my existing koreader settings over
  to the new android tablet?" with hypothesis
  > "I'm thinking the only files to throw on are settings.reader.lua and
  > everything in /settings/?"
  Closed without feature delivery.
  <https://github.com/koreader/koreader/issues/6925>

**Quantification not possible without Reddit access**, but the number of
independent issues and the number of sync plugins indicates multi-device users
are a meaningful and vocal fraction, and parity is **one of the top 3 community
asks**.

---

## Q10. Beyond SimpleUI, top community plugins mentioned?

Ranked by a blend of ⭐ count, thread frequency, and awesome-koreader
curation:

1. **ProjectTitle** (UI) — 880 ⭐
2. **SimpleUI** (UI) — 624 ⭐ *(asked about separately, included for context)*
3. **Assistant.koplugin** (AI chat) — 271 ⭐
4. **KoInsight** (sync/stats server) — 266 ⭐
5. **AppStore.koplugin** — 202 ⭐
6. **Z-Library client (zlibrary.koplugin)** — 157 ⭐ top fork, ~152 second fork
7. **Anki.koplugin** — 143 ⭐
8. **joshuacant/KOReader.patches** — 139 ⭐ (patches, not a plugin, but widely
   used)
9. **annas.koplugin** (Anna's Archive) — 5+ forks, FR #12597 in core
10. **Wallabag.koplugin** — built-in, read-it-later
11. **News downloader** — built-in, RSS → HTML
12. **Calibre Companion** — built-in, wifi send-to-device
13. **Readest plugin** — cross-device sync (recent, buzz in 2025/2026 tutorials)
14. **Syncthing plugin** (jasonchoimtt) — folder sync workaround
15. **Zotero Sync** — academic PDFs

Built-ins that are *default-on and tolerated*: reading statistics, dictionary,
bookmarks, gestures, profiles, quick menu. These don't come up as "install
post-reset" because they arrive by default.

Sources: <https://github.com/ruiribeiro04/awesome-koreader>,
<https://kindlemodshelf.me/plugins>, individual repo stars.

---

## Top signals (ranking)

Ranked by **frequency × emotional intensity** across the sampled corpus.

### Tier 1 — "this is the product"

1. **Backup / restore is folklore, not a feature, and everyone has a horror
   story.** Issues #5562, #5577, #6925, #11882, #13875, #1612 all converge on
   the same request: a one-command, survives-reinstall, version-aware backup.
   Quotes range from resigned ("I had to go again everywhere and set margins,
   taps, font … everything") to indignant ("makes it feel like an incomplete
   piece of software"). This is the #1 signal in the data.
2. **Multi-device parity is unsolved, and the fragmentation of workarounds is
   proof.** Six independent third-party sync solutions, maintainers publicly
   refusing to ship any of them, the top community plugin (KoInsight, 266 ⭐)
   is a sync server. If `korea` can describe a setup once and apply it to N
   devices, this is a killer demo.
3. **Menu/plugin bloat is the first-run experience.** "More buttons than a
   spaceship cockpit." JoeBumm's Menu Customizer has 88 ⭐ just for *hiding*
   menus. Core devs themselves merged PR #12766 to auto-disable wrong-device
   defaults. Any tool that ships an opinionated "minimal reader" preset lands
   in a pre-existing demand.

### Tier 2 — strong secondary signals

4. **UI plugins (ProjectTitle, SimpleUI) are fragile across KOReader
   versions.** Issue #13942 documents this at an architectural level; #89 and
   #135 are concrete crashes. Anyone relying on a UI plugin re-breaks a few
   times a year. A declarative tool that can *reapply* the same UI choices
   after a plugin update is directly useful.
5. **Gestures/profiles are "cumbersome, and, if complex, difficult to
   replicate."** (#8590, author's own words.) Existing Profiles plugin has
   JSON export/import but is underdocumented; `settings/profiles.lua` is where
   they live. A shareable gesture map is a concrete feature.
6. **People already share setups in prose + screenshots; the format is
   miserable.** The demand is latent but obvious — KemoNine's zip, the
   darnedestthing's blog post as "personal backup," seven user-patch repos.
   Nobody has a format. `korea` can be that format.

### Tier 3 — real but less acute

7. **Default plugins people consistently kill**: `zsync`, `evernote`,
   `calibrecompanion`, `autofrontlight/dim/warmth` (on e-ink w/o frontlight),
   `backgroundrunner`. Good candidates for a `minimal` preset.
8. **Recurring "how do I wire up X" requests**: cloud storage, Calibre OPDS,
   night-mode persistence, mosaic density, folder covers. Any of these can be
   a one-liner in a declarative config.
9. **AppStore.koplugin (202 ⭐) proves the community accepts and wants
   automated install tooling.** The cultural acceptance of a CLI/declarative
   tool is therefore higher than a pure Reddit read would suggest — these are
   users who already jailbreak their devices and install .koplugin zips by
   hand.

### Gaps / questions this research could not answer

- **True Reddit volume** for "how do I set up X" — not accessible.
- **Format distribution on r/koreader** (% screenshots vs prose vs
  gist) — not accessible.
- **% r/koreader users who'd install a `brew`-gated CLI** — not accessible;
  best proxy is that jailbreaking + manual plugin install is already the
  baseline, so the floor is fairly high.
- **Whether ProjectTitle users feel *actively pushed* to SimpleUI, or just
  curious** — unclear from non-Reddit data. Both repos are active; no
  deprecation notice on either.
- **Any already-existing declarative KOReader config tool** — searches found
  none. No `koreader-home-manager`, no `koreader-nix`, nothing. The closest
  prior art is AppStore.koplugin (installs only, no settings) and KemoNine's
  zip (personal, not a tool).

---

## Key links (for later deep reads)

- Backup pain issues: [#5562](https://github.com/koreader/koreader/issues/5562),
  [#5577](https://github.com/koreader/koreader/issues/5577),
  [#6925](https://github.com/koreader/koreader/issues/6925),
  [#11882](https://github.com/koreader/koreader/issues/11882),
  [#13875](https://github.com/koreader/koreader/issues/13875),
  [#1612](https://github.com/koreader/koreader/issues/1612),
  [#13035](https://github.com/koreader/koreader/issues/13035)
- Multi-device: [Discussion #9189](https://github.com/koreader/koreader/discussions/9189),
  [Discussion #8885](https://github.com/koreader/koreader/discussions/8885),
  [MobileRead 363975](https://www.mobileread.com/forums/showthread.php?t=363975)
- Menu complexity: [#2564](https://github.com/koreader/koreader/issues/2564),
  [#9638](https://github.com/koreader/koreader/issues/9638),
  [Menu Customizer](https://github.com/JoeBumm/Koreader-Menu-customizer),
  [grokking koreader](http://thedarnedestthing.com/grokking%20koreader)
- UI plugin fragility: [#13942](https://github.com/koreader/koreader/issues/13942),
  [ProjectTitle #89](https://github.com/joshuacant/ProjectTitle/issues/89),
  [SimpleUI #135](https://github.com/doctorhetfield-cmd/simpleui.koplugin/issues/135)
- Plugin ecosystem: [awesome-koreader](https://github.com/ruiribeiro04/awesome-koreader),
  [kindlemodshelf plugins](https://kindlemodshelf.me/plugins),
  [AppStore.koplugin](https://github.com/omer-faruq/appstore.koplugin)
- Setup sharing in the wild: [KemoNine template](https://blog.kemonine.info/blog/2026-03-07-koreader/),
  [thedarnedestthing settings](http://thedarnedestthing.com/koreader%20settings),
  [joshuacant patches](https://github.com/joshuacant/KOReader.patches),
  [sebdelsol patches](https://github.com/sebdelsol/KOReader.patches)
- Defaults / plugins disabled: [PR #12766](https://github.com/koreader/koreader/pull/12766),
  [Disabling Wallabag MR thread](https://www.mobileread.com/forums/showthread.php?t=359838),
  [Change defaults wiki](https://github.com/koreader/koreader/wiki/Change-defaults)
- Profiles (existing partial solution): [Profiles wiki](https://github.com/koreader/koreader/wiki/Profiles),
  [#8590](https://github.com/koreader/koreader/issues/8590),
  [PR #10036](https://github.com/koreader/koreader/pull/10036)

---

*Compiled 2026-04-21. Reddit direct access unavailable at research time —
findings triangulated from GitHub, MobileRead, eReadersForum, and blogs. See
top-of-document caveat.*
