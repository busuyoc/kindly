# 97 — KOReader plugin loader analysis: trust boundaries for quarantine design
### *Source-level findings from `pluginloader.lua` and `userpatch.lua` — shapes W39–W41*

Date: 2026-04-23.
Source: `/Volumes/Kindle/koreader/frontend/pluginloader.lua` (353 lines),
`/Volumes/Kindle/koreader/frontend/userpatch.lua` (175 lines),
`/Volumes/Kindle/koreader/reader.lua` (boot sequence).
Companion: docs/96-red-team-v0.11.1.md (S4 confirmed this analysis).

---

## 0. Why this document exists

The W41 quarantine proposal (doc 96 §6) assumed `plugins_disabled`
prevents code execution for disabled plugins. Reading the actual
KOReader source reveals this is **partially false**: disabled plugins
still execute `_meta.lua`. This document records the three findings
from the source and their implications for kindly's hardening plan.

---

## 1. Finding: `plugins_disabled` applies to all plugin paths

**File:** `pluginloader.lua:130-186` (`_discover` function).

```lua
local plugins_disabled = G_reader_settings:readSetting("plugins_disabled")
-- ...
for _, lookup_path in ipairs(lookup_path_list) do
    -- lookup_path_list = DEFAULT_PLUGIN_PATH + extra_plugin_paths
    for entry in lfs.dir(lookup_path) do
        if plugins_disabled and plugins_disabled[entry:sub(1, -10)] then
            mainfile = metafile   -- load _meta.lua instead of main.lua
            disabled = true
        end
    end
end
```

The `plugins_disabled` check at line 170 runs identically for the
default `plugins/` directory AND every `extra_plugin_paths` entry.
No special-casing per path.

**Implication:** quarantine-by-default (setting `plugins_disabled[name]
= true` on install) works regardless of where the plugin lives on the
filesystem. The `extra_plugin_paths` attack vector from doc 88 §4.3
does not bypass `plugins_disabled`.

---

## 2. Finding: disabled plugins still execute `_meta.lua`

**File:** `pluginloader.lua:169-172, 202`.

When a plugin is disabled:
```lua
if plugins_disabled and plugins_disabled[entry:sub(1, -10)] then
    mainfile = metafile   -- ← switches to _meta.lua
    disabled = true
end
```

Later, in `_load`:
```lua
local ok, plugin_module = pcall(dofile, mainfile)  -- line 202
```

`dofile` executes `_meta.lua` unconditionally. A normal `_meta.lua`
is harmless:

```lua
local _ = require("gettext")
return {
    name = "SSH",
    fullname = _("SSH"),
    description = _([[Connect and transfer files to the device using SSH.]]),
}
```

But nothing prevents an attacker from putting arbitrary Lua in
`_meta.lua`. A disabled plugin with a malicious `_meta.lua` executes
on every KOReader boot. The "disabled" state only prevents
`main.lua` from loading — `_meta.lua` is the metadata entrypoint
and is always trusted.

**Implication:** quarantine alone is not sufficient. Kindly must also
validate `_meta.lua` content at install time. The validation is
feasible because the `_meta.lua` contract is narrow:

- Must return a table
- Table fields: `name` (string), `fullname` (string or gettext call),
  `description` (string or gettext call), `deprecated` (table or nil),
  `version` (string or nil)
- Only allowed `require`: `require("gettext")`
- No other function calls, no assignments, no side effects

**Validation approach:** parse `_meta.lua` as text and reject if it
contains any token outside the allowlist: `return`, `{`, `}`, string
literals, `require("gettext")`, `_()`, `nil`, `true`, `false`,
field names from the known set. This is a tiny allowlist on a
4-line file, not a general-purpose Lua analyzer.

Alternatively: kindly could **replace** the shipped `_meta.lua` with
a synthesized one built from the manifest's metadata fields. The
original `_meta.lua` is preserved in the safety snapshot but never
written to the device. This sidesteps validation entirely — kindly
controls the bytes that `dofile` will execute.

---

## 3. Finding: patches execute unconditionally, no disable mechanism

