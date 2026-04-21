# Profile Schema (draft)

A profile is a YAML (or TOML) file describing a full KOReader setup.

## Example

```yaml
name: "claudiu-daily-reader"
description: "Kindle PW, minimal SimpleUI setup"
extends: simpleui-mosaic   # inherit from a named preset

device:
  model: kindle            # kindle | kobo | boox | pocketbook | generic
  mount_hint: /Volumes/Kindle

plugins:
  enabled:
    - simpleui: { version: "1.4.0" }
    - zlibrary:
        email: "${secrets.zlib_email}"
        password: "${secrets.zlib_password}"
        base_url: "https://z-library.sk"
    - localsend: { port: 53317 }
    - kosync: { username: "${secrets.kosync_user}" }
    - coverbrowser
    - statistics
  disabled:
    # defaults we don't want
    - newsdownloader
    - wallabag
    - japanese
    - perceptionexpander
    - autoturn

koreader:
  # keys mirror settings.reader.lua structure
  home_dir: "/mnt/us/Books"
  night_mode: true
  reader:
    font_size: 20
    line_spacing: 1.2
  filemanager:
    display_mode: mosaic
    show_hidden: false
  gestures:
    tap_top_left: toggle_night_mode
    swipe_south: toggle_status_bar

simpleui:
  top_bar:
    size_pct: 90
    items: [swipe_ind, battery, wifi]
  home_screen:
    start_with_home: true
    no_module_limit: true
    modules:
      - clock:
          date: true
          battery: false
          scale_pct: 70
          margin_pct: 100
      - quick_actions_1:
          scale_pct: 70
          text_pct: 70
          margin_pct: 80
          items: [power, bookmarks, stats, brightness, wifi]
      - currently_reading:
          scale_pct: 100
          text_pct: 70
          cover_pct: 70
      - collections:
          scale_pct: 70
          text_pct: 80
          cover_pct: 160
          margin_pct: 60
      - reading_stats:
          type: cards
          scale_pct: 60
          text_pct: 100
          margin_pct: 100
  bottom_bar:
    size_pct: 70
    margin_pct: 100
    icon_pct: 100
    label_pct: 70
    separator: hidden
    type: icons_and_text
    tabs: [home, library, collections, history, continue]

secrets:
  # resolved from env or a companion .secrets file, never committed
  source: env   # env | file:.secrets.yaml | op:1password
```

## Design principles

1. **Human-writable first.** Someone reading r/koreader should be able to hand-author this in 10 min.
2. **Inheritance.** `extends: <preset>` lets users override only what they care about.
3. **Secrets separated.** Never inline credentials in a shareable profile.
4. **Forward-compatible.** Unknown keys are preserved on `pull`, not stripped.
5. **Device-aware but not device-locked.** A profile written for a Kindle mostly applies to a Kobo — tool warns on genuinely incompatible settings.

## Open questions

- YAML vs TOML — YAML is more forgiving for nested stuff, TOML is friendlier for hand-editing simple configs. Lean YAML.
- Versioning: pin `korea schema version` per profile so future breaking changes are safe.
- Per-book metadata (`.sdr/`): out of scope for v1? Or sync highlights too?
- Plugins outside default KOReader ship (zlib, simpleui, localsend) — where does the tool download them from? Hardcoded registry vs custom URLs per plugin spec?
