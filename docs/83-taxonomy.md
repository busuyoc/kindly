# Settings taxonomy

The taxonomy assigns every `settings.reader.lua` key to a category, a human
label, an optional description, and a control hint the GUI can render. It is
the spec the GUI's sidebar renders from. Source of truth:

- `data/taxonomy/settings.v1.categories.yaml` — hand-curated (key → category + overrides)
- `data/taxonomy/settings.v1.json` — built artifact, consumed by the CLI + GUI
- `scripts/build-taxonomy.ts` — builder (regenerate with `bun run scripts/build-taxonomy.ts`)

**Orthogonality:** the taxonomy answers *"where does this setting live in the
UI tree?"* It deliberately does NOT answer *"is this setting active?"* or
*"does this depend on that other one?"* — relevance/dependency data lives in
a separate `data/relevance/` file whenever that lands, so the shapes can
version independently.

---

## Status

- **W7 (shipped 2026-04-22):** builder + validation + 3-category stub (17 keys)
- **W8 (shipped 2026-04-22):** full 10-category curation across all 557
  schema keys. Zero uncategorized. 100% hit rate against a real-world
  180-key device.

### Distribution (schema-wide, 557 keys)

| Category | Keys | % |
|---|---:|---:|
| `plugins_bundled` | 164 | 29.4% |
| `reading` | 92 | 16.5% |
| `menu` | 77 | 13.8% |
| `display` | 77 | 13.8% |
| `gestures` | 45 | 8.1% |
| `fonts` | 33 | 5.9% |
| `screensaver` | 27 | 4.8% |
| `status_bar` | 21 | 3.8% |
| `ephemeral` | 18 | 3.2% |
| `progress` | 3 | 0.5% |

`plugins_bundled` dominates the schema — a third of all keys are
plugin-scoped. Plugin catalog (W19-W24) is where those get the
per-plugin metadata (owner, description, upstream URL) that makes
them navigable. Until then, they're one flat bucket.

### Distribution (real-device, 180 user-set keys)

The device test shows users actually *set* a different mix than the
schema's uniform distribution:

| Category | Keys on device | % of device |
|---|---:|---:|
| `plugins_bundled` | 80 | 44.4% |
| `display` | 19 | 10.6% |
| `status_bar` | 16 | 8.9% |
| `menu` | 15 | 8.3% |
| `reading` | 14 | 7.8% |
| `screensaver` | 14 | 7.8% |
| `ephemeral` | 9 | 5.0% |
| `gestures` | 7 | 3.9% |
| `progress` | 3 | 1.7% |
| `fonts` | 3 | 1.7% |

Near-half of a real user's config is plugin-owned — confirming W19-W24
catalog is the next big value unlock after taxonomy.

---

## Categories (target)

The ten flat buckets from the roadmap. Flat is chosen over nested because a
GUI sidebar needs one-click category filtering; a tree would force users to
expand/collapse to find common settings.

| Category | What lives here | Rationale |
|---|---|---|
| `reading` | Things that affect *how* a book is read and navigated. Examples: `home_dir`, `lastfile`, `copt_*` (CR engine layout opts), `inertial_scroll`, `end_document_action`. | The default-focus bucket — if a user lands on the GUI and clicks the first category, they should see the core reading controls. |
| `fonts` | Font families, fallbacks, CSS overrides. Examples: `cre_font_family_fonts`, `cre_fonts_recently_selected`, `copt_css`, `copt_fb2_css`, `font_ui_fallbacks`, `text_lang_fallback`. | Typography is its own discipline in KOReader. Users tune fonts in one sitting, not interleaved with other settings. |
| `status_bar` | Bottom footer + CREengine top header. Examples: `reader_footer_*`, `footer`, `footer_presets`, `cre_header_*`, `readtimer_show_value_in_footer`. | Footer and CR-header are two faces of the same "what info is always visible while reading" concern. Treat as one bucket. |
| `menu` | File manager, TOC, bookmark, history, keyboard UI chrome. Examples: `bookmarks_items_*`, `toc_items_per_page`, `keyboard_*`, `collate`, `history_filter`, `show_filter`, `show_unsupported`, `filemanagermenu_tab_index`. | "How the UI around reading behaves." Not the reading view itself. |
| `gestures` | Tap zones, gesture timing. Examples: `ges_tap_interval_on_keyboard_ms`, `page_turns_tap_zones`. Small bucket but conceptually distinct — touch behavior is often broken or tuned independently of visuals. |
| `progress` | Reading stats, session tracking, end-of-book actions. Examples: `statistics`, `readtimer`, `end_document_action`, `autoremove_deleted_items_from_history`. | Reading *history* and *tracking* is a coherent concern separate from active reading. |
| `screensaver` | All `screensaver_*` keys. Examples: `screensaver_type`, `screensaver_delay`, `screensaver_document_cover`, `screensaver_message*`, `screensaver_img_background`. | Large coherent cluster (~14 keys on our test device), deserves its own bucket rather than being lumped into `display`. |
| `display` | Backlight, nightmode, warmth, auto-dim, auto-standby, orientation. Examples: `night_mode`, `autowarmth_*`, `autodim_*`, `auto_suspend_timeout_seconds`, `auto_standby_timeout_seconds`, `autoshutdown_timeout_seconds`, `screen_dpi`, `kindle_hall_effect_sensor_enabled`, `closed_rotation_mode`. | Everything that affects the physical screen state. Power-management settings belong here too — on a Kindle, power and display are the same conversation. |
| `plugins_bundled` | Settings owned by shipped-with-KOReader plugins. Examples: `pinpadlock_*`, `kosync`, `dict_*`, `dicts_*`, `wikipedia_*`, `vocabulary_builder`, `coverbrowser_*`, `style_tweaks*`, `exporter`, `terminal_*`, `httpinspector_port`, `LocalSend_*`, `zlibrary_*`, `zlib_*`. | Plugin settings that aren't first-class core features. Keeps the core buckets clean. W19-W24 plugin catalog will eventually annotate these with per-plugin metadata. |
| `ephemeral` | Runtime state that shouldn't be synced between devices but KOReader happens to persist. Examples: `last_migration_date`, `quickstart_shown_version`, `device_id`, `wifi_was_on`, `currently_blocked`, `filemanagermenu_tab_index`, `menu_search_string`, `lastdir`. | The bucket that makes explicit what `pull --minimal` already filters. Visible-but-greyed-out in the GUI so users understand what's intentionally not portable. |
| `uncategorized` | Keys not yet mapped. Builder-assigned fallback. | Scoreboard for curation completeness. `stats.uncategorized_count` in the built JSON should trend to zero. |