**File:** `userpatch.lua:47-88, 92-103`, `reader.lua:24-27`.

Boot sequence:
```lua
-- reader.lua:24-26 — runs BEFORE settings are loaded
local userpatch = require("userpatch")
userpatch.applyPatches(userpatch.early_once)  -- priority "0"
userpatch.applyPatches(userpatch.early)       -- priority "1"
```

Patch loader:
```lua
-- userpatch.lua:66-84
for i, entry in ipairs(patches) do
    local fullpath = dir .. "/" .. entry
    if fullpath:match("%.lua$") then
        local ok, err = pcall(dofile, fullpath)  -- ← unconditional execution
    end
end
```

No `patches_disabled` dict. No settings check. No allowlist. Every
`.lua` file in `koreader/patches/` matching the priority pattern
(`N-name.lua` where N is `0`–`9`) runs via `dofile`.

Priority `0` (`early_once`) runs **before `G_reader_settings` is even
loaded** (reader.lua:24 vs reader.lua:33). At this point KOReader
hasn't read `settings.reader.lua` yet — there is no mechanism to
disable a priority-0 patch via settings even in theory.

**Additional risk amplifier:** `userpatch.lua` exports reflection
utilities as first-class API:

```lua
function userpatch.getUpValue(func_obj, up_value_name)    -- debug.getupvalue
function userpatch.replaceUpValue(func_obj, up_value_idx, replacement_obj)  -- debug.setupvalue
function userpatch.registerPatchPluginFunc(plugin_name, patch_func)  -- hook plugin instantiation
```

These allow any patch to:
- Read private locals from any KOReader module (`getUpValue`)
- Replace private locals in any module (`replaceUpValue`)
- Intercept and modify any plugin at instantiation time
  (`registerPatchPluginFunc`)

A malicious patch with priority `1` can hook `pluginloader.lua`'s own
`createPluginInstance` to inject code into *every* plugin that loads
after it, including bundled ones whose hashes we've already verified.

**Implication:** patches are strictly more dangerous than plugins.
They run earlier, have no disable switch, and have blessed access to
reflection primitives that can subvert the entire plugin system.

Kindly's current flag matrix treats `--accept-patches` as equivalent
to `--accept-plugins`. This is wrong. Patches need their own trust
tier.

---

## 4. S4 in context

S4 from doc 96 confirmed this analysis in practice. The attack:

1. Ship `bookshortcuts.koplugin` verbatim (BUNDLED_MATCH — passes W32)
2. Ship `patches/2-analytics-hook.lua` alongside it (evades W36
   scanner via byte-table assembly)
3. Run with `--accept-plugins --accept-patches --strict-imports`
4. Output: "scanner: 1 file(s) scanned, 2 suppressed by catalog —
   no novel findings"
5. Patch lands in `koreader/patches/`, executes on boot, reads
   `settings.reader.lua`, POSTs credentials to attacker server

The plugin is a decoy. The payload is in the patch. Every trust gate
kindly has — catalog hashes, strict imports, scanner — applies to the
plugin and not to the patch. The patch is the shadow entry point.

---

## 5. Concrete hardening (inputs to W39–W41 design)

### 5.1 `_meta.lua` sanitization at install time

When kindly installs an uncatalogued plugin, replace the shipped
`_meta.lua` with a kindly-synthesized version built from the
manifest's `meta.name`, `meta.description`, and the plugin's
`_meta.lua` parsed fields (name, fullname, description only). The
original `_meta.lua` is archived in the safety snapshot. The version
written to the device contains only the return-table shape KOReader
expects — no executable code beyond `require("gettext")` and `_()`.

For catalogued MATCH plugins: the `_meta.lua` is hash-verified, so
no replacement needed. The bytes are known-good.

### 5.2 Patch trust tier

Patches require a separate, louder flag: `--accept-boot-code` (not
`--accept-patches`). The name makes the risk explicit: this code runs
at KOReader startup with full process access and no off switch.

