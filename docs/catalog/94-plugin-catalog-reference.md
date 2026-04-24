# 94 — KOReader plugin catalog reference
### *User-facing descriptions, dependencies, and provenance for the kindly GUI.*

Date: 2026-04-23.
Source: KOReader install on `/Volumes/Kindle/`, cross-referenced with
`data/catalog/plugins.bundled.v1.json` (37 catalogued) + 4 third-party
plugins found on this device.

---

## 0. How to read this document

Each plugin entry includes:

- **What it does** — plain-language description for a non-technical user.
- **Ships enabled** — whether KOReader enables this by default.
- **Recommendation** — kindly's curation opinion (recommended / niche / debloat).
- **Kindle notes** — device-specific caveats.
- **Dependencies** — other plugins or system features this plugin needs, or that depend on it. "Soft" means the feature degrades but doesn't crash; "hard" means it breaks.
- **Dispatcher actions** — actions this plugin registers that gestures, profiles, and hotkeys can trigger. Disabling the plugin silently removes these actions from any gesture/profile that references them.
- **Source** — KOReader core repo or third-party repo URL.

---

## 1. Bundled plugins (KOReader core)

All sourced from `github.com/koreader/koreader/tree/master/plugins/`.

### archiveviewer
**What it does:** Browse the contents of ZIP archives from KOReader's file browser without extracting them.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** —
**Dependencies:** None.
**Dispatcher actions:** None.

### autodim
**What it does:** Gradually dims the frontlight after a period of inactivity, then restores brightness on touch. Saves battery and reduces eye strain during nighttime reading.
**Ships enabled:** Only on devices with a frontlight.
**Recommendation:** Niche.
**Kindle notes:** Requires a frontlight; irrelevant on old non-lit Kindles. Does not need warm-light hardware.
**Dependencies:** None. Independent of autowarmth (they control different things — autodim controls brightness level, autowarmth controls color temperature and night mode).
**Dispatcher actions:** None.

### autostandby
**What it does:** Puts the device into a low-power standby state when idle, and wakes on touch. Different from suspend: standby keeps the CPU in a lighter sleep state.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** Not useful on Kindle — Kindles use autosuspend instead. Autostandby is designed for devices that support a separate standby state (some Kobos). Leaving this off on Kindle is correct.
**Dependencies:** None.
**Dispatcher actions:** None.

### autosuspend
**What it does:** Automatically suspends, powers off, or enters standby after configurable periods of inactivity. The main battery-saving mechanism for unattended devices.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Shipped enabled by default on Kindle builds. If users see excessive battery drain, tune the suspend timeout rather than disabling the plugin.
**Dependencies:**
- Soft → **keepalive**: reads `PluginShare.keepalive` flag. If keepalive is enabled and active, autosuspend defers its timers. Disabling keepalive doesn't break autosuspend — it just means autosuspend won't pause for Wi-Fi tasks.
- Soft → **autoturn**: both use `PluginShare` for timer coordination. No hard dependency.
**Dispatcher actions:** None (uses menu items only).

### autoturn
**What it does:** Automatically turns the page after a set number of seconds. Useful for hands-free reading (e.g., while eating). Hold the menu item to configure scroll distance.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Known issue: autoturn can stop working after Kindle wakes from sleep. Auto-dimmer may dim the frontlight while autoturn is active.
**Dependencies:** Soft → uses `PluginShare` for timer state. No hard dependency on other plugins.
**Dispatcher actions:** None.

### autowarmth
**What it does:** Automatically adjusts frontlight warmth and/or enables night mode based on time of day and location. On devices without warm light, collapses to auto night-mode only.
**Ships enabled:** Only on devices with natural light (warm frontlight).
**Recommendation:** Niche.
**Kindle notes:** Most Kindles lack a warm frontlight. The plugin detects this and offers "Auto night mode" only. Kindle Scribe and some later Paperwhites are the main exceptions.
**Dependencies:** None.
**Dispatcher actions:** `auto_warmth_activate_*` (6 actions), `show_ephemeris`.

### batterystat
**What it does:** Collects and displays battery charge/discharge statistics over time. Shows graphs of battery level, charge cycles, and estimated battery health.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** Can be handy when debugging whether KOReader or the Amazon framework is responsible for battery drain; otherwise adds background bookkeeping.
**Dependencies:** None.
**Dispatcher actions:** `battery_statistics`.

### bookshortcuts
**What it does:** Assigns a specific book to a gesture or physical key, so you can jump directly to it from anywhere.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** —
**Dependencies:** Hard → **gestures** (or **hotkeys** / **profiles**): shortcuts are registered via the Dispatcher and consumed by gesture/profile triggers. The plugin itself doesn't break without gestures, but the shortcuts have no way to fire.
**Dispatcher actions:** Dynamic — one action per user-configured shortcut.

