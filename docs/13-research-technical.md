# 13 — KOReader Technical Research

Investigation of KOReader internals for the korea project. Source:
`/tmp/koreader-src` (koreader main repo) and `/tmp/simpleui`
(doctorhetfield-cmd/simpleui.koplugin). No Kindle mounted — source only.

Citations use `path:line` format, paths relative to the respective source tree
root.

---

## 1. `settings.reader.lua` — the full story

### Where it's loaded

One entry point, in `reader.lua:39-40`:

```lua
G_reader_settings = require("luasettings"):open(
    DataStorage:getDataDir().."/settings.reader.lua")
```

`DataStorage:getDataDir()` (`datastorage.lua:16-50`) resolves the data dir per
platform:

- `KO_HOME` env var overrides everything
- Android: `android.getExternalStoragePath().."/koreader"`
- AppImage / Flatpak / multi-user: `$XDG_CONFIG_HOME/koreader` or
  `~/.config/koreader` (on macOS, `~/Library/Application Support/koreader`)
- Otherwise: `.` (i.e. current working directory = the KOReader install root).
  On Kindle, Kobo, PocketBook, etc. the launcher `cd`s into the install dir,
  so `settings.reader.lua` lives next to the binary.

Kindle install root: `/mnt/us/koreader/` → `/mnt/us/koreader/settings.reader.lua`.
Kobo: `/mnt/onboard/.adds/koreader/settings.reader.lua`.
PocketBook: `/mnt/ext1/applications/koreader/settings.reader.lua`.

### How it's loaded

`frontend/luasettings.lua:21-48`:

```lua
function LuaSettings:open(file_path)
    local new = LuaSettings:extend{ file = file_path }
    local ok, stored
    local existing = lfs.attributes(new.file, "mode") == "file"
    ok, stored = pcall(dofile, new.file)
    if ok and stored then
        new.data = stored
    else
        if existing then logger.warn("LuaSettings: Failed reading", new.file, "(probably corrupted).") end
        ok, stored = pcall(dofile, new.file..".old")
        if ok and stored then
            ...
            new.data = stored
        else
            ...
            new.data = {}
        end
    end
    return new
end
```

**Critical**: load is `pcall(dofile, ...)`. That is **full Lua execution**, not
a parse. The file is an executable Lua chunk that returns a table. No sandbox
is installed (contrast `luadata.lua:72` which uses `loadfile(path, "t", env)`
with a restricted env). Practically every real `settings.reader.lua` observed
in the wild is pure data (a single top-level `return { ... }`), but the
loader will happily execute arbitrary code if present.

**Corrupt file behavior**: `pcall` catches the error, logs a warn, then falls
back to `settings.reader.lua.old`. If that also fails, `data = {}` — starts
fresh (KOReader will rebuild the file on next flush). No user prompt; it just
silently resets. `.old` is produced via `os.rename` during `flush()` if the
current file is ≥60s old (`luasettings.lua:252-267`).

### How it's written

`frontend/luasettings.lua:270-275`:

```lua
function LuaSettings:flush()
    if not self.file then return end
    local directory_updated = self:backup()
    util.writeToFile(dump(self.data, nil, true), self.file, true, true, directory_updated)
    return self
end
```

`util.writeToFile` with `lua_dofile_ready=true` wraps the dump as
`"-- <filepath>\nreturn <data>\n"` (`util.lua:1141-1160`). So the emitted file
is *always* a leading comment with the path, then `return { ... }`. No other
comments survive.

The serializer is `dump(data, max_lv=nil, ordered=true)` from
`frontend/dump.lua`. Relevant body (`dump.lua:10-73`):

```lua
local function _serialize(what, outt, indent, max_lv, history, pairs_func)
    ...
    if datatype == "table" then
        ...
        insert(outt, "{")
        for k, v in pairs_func(what) do
            insert(outt, "\n")
            insert(outt, string.rep(indent_prefix, indent+1))
            insert(outt, "[")
            _serialize(k, outt, indent+1, max_lv, new_history, pairs_func)
            insert(outt, "] = ")
            _serialize(v, outt, indent+1, max_lv, new_history, pairs_func)
            insert(outt, ",")
            ...
        end
        ...
        insert(outt, "}")
    elseif datatype == "string" then
        insert(outt, string.format("%q", what))   -- Lua %q quoting
    elseif datatype == "number" then
        insert(outt, tostring(what))
    elseif datatype == "boolean" then
        insert(outt, tostring(what))
    elseif datatype == "function" then
        insert(outt, tostring(what))              -- dumps e.g. "function: 0x..." — broken on reload
    elseif datatype == "nil" then
        insert(outt, "nil")
    end
end

local function dump(data, max_lv, ordered)
    local out = {}
    local pairs_func = ordered and require("ffi/util").orderedPairs or pairs
    _serialize(data, out, 0, max_lv, nil, pairs_func)
    return table.concat(out)
end
```

Key points:

- **All keys are always bracket-quoted**: `["key"] = value`, even for
  identifier-legal keys. Numeric keys emit as `[1] = ...`.