Under `--strict-imports`, patches are hard-blocked unless the user
provides a per-file hash pin: `--expect-patch-hash <sha256>`. This
is the same trust model as `--expect-hash` for the manifest — the
user obtained the hash out-of-band and asserts it.

Without `--strict-imports`, the `--accept-boot-code` flag surfaces a
mandatory warning block:

```
⚠ This Setup ships 1 patch file(s) — Lua code that executes at
KOReader startup with full device access. Patches CANNOT be disabled
via KOReader's plugin manager. kindly cannot verify their safety.

  patches/2-analytics-hook.lua  (1.1 KB)

You are vouching for this code yourself.
```

### 5.3 Patch quarantine via filename

KOReader's patch loader matches `^<priority><digits>%-` in filenames
(userpatch.lua:55). Files that don't match the pattern are ignored.
Kindly can quarantine a patch by installing it with a `.pending`
extension or under a `patches/.pending/` subdirectory — the loader
won't pick it up. The user must rename the file manually to activate.

This is weaker than plugin quarantine (requires shell/SSH access to
rename) but it's the only mechanism available given the loader's
design. The alternative — modifying the loader itself — is out of
scope.

### 5.4 Bytecode hard-block

Check every `.lua` file for the LuaJIT/Lua bytecode header (`\x1bLua`)
before writing to the device. Present → refuse the entire archive.
Legitimate plugins always ship source. Bytecode is either:
- A build artifact the author should clean up
- Deliberate obfuscation to prevent inspection

Five lines of code, permanent closure of the detection-bypass-via-
compilation vector.

### 5.5 Plugin quarantine (revised from doc 96 W41)

Install uncatalogued plugins with `plugins_disabled[name] = true` in
`settings.reader.lua`. Combined with `_meta.lua` sanitization (§5.1),
the plugin lands on the device with:
- `main.lua`: present but not executed (disabled)
- `_meta.lua`: kindly-synthesized, harmless return-table
- User must enable manually in KOReader's plugin manager

For BUNDLED_MATCH plugins: install enabled, no sanitization, no
quarantine. The bytes are trusted.

For COMMUNITY_MATCH plugins (future W40): install enabled but with
`_meta.lua` sanitization. The community catalog vouches for the hash
but kindly doesn't trust the `_meta.lua` contract unless it verifies
it.

---

## 6. Defense matrix after proposed hardening

| Attack | pre-fix | post-W39 (flags) | post-W41 (quarantine) |
|--------|---------|-------------------|----------------------|
| S1 catalog impersonation | fixed (e8ce545) | fixed | fixed |
| S2 `_G` obfuscation in plugin | strict blocks | strict blocks | quarantine blocks |
| S3 byte-table in uncatalogued plugin | **passes** without strict | flag gate blocks default path | quarantine blocks |
| S3 same, with `--accept-community-plugins` | — | advisory + ack required | quarantine: lands disabled |
| **S4 patch-in-MATCH** | **passes under full strict** | `--accept-boot-code` required | patch quarantined via filename |
| S4 with `--accept-boot-code` | — | mandatory warning | `.pending` extension: user renames to activate |
| Bytecode payload | **passes** | bytecode hard-block | bytecode hard-block |
| Malicious `_meta.lua` in disabled plugin | **executes** | `_meta.lua` sanitized | `_meta.lua` sanitized |

---

## 7. Priority order

1. **Bytecode hard-block** — 5 lines, closes a vector permanently.
2. **`_meta.lua` sanitization** — ~30 lines, prevents disabled-plugin
   code execution.
3. **`--accept-boot-code` flag split** — ~20 lines flag + tests,
   makes patch risk explicit.
4. **Patch quarantine via `.pending`** — ~15 lines, neutralizes S4.
5. **Flag default flip** (`--accept-plugins` → strict by default) —
   closes S3's default pathway.
6. **Community catalog** (W40) — extends trust beyond 37 bundled.
7. **Signing** (v0.13+) — the real long-term fix.

Items 1–4 are ~70 LOC total and close S4 + the `_meta.lua` gap +
bytecode. Item 5 is the S3 closure. Together they're 2–3 days of
work.