### calibre
**What it does:** Send books from your computer's Calibre library to the device over Wi-Fi. Also search Calibre metadata (authors, tags, series) from the device.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Requires Wi-Fi to stay awake during transfer. Calibre uses TCP 9090 + UDP discovery ports — a locked-down PC firewall is the usual culprit when the Kindle can't see the server.
**Dependencies:** None. Uses `require("socket")` directly (no plugin dependency).
**Dispatcher actions:** `calibre_search`, `calibre_browse_tags`, `calibre_browse_series`, `calibre_browse_authors`, `calibre_browse_titles`, `calibre_start_connection`, `calibre_close_connection`.

### coverbrowser
**What it does:** Replaces the default file list with a mosaic or detailed cover view in the file browser and reading history. Shows book covers as thumbnails.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** First-time mosaic view on a large library can take a while to render thumbnails on older Kindle hardware.
**Dependencies:** None. But **simpleui** (third-party) has a soft dependency on coverbrowser's `bookinfomanager` module.
**Dispatcher actions:** None.

### coverimage
**What it does:** Saves the current book's cover image to a file on disk, which can then be used as a custom screensaver by external tools.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Kindle doesn't use this file natively — you need a separate screensaver mod. Safe to leave off.
**Dependencies:** None.
**Dispatcher actions:** None.

### docsettingtweak
**What it does:** Applies custom Lua configuration snippets to document settings before a book opens. Power-user tool for per-book rendering tweaks.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** —
**Dependencies:** None.
**Dispatcher actions:** None.

### exporter
**What it does:** Exports your highlights and notes from books to various formats: HTML, Markdown, JSON, text, Joplin, or the Kindle `My Clippings.txt` format.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Joplin/network exports need Wi-Fi up for the whole batch. Large libraries can take minutes. Pulling highlights from the native Kindle reader requires that the clippings file be readable.
**Dependencies:** None for local export. Joplin target uses `require("socket.http")`.
**Dispatcher actions:** `export_all_notes`, `export_current_notes`.

### externalkeyboard
**What it does:** Manages USB OTG host mode and configures an external physical keyboard for text input and navigation.
**Ships enabled:** Only on devices with USB OTG support.
**Recommendation:** Niche.
**Kindle notes:** USB OTG on Kindle is limited and fragile — switching to USBMS while KOReader is active can crash the device. Leave off unless explicitly needed.
**Dependencies:** None. Uses `require("ffi")` for ioctl.
**Dispatcher actions:** None.

### gestures
**What it does:** Maps touch gestures (swipe, tap, pinch, hold, etc.) to KOReader actions. The core input customization system — most other plugins register their actions into gestures' Dispatcher.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** All modern touchscreen Kindles supported. Non-touch Kindle 4 uses physical keys instead.
**Dependencies:** This is a dependency *of* many other plugins. Disabling gestures removes the ability to trigger any Dispatcher-registered action via touch. Plugins that register actions (calibre, statistics, wallabag, kosync, readtimer, etc.) still function via their menu entries, but gesture triggers break.
**Dispatcher actions:** None of its own — it *consumes* other plugins' actions.

### hello
**What it does:** A minimal debugging plugin that shows "Hello World." Developer sample code, not a user feature.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** —
**Dependencies:** None.
**Dispatcher actions:** `helloworld_action`.

### hotkeys
**What it does:** Maps physical device keys to KOReader actions. Similar to gestures but for button presses instead of touch.
**Ships enabled:** Only on devices with physical keys.
**Recommendation:** Niche.
**Kindle notes:** Useful on Kindle Oasis and older keyboard Kindles. Pointless on touch-only Paperwhites and base Kindles.
**Dependencies:** Consumes Dispatcher actions from other plugins (same relationship as gestures).
**Dispatcher actions:** None of its own.

### httpinspector
**What it does:** Starts a local HTTP server that exposes KOReader's internal objects for inspection. Aimed at developers.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** On a Kindle sharing public Wi-Fi, this is an unnecessary attack surface. Keep off by default.
**Dependencies:** None.
**Dispatcher actions:** None.
**Security note:** Exposes internal state over the network. SENSITIVE keys `httpinspector_autostart` and `httpinspector_port` gate this in kindly.