- **String values use `%q`** — full Lua escaping (embedded newlines, quotes,
  nulls). Not JSON-compatible: `\n` in the source becomes a literal line
  break followed by Lua's `"` continuation (`%q` may emit `"\\\n"`).
- **No trailing comma suppression** — every k/v gets a trailing `,`, including
  the last one.
- **Indent is 4 spaces** (`dump.lua:8`).
- **Ordered=true** uses `ffi/util.orderedPairs` (lives in koreader-base, not
  in this repo). `orderedPairs` sorts keys alphabetically on each iteration.
  So **key order is NOT preserved across write**: every flush re-sorts
  top-level keys alphabetically and does the same for every nested table.
  This is actually great news for diffing.
- **No comments are preserved**. The file always opens with a single
  `-- <absolute path>` generated by `writeToFile`, then `return { ... }`.

### Example minimal shape

No real device sample, but the code guarantees the file starts:

```
-- /mnt/us/koreader/settings.reader.lua
return {
    ["foo"] = "bar",
    ...
}
```

### Atomicity / safety

- `backup()` (`luasettings.lua:252-267`) renames current file → `.old` if it's
  ≥60s old, before writing the new one. So the previous "stable" state is
  always recoverable from `.old`.
- `writeToFile` uses `force_flush=true` which calls `ffiUtil.fsyncOpenedFile`
  and optionally `fsyncDirectory` after rename (`util.lua:1152-1158`).

### Related files with identical format

- `defaults.custom.lua` — same dump path via `LuaDefaults:flush()`
  (`luadefaults.lua:153-158`).
- Per-document `*.sdr/metadata.*.lua` sidecar files via `docsettings.lua`
  (same pattern).
- `luadata.lua` — used for append-heavy files (bookmarks, search history).
  Totally different format: emits
  `<Name>Entry{ ... }` function-call lines, loaded with sandboxed env
  (`luadata.lua:38-80`). Not relevant to `settings.reader.lua`.

---

## 2. Plugin enable/disable mechanism

All in `frontend/pluginloader.lua`. The setting key is `plugins_disabled`,
stored in `settings.reader.lua` as a table-keyed-by-plugin-name:

```lua
plugins_disabled = { ["plugintwo"] = true, ... }
```

### Discovery (`pluginloader.lua:132-190`)

- Scan `DEFAULT_PLUGIN_PATH` (= `"plugins"` relative to CWD, i.e.
  `/mnt/us/koreader/plugins/` on Kindle) plus any `extra_plugin_paths`
  (usually `<data_dir>/plugins/` — auto-added on first run,
  `pluginloader.lua:155-161`).
- Each entry ending in `.koplugin` with `mode == "directory"` is a candidate.
- `plugin_name = entry:sub(1, -10)` — strips the `.koplugin` suffix. So
  `hello.koplugin` → key `"hello"`.
- If `plugins_disabled[plugin_name] == true`: marked disabled, only
  `_meta.lua` is loaded (for the plugin manager menu display); `main.lua` is
  skipped.

### Plugin self-disable (`pluginloader.lua:205-208`)

```lua
local ok, plugin_module = pcall(dofile, mainfile)
if not ok or not plugin_module then ...
elseif type(plugin_module.disabled) ~= "boolean" or not plugin_module.disabled then
    ...
```

A plugin's `main.lua` can return `{ disabled = true }` to exclude itself at
runtime. This is used as a capability gate — e.g. `SSH.koplugin/main.lua:21`
bails out if the device doesn't support it; `externalkeyboard.koplugin/main.lua:87-94`
bails unless the USB-OTG platform can keep up. The user toggle in
`plugins_disabled` does NOT override this.

### Toggling at runtime (`pluginloader.lua:285-293`)

```lua
local plugins_disabled = G_reader_settings:readSetting("plugins_disabled") or {}
plugin.enable = not plugin.enable
if plugin.enable then
    plugins_disabled[plugin.name] = nil
else
    plugins_disabled[plugin.name] = true
    self:stopPluginInstanceByName(plugin.name)
end
G_reader_settings:saveSetting("plugins_disabled", plugins_disabled)
```

Flipping a plugin then triggers `UIManager:askForRestart()`. Uninstall deletes
the folder via `ffiUtil.purgeDir` and clears the `plugins_disabled` entry
(`pluginloader.lua:310-320`).

### Plugin lifecycle

- **Load-time**: `dofile(main.lua)` returns a `WidgetContainer:extend{ name = ... }`
  table (see `plugins/hello.koplugin/main.lua:18-21` for canonical shape).
  Metadata is merged in from `_meta.lua` (`pluginloader.lua:214-223`).
- **Instantiation**: `PluginLoader:createPluginInstance(plugin, attr)`
  (`pluginloader.lua:347-356`) calls `plugin.new(plugin, attr)` — each plugin
  gets a fresh instance per `ReaderUI`/`FileManager`. The class is typically
  a subclass of `WidgetContainer` (`ui/widget/container/widgetcontainer.lua`).
- **`:init()`** is invoked by `WidgetContainer:new → extend → init`. Plugins
  register menu items (`self.ui.menu:registerToMainMenu(self)`), actions
  (`Dispatcher:registerAction`), etc.
