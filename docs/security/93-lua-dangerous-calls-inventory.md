# 93 — Dangerous Lua call inventory in KOReader bundled plugins
### *Data input for W36 (Lua static scanner). No design opinions — raw findings only.*

Date: 2026-04-23.
Source: `/Volumes/Kindle/koreader/plugins/` on a current KOReader install (40 plugins).
Catalog cross-reference: `data/catalog/plugins.bundled.v1.json` (37 entries).

---

## 0. Scope

Scanned every `.lua` file under `koreader/plugins/` for the call
patterns W36 will flag: `os.execute`, `io.popen`, `loadstring`,
`load(<non-literal>)`, `dofile(<non-literal>)`, `require("socket")`,
`require("ffi")`, `package.loadlib`, `debug.getregistry`, and
`io.open` with write modes (`"w"`, `"a"`, `"wb"`, `"we"`).

Four plugins on the device are **not in the kindly catalog**:
`localsend`, `pinpadlockscreen`, `simpleui`, `zlibrary`. These are
third-party or sideloaded. Their hits are flagged as **uncatalogued**.

---

## 1. `os.execute` — 33 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| SSH | niche | 8 | `main.lua` | sshd lifecycle: start/stop/kill, iptables rules, devpts mount, mkdir settings dir |
| localsend | **uncatalogued** | 10 | `localsend_update.lua`, `localsend_firewall.lua`, `localsend_server.lua`, `localsend_discovery.lua`, `localsend_sender.lua` | process kill, iptables firewall rules, file copy/chmod/unzip for self-update |
| httpinspector | debloat | 4 | `main.lua` | start/stop socat-based HTTP traffic inspector |
| timesync | recommended | 3 | `main.lua` | ntpdate NTP sync, hwclock write, setdate fallback |
| keepalive | niche | 2 | `main.lua` | lipc-set-prop to toggle Kindle screensaver prevention |
| coverimage | niche | 2 | `main.lua` | `sync` + `iv2sh WriteStartupLogo` for custom screensaver |
| terminal | debloat | 2 | `main.lua` | devpts mount, `stty cols/rows` for PTY resize |
| externalkeyboard | niche | 1 | `main.lua` | `mount -t debugfs` for USB OTG host mode |
| simpleui | **uncatalogued** | 1 | `sui_updater.lua` | shell command for OTA update install |
| zlibrary | **uncatalogued** | 1 | `zlibrary/cache.lua` | `mkdir -p` for download cache directory |
| autostandby | debloat | 0 | `main.lua:178` | commented-out `echo mem > /sys/power/state` (not live) |

---

## 2. `io.popen` — 12 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| localsend | **uncatalogued** | 9 | `localsend_update.lua` | `ls`, `uname -m`, `curl` for self-update download + version check |
| systemstat | debloat | 1 | `main.lua:248` | pipe system stats (uptime, memory) for display |
| timesync | recommended | 1 | `main.lua:43` | `date` command to read current system time |
| localsend | **uncatalogued** | 1 | `localsend_update.lua:383` | curl for remote version check |

---

## 3. `loadstring` / `load(<non-literal>)` — 7 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| exporter | recommended | 5 | `template/slt2.lua` | slt2 template engine: compiles Lua from export templates via `loadstring` (line 32, 93, 129) and `load(t.code, ...)` (line 152) |
| docsettingtweak | niche | 1 | `main.lua:73` | `pcall(loadstring(content))` to syntax-check user-supplied Lua config snippet before saving |
| newsdownloader | niche | 1 | `main.lua:1313` | `loadstring(content)` to syntax-check feed config file before writing |
| simpleui | **uncatalogued** | 1 | `sui_i18n.lua:80` | `loadstring or load` Lua-version compat shim for i18n loader |

---

## 4. `require("socket")` / `require("socket.http")` — 17 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| opds | recommended | 4 | `opdsbrowser.lua`, `opdspse.lua` | OPDS catalog browse + ebook download over HTTP |
| newsdownloader | niche | 4 | `main.lua`, `epubdownloadbackend.lua` | RSS/Atom feed fetch + epub download |
| calibre | recommended | 2 | `wireless.lua` | Calibre wireless sync (UDP broadcast discovery + TCP transfer) |
| exporter | recommended | 2 | `base.lua`, `target/joplin.lua` | Joplin API HTTP export |
| wallabag | niche | 2 | `main.lua` | Wallabag read-later API sync |
| simpleui | **uncatalogued** | 2 | `sui_updater.lua` | OTA update download via HTTP |
| pinpadlockscreen | **uncatalogued** | 1 | `ui/pinpadmenuentry.lua` | version-check HTTP call |
| zlibrary | **uncatalogued** | 1 | `zlibrary/api.lua` | Z-Library API HTTP calls (search, download) |

---

## 5. `require("ffi")` — 6 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| externalkeyboard | niche | 2 | `main.lua`, `find-keyboard.lua` | ioctl for USB OTG mode switch + HID device detection |
| timesync | recommended | 1 | `main.lua` | `settimeofday` syscall via FFI |
| terminal | debloat | 1 | `main.lua` | ioctl for PTY allocation |
| opds | recommended | 1 | `opdsparser.lua` | XML parser C binding |
| simpleui | **uncatalogued** | 1 | `sui_browsemeta.lua:787` | `ffi.os == "Windows"` OS detection (one-shot) |

