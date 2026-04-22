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
- **W8 (in progress):** expand to the 10-category target below, using the
  cluster analysis from the 2026-04-22 device hit-rate run as the worklist

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

## Cluster findings from device audit (2026-04-22)

Ran `scripts/taxonomy-hitrate.ts` against a real-world device with 180 set
keys. 0 schema misses, 95.6% uncategorized at stub time. The uncategorized
set clusters cleanly — this is the W8 worklist.

### Natural clusters, sized by device-observed count

| Cluster | Count on device | Target category | Notes |
|---|---|---|---|
| `screensaver_*` | ~14 | `screensaver` | Own bucket — large and coherent. |
| `navbar_*` | ~18 | `plugins_community` (new?) or `plugins_bundled` | **Community plugin**, not stock KOReader. Could also be deferred to plugin catalog (W19+). |
| `cre_header_*` | ~12 | `status_bar` | Stub missed these — fix in W8. Same bucket as `reader_footer_*`. |
| `autowarmth_*` + `autodim_*` + `night_mode` + `kindle_hall_effect_sensor_enabled` | ~10 | `display` | Screen-warmth + brightness automation. |
| `autoturn_*` + `auto_standby_*` + `auto_suspend_*` + `autoshutdown_*` | ~6 | `display` | Power-management lives with display. |
| `bookmarks_*` + `toc_items_per_page` + `keyboard_*` + UI chrome | ~8 | `menu` | |
| `ges_tap_*` + `page_turns_tap_zones` + `inertial_scroll` + `scroll_method` | ~4 | `gestures` | |
| `simpleui_*` | ~8 | `plugins_community` or catalog | Community UI mod. |
| `pinpadlock_*` | ~6 | `plugins_bundled` | Includes `pinpadlock_pin_code` — SECRET (already filtered by pull). |
| `zlibrary_*` + `zlib_*` | ~8 | `plugins_bundled` | Includes passwords — SECRETs already filtered. |
| `kosync` + `dict_*` + `dicts_*` + `wikipedia_*` + `vocabulary_builder` + `coverbrowser_*` + `style_tweaks*` + `readtimer` + `statistics` + `exporter` + `terminal_*` + `httpinspector_port` + `LocalSend_*` | ~25 | `plugins_bundled` | The long tail of stock plugins. |
| `quickstart_shown_version` + `last_migration_date` + `device_id` + `wifi_was_on` + `currently_blocked` + `filemanagermenu_tab_index` + `menu_search_string` + `lastdir` + `start_with` | ~10 | `ephemeral` | Runtime state, already filtered by `pull --minimal`. |
| Miscellaneous long tail | ~20 | various | Case-by-case — e.g. `dimension_units`, `duration_format`, `default_highlight_action` → `reading`; `folder_shortcuts` + `inbox_dir` + `lock_home_folder` → `menu` or `reading`. |

### Signals beyond categorization

1. **Community-plugin namespace clusters** (`navbar_*`, `simpleui_*`, `aaaProjectTitle_*`) are a clear signal that the device has third-party plugins installed. The taxonomy can slot them into a generic `plugins_community` bucket, but the richer answer lives in the plugin catalog (W19-W24): once we have per-plugin metadata, these clusters get annotated with plugin identity, description, upstream URL, etc. W8 should leave a pragmatic seam — do *not* over-invest in categorizing community-plugin keys by function, because plugin catalog will re-layer them.

2. **Stub gap — `cre_header_*` should have been in `status_bar` from day one.** The W7 stub only caught `reader_footer_*`, missing the CREengine's own top-header settings. Footer + CR-header are two expressions of the same "info always visible while reading" concern — W8 merges them.

3. **Secret keys present on device** (`pinpadlock_pin_code`, `zlibrary_password`, `zlib_user_key`) are already filtered by `pull` / `setup export` via the denylist. The taxonomy records them under `plugins_bundled` for UI completeness; the relevance file (when it lands) or a future `is_secret` flag in the taxonomy can mark them for GUI-side redaction.

4. **Schema drift is zero.** All 180 device keys exist in `data/schemas/settings.reader.lua.v1.json`. The March schema extract is still accurate against current-device KOReader. No W8 blocker on that front.

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