- **Events**: Every `on<EventName>` method becomes an event handler, wrapped
  by `HandlerSandbox` for stack-trace logging (`pluginloader.lua:116-122`).
  Standard events: `onResume`, `onSuspend`, `onReaderReady`,
  `onDispatcherRegisterActions`, `onFlushSettings`, etc.
- **Stop/cleanup**: plugins can implement `stopPlugin(force)` and
  `deletePluginSettings()` (`pluginloader.lua:362-423`).

### Subsystems

- `extra_plugin_paths` (string or table): side-loaded plugins in a different
  directory (`pluginloader.lua:140-151`). Auto-populated to `<data_dir>/plugins/`.
- Providers (plugin names starting with `"provider"`) are loaded before other
  plugins (`pluginloader.lua:33-43, 244`) so that their globals exist when
  normal plugins init.

---

## 3. Which plugins ship by default

Every folder under `/tmp/koreader-src/plugins/` matching `*.koplugin` is
discovered at runtime. **KOReader has no hardcoded "default-disabled" list in
`plugins_disabled`** — a fresh install has `plugins_disabled = nil` and every
plugin whose `main.lua` doesn't self-gate is enabled.

36 plugin folders ship in the main repo:

```
archiveviewer, autodim, autostandby, autosuspend, autoturn, autowarmth,
batterystat, bookshortcuts, calibre, cloudstorage, coverbrowser, coverimage,
docsettingtweak, exporter, externalkeyboard, gestures, hello, hotkeys,
httpinspector, japanese, keepalive, kosync, movetoarchive, newsdownloader,
opds, perceptionexpander, profiles, qrclipboard, readtimer, SSH, statistics,
systemstat, terminal, texteditor, timesync, vocabbuilder, wallabag
```

Plugins that **always self-disable unconditionally** (debug/dev-only — return
`{disabled = true}` at top of main):