---

## 6. `dofile(<non-literal>)` — 0 flaggable hits

Two `dofile` calls found, both with string literals:

| Plugin | Opinion | File:Line | Argument |
|--------|---------|-----------|----------|
| externalkeyboard | niche | `main.lua:400` | `"plugins/externalkeyboard.koplugin/event_map_keyboard.lua"` |
| pinpadlockscreen | **uncatalogued** | `ui/pinpadmenuentry.lua:122` | `"plugins/pinpadlockscreen.koplugin/_meta.lua"` |

String-literal `dofile` is safe — the path is hardcoded. W36 should
only flag `dofile` with variable/computed arguments.

---

## 7. `io.open` (write mode) — 20 hits

| Plugin | Opinion | Hits | Files | Purpose |
|--------|---------|------|-------|---------|
| exporter | recommended | 4 | `target/html.lua`, `target/json.lua`, `target/my_clippings.lua`, `target/markdown.lua`, `target/text.lua` | write exported highlights/annotations to user-specified output files |
| newsdownloader | niche | 2 | `main.lua` | write downloaded articles to epub, save feed config |
| zlibrary | **uncatalogued** | 2 | `zlibrary/api.lua` | write downloaded ebooks to target filepath |
| simpleui | **uncatalogued** | 3 | `sui_updater.lua` | write version cache, download OTA binary, probe writable dir |
| calibre | recommended | 1 | `wireless.lua:635` | receive file from Calibre wireless transfer |
| externalkeyboard | niche | 2 | `main.lua` | write to sysfs OTG role path |
| opds | recommended | 1 | `opdsbrowser.lua:1040` | download ebook from OPDS catalog |
| terminal | debloat | 2 | `aliases.lua`, `main.lua` | save alias config, write PID file |
| texteditor | debloat | 1 | `main.lua:455` | save edited file |
| wallabag | niche | 1 | `main.lua:849` | download article for offline reading |

All write to well-scoped paths (export output dirs, PID files, config
files, download targets). No path-traversal or arbitrary-write patterns
observed.

---

## 8. Zero-hit call types

| Call type | Hits | Note |
|-----------|------|------|
| `package.loadlib` | 0 | Not used by any plugin |
| `debug.getregistry` | 0 | Not used by any plugin |

---

## 9. Summary table

| Call type | Total | Recommended | Niche | Debloat | Uncatalogued |
|-----------|-------|-------------|-------|---------|--------------|
| `os.execute` | 33 | 5 | 11 | 6 | 12 |
| `io.popen` | 12 | 1 | 0 | 1 | 9 |
| `loadstring`/`load` | 7 | 5 | 2 | 0 | 1 |
| `require("socket")` | 17 | 8 | 6 | 0 | 3 |
| `require("ffi")` | 6 | 2 | 2 | 1 | 1 |
| `dofile(<var>)` | 0 | — | — | — | — |
| `io.open(w)` | 20 | 7 | 6 | 2 | 5 |
| `package.loadlib` | 0 | — | — | — | — |
| `debug.getregistry` | 0 | — | — | — | — |
| **Total** | **95** | **28** | **27** | **10** | **31** |

Zero hits flagged as suspicious — every dangerous call serves a
documented purpose (sshd lifecycle, NTP sync, file export, network
sync, template compilation, PTY management, USB OTG).

---

## 10. Uncatalogued plugin summary

Four plugins on the device are not in `plugins.bundled.v1.json`:

| Plugin | `os.execute` | `io.popen` | `loadstring` | `socket` | `ffi` | `io.open(w)` | Total |
|--------|-------------|-----------|-------------|---------|------|-------------|-------|
| localsend | 10 | 9 | 0 | 0 | 0 | 0 | 19 |
| simpleui | 1 | 0 | 1 | 2 | 1 | 3 | 8 |
| zlibrary | 1 | 0 | 0 | 1 | 0 | 2 | 4 |
| pinpadlockscreen | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| **Subtotal** | **12** | **9** | **1** | **4** | **1** | **5** | **32** |

`localsend` is the heaviest user of dangerous calls (19 hits) — its
self-update mechanism shells out extensively for download, extraction,
and process management.

---

## 11. W36 scanner implication

This data answered three design questions for the W36 Lua static
scanner (shipped in `53467cd`, spec at `93-lua-static-scanner-spec.md`):

**Q: Should the scanner hard-block?**
No. 28 hits in recommended plugins. Hard-block would reject stock
KOReader plugins. → Implemented as catalog-whitelist (see below).

**Q: Should it warn on every hit?**
No. 95 hits across 17 plugins. Warn-only is noise — every fat Setup
with a bundled plugin would generate warnings the user can't act on.
→ Catalog MATCH suppresses; only novel/tampered code surfaces.

**Q: What model works?**
Catalog-whitelist. W32 verifies per-file SHA256 for catalogued
plugins. W36 flags dangerous calls **only in files whose hash does
NOT match the catalog**. Known-good files with matching hashes get a
pass. Modified or uncatalogued files get flagged per-call with
file:line context. Under `--strict-imports`, any unsuppressed finding
blocks the import.

The 31 uncatalogued hits (localsend, simpleui, pinpadlockscreen,
zlibrary) always flag — correct, since kindly can't verify them.
