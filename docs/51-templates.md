# Curated templates — v0.3

Templates are pre-authored starting points bundled in the `kindly` binary.
Each is a named bundle of `settings` + `plugins.disabled` for a specific
use case. They're not magic — they're just opinionated defaults you can
build on.

## How they work

```
kindly setup templates                          # list the registry
kindly setup export my-name --template <id>     # build a manifest from one
```

A template-driven export **does not read the device**. The manifest is
constructed entirely from the template's key/value pairs. CLI flags layer
on top:

| Flag                 | Behavior with `--template`                              |
|----------------------|---------------------------------------------------------|
| `--description`      | overrides the template's description                    |
| `--apply-mode`       | overrides the template's mode (all ship `additive`)     |
| `--author`, `--tags` | layer onto `meta`; templates don't set these            |
| `--keys a,b`         | narrows the template's settings to the intersection     |
| `--compat-*`         | adds compat metadata as usual                           |
| `--include-plugin-files`, `--include-patches` | **reads the device** to augment the template with live plugin dirs / patch files |

All three shipped templates default to **`apply_mode: additive`**. They
*layer onto* the user's existing configuration; they don't wipe it. A
`replace`-mode template would effectively factory-reset the device, keeping
only the ~10 keys the template declares — almost never what a user asking
for "night reading" or "minimal UI" actually wants.

You can force replace semantics at export time with `--apply-mode replace`,
but do it deliberately.

## The three shipped templates

### `minimal-ui` — quiet reader chrome

Suppress UI flashing, hide the footer, turn off plugins that add visual
weight (cover browser, calendar, news downloader).

| Key                          | Value | Why                                            |
|------------------------------|-------|------------------------------------------------|
| `avoid_flashing_ui`          | true  | don't repaint UI on every tap                  |
| `book_map_ten_pages_markers` | 0     | fewer tick marks in book map                   |
| `reader_footer_mode`         | 0     | hide the bottom status bar                     |
| `plugins.disabled`           | `coverbrowser`, `calendar`, `newsdownloader` | heavy / off-topic UI panels |

### `night-reading` — warmth and gentle dimming

Turns on autowarmth in easy mode, sets gentle autodim parameters.

| Key                                  | Value | Why                                       |
|--------------------------------------|-------|-------------------------------------------|
| `autowarmth_activate`                | 1     | turn autowarmth on (fixture default is 0) |
| `autowarmth_easy_mode`               | true  | simpler warmth curve                      |
| `autowarmth_hide_nightmode_warning`  | true  | less nagging at bedtime                   |
| `autodim_duration_seconds`           | 5     | smooth, short fade                        |
| `autodim_fraction`                   | 20    | dim to 20% — still readable               |

No plugin toggles. Tune further in KOReader → *Screen* → *Frontlight*.

### `distraction-free` — reader-only

Disables autoturn, routes end-of-document to the next file (no menu prompt),
turns off plugins that surface unrelated content.

| Key                   | Value         | Why                                    |
|-----------------------|---------------|----------------------------------------|
| `autoturn_enabled`    | false         | no automatic page turning              |
| `end_document_action` | `"next_file"` | skip "what next?" menus at end of book |
| `plugins.disabled`    | `calendar`, `coverbrowser`, `japanese`, `newsdownloader`, `opds`, `statistics` | typical "not reading right now" surfaces |

## Editing after export

Templates are a starting point. The exported `.kset.yaml` is a plain text
file — open it, tune values, save. Re-importing after editing is safe
(same content-hash flow as any manually authored Setup).

A common pattern:

```
kindly setup export night-reading --template night-reading  # get the starter
$EDITOR ~/.kindly/setups/<id>-night-reading.kset.yaml       # tune
kindly setup import ~/.kindly/setups/<id>-night-reading.kset.yaml
```

## Why not user-defined templates?

v0.3 ships only the bundled registry. A user-defined template layer
(e.g. `~/.kindly/templates/*.yaml`) is deferred — it would introduce a
second format with no obvious advantage over "export a Setup, share the
.kset.yaml." If you want your own template, that's what an already-authored
Setup is for.

## Why no fat templates?

Templates are lean by design: they declare *settings* (and optionally which
plugins are disabled), not which plugins to *ship*. Shipping Lua is
device-specific and compat-sensitive — not the job of a portable starting
point. Use `--include-plugin-files` / `--include-patches` at export time to
augment a template with the connected device's plugin directories.