- `hello` — `plugins/hello.koplugin/main.lua:8-10` ("This is a debug plugin,
  remove the following if block to enable it")

Plugins that **self-disable conditionally based on device/platform**:

- `autodim` — `plugins/autodim.koplugin/main.lua:10` (needs frontlight control)
- `autostandby` — `plugins/autostandby.koplugin/main.lua:4` (needs standby support)
- `autosuspend` — `plugins/autosuspend.koplugin/main.lua:5` (needs suspend)
- `coverimage` — `plugins/coverimage.koplugin/main.lua:10` (needs writable screensaver path)
- `docsettingtweak` — `plugins/docsettingtweak.koplugin/main.lua:4` (???)
- `externalkeyboard` — `plugins/externalkeyboard.koplugin/main.lua:87-94` (needs USB OTG)
- `gestures` — `plugins/gestures.koplugin/main.lua:3` (needs gesture detector)
- `hotkeys` — `plugins/hotkeys.koplugin/main.lua:14` (physical keys required)
- `keepalive` — `plugins/keepalive.koplugin/main.lua:56`
- `SSH` — `plugins/SSH.koplugin/main.lua:21`
- `terminal` — `plugins/terminal.koplugin/main.lua:64`
- `timesync` — `plugins/timesync.koplugin/main.lua:10,28`

Every other plugin in the list is **default-enabled** on a capable device.
There is NO ship-level "off by default" list — KOReader's philosophy is
"enable everything your hardware supports, user opts out".

`exporter` also has `_meta.lua:5` `deprecated = { "feature", "Joplin " }` — not
disabled, just flagged for the plugin-manager UI.

**Implication for korea**: a `korea apply` to shrink a fresh install must
*add* the unwanted plugin names to `plugins_disabled`. There's no
"reset to ship defaults" shortcut — you must either remove the folder
(`ffiUtil.purgeDir` style) or toggle it off in the settings file.

---

## 4. Cross-device differences

### Data/install directory

| Platform | Install root | `home_dir` default |
|---|---|---|
| Kindle | `/mnt/us/koreader/` | `/mnt/us` (`kindle/device.lua:403`) |
| Kobo | `/mnt/onboard/.adds/koreader/` | `/mnt/onboard` (`kobo/device.lua:127`) |
| PocketBook | `/mnt/ext1/applications/koreader/` | `/mnt/ext1` (`pocketbook/device.lua:39`) |
| reMarkable | install root varies | `/home/root` (`remarkable/device.lua:72`) |
| Cervantes | `/mnt/public/.../koreader/` | `/mnt/public` (`cervantes/device.lua:41`) |
| Android | ext storage | `android.getExternalStoragePath()` (`android/device.lua:89`) |
| Sony PRSTUX | n/a | `nil` (`sony-prstux/device.lua:23`) |
| SDL desktop | n/a | `$XDG_DOCUMENTS_DIR` or `$HOME` (`sdl/device.lua:67`) |
| Generic | n/a | `nil` (`generic/device.lua:35`) |

`settings.reader.lua` always lives at `<install_root>/settings.reader.lua` on
embedded devices (because `data_dir = "."` = CWD = install dir); on desktop
it's under `~/.config/koreader/` or `~/Library/Application Support/koreader/`
(`datastorage.lua:35-39`). Boox is Android → standard Android path.

### Platform-specific plugin gating

Plugins self-disable as documented in §3. Examples:

- `gestures.koplugin` — touch devices only.
- `SSH.koplugin`, `terminal.koplugin` — Linux-ish platforms with the right
  binaries bundled.
- `externalkeyboard.koplugin` — USB-OTG capable hardware.
- `autowarmth.koplugin/_meta.lua:3` changes its own displayed name based on
  `Device:hasNaturalLight()` ("Auto warmth and night mode" vs "Auto night mode").

### Platform-specific settings keys

Some keys are only ever written on specific platforms — e.g.
`platform/kobo/koreader.sh:347` reads `color_rendering`;
`platform/*/koreader.sh:~123` reads `dev_startup_no_fbdepth`;
`platform/kobo/koreader.sh:536` reads `language`. These are grep'd from the
settings file by the launcher script before KOReader starts — the format
(`["key"] = value`) is stable enough that a `grep -q '\["color_rendering"\] = false'`
works. This is strong evidence that the dump format is not going to change
casually.

### Kindle specifics

Kindle runs old busybox/glibc; `kindle/device.lua:19-41` detects Wario/MTK
boards by parsing `/proc/cpuinfo`, `:43-46` detects hardfp Kindles. None of
that surfaces in `settings.reader.lua` directly; it's used to pick runtime
code paths. The `otaModel()` field (`kindle/device.lua:593`) does persist for
OTA updates.

### What korea must know per device

- Mount path for settings file (this is all we need for file I/O).
- `home_dir` default, so "no custom home_dir" can be represented as "matches
  ship default for this device" in the profile.
- Which plugins will self-disable anyway so they can be silently dropped from
  the effective plugin set (no point enabling `SSH` on a Kindle that'll bail).

---

## 5. SimpleUI internals

### Persistence model

**All settings live in `G_reader_settings`** — i.e. inline in
`settings.reader.lua`, not a separate file. Every SimpleUI read/write goes
through `G_reader_settings:readSetting(key)` / `:saveSetting(key, value)`.

Grep `sui_*.lua` confirms: every call site uses `G_reader_settings`; there's
no dedicated `LuaSettings:open("simpleui/...")` anywhere in the plugin.

### Key naming

Two prefixes dominate:

- `navbar_*` — user-visible UI config (nav bar, top bar, home screen).
  Examples: `navbar_enabled`, `navbar_topbar_enabled`, `navbar_mode`,
  `navbar_tabs`, `navbar_bar_size`, `navbar_pagination_size`,
  `navbar_homescreen_enabled`, `navbar_homescreen_header`,
  `navbar_homescreen_quick_actions_1_items`,
  `navbar_custom_qa_list`, `navbar_cqa_<id>` (per-quick-action config),
  `navbar_reading_goal`, `navbar_daily_reading_goal_secs`.
- `simpleui_*` — plugin meta / migration guards. Examples:
  `simpleui_enabled`, `simpleui_defaults_v1`, `simpleui_defaults_v2`,
  `simpleui_tb_item_search_button`, `simpleui_tb_fm_cfg`,
  `navbar_custom_qa_migrated_v1`.
- `sui_*` — a few scattered keys (e.g. `sui_tbr_list` in
  `sui_patches.lua:808,859`).
- Hooks into KOReader core keys (not SimpleUI's): `start_with` (value
  `"homescreen_simpleui"` is a SimpleUI-defined sentinel —
  `sui_patches.lua:37,671`), `home_dir`, `language`.

See `sui_config.lua:621-656` (`applyFirstRunDefaults`) for the authoritative
list of defaults applied on a fresh install.

Per-quick-action config is stored as *one key per action*:
`navbar_cqa_<id>` where `<id>` is auto-incremented (`sui_quickactions.lua:244,
301, 1243, 1314`). So the settings file can have arbitrarily many
`navbar_cqa_custom_qa_1`, `navbar_cqa_custom_qa_2`, etc. keys.

### Key stability across versions

No git history available (sandbox denies git). Evidence inside the source:

- `sui_config.lua:549` `M.migrateOldCustomSlots()` migrates from
  `navbar_custom_<slot>` (1-4) to the dynamic `navbar_cqa_<id>` scheme.
  Idempotent; guarded by `navbar_custom_qa_migrated_v1`
  (`sui_config.lua:550, 608`).
- `sui_config.lua:610-613` legacy rename: `navbar_enabled` → `simpleui_enabled`
  (only if the new key is absent, preserving user state).
- `sui_config.lua:663` v2 defaults layer (`simpleui_defaults_v2`) rewrites
  titlebar layout.

So SimpleUI **does rename keys between versions**, but it owns the migration
path with sentinel guards. korea's SimpleUI codec must pick the right
"schema version" to write, and leave the old keys alone if they exist (the
plugin will migrate them on first boot).

Git log was requested but the sandbox denied `git -C /tmp/simpleui log`. The
`.git` dir exists and is a shallow clone; running `git log --oneline --
sui_config.lua` locally will show the version tags around each migration
step — worth doing once out of the sandbox.

---

## 6. Schema stability (KOReader core)

`git log` against `/tmp/koreader-src` was denied by the sandbox. Using
`frontend/ui/data/onetime_migration.lua` as a proxy for "keys renamed by
KOReader itself". That file is literally a dated list of migrations KOReader
applies on upgrade — so it's a lower bound on schema churn.

Sample renames from `onetime_migration.lua`:

- `:234` 20210518 ReaderFooter restructure (#7702)
- `:263` 20210521 `zoom_factor` → `kopt_zoom_factor` (#7728)
- `:276` 20210531 deprecate `zoom_mode` in global settings (#7780)
- `:299` 20210629 duration format moved
- `:311` 20210715 rename `numeric` → `natural` (sort order)
- `:347` 20210902 remove old `auto_warmth` settings
- `:527` 20230531 rename `strcoll_mixed` → `strcoll` + `collate_mixed` (#10198)
- `:563` 20230710 migrate KOSync to full settings table (#10669)
- `:649` 20231217 `folder_shortcuts`: array → hash (#11221)
- `:664` 20240408 drop screensaver `image_file` (#11549)
- `:680` 20240731 store unscaled progress bar margins (#12243)
- `:717` 20240915 `metric_length` → `dimension_units` (#12507)
- `:755` 20241207 patch-management plugin removed, moved to core
- `:771` 20241228 wallabag refactor
- `:836` 20250302 OPDS settings moved from `settings.reader.ui` to
  `settings/opds.lua` — NB: first time non-trivial keys have moved *out* of
  the big settings file into a sub-file.

Takeaway: a ~1-2 key renames per year on average. Not zero, not constant
churn. Most renames are well-documented via PR numbers. korea must target a
KOReader version range; a thin "migration rules" table (keyed by KOReader
version) can replicate what `onetime_migration.lua` does on-device.

The `:836` 2025-03-02 note is significant: OPDS moved to
`settings/opds.lua` — a *separate* LuaSettings file. Some subsystems are now
splitting out. korea's codec should assume `<data_dir>/settings/` may contain
additional LuaSettings-formatted files (same dump format).

---

## 7. Real config file

No Kindle mounted. Shape guarantees from code alone:

- Line 1: `-- <absolute path of file>` (injected by `util.writeToFile`,
  `util.lua:1144`).
- Line 2: `return {` .
- N lines: `    ["<key>"] = <value>,` per top-level key, **alphabetically
  sorted** (from `orderedPairs`). Nested tables indented by 4 spaces per
  level. Every key-line ends with `,`.
- Last line: `}` then newline.
- No blank lines, no inline comments, no multi-line comments.
- Strings use Lua `%q` escaping: `\n` may appear as a literal newline inside
  `"..."` pairs (Lua tolerates this; `string.format("%q", "a\nb")` emits
  `"a\\\nb"` — a backslash + newline inside quotes).
- Numbers: integers as integers, floats with `tostring` (may have floating
  imprecision — `autowarmth.koplugin/main.lua:550` even has a comment noting
  "round up, due to reduced precision in settings.reader.lua").
- Booleans: `true` / `false` lowercase.

Example synthetic (matches format exactly):

```lua
-- /mnt/us/koreader/settings.reader.lua
return {
    ["device_id"] = "3F0A...",
    ["font_size"] = 20,
    ["home_dir"] = "/mnt/us/Books",
    ["night_mode"] = true,
    ["plugins_disabled"] = {
        ["SSH"] = true,
        ["hello"] = true,
    },
}
```

---

## 8. Plugin metadata (`_meta.lua`)

Every plugin has a `_meta.lua` with a consistent minimal shape:

```lua
local _ = require("gettext")
return {
    fullname = _("<display name>"),
    description = _([[<longer explanation>]]),
}
```

Verified across all 36 plugins (see grep in investigation). Standardized
fields:

- `fullname` — always present, always wrapped in `_()` for i18n.
- `description` — always present, `_([[...]])`.

Optional / rare fields:

- `deprecated` — only in `exporter.koplugin/_meta.lua:5`:
  `deprecated = { "feature", "Joplin " }`. Format: `{ kind, detail }` where
  `kind` ∈ `{"remove", "feature"}` (`pluginloader.lua:24-27`).
- `fullname` / `description` can be *computed* — see
  `autowarmth.koplugin/_meta.lua:3` which calls
  `require("device"):hasNaturalLight()` at load time. So `_meta.lua`
  execution requires a KOReader runtime — **not safe to `dofile` outside
  KOReader**. korea must extract these fields with a more tolerant scheme
  (e.g. read the string literals directly, or eval in a stub env that
  returns `false` for any method call).

**Missing / not standardized** — nothing KOReader itself cares about:

- No version field.
- No dependency declarations (neither on KOReader version nor on other
  plugins).
- No platform field (platform-gating is inside `main.lua` as runtime checks,
  not declared).
- No author / URL / license.
- No `name` field — `pluginloader.lua:217-220` actively logs a *warning* if
  `_meta.lua` contains `name` ("deprecated and will be ignored"). The name
  comes from the folder (`<n>.koplugin`).

Implication: a korea plugin registry cannot rely on any metadata from the
plugin itself other than `fullname` + `description`. Everything else
(version, URL, dependency) has to be maintained externally (by korea, or by
the plugin author in a `korea.yaml` alongside the plugin).

---

## 9. Settings format — executable Lua or pure data?

**Both, but the loader treats it as executable.**

`luasettings.lua:31` — `pcall(dofile, new.file)`. That's `dofile`, which is:

1. `loadfile(path)` — parses the file as a Lua chunk. No mode restriction
   given → both text and binary (bytecode) Lua are accepted.
2. Runs the chunk, returning its return value.

There is no sandbox, no env restriction. Contrast `luadata.lua:72` which
uses `loadfile(path, "t", env)` — `"t"` forbids bytecode and `env` shadows
globals. `LuaSettings` does neither.

So the loader is a *full Lua interpreter*. KOReader itself always *writes*
pure data (a single `return { ... }`), so in practice every file you'll see
in the wild is pure data. But an attacker (or curious user) editing the file
to include `os.execute(...)` would have that run at next boot — with the
process privileges of KOReader.

**What this means for korea**:

- **Writing is trivial**: reproduce `dump()`'s output bit-for-bit. ~80 lines
  of code in any language. As long as the serialization produces `return { ... }`
  with correct Lua escaping, KOReader will load it.
- **Reading the subset KOReader writes is trivial**: a recursive-descent
  parser over `{`, `}`, `[`, `]`, `=`, `,`, `"..."` (with `%q` escape
  handling), numbers, `true`/`false`/`nil`. No string interpolation, no
  concatenation, no operators appear in dump output. Grammar is ~10 rules.
  The platform/`koreader.sh` scripts even `grep` for `["key"] = value` —
  that's how simple it is.
- **Reading user-modified files**: if a user hand-edits `settings.reader.lua`
  and introduces e.g. `["x"] = 1 + 2`, KOReader will evaluate it (2+1=3) but
  our pure-data parser will barf. Mitigation: on parse failure, fall back to
  an embedded Lua or shell out. Rare case.

### Evidence table

| Feature used by writer | Can a data parser handle it? |
|---|---|
| `{}` nesting | yes |
| `["string"] = v` (always bracketed) | yes |
| `[1] = v` numeric keys | yes |
| `%q` string escapes (`\n`, `\"`, `\\`, embedded nulls) | yes, needs careful impl |
| numbers (int, float, scientific) | yes |
| `true`, `false` | yes |
| `nil` | yes |
| Functions (written as `function: 0xADDR`) | **broken anyway** — dumped values don't parse back; KOReader never reads these (they're written in error cases, and a subsequent dofile would syntax-error). Not a real concern. |
| Comments | not emitted by dump |
| Multi-line strings `[[...]]` | not emitted by dump |

---

## 10. Existing import/export inside KOReader

### Reusable infrastructure

- `frontend/dump.lua` — the serializer. Self-contained, ~75 lines, no
  dependencies beyond `ffi/util.orderedPairs` (which is a simple
  alphabetical-key sort). Easy to port.
- `frontend/luasettings.lua` — the load/save wrapper.
- `frontend/luadata.lua` — append-oriented variant (sandboxed loading).
- `frontend/persist.lua` — a lower-level codec registry (`Persist.getCodec`
  at `persist.lua:301`) supporting luajit, zstd, bitser codecs for
  cache/serialization. Unrelated to settings; irrelevant for korea.
- `frontend/readcollection.lua`, `readhistory.lua` — domain-specific
  persisters using LuaSettings underneath.

### Import/export features

- **`exporter.koplugin`** — user-facing export, but of highlights/annotations
  (JSON, MD, HTML, Joplin) — not of settings. Not reusable for korea.
- **`plugins/httpinspector.koplugin/main.lua:547`** exposes
  `g_settings/` over HTTP: "your global settings saved as
  settings.reader.lua". This is a debug/HTTP-browse endpoint; not an import
  path, but confirms the file is canonical.
- **`frontend/apps/filemanager/filemanagersetdefaults.lua`** — the UI
  underneath "Advanced settings" that edits `defaults.custom.lua`. Uses
  `ffiUtil.orderedPairs` directly (`:85, :139`) to present keys.
- **`frontend/apps/filemanager/lib/md.lua:424`** — dumps metadata to Markdown
  using `orderedPairs`. Not relevant.
- **No built-in profile import/export system.** No `exportSettings` /
  `importSettings` / "backup config" function anywhere. A
  `plugins/profiles.koplugin` exists but it's about *reading profiles*
  (PDF/EPUB render settings) — unrelated to global config snapshotting.

Bottom line: KOReader has no analog to `korea` built-in. The pieces we can
reuse (conceptually, not as code) are `dump.lua` (serialization format) and
the `LuaSettings` open/flush cycle (file layout + backup semantics). Both
are small enough to reimplement.

---

## What docs/03-architecture.md got wrong

1. **"We need to preserve order and formatting where possible"**
   (`03-architecture.md:41`).
   False. KOReader itself does NOT preserve order — every flush re-sorts
   alphabetically via `orderedPairs`. Matching that (sort keys alphabetically
   before emit) is sufficient for bit-for-bit round-trip compatibility. We
   don't need to preserve user-supplied order because KOReader throws it away
   on first save.

2. **"Plugins are folders. Enable/disable controlled by (a) folder presence
   and (b) `plugins_disabled` set"** (`03-architecture.md:52-56`).
   Mostly right, but missing: **(c)** the plugin's own `main.lua` can
   return `{disabled = true}` and bypass both. This is how ~13 of 36 plugins
   self-gate on device capability. korea cannot force-enable these by
   clearing `plugins_disabled` — they'll still refuse to load. The profile
   schema needs to treat "enabled" as a *request*, not a guarantee.

3. **"SimpleUI stores config under specific keys in `settings.reader.lua`.
   Each module's state is a nested subtable"** (`03-architecture.md:62`).
   First half right, second half wrong. SimpleUI stores mostly *flat* keys
   with prefix conventions (`navbar_*`, `simpleui_*`), not nested subtables.
   Some keys hold tables (e.g. `navbar_tabs` is an array, `navbar_cqa_<id>`
   is a record), but there's no single `simpleui = { ... }` parent. This
   matters for profile ergonomics: the user-facing schema has to decide
   whether to group these under `simpleui:` in YAML (requires a mapping
   table) or expose the raw flat keys.

4. **"Recommendation: embedded Lua interpreter (mlua)"**
   (`03-architecture.md:44-48`).
   Overkill for the common case. Writing is trivial string formatting;
   reading the dump format is a simple recursive-descent parser. An embedded
   Lua could be a *fallback* for user-hand-edited files, but the primary
   path doesn't need it. See confidence verdict below.

5. **"plugin_registry: hardcoded YAML mapping name → URL"**
   (`03-architecture.md:58`).
   The `_meta.lua` files expose only `fullname` + `description` and nothing
   else (no version, deps, URL). The registry has to carry all that
   additional metadata itself — there's no useful subset korea can scrape
   from the plugin source. (True for main KOReader plugins *and* third-party
   ones like SimpleUI.)

6. **The `.korea/backups/<timestamp>.lua` safety pattern**
   (`03-architecture.md:82`).
   Not wrong, but note KOReader *already* maintains a `.old` sibling file
   (`luasettings.lua:252-267`). korea should not rely on `.old` as its own
   backup (KOReader will overwrite it), but should be aware of it for
   recovery flows ("device has `.old` newer than our expected state →
   something wrote since pull → abort").

---

## What's hard vs trivial

### Trivial

- **Reading settings.reader.lua**: ~10-rule grammar, no arithmetic, no
  string concat, nested-table + string + number + boolean + nil. A few
  hundred lines in Rust/Go/TS.
- **Writing settings.reader.lua**: port `dump.lua` (75 lines) with
  alphabetical key sort. Must match `%q` escaping rules bit-for-bit to round-trip.
- **Plugin folder manage**: ship/remove directories. Same on all devices.
- **Enable/disable**: toggle `plugins_disabled[name]` table.
- **Detecting device type at mount**: folder presence (e.g.
  `.kindle/` marker on Kindle root, or `/mnt/us` when mount is `/Volumes/Kindle`
  on macOS). Mechanical.
- **Backup before write**: copy file to `.korea/backups/` — standard.

### Medium

- **Lua `%q` escape compatibility**: `string.format("%q", s)` has quirks —
  `\n` may be emitted as a literal newline inside quotes, control chars as
  `\N` where N is decimal. A naïve JSON-escape won't match. Need a faithful
  port (easy but fiddly).
- **Handling user-edited files with expressions**: `["x"] = 5 + 3` or
  `["y"] = math.huge`. Pure-data parser fails. Either (a) bundle a
  minimal Lua interpreter (mlua-lite), (b) fall back to shelling out, or
  (c) error-and-abort with a clear message. Pick based on philosophy.
- **`_meta.lua` extraction**: may call `require("device")` at load time
  (`autowarmth`). Can't just `dofile` in a sandbox — either grep the string
  literals or run in a stub env where `require` returns a chainable fake.
- **SimpleUI schema versioning**: key layout evolves; the plugin owns its own
  migrations via `simpleui_defaults_v1`, `_v2` guards. korea's SimpleUI codec
  must pin against a plugin version and either (a) write keys for the newest
  it knows, letting the plugin's own migrator upgrade on-device, or (b)
  replicate the migration logic for `pull`. (a) is safer.
- **Cross-device path abstraction**: 8 device flavors, each with a distinct
  `home_dir` default and install root. Manageable table lookup.

### Hard

- **Schema drift across KOReader versions**: ~1-2 renamed keys per year
  (visible via `onetime_migration.lua`). A profile written for KOReader
  2023.11 may have keys that 2025.03 renamed or removed. Strategies:
  - Pin profiles to a KOReader version (`koreader_version: 2024.10` in YAML).
  - Ship a migration rules table paralleling `onetime_migration.lua`.
  - Accept churn: `korea doctor` warns about known-renamed keys.
- **Per-document sidecar settings**: `<book>.sdr/metadata.*.lua` files
  replicate the same format but are book-specific and numerous. If korea
  wants to include "my book is at page X" in a profile, it needs to handle
  these too — which means enumerating every sidecar in
  `<data_dir>/docsettings/` or beside each document. Bigger scope.
- **SimpleUI quick-action keys** (`navbar_cqa_<auto-id>`): the *set* of keys
  is dynamic, not fixed. A pull has to enumerate all `navbar_cqa_*` keys and
  reconstruct the action list by joining with `navbar_custom_qa_list`.
  Brittle against plugin behavior changes.
- **Verifying a write "took"**: KOReader caches `G_reader_settings` in
  memory. If the app is running when korea writes, next flush overwrites our
  changes. korea must require the app to be off (unmounted from USB → app
  exited on Kindle) before apply. Sanity-check via some form of lockfile or
  last-modified heuristic.

---

## Confidence verdict: pure data parser vs embedded Lua

**Answer: a pure text/data Lua parser can handle `settings.reader.lua` for
the 99.9% case; an embedded interpreter is NOT required.**

### Evidence

1. **The write path is deterministic and narrow.** Every file KOReader
   writes comes from `dump.lua`'s `_serialize`, which emits exactly these
   syntactic forms (`dump.lua:20-58`):

   - `{` + indented children + `}`
   - `["<%q-escaped-string>"] = ...,`
   - `[<number>] = ...,`
   - `"<%q-escaped-string>"`
   - `<tostring-of-number>` (integer or float)
   - `true` / `false`
   - `nil`
   - (`function: 0x...` — but only in error cases; file then fails to
     reload and KOReader discards via `pcall`)

   No operators, no concatenation, no variables, no function calls. The
   grammar is context-free and small.

2. **KOReader itself parses this format with `grep`** in its own launcher
   scripts: `platform/kobo/koreader.sh:347, 359, 435, 536` all do
   `grep -q '\["key"\] = value' settings.reader.lua`. This is "insufficient"
   for full parse but confirms the format is literal and line-oriented at
   top level.

3. **The loader is only `dofile` because it's the shortest Lua code path.**
   `luasettings.lua:31` picks `dofile` to avoid reimplementing a parser —
   not because files actually need a Lua runtime. When a file fails to
   parse, the fallback is `data = {}` (no recovery attempt) — which means
   KOReader doesn't itself handle "partial/weird" Lua either.

4. **The platform-launch scripts grepping this file (`kobo`, `remarkable`,
   `cervantes`) would break silently if the dump format changed.** This is
   strong social pressure against format churn. `dump.lua` has not changed
   meaningfully in years (the `ordered` parameter was added, but the output
   shape is the same).

5. **User-hand-edited files are rare and not KOReader-endorsed.** The
   `defaults.lua` preamble literally says "copy defaults.lua to
   defaults.custom.lua and make the changes there, or go to [Tools] > More
   tools > Advanced settings" — not "hand-edit settings.reader.lua".

### Recommended implementation for korea

1. **Primary**: hand-rolled recursive-descent parser for the dump subset
   (strings with %q escape handling, numbers, booleans, nil, nested tables
   keyed by strings or integers). Reject expressions. ~200-400 lines in Rust
   or Go. Unit-test against `dump.lua`'s output for representative settings.

2. **Fallback**: if parse fails, either error with a clear "file was
   hand-edited, not in dump format" message (safe default), or optionally
   shell out to `lua -e '...'` if the user has a Lua binary installed
   (opt-in). An embedded Lua (mlua/gopher-lua) is appropriate only if you
   want to support hand-edited files by default.

3. **Writer**: direct port of `dump.lua` with `ordered = true` hardcoded.
   ~80 lines. Must match `string.format("%q", ...)` semantics exactly. The
   reference implementation is in luajit source; test cases should include
   strings with `\n`, `\"`, `\\`, `\0`, and high-bit bytes.

This keeps korea as a single static binary with no Lua runtime dependency.
The marginal loss (unable to round-trip hand-edited exotic Lua) is accepted
with a clear error message. Embedded Lua is a "feature flag" for later, not
a v1 requirement.

---

## Loose ends / follow-ups

- **Can't run git log** in the sandbox. Manual follow-up:
  `cd /tmp/simpleui && git log --oneline -- sui_config.lua` to get
  migration-commit dates, and `cd /tmp/koreader-src && git log --since="1
  year ago" --oneline frontend/ui/data/onetime_migration.lua` to see which
  migrations were added recently (indicates where churn is happening).
- **No live Kindle mounted.** When one is available, verify: `wc -l
  settings.reader.lua`, check actual top-level key count (expected: 100-300
  for a power user, less for a fresh install), and confirm the first line is
  literally `-- /mnt/us/koreader/settings.reader.lua`.
- **`onetime_migration.lua` itself is a gold mine**: if korea wants to be
  KOReader-version-aware, reading that file directly gives us a rules table
  almost for free.
- **`settings/opds.lua` (2025-03-02 migration)** is the first separate
  LuaSettings file. If this pattern continues, korea's codec needs to scan
  `<data_dir>/settings/` too, not just `settings.reader.lua`.