---

## W8 notes — non-obvious categorization calls

A few decisions worth surfacing so future curators don't second-guess them:

1. **Community plugins land in `plugins_bundled`.** `navbar_*` (45 keys),
   `simpleui_*` (10), `aaaProjectTitle_*` (1) are clearly third-party, but
   the roadmap fixes the bucket at 10 categories. Keeping them in
   `plugins_bundled` (mislabeled for stock-only) is the pragmatic call;
   plugin catalog (W19-W24) will re-layer by plugin identity. Don't
   rename the bucket to `plugins` — consumer contracts already reference
   `plugins_bundled`.

2. **`lastfile` is `ephemeral`, not `reading`.** Previously in the stub
   under `reading`, but it's the path to the last-opened book — pushing
   it device-to-device would spuriously change the "next open" target.
   Moved to `ephemeral` in W8; the pull/export denylist already filters
   it, so no behavior change.

3. **`cre_show_progress` landed in `reading`, not `status_bar`.** It's a
   global CR engine flag for progress indication, not specifically a
   header setting. The `cre_header_*` keys (all 11) went to `status_bar`.

4. **Power-management belongs in `display`.** `auto_standby_*`,
   `auto_suspend_*`, `autoshutdown_*`, `frontlight_*`, `autowarmth_*`,
   `autodim_*`, `ota_*`, wifi, mass-storage — all display/power territory
   on a Kindle. Separating a `power` bucket would only help if we had
   >20 clearly-power-only keys, and we don't.

5. **`autoturn_*` is `reading`, not `gestures`.** Auto-page-turn is a
   scheduled reading feature, not input. `gestures` is for user-driven
   input (taps, swipes, keys, sensors).

6. **`dev_*` keys kept as `display` with "Developer:" label prefix.**
   They're mostly rendering-debug flags (blitter, dither, fbdepth). The
   prefixed label lets the GUI gray them out or put them behind an
   "advanced" toggle.

7. **`fulltext_search_*` is `reading`, not `menu`.** In-book text search
   is a reading-experience feature; file-manager search went to `menu`.

8. **`kopt_*`, `copt_*` and `cre_*` are split by function, not by
   engine.** Engine prefix is a KOReader implementation detail; the
   user-facing concern is whether it's fonts, reading layout, or header
   display.

9. **Schema drift is zero.** All 180 device keys exist in the schema
   extract. No W8 blocker on that front.

### Hit-rate

Before W8: 17/540 keys categorized (3% schema coverage), 8/180 device-keys
hit (4.4%).

After W8: 557/557 (100% schema coverage), 180/180 (100% device hit).

---

## Workflow for adding a category assignment

1. Edit `data/taxonomy/settings.v1.categories.yaml` — add `key: category` (string) or the object form with `label`/`description`/`control_hint` overrides.
2. Run `bun run scripts/build-taxonomy.ts`. Builder fails if:
   - A referenced category isn't declared in the `categories:` list.
   - A mapped key isn't present in the schema (catches typos + stale entries).
3. Commit both the categories YAML *and* the built `settings.v1.json`. The artifact is version-controlled so GUI consumers don't need to run the builder; the YAML is auditable so reviewers can see *why* a key landed where it did.
4. For a sanity check against a real device, run `bun run scripts/taxonomy-hitrate.ts` with Kindle mounted — prints categorized/uncategorized counts and the list of uncategorized keys actually in use.

---

## Non-goals

- **Deep nesting.** No `display.brightness.auto_dim.schedule` trees. Flat + filterable > hierarchical.
- **Localization.** Labels are in English; localization is a UI-layer concern.
- **Machine-inferred categories.** Someone who knows KOReader has to make the call, because the key names don't always mean what they look like (e.g. `copt_*` = "CR engine options", not "copy-something").
- **Per-plugin breakdown inside `plugins_bundled`.** That's plugin-catalog territory (W19-W24). Keep the taxonomy's plugin bucket flat; the catalog re-layers it.