### japanese
**What it does:** Adds Japanese language support with Yomichan-style deinflection and text scanning. Enables one-tap lookups of inflected verbs and multi-character phrases.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Requires a Japanese StarDict dictionary installed separately. Fuzzy search should be turned off for JP lookups.
**Dependencies:** Requires at least one Japanese dictionary installed in KOReader's dictionary folder.
**Dispatcher actions:** None.

### keepalive
**What it does:** Prevents the device from going to sleep, keeping Wi-Fi alive. Useful during long network operations (Calibre transfers, OPDS downloads).
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Safe to have installed but should not be auto-enabled. Users should remember to turn it off after finishing a network task — leaving it on drains the battery.
**Dependencies:**
- Soft ← **autosuspend**: autosuspend checks `PluginShare.keepalive` and defers its timers when keepalive is active. Disabling keepalive doesn't break autosuspend.
**Dispatcher actions:** None (menu toggle only).

### kosync
**What it does:** Synchronizes your reading progress (current page/position) to a server, so you can pick up where you left off on another KOReader device.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Auto-sync fires on book open/close, so the Kindle must wake Wi-Fi at those moments. Registration on the Kindle keyboard is painful — most users create the account on a computer first.
**Dependencies:** Requires a sync server (official `sync.koreader.rocks` or self-hosted `koreader-sync-server`).
**Dispatcher actions:** `kosync_push_progress`, `kosync_pull_progress`, `kosync_set_autosync`, `kosync_toggle_autosync`.
**Security note:** `kosync.custom_server` and `kosync.username`/`kosync.userkey` are SENSITIVE/SECRET keys in kindly.

### movetoarchive
**What it does:** Moves or copies the currently open book to a configurable archive folder. Quick way to organize finished books.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Purely local file operation. The archive folder should live under KOReader's library root so the native Kindle reader doesn't also index it.
**Dependencies:** None.
**Dispatcher actions:** One action (dynamic name).

### newsdownloader
**What it does:** Downloads RSS and Atom feeds and saves them as HTML files that KOReader can read as ebooks. A basic offline news reader.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Needs Wi-Fi during download. Kindle PW5 users have reported crashes when adding feeds. Less polished than QuickRSS alternatives.
**Dependencies:** Uses `require("socket.http")` for network.
**Dispatcher actions:** None.

### opds
**What it does:** Browse and download ebooks from OPDS catalogs — online libraries like Project Gutenberg, ManyBooks, or self-hosted Calibre OPDS servers.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Needs Wi-Fi during browsing and download. Kindle Wi-Fi sleep will kill in-flight downloads of large books. Books land in KOReader's download folder, not the native Kindle library.
**Dependencies:** Uses `require("socket")` and `require("ffi")` for network and XML parsing.
**Dispatcher actions:** `opds_show_catalog`.

### perceptionexpander
**What it does:** Draws two vertical lines over the text at a configurable distance from the margins. A speed-reading aid designed to train peripheral vision.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** E-ink burn-in from the static vertical lines is a real concern on older Kindles. Not recommended for long continuous use.
**Dependencies:** None.
**Dispatcher actions:** None.

### profiles
**What it does:** Lets you save and switch between named groups of settings — for example, a "day reading" profile with bright light and a "night reading" profile with dimmed light and night mode.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** —
**Dependencies:** Consumes Dispatcher actions from other plugins. Disabling a plugin whose action is in a profile will silently skip that action when the profile is applied.
**Dispatcher actions:** Dynamic — one action per user-configured profile.

### qrclipboard
**What it does:** Generates a QR code from the device clipboard contents. Useful for transferring a URL or text snippet to your phone quickly.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** —
**Dependencies:** None.
**Dispatcher actions:** None.

### readtimer
**What it does:** Shows a notification after a specified reading time. Useful for limiting reading sessions or taking breaks.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Pause-on-sleep lag means the timer can overrun actual reading time by a minute or two.
**Dependencies:** None.
**Dispatcher actions:** `show_alarm`, `show_timer`, `stop_timer`.

### SSH
**What it does:** Starts a lightweight SSH/SFTP server on the device so you can log in and transfer files wirelessly from a computer. The main way to manage files without plugging in USB.
**Ships enabled:** Only on devices with Wi-Fi.
**Recommendation:** Niche.
**Kindle notes:** Works on jailbroken Kindles with Wi-Fi. KOReader must be running and Wi-Fi enabled. Beginners commonly hit connection trouble (wrong IP, firewall, ECDSA-only keys). The wiki explicitly warns against the no-password mode.
**Dependencies:** None.
**Dispatcher actions:** `toggle_ssh_server`.
**Security note:** `SSH_allow_no_password`, `SSH_autostart`, `SSH_key_only_auth`, `SSH_port` are SENSITIVE keys in kindly.

