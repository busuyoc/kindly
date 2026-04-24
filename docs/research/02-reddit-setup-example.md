# Test case: Reddit setup → profile

**Source:** r/koreader comment, SimpleUI 1.2.5 setup, 30 upvotes.

## The original prose (what users deal with today)

> Night Mode on (obviously)
>
> If you're switching from ProjectTitle, remove the projecttitle plugin folder, as well as re-enable Cover Browser under plugin management in KOReader.
>
> Display mode: Mosaic with cover images
>
> SimpleUI Settings:
>
> - **Top: Status Bar** — Size 90%, Items: Swipe Ind. Battery WiFi
> - **Home Screen:** Start with Home screen enabled
>   - **Modules:** No Module Limit enabled, arranged as follows:
>     - Clock: Date on, Battery off, Scale 70%, Margin 100%
>     - Quick Actions 1: Scale 70%, Text 70%, Margin 80%, Items: Power, Bookmarks, Stats, Brightness, WiFi
>     - Currently Reading: Scale 100%, Text 70%, Cover 70%
>     - Collections: Scale 70%, Text 80%, Cover 160%, Margin 60%
>     - Reading Stats: Type: Cards, Scale 60%, Text 100%, Margin 100%
> - **Bottom: Nav Bar** — Size 70%, Margin 100%, Icons 100%, Labels 70%, Separator Hidden, Type: Icons + Text, Tabs: Home, Library, Collections, History, Continue

Someone reading this has to tap through ~50 menu interactions on an e-ink device to replicate it. Each tap has screen refresh lag. Easy to miss a setting.

## The same thing as a profile

```yaml
name: "reddit-simpleui-mosaic"
description: "Clean SimpleUI mosaic setup, shared on r/koreader"
extends: simpleui-base

plugins:
  disabled: [projecttitle]
  enabled: [coverbrowser, simpleui]

koreader:
  night_mode: true
  filemanager:
    display_mode: mosaic_with_covers

simpleui:
  top_bar:
    size_pct: 90
    items: [swipe_indicator, battery, wifi]

  home_screen:
    start_with_home: true
    no_module_limit: true
    modules:
      - clock: { date: true, battery: false, scale_pct: 70, margin_pct: 100 }
      - quick_actions_1:
          scale_pct: 70
          text_pct: 70
          margin_pct: 80
          items: [power, bookmarks, stats, brightness, wifi]
      - currently_reading: { scale_pct: 100, text_pct: 70, cover_pct: 70 }
      - collections: { scale_pct: 70, text_pct: 80, cover_pct: 160, margin_pct: 60 }
      - reading_stats: { type: cards, scale_pct: 60, text_pct: 100, margin_pct: 100 }

  bottom_bar:
    size_pct: 70
    margin_pct: 100
    icon_pct: 100
    label_pct: 70
    separator: hidden
    type: icons_and_text
    tabs: [home, library, collections, history, continue]
```

## Applied

```bash
korea apply reddit-simpleui-mosaic.yaml --device /Volumes/Kindle
# → reads current device state
# → computes diff
# → shows: 18 changes (3 plugin ops, 15 settings)
# → applies, writes settings.reader.lua, toggles plugins
# → done in 3 seconds, no menu tapping
```

This is the north star: the Reddit comment above should be reproducible with one command.
