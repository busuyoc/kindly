# 95 — Community plugin catalog
### *Inventory of third-party KOReader plugins from koreader/contrib + KindleModShelf*

Date: 2026-04-23.
Sources: `github.com/koreader/contrib` (66 plugins, 291 stars),
`kindlemodshelf.me/plugins.html` (81 entries). Deduplicated union
below: **113 unique plugins** (after merging overlaps and forks).

Status: raw inventory. To be refined into `data/catalog/plugins.community.v1.json`
when the GUI plugin picker ships.

---

## 0. Coverage gaps and unreachable repos

| Plugin | Issue |
|--------|-------|
| Calculator (zwim) | GitHub repo 404 — private or renamed. Listed on contrib OWNER.md. |
| Reading Goals | No repo — links to a KOReader issue (#14195), not a plugin. |
| TimeBlock | No GitHub — hosted as a direct download on KindleModShelf. |
| ReadMastery | In contrib, no _meta.lua, no upstream repo linked in .gitmodules. |

Everything else is reachable and verified.

---

## 1. Master list

Sorted alphabetically. Columns:
- **Source**: `contrib` = in koreader/contrib, `modshelf` = on KindleModShelf only, `both` = in both.
- **Repo**: GitHub `owner/repo` (or other host).
- **Stars**: GitHub stars at scan time.
- **Category**: from KindleModShelf grouping or inferred.
- **Kindle-relevant**: whether the plugin makes sense on Kindle specifically.

### Reading & UI enhancement

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| ProjectTitle | modshelf | joshuacant/ProjectTitle | 884 | Enhanced cover browser with custom title bar and visual improvements | Yes |
| Reader Menu Redesign | both | kristianpennacchia/zzz-readermenuredesign.koplugin | — | Redesigned reader menus and popups | Yes |
| SimpleUI | both | doctorhetfield-cmd/simpleui.koplugin | — | Alternative simplified UI overlay | Yes |
| Appearance | contrib | Euphoriyy/appearance.koplugin | 48 | Customize KOReader colors, themes, fonts, backgrounds | Yes |
| Bookends | contrib | AndyHazz/bookends.koplugin | — | Configurable text overlays — tokens, icons, per-line styling | Yes |
| Maximum | contrib | Shac0x/maximum.koplugin | — | Improved zooming for manga reading | Yes |
| Customisable Sleep Screen | contrib | pxlflux/customisablesleepscreen.koplugin | 139 | Reading stats and book info on sleep screen | Yes |
| Weather Lockscreen | modshelf | loeffner/WeatherLockscreen | 57 | Weather info on device sleep screen | Yes |
| Reading Ruler | both | syakhisk/readingruler.koplugin | — | Movable underline to guide reading | Yes |
| Cover Image | bundled | — | — | (already in bundled catalog) | Yes |
| Coverbrowser | bundled | — | — | (already in bundled catalog) | Yes |
| Perception Expander | bundled | — | — | (already in bundled catalog) | Yes |
| Icons Changer | modshelf | ebanDev/iconschanger.koplugin | 59 | Download and change icon packs | Yes |
| Menu Customizer | modshelf | JoeBumm/Koreader-Menu-customizer | 88 | Hide menus, hide plugins, simplify interface | Yes |
| Flat View / By Author | modshelf | peterstamps/Flat-View-Ebooks-and-By-Author | 14 | Reorganize file view by author or flat list | Yes |
| Illustrations | modshelf | agaragou/illustrations.koplugin | 25 | Browse and navigate book illustrations gallery | Yes |
| Incognito | contrib | Craftwork2720/incognito.koplugin | 6 | Disable reading history/statistics tracking | Yes |
| Shortcuts Toolbar | contrib | xusoo/shortcutstoolbar.koplugin | 18 | Configurable shortcuts toolbar | Yes |
| Find History | contrib | (in contrib, no upstream) | — | Search reading records and update history view | Yes |

### File management & sync

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| LocalSend | both | kaikozlov/localsend.koplugin | — | Wireless file transfer via LocalSend protocol | Yes |
| SyncThing | modshelf | jasonchoimtt/koreader-syncthing | 303 | File sync across devices via Syncthing | Yes |
| File Browser | both | b-/filebrowser.koplugin | — | Manage files from a browser web UI | Yes |
| File Browser Plus | both | patelneeraj/filebrowserplus.koplugin | — | Run Filebrowser server for wireless management | Yes |
| FileSync | contrib | abrahamnm/filesync.koplugin | — | Wireless file manager | Yes |
| Telegram Downloader | modshelf | Evgeniy-94/TelegramDownloader.koplugin | 31 | Send files via Telegram bot | Yes |
| Email to KOReader | modshelf | marinov752/emailtokoreader.koplugin | 27 | Receive documents via email | Yes |
| Super Sync | modshelf | BrendanL79/supersync.koplugin | 37 | Full metadata sync to cloud storage | Yes |
| WebDAV Fetcher | contrib | karlb/webdavfetcher.koplugin | 1 | Fetch files from WebDAV server | Yes |

### Reading services integration

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| KoInsight | modshelf | GeorgeSG/KoInsight | 509 | Web dashboard for reading stats, streaks, history | Yes |
| Zotero | modshelf | stelzch/zotero.koplugin | 137 | Browse and download from Zotero collections | Yes |
| Readeck | modshelf | flip-rossi/readeck.koplugin | 46 | Readeck read-later integration | Yes |
| Readeck (iceyear) | modshelf | iceyear/readeck.koplugin | 83 | Readeck integration (alternate) | Yes |
| OPDS Plus | modshelf | greywolf1499/opds_plus.koplugin | 92 | Enhanced OPDS browser with cover display | Yes |
| Audiobookshelf | modshelf | naleo/audiobookshelf.koplugin | 75 | Browse and download from Audiobookshelf | Yes |
| ABS KoSync Bridge | modshelf | J-Lich/abs-kosync-bridge | 61 | Sync progress between Audiobookshelf and KOReader | Partial |
| Wallabag 2 | modshelf | clach04/wallabag2.koplugin | 20 | Wallabag v2 server integration | Yes |
| Hardcover | both | Billiam/hardcoverapp.koplugin | — | Update reading status on Hardcover.app | Yes |
| Telegram Highlights | modshelf | 0xmiki/telegramhighlights.koplugin | 68 | Send highlights to Telegram as images | Yes |
| Beeminder | modshelf | cbrxyz/beeminder.koplugin | 5 | Auto-log reading progress to Beeminder | Yes |
| Gota (Raindrop.io) | modshelf | cristenger/gota.koplugin-for-raindrop | 13 | Access Raindrop.io bookmarks | Yes |
| Karakeep | modshelf | AlgusDark/karakeep.koplugin | 23 | Access Karakeep bookmarks | Yes |
| EReader | modshelf | quicklywilliam/ereader | 33 | Read-it-later with Instapaper support | Yes |
| Readwise Reader | contrib | (in contrib, no upstream) | — | Readwise Reader integration | Yes |
| Luminaria | contrib | (in contrib, no upstream) | — | Export highlights to Luminaria website | Yes |
| Instapaper | contrib | omer-faruq/instapaper.koplugin | — | Instapaper integration | Yes |
| QuickRSS | contrib | qewer33/quickrss.koplugin | 38 | Fast standalone RSS reader | Yes |
| Kagi News | contrib | ysfsvm/kagi-news.koplugin | 4 | Kagi news reader | Yes |

### Highlights & annotations

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Annotation Sync | both | dani84bs/AnnotationSync.koplugin | — | Sync annotations across devices via cloud | Yes |
| Highlight Sync | both | gitalexcampos/highlightsync.koplugin | — | Sync highlights with external services | Yes |
| WebDAV Highlights Export | both | fairlygood/provider-webdav-highlights.koplugin | — | Export highlights to WebDAV | Yes |
| Highlight Import | contrib | nojux-official/HighlightImport.koplugin | 7 | Import highlights from various formats | Yes |
| Highlights Web App | modshelf | VeeBui/KOReader-highlights-web-app | 4 | View/filter highlights in browser (Apps Script) | Partial |
| Hylit | modshelf | TaylanTatli/Hylit | 13 | Sync highlights to Notion or Hardcover | Partial |
| Review | contrib | (framagit.org) | — | Review annotations plugin | Yes |

### Dictionary & language

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Dictionary Mode | both | ckilb/koreader-dictionarymode | — | One-tap dictionary lookups | Yes |
| WordReference | both | kristianpennacchia/wordreference.koplugin | — | Lookup on WordReference | Yes |
| Fast Dict Lookup | contrib | Sirozha1337/fastdictlookup.koplugin | — | Kindle-like instant word lookup with typewriter cursor | Yes |
| Anki | modshelf | Ajatt-Tools/anki.koplugin | 191 | Generate Anki flashcards from dictionary lookups | Yes |
| Vocabulary Builder (nbngoc93) | modshelf | nbngoc93/vocabulary.koplugin | 11 | Build vocabulary from lookups (alternate impl) | Yes |
| Memobook | both | omer-faruq/memobook.koplugin | — | Personal dictionary for terms and in-book memos | Yes |
| Phrase Deck | contrib | omer-faruq/phrasedeck.koplugin | — | Phrase learning deck | Yes |

### Security & access control

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| ScreenLock PIN | both | oleasteo/koreader-screenlockpin | — | PIN lock screen | Yes |
| Pinpad Screenlock | modshelf | Lena2309/pinpad_screenlock_plugin | — | Numeric keypad PIN variant | Yes |
| Screenlock (Wake PIN) | modshelf | yogi81/screenlock_koreader_plugin | — | PIN lock after wake | Yes |
| TimeBlock | modshelf | (no GitHub — direct download) | — | Parental controls with time windows | Yes |
| Go To Bed | modshelf | edoput/gotobed.koplugin | 12 | Enforces bedtime | Yes |

### AI & assistants

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| KoAssistant | both | zeeyado/koassistant.koplugin | — | AI assistant with multiple providers | Yes |
| Assistant (omer-faruq) | both | omer-faruq/assistant.koplugin | — | AI for translation and summarization | Yes |

### Comics & manga

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Rakuyomi | modshelf | tachibana-shin/rakuyomi | 305 | Manga streaming with source support | Yes |
| Comic Reader | both | OGKevin/comicreader.koplugin | 74 | Dual-page view for comics | Yes |
| Comic Meta | both | NightQuest/comicmeta.koplugin | 47 | Extract metadata from CBZ/CBR | Yes |
| Mokuro Reader | modshelf | Magyarapointe/mokuroreader-koreader | 14 | Manga OCR text overlay reader | Yes |

### Utilities & tools

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Crash Log Viewer | both | Billiam/crashlog.koplugin | — | View and filter crash logs | Yes |
| Airplane Mode | both | kodermike/airplanemode.koplugin | — | Quick airplane mode toggle | Yes |
| App Store | both | omer-faruq/appstore.koplugin | — | Browse and install KOReader plugins | Yes |
| Updates Manager | modshelf | advokatb/updatesmanager.koplugin | 81 | Manage plugin/patch updates from GitHub | Yes |
| Remote Note | modshelf | j-v/remotenote.koplugin | 14 | Type notes on another device for passages | Yes |
| Stoka | modshelf | notmarek/stoka.koplugin | 2 | Launch external binaries/scripts from KOReader | Yes |
| To-Do | modshelf | matthewashton-k/todo-koplugin | 9 | Simple todo list | Yes |
| Tailscale Toggle | modshelf | victoria-riley-barnett/koreader-tailscale | 76 | Toggle Tailscale VPN | Yes |
| Smart Delete | modshelf | tachibana-shin/smartdelete.koplugin | 8 | Enhanced file deletion with warnings | Yes |
| Home Assistant | contrib | moritz-john/homeassistant.koplugin | 37 | Control Home Assistant from KOReader | Yes |
| App Launcher | contrib | omer-faruq/applauncher.koplugin | — | Launch apps from KOReader | Yes |
| Notification Listener | contrib | omer-faruq/notificationlistener.koplugin | — | Listen for notifications | Yes |
| Sleep Logger | contrib | theiltho/koreader-sleeplogger | 0 | Log device sleep times | Yes |
| Copy to Xochitl | contrib | cyanjnpr/copytoxochitl.koplugin | — | Copy files to reMarkable (Xochitl) | No |

### Clocks & time

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Digital Clock | both | DucNg/digitalclock.koplugin | — | Time, date, and image as clock | Yes |
| Clock (analog) | both | jperon/clock.koplugin | — | Analog clock display | Yes |
| dtDisplay | modshelf | kktse/dtdisplay.koplugin | 24 | Fullscreen time and date widget | Yes |

### Reading tracking & goals

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Reading Streak | both | advokatb/readingstreak.koplugin | — | Track consecutive reading days | Yes |
| Weight Tracker | modshelf | KikyTokamuro/weighttracker.koplugin | 3 | Track weight measurements | Yes |
| AO3 Updater | modshelf | ProfBlack/ao3updater.koplugin | 21 | Auto-update AO3 EPUBs | Yes |

### Games

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Crossword | both | roygbyte/crossword.koplugin | — | Solve crosswords | Yes |
| Sudoku | both | omer-faruq/sudoku.koplugin | — | Sudoku puzzles | Yes |
| Sudoku (non-touch) | modshelf | maharjanmilan/sudoku.koplugin | 0 | Sudoku for key-only devices | Yes |
| Word Search | both | omer-faruq/wordsearch.koplugin | — | Word search puzzles | Yes |
| Connections | modshelf | odrling/connections.koplugin | 15 | NYT Connections puzzle | Yes |
| Solitaire | contrib | Lalocaballero/solitaire.koplugin | 20 | Card solitaire | Yes |
| Chess | contrib | coffman/kochess.koplugin | — | Chess game | Yes |
| Nonogram | contrib | omer-faruq/nonogram.koplugin | — | Nonogram puzzles | Yes |
| 2048 | contrib | stefan-misik/game2048.koplugin | — | 2048 number game | Yes |

### PocketBook-specific (not Kindle-relevant)

| Plugin | Source | Repo | Stars | Description |
|--------|--------|------|-------|-------------|
| PocketBook Cover | modshelf | ckilb/pocketbookcover.koplugin | 19 | Sync cover to PocketBook power-off screen |
| PocketBook Sync | both | ckilb/pocketbooksync.koplugin | — | Sync progress to PocketBook Library |

### Web & networking

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Web Browser | both | omer-faruq/webbrowser.koplugin | — | Text-based web browsing | Yes |
| Weather | both | roygbyte/weather.koplugin | — | Weather forecasts and conditions | Yes |
| MTA Stop | modshelf | HaukeCornell/mtastop.koplugin | 1 | Real-time MTA bus arrivals | No |
| Gemini | contrib | (repo.or.cz) | — | Gemini protocol browser | Yes |
| RSS Reader | both | omer-faruq/rssreader.koplugin | — | RSS feed reader | Yes |
| LOC | contrib | (in contrib) | — | Search/download from Library of Congress | Yes |

### Notes & writing

| Plugin | Source | Repo | Stars | Description | Kindle |
|--------|--------|------|-------|-------------|--------|
| Notes | modshelf | prasy-loyola/notes.koplugin | 44 | Handwritten notes with stylus support | Partial |
| TBR Planner | both | omer-faruq/tbrplanner.koplugin | — | Organize To-Be-Read list | Yes |
| Anki Viewer | contrib | omer-faruq/ankiviewer.koplugin | — | View Anki cards | Yes |

---

## 2. Prolific authors

| Author | Plugins | GitHub |
|--------|---------|--------|
| omer-faruq | 13 | appstore, assistant, instapaper, memobook, notificationlistener, phrasedeck, applauncher, rssreader, sudoku, wordsearch, tbrplanner, nonogram, ankiviewer, webbrowser |
| Billiam | 2 | crashlog, hardcoverapp |
| roygbyte | 2 | weather, crossword |
| ckilb | 3 | dictionarymode, pocketbooksync, pocketbookcover |
| kristianpennacchia | 2 | wordreference, readermenuredesign |
| tachibana-shin | 2 | smartdelete, rakuyomi |
| advokatb | 2 | readingstreak, updatesmanager |

---

## 3. Security-relevant notes

Plugins with self-update mechanisms (download + execute from GitHub):
- **LocalSend** — `localsend_update.lua` (19 dangerous calls)
- **SimpleUI** — `sui_updater.lua` (8 dangerous calls)
- **Z-Library** — `zlibrary/ota.lua` (4 dangerous calls)
- **Updates Manager** — manages updates for OTHER plugins
- **App Store** — installs plugins from a registry

These are the plugins most likely to trip the W36 scanner. The App
Store and Updates Manager are architecturally interesting — they do
on-device what kindly does from the host, but without integrity
verification.

---

## 4. Not-a-plugin entries

These appear on KindleModShelf but are NOT KOReader plugins:

| Entry | What it actually is |
|-------|-------------------|
| KoInsight | Web dashboard (runs on a server, reads KOReader's sqlite) |
| Highlights Web App | Google Apps Script web app |
| Hylit | Python CLI tool (extracts highlights from Kobo/Kindle files) |
| ABS KoSync Bridge | Server-side bridge (Node.js) |
| Reading Goals | KOReader issue (#14195), not a shipped plugin |
| Calculator (zwim) | Repo is 404 / unreachable |

These should NOT go in the community plugin catalog — they're
companion tools, not `.koplugin` directories.

---

## 5. Next steps

1. Filter to `.koplugin`-only entries (drop §4 items).
2. Assign preliminary `curation_opinion` based on: star count, author
   reputation, dangerous-call count (from doc 93 for installed ones;
   scan on install for new ones), Kindle relevance.
3. Write `data/catalog/plugins.community.v1.json` — same schema as
   `plugins.bundled.v1.json` but without `known_hashes` (we don't
   control the source trees).
4. Wire into the GUI plugin picker as a "Community" tab.