### statistics
**What it does:** Tracks your reading time, pages read, and reading speed per book. Shows daily/weekly/monthly summaries, calendar views, and per-book breakdowns.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** SQLite database survives KOReader upgrades. Do not downgrade KOReader after the DB has been written by a newer version.
**Dependencies:** None.
**Dispatcher actions:** `book_statistics`, `reading_progress`, `stats_calendar_view`, `stats_calendar_day_view`, `stats_time_range`, `stats_sync`, `enable_statistics`, `toggle_statistics`.

### systemstat
**What it does:** Shows system-level statistics — uptime, memory usage, CPU info, storage. A diagnostic tool.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** —
**Dependencies:** None.
**Dispatcher actions:** `system_statistics`.

### terminal
**What it does:** A VT52/ANSI terminal emulator running inside KOReader. Gives shell access directly on the device screen.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** Works on jailbroken Kindles with `/bin/sh`. On newer NT-based Kindles, reports that it simply doesn't open. Off by default is correct.
**Dependencies:** Uses `require("ffi")` for PTY allocation.
**Dispatcher actions:** `terminal`.

### texteditor
**What it does:** A basic plain-text editor for making small changes to config files or notes directly on the device.
**Ships enabled:** No.
**Recommendation:** Debloat.
**Kindle notes:** On a Kindle without SSH access, this is one of the only ways to tweak config files on the device — which is exactly why it's risky to enable by default.
**Dependencies:** None.
**Dispatcher actions:** `edit_last_edited_file`.

### timesync
**What it does:** Synchronizes the device's clock with NTP servers over the network. Ensures accurate timestamps in reading statistics and file dates.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** Needs Wi-Fi to actually sync; otherwise a silent no-op. No additional root/jailbreak required beyond what KOReader itself needs.
**Dependencies:** Uses `require("ffi")` for settimeofday syscall.
**Dispatcher actions:** None.

### vocabbuilder
**What it does:** Collects words you look up in the dictionary and uses spaced repetition to help you review them later. Builds a personal vocabulary list as you read.
**Ships enabled:** Yes (always).
**Recommendation:** Recommended.
**Kindle notes:** SQLite database should be preserved across reinstalls. Do not downgrade KOReader after the DB has been written by a newer version.
**Dependencies:** Relies on KOReader's built-in dictionary lookup system (not a plugin).
**Dispatcher actions:** `show_vocab_builder`.

### wallabag
**What it does:** Syncs articles from a Wallabag read-later service to the device for offline reading. Wallabag is an open-source alternative to Pocket/Instapaper.
**Ships enabled:** No.
**Recommendation:** Niche.
**Kindle notes:** Requires a self-hosted or app.wallabag.it account, plus Client ID/Secret. Sync needs Wi-Fi — trigger manually rather than relying on auto-sync because the Kindle's radio will usually be asleep.
**Dependencies:** Uses `require("socket.http")` for API calls.
**Dispatcher actions:** `wallabag_download`, `wallabag_queue_upload`, `wallabag_status_upload`.

---

## 2. Third-party plugins (not in kindly catalog)

These plugins are installed on this device but are not part of KOReader's
official repository. They are maintained independently, may have their
own update mechanisms, and are not covered by kindly's W32 hash
verification.

### localsend
**What it does:** Send and receive files between devices using the LocalSend protocol (an open-source AirDrop alternative). Discovers devices on the local network and transfers files without a server.
**Ships enabled:** No (sideloaded).
**Recommendation:** Not catalogued.
**Version:** v1.3.0.
**Source:** `github.com/kaikozlov/localsend.koplugin`
**Kindle notes:** Includes a self-update mechanism that downloads and installs new versions from GitHub. Heaviest user of dangerous Lua calls in any plugin on this device (19 hits — see doc 93).
**Dependencies:** None.
**Dispatcher actions:** `toggle_localsend_server`.
**Security note:** `LocalSend_autostart`, `LocalSend_port`, `LocalSend_save_dir`, `LocalSend_ext_dirs` are SENSITIVE keys in kindly. The self-update mechanism (`localsend_update.lua`) uses `os.execute`, `io.popen`, and shell commands for download, extraction, and file copy.

### pinpadlockscreen
**What it does:** Locks the device with a PIN code. Shows a numeric keypad on wake that must be unlocked before KOReader can be used.
**Ships enabled:** No (sideloaded).
**Recommendation:** Not catalogued.
**Version:** v1.0.3.
**Source:** `github.com/Lena2309/pinpad_screenlock_plugin` (fork of `github.com/yogi81/screenlock_koreader_plugin`)
**Kindle notes:** —
**Dependencies:** None. Uses `require("socket.http")` for version checking.
**Dispatcher actions:** `screenlock_pin_pad_lock_screen`.
**Security note:** `pinpadlock_pin_code` and `pinpadlock_message` are SECRET keys in kindly.

