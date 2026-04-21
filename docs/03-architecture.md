# Architecture (draft)

## Layers

```
┌─────────────────────────────────────────────┐
│  CLI (korea apply/pull/diff/init/share)     │
├─────────────────────────────────────────────┤
│  Profile parser (YAML → internal model)     │
│  Profile renderer (internal model → YAML)   │
├─────────────────────────────────────────────┤
│  Diff engine (model ↔ model)                │
│  Preset registry (built-in profiles)        │
│  Secrets resolver (env/file/1password)      │
├─────────────────────────────────────────────┤
│  Device adapter — Lua settings codec        │
│  Device adapter — Plugin folder manager     │
│  Device adapter — SimpleUI codec (shim)     │
├─────────────────────────────────────────────┤
│  Filesystem I/O (mount detection, safe writes) │
└─────────────────────────────────────────────┘
```

## The hard part: `settings.reader.lua` codec

KOReader's main config is a Lua file returning a nested table. Not JSON, not TOML — Lua. Example shape:

```lua
-- ~/Kindle/koreader/settings.reader.lua
return {
  ["home_dir"] = "/mnt/us/Books",
  ["night_mode"] = true,
  ["font_size"] = 20,
  ["gestures"] = {
    ["tap_top_left"] = "toggle_night_mode",
  },
  -- ...hundreds more keys
}
```

We need to **parse** this into JSON-ish structure **and write it back** preserving order and formatting where possible. KOReader writes this file itself; our writes must be readable by it.

**Options:**
1. **Embed a Lua interpreter** (mlua crate in Rust, or native Lua in Go). Load the file, read the table, walk it. Writes are string-serialized using KOReader's own dump format.
2. **Hand-rolled parser** for the subset KOReader uses (strings, numbers, booleans, nested tables with string keys). Doable but brittle.
3. **Shell out to lua** if installed. Portable but a dep.

**Recommendation:** option 1 (embedded interpreter). Most robust. `mlua` in Rust is well-maintained. Alternative: `gopher-lua` if Go.

## Plugin management

Plugins are folders in `koreader/plugins/`. Enable/disable is controlled by:
- Presence of the folder (install/uninstall)
- Entry in `settings.reader.lua` → `plugins_disabled` set

So `korea apply` plugin changes = (a) ensure folders exist, fetching from registry if missing, (b) update `plugins_disabled` set.

**Plugin registry (v1):** a hardcoded YAML in the binary mapping name → download URL. Later: user-pluggable via `~/.korea/registry.yaml`.

## SimpleUI settings

SimpleUI stores config under specific keys in `settings.reader.lua`. Each module's state is a nested subtable. We provide a typed schema (`simpleui` in profile) that maps to those keys — hiding the raw key names from the user.

This makes SimpleUI upgrades risky: if v1.5 renames internal keys, our codec breaks. Mitigation: version our SimpleUI shim (`simpleui_schema_version: 1.4`) and support multiple.

## Commands

| Command | Action |
|---|---|
| `korea init <preset>` | Scaffold `./korea.yaml` from a built-in preset |
| `korea apply <file>` | Push profile to device |
| `korea pull` | Read device → write `./korea.yaml` |
| `korea diff` | Compare local profile to device state |
| `korea presets list` | Show built-in presets |
| `korea plugins search <q>` | Search registry |
| `korea share` | Upload profile to gist, print URL |
| `korea doctor` | Sanity-check device & profile |

## Safety

- Always write settings to a `.tmp`, validate parseable Lua, atomic rename
- Snapshot `settings.reader.lua` to `.korea/backups/<timestamp>.lua` before overwriting
- Dry-run flag on `apply` showing exact writes before committing

## Tech stack (proposal)

- **Rust** (single binary, no runtime, mlua for Lua interop) — my lean
- Alt: Go (simpler, gopher-lua, faster to ship)
- Alt: TypeScript/Bun (fastest for Claudiu given stack, but Lua parsing is weaker)

Decision in `04-open-questions.md`.