### simpleui
**What it does:** An alternative simplified UI overlay for KOReader. Replaces the default interface with a streamlined layout aimed at less technical users.
**Ships enabled:** No (sideloaded).
**Recommendation:** Not catalogued.
**Version:** 1.4.0.
**Author:** Doctor Hetfield.
**Source:** `github.com/doctorhetfield-cmd/simpleui.koplugin`
**Kindle notes:** —
**Dependencies:**
- Soft → **coverbrowser**: simpleui's `sui_config.lua` does `pcall(require, "plugins/coverbrowser.koplugin/bookinfomanager")` to reuse cover metadata. Fails gracefully if coverbrowser is disabled — the feature degrades but doesn't crash.
**Dispatcher actions:** None.
**Security note:** Includes a self-update mechanism (`sui_updater.lua`) that downloads from GitHub and installs via `os.execute`. Uses `require("socket")` and `require("ffi")`.

### zlibrary
**What it does:** Search and download books from Z-Library directly from the device.
**Ships enabled:** No (sideloaded).
**Recommendation:** Not catalogued.
**Version:** 1.0.28.
**Source:** `github.com/ZlibraryKO/zlibrary.koplugin`
**Kindle notes:** Requires a Z-Library account. Downloads go to a configurable directory.
**Dependencies:** Uses `require("socket.http")` for API calls.
**Dispatcher actions:** `zlibrary_search`.
**Security note:** `zlibrary_base_url`, `zlibrary_password`, `zlibrary_username` — the URL is SENSITIVE, credentials are SECRET in kindly. Includes a self-update mechanism (`zlibrary/ota.lua`) that downloads and installs from GitHub.

---

## 3. Dependency map

### Hard dependencies (disabling X breaks Y)

None found. All cross-plugin references use `pcall`, `PluginShare`, or
Dispatcher registration — graceful degradation, not hard crashes.

### Soft dependencies (disabling X degrades Y)

| If you disable... | ...this is affected | How |
|---|---|---|
| **gestures** | All plugins with Dispatcher actions | Touch gesture triggers for those actions stop working. Menu entries still function. |
| **hotkeys** | All plugins with Dispatcher actions | Physical key triggers stop working. Menu entries still function. |
| **profiles** | — | No plugin depends on profiles. But profile payloads that reference a disabled plugin's action will silently skip it. |
| **keepalive** | **autosuspend** | Autosuspend can no longer defer for Wi-Fi tasks. It still suspends on its own schedule — just won't know to wait. |
| **coverbrowser** | **simpleui** (third-party) | simpleui's metadata browser degrades. Cover thumbnails may not display. |
| **statistics** | Gesture/profile actions using `book_statistics`, etc. | The action silently does nothing. No crash. |

### Dispatcher action → plugin mapping

If a user disables a plugin, any gesture, profile, or hotkey bound to
that plugin's action will silently stop working. The Dispatcher does
not warn about orphaned bindings.

| Action | Registered by |
|--------|--------------|
| `auto_warmth_*` (6) | autowarmth |
| `battery_statistics` | batterystat |
| `book_statistics`, `reading_progress`, `stats_*` (8) | statistics |
| `calibre_*` (7) | calibre |
| `export_*_notes` (2) | exporter |
| `helloworld_action` | hello |
| `kosync_*` (4) | kosync |
| `opds_show_catalog` | opds |
| `screenlock_pin_pad_lock_screen` | pinpadlockscreen |
| `show_alarm`, `show_timer`, `stop_timer` | readtimer |
| `system_statistics` | systemstat |
| `terminal` | terminal |
| `toggle_localsend_server` | localsend |
| `toggle_ssh_server` | SSH |
| `edit_last_edited_file` | texteditor |
| `show_vocab_builder` | vocabbuilder |
| `wallabag_*` (3) | wallabag |
| `zlibrary_search` | zlibrary |
| *(dynamic per-book)* | bookshortcuts |
| *(dynamic per-profile)* | profiles |

---

## 4. Cloud storage note

**Cloud storage** (`cloudstorage`) appears in the kindly catalog but
is NOT a plugin — it's a core KOReader frontend app
(`frontend/apps/cloudstorage/`). It cannot be disabled via
`plugins_disabled` and is not togglable in the kindly GUI. Excluded
from this reference.
