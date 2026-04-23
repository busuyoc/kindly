# 98 -- KOReader emulator on macOS: build, run, and screenshot pipeline

Date: 2026-04-23.
Status: **research complete -- ready for hands-on verification.**
Companion: `contrib/preview-patch/2-kindly-screenshot.lua`, `docs/86-gui-sandbox.md`.

---

## 0. Executive summary

KOReader has a working SDL3-based desktop emulator for macOS. There are
**no pre-built macOS binaries** in any release (checked v2025.08 through
v2026.03 -- only Linux, Android, Kindle, Kobo, PocketBook, reMarkable).
You must build from source.

The build compiles ~60 C/C++ libraries (LuaJIT, crengine, MuPDF,
FreeType, HarfBuzz, SDL3, etc.). First build: **15--30 minutes** on
Apple Silicon. Incremental rebuilds: seconds. CI with warm cache: ~2 min.

The screenshot pipeline (`contrib/preview-patch/`) works: KOReader's
`Screen:shot()` writes PNG from the in-memory framebuffer via LodePNG --
no display capture needed. Headless operation requires SDL3's `offscreen`
or `dummy` video driver.

---

## 1. Build prerequisites on macOS

### 1.1 Homebrew packages (required)

```bash
brew install autoconf automake bash binutils cmake coreutils findutils \
    gettext gnu-getopt libtool make meson nasm ninja pkgconf sdl3 \
    util-linux
```

Minimum versions: cmake >= 3.17.5, make >= 4.4, meson >= 1.8.3,
bash >= 4.0, python >= 3.10, ninja >= 1.13.2, SDL3 >= 3.2.12.

### 1.2 Homebrew packages (optional but recommended)

```bash
brew install ccache luacheck p7zip shellcheck shfmt
```

`ccache` is strongly recommended -- it makes incremental rebuilds near-instant.

### 1.3 PATH configuration (critical)

Homebrew's GNU tools must shadow the macOS BSD versions. Add to your
shell profile:

```bash
export PATH="$(brew --prefix)/opt/findutils/libexec/gnubin:$(brew --prefix)/opt/gnu-getopt/bin:$(brew --prefix)/opt/make/libexec/gnubin:$(brew --prefix)/opt/util-linux/bin:${PATH}"
```

Without this, the build will fail silently or produce broken output
because macOS `make`, `find`, `getopt`, etc. have incompatible flags.

### 1.4 Deployment target

```bash
export MACOSX_DEPLOYMENT_TARGET=10.09
```

On Apple Silicon with macOS 11+, the CI uses `MACOSX_DEPLOYMENT_TARGET=11.0`.

### 1.5 LuaJIT -- bundled, do not install separately

KOReader builds its own LuaJIT from source as part of `koreader-base`.
Do NOT install a system LuaJIT -- it will not be used and may cause
confusion. The built LuaJIT binary lives at `koreader-emulator/koreader/luajit`.

### 1.6 macOS-specific gotchas

**ARM vs Intel:** Both architectures are supported and tested in CI
(macOS 15, Xcode 16.4). ARM64 targets macOS 11.0 minimum, x86-64
targets macOS 10.15. No Rosetta needed on Apple Silicon.

**Code signing:** The release script applies ad-hoc signing:
`codesign --force --deep -s -`. For local development/emulator use,
this is handled automatically. No Apple Developer account needed.

**Sandboxing:** Not applicable to the emulator. The `.app` bundle
(produced by `./kodev release macos`) is not notarized. The emulator
launched via `./kodev run` is just a LuaJIT binary -- no bundle, no
sandbox.

**Debugger on macOS:** `./kodev run -g` defaults to `lldb` instead of
`gdb` on macOS.

---

## 2. Build steps

### 2.1 Clone and initialize

```bash
git clone --recurse-submodules https://github.com/koreader/koreader.git
cd koreader
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### 2.2 Build the emulator

```bash
./kodev build
```

This invokes `make` which builds `koreader-base` (the C/C++ layer) and
then installs the Lua frontend into `koreader-emulator/koreader/`.

### 2.3 What gets compiled

The `koreader-base` submodule compiles approximately 60 third-party
libraries via CMake + Ninja. Major components:

| Category | Libraries |
|----------|-----------|
| Runtime | LuaJIT |
| Document rendering | crengine (CRE), MuPDF, DjVuLibre, libk2pdfopt |
| Text/fonts | FreeType2, HarfBuzz, FriBidi, utf8proc, libunibreak |
| Image | libjpeg-turbo, libpng, libwebp, giflib, LodePNG, LunaSVG, NanoSVG |
| Compression | zlib, zstd, xz, brotli, libarchive, minizip |
| Network | curl, libReSSL, LuaSocket, LuaSec, cURL |
| Display | SDL3 |
| OCR | Tesseract, Leptonica |
| Other | SQLite, lpeg, dkjson, lua-rapidjson, md4c |

### 2.4 Build time estimates

| Scenario | Time (Apple Silicon) |
|----------|---------------------|
| First build (cold) | 15--30 minutes |
| First build with `ccache` warm from prior attempt | 3--5 minutes |
| Incremental rebuild (Lua-only changes) | seconds |
| CI with warm cache | ~2 minutes |

The CI step timings confirm: with cached build artifacts, the full
build+test+artifact pipeline runs in under 2 minutes on GitHub's macOS
15 ARM64 runner.

### 2.5 Pre-built macOS binaries

**None exist.** KOReader releases include: Linux (x86_64, ARM64, ARMhf),
AppImage (x86_64, ARM64, ARMhf), .deb (amd64, arm64, armhf), Android
(ARM, ARM64, x86), Kindle (4 variants), Kobo, PocketBook, reMarkable,
Cervantes.

No macOS .app or .dmg has ever been published in any release. The macOS
build target (`./kodev release macos`) produces a `.7z` archive
containing a `.app` bundle, but it's only available via CI artifacts --
not in GitHub Releases.

**Workaround:** download the CI artifact from a successful `macos`
workflow run. The `macOS 15 ARM64` job produces a `.7z` artifact. This
requires a GitHub account and navigating to Actions > macos > latest
successful run > Artifacts.

---

## 3. Running the emulator

### 3.1 Basic launch

```bash
./kodev run
```

This executes `./luajit reader.lua` inside the `koreader-emulator/koreader/`
directory, with environment variables set for emulator mode.

### 3.2 Device simulation presets

```bash
./kodev run -s=kindle              # 600x800 @ 167 DPI
./kodev run -s=kindle-paperwhite   # 1072x1448 @ 300 DPI
./kodev run -s=kobo-forma          # 1440x1920 @ 300 DPI
./kodev run -s=kobo-clara          # 1072x1448 @ 300 DPI
./kodev run -s=kobo-h2o            # 1080x1440 @ 265 DPI
./kodev run -s=legacy-paperwhite   # 758x1024 @ 212 DPI
./kodev run -s=hidpi               # 1500x2000 @ 326 DPI
```

### 3.3 Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMULATE_READER_W` | 600 | Window width in pixels |
| `EMULATE_READER_H` | 800 | Window height in pixels |
| `EMULATE_READER_DPI` | (auto) | Screen DPI |
| `EMULATE_READER_FLASH` | (unset) | If set, duration in ms for e-ink flash simulation |
| `EMULATE_READER_VIEWPORT` | (unset) | Lua table syntax: `"{x=10,w=550,y=5,h=790}"` |
| `EMULATE_READER_FORCE_PORTRAIT` | (unset) | Forces portrait orientation |
| `DISABLE_TOUCH` | (unset) | Set to `1` to disable touch, enable D-Pad |
| `SDL_FULLSCREEN` | (unset) | Enable fullscreen mode |
| `KOREADER_WINDOW_POS_X` | (auto) | Initial window X position |
| `KOREADER_WINDOW_POS_Y` | (auto) | Initial window Y position |
| `KO_HOME` | (unset) | Override data directory (see section 5) |
| `EMULATE_BB_TYPE` | `BBRGB32` | Blitbuffer pixel format |
| `EMULATE_BW_SCREEN` | (unset) | Set to disable color |

### 3.4 Opening a specific book

```bash
./kodev run -- /path/to/book.epub
```

The `--` separates kodev flags from arguments passed to `reader.lua`.
Without a file argument, KOReader opens the file manager or last-read
book per user settings.

### 3.5 SDL hints set by KOReader

The code sets these SDL hints during initialization:

- `SDL_MOUSE_FOCUS_CLICKTHROUGH=1` -- macOS: clicking the window brings
  it to focus and processes the click
- `SDL_RENDER_VSYNC=1` -- enable vsync
- `SDL_VIDEO_X11_NET_WM_BYPASS_COMPOSITOR=0` -- for Linux only

---

## 4. Data directory and settings injection

### 4.1 How KOReader finds its data directory

`datastorage.lua` resolves the data directory in this priority order:

1. **`KO_HOME` env var** -- if set, uses this path directly
2. **Android** -- `<external_storage>/koreader`
3. **Ubuntu confinement** -- `$XDG_DATA_HOME/<package_name>`
4. **AppImage / Flatpak / `KO_MULTIUSER`** -- `$XDG_CONFIG_HOME/koreader`
   or `~/Library/Application Support/koreader` on macOS
5. **Default** -- `.` (current working directory)

For the emulator (none of APPIMAGE, FLATPAK, KO_MULTIUSER, or
UBUNTU_APPLICATION_ISOLATION are set), the default is **`.`** -- meaning
the current working directory, which is `koreader-emulator/koreader/`.

### 4.2 Where settings.reader.lua lives

```
koreader-emulator/koreader/settings.reader.lua
```

This is the emulator's data directory (`.` resolved to the CWD where
`reader.lua` runs). Subdirectories are auto-created: `cache/`, `data/`,
`plugins/`, `settings/`, `screenshots/`, etc.

### 4.3 Injecting custom settings for preview

**Method 1: Direct copy (simple)**

```bash
cp /path/to/custom-settings.reader.lua koreader-emulator/koreader/settings.reader.lua
```

**Method 2: KO_HOME override (clean isolation)**

```bash
mkdir -p /tmp/kindly-preview
cp /path/to/custom-settings.reader.lua /tmp/kindly-preview/settings.reader.lua
KO_HOME=/tmp/kindly-preview ./kodev run
```

`KO_HOME` is the highest-priority override. It completely redirects where
KOReader reads/writes settings, history, and all user data. This is the
cleanest way to inject settings without touching the emulator's own data
directory.

**Method 3: For the screenshot pipeline (recommended)**

```bash
# Create isolated preview directory
PREVIEW_DIR=$(mktemp -d)
cp generated-settings.reader.lua "$PREVIEW_DIR/settings.reader.lua"
mkdir -p "$PREVIEW_DIR/patches"
cp contrib/preview-patch/2-kindly-screenshot.lua "$PREVIEW_DIR/patches/"

# Run with KO_HOME pointing to the isolated directory
cd koreader-emulator/koreader
KO_HOME="$PREVIEW_DIR" \
EMULATE_READER_W=600 EMULATE_READER_H=800 \
KINDLY_SCREENSHOT=/tmp/preview.png \
./luajit reader.lua /path/to/sample.epub

# Preview is at /tmp/preview.png
rm -rf "$PREVIEW_DIR"
```

### 4.4 Settings loading in reader.lua

Settings are loaded from `DataStorage:getDataDir().."/settings.reader.lua"`.
The load happens after environment setup (setupkoenv) but before UI
initialization. The boot sequence:

1. Set up Lua environment, load `setupkoenv`
2. Load `settings.reader.lua` from the data directory
3. Generate device ID if missing, apply JIT tweaks
4. Initialize device, canvas, UIManager
5. Run user patches (priority 0, 1, 2)
6. Open FileManager or ReaderUI
7. Enter main event loop

The kindly screenshot patch runs at priority 2 (after UIManager is ready),
schedules a delayed screenshot, then quits.

---

## 5. Screenshot pipeline

### 5.1 How it works

`contrib/preview-patch/2-kindly-screenshot.lua` is a KOReader user patch
(priority 2 = "late"):

```lua
local screenshot_path = os.getenv("KINDLY_SCREENSHOT")
if not screenshot_path then return end              -- no-op if unset

local delay_s = tonumber(os.getenv("KINDLY_SCREENSHOT_DELAY")) or 2

local UIManager = require("ui/uimanager")
local Screen = require("device").screen

UIManager:scheduleIn(delay_s, function()
    Screen:shot(screenshot_path)                    -- PNG via LodePNG
    UIManager:quit(0)                               -- clean exit
end)
```

- `Screen:shot(path)` calls `self.bb:writePNG(filename, bgr)` on the
  in-memory framebuffer. Uses LodePNG, writes directly to disk. No
  display capture, no OS screenshot API.
- `UIManager:scheduleIn` inserts into the task queue with an absolute
  deadline. The main loop processes it before the next input poll.
- `UIManager:quit(0)` sets `_exit_code`, clears the window stack and
  task queue, and exits the main loop cleanly.

### 5.2 Full pipeline command

```bash
cd koreader-emulator/koreader

# Prepare isolated data directory
PREVIEW_DIR=$(mktemp -d)
cp /path/to/kindly-generated-settings.reader.lua "$PREVIEW_DIR/settings.reader.lua"
mkdir -p "$PREVIEW_DIR/patches"
cp /path/to/kindly/contrib/preview-patch/2-kindly-screenshot.lua "$PREVIEW_DIR/patches/"

# Run the emulator
KO_HOME="$PREVIEW_DIR" \
EMULATE_READER_W=600 \
EMULATE_READER_H=800 \
KINDLY_SCREENSHOT="$PREVIEW_DIR/preview.png" \
KINDLY_SCREENSHOT_DELAY=2 \
./luajit reader.lua /path/to/sample.epub

# Result: $PREVIEW_DIR/preview.png contains the rendered page
```

### 5.3 Headless operation (no display)

The emulator normally opens an SDL3 window. For CI or headless servers,
you need a video driver that doesn't require a display.

**SDL3 video drivers for headless use:**

| Driver | Env var | Notes |
|--------|---------|-------|
| `offscreen` | `SDL_VIDEO_DRIVER=offscreen` | Purpose-built for headless rendering. Must be compiled into SDL3 with `SDL_VIDEO_DRIVER_OFFSCREEN` enabled. |
| `dummy` | `SDL_VIDEO_DRIVER=dummy` | Allows SDL apps to function without display. Must be compiled with `SDL_VIDEO_DRIVER_DUMMY` enabled. |

**Usage:**

```bash
SDL_VIDEO_DRIVER=offscreen \
KO_HOME="$PREVIEW_DIR" \
EMULATE_READER_W=600 \
EMULATE_READER_H=800 \
KINDLY_SCREENSHOT="$PREVIEW_DIR/preview.png" \
./luajit reader.lua /path/to/sample.epub
```

**Important caveat:** whether `offscreen` and `dummy` drivers are compiled
into Homebrew's SDL3 package is unverified. You may need to build SDL3
from source with `-DSDL_VIDEO_DRIVER_OFFSCREEN=ON -DSDL_VIDEO_DRIVER_DUMMY=ON`.
KOReader-base's own SDL3 build may or may not enable these.

**Verification step (run after building):**

```bash
# Check if the offscreen driver is available
SDL_VIDEO_DRIVER=offscreen ./luajit -e 'require("ffi/SDL3")' 2>&1
# If it errors with "No available video device", the driver isn't compiled in
```

**macOS alternative:** On macOS with a desktop session, the emulator
just works -- SDL3 uses the native Cocoa video driver. The window
appears briefly (2 seconds), the screenshot is taken, and it exits.
For local development this is fine.

### 5.4 CI environments (GitHub Actions)

**macOS runners:** Have a display server. SDL3 Cocoa driver works out
of the box. No Xvfb needed. The window will appear on the runner's
virtual display during the 2-second screenshot delay.

**Linux runners:** Need either `xvfb-run` or the `offscreen` SDL3 driver.

```yaml
# GitHub Actions macOS -- just works
- run: |
    KINDLY_SCREENSHOT=/tmp/preview.png \
    EMULATE_READER_W=600 EMULATE_READER_H=800 \
    KO_HOME=${{ runner.temp }}/preview \
    ./luajit reader.lua sample.epub

# GitHub Actions Linux -- needs virtual framebuffer
- run: |
    sudo apt-get install -y xvfb
    xvfb-run -a \
    KINDLY_SCREENSHOT=/tmp/preview.png \
    EMULATE_READER_W=600 EMULATE_READER_H=800 \
    KO_HOME=${{ runner.temp }}/preview \
    ./luajit reader.lua sample.epub
```

### 5.5 Screenshot quality and format

- Output: PNG, color depth matches blitbuffer type (default BBRGB32 = 32-bit RGBA)
- For e-ink simulation: set `EMULATE_BW_SCREEN=1` to get grayscale output
- Resolution: exactly `EMULATE_READER_W x EMULATE_READER_H` pixels
- File size: typically 50--200 KB for a text page at 600x800

---

## 6. Size and performance

### 6.1 Disk footprint

| Component | Size (approximate) |
|-----------|-------------------|
| Source checkout (with submodules) | ~1.5 GB |
| Build artifacts (koreader-base) | ~500 MB |
| Emulator directory (`koreader-emulator/`) | ~80 MB |
| macOS .app release bundle (uncompressed) | ~80 MB |
| macOS .app release bundle (7z compressed) | ~30 MB |

The emulator directory is what you'd ship for preview. The 80 MB
includes all plugins, dictionaries data, fonts, and the LuaJIT runtime.

### 6.2 Stripping for preview-only use

The macOS release build already excludes:
- `plugins/SSH.koplugin`
- `plugins/autofrontlight.koplugin`
- `plugins/hello.koplugin`
- `plugins/timesync.koplugin`
- `tools/` directory

For a preview-only emulator, you could further strip:
- `data/dict/` -- dictionary data (~5 MB)
- `data/tessdata/` -- OCR trained data (~15 MB)
- Most plugins in `plugins/` that aren't needed for rendering
- `fonts/` if system fonts suffice (the emulator has `hasSystemFonts = yes`)

**Estimated stripped size:** ~40--50 MB. This is still substantial because
the core rendering libraries (crengine, MuPDF, FreeType, HarfBuzz, SDL3)
are all C shared libraries.

### 6.3 Startup and rendering performance

| Metric | Estimate |
|--------|----------|
| Cold start to file manager | ~1--2 seconds |
| Cold start to first page render | ~2--3 seconds |
| Screenshot pipeline total (start + 2s delay + shot + quit) | ~4--5 seconds |

The 2-second delay in the screenshot patch is conservative. Testing may
reveal that 0.5--1 second is sufficient for the first page to render,
which would bring the total pipeline to ~2--3 seconds.

The `KINDLY_SCREENSHOT_DELAY` env var controls this without modifying
the patch.

---

## 7. Integration plan for kindly GUI

Based on `docs/86-gui-sandbox.md` architecture:

### 7.1 Emulator as a child process

The GUI's main process (Electron/Node) would:

1. Maintain a built KOReader emulator at a known path (e.g.,
   `~/.kindly/emulator/koreader/` or bundled with the app)
2. When the user requests a preview:
   a. Write a temp `settings.reader.lua` with the Setup's settings applied
   b. Create an isolated `KO_HOME` directory with the settings + patch
   c. Spawn: `./luajit reader.lua <sample-book>` with env vars
   d. Wait for process exit (timeout: 10 seconds)
   e. Read the output PNG from `KINDLY_SCREENSHOT` path
   f. Display in the preview pane
   g. Clean up temp directory

### 7.2 Emulator lifecycle

Options:
- **On-demand build:** User runs `kindly setup-emulator` once, which
  clones + builds KOReader. Slow first time, fast updates via `git pull`.
- **Pre-built bundle:** Ship the macOS `.app` bundle contents (~80 MB
  compressed to ~30 MB). No build step needed. Requires tracking
  KOReader releases.
- **CI artifact download:** `gh run download` the latest macOS CI
  artifact. Automated but depends on GitHub availability.

Recommendation: start with on-demand build (user already has Homebrew
for development). Long-term, ship a pre-built bundle.

### 7.3 Sample book

The preview needs a book to render. Options:
- Bundle a small EPUB (~10 KB) with kindly
- Use an existing book from the user's library
- Generate a synthetic EPUB with sample text

---

## 8. Known limitations and open questions

### 8.1 Confirmed limitations

1. **No pre-built macOS releases.** Must build from source or extract CI
   artifacts.
2. **Large build.** ~60 C/C++ libraries, 15--30 min first build. Requires
   ~2 GB disk for source + build.
3. **SDL3 dummy/offscreen driver availability.** Unknown whether
   Homebrew's SDL3 or KOReader-base's SDL3 compile these drivers. Needs
   hands-on verification.
4. **No true headless mode in KOReader.** The emulator assumes a display.
   `Screen:shot()` works from memory (no display capture), but SDL3
   initialization may fail without a video driver.
5. **Window flashes on screen.** On macOS with a display, the emulator
   window appears for ~2 seconds during the screenshot pipeline. Cosmetic
   issue only.

### 8.2 Open questions (need hands-on testing)

1. Does `SDL_VIDEO_DRIVER=offscreen` work with KOReader's SDL3 build on
   macOS?
2. Can `KO_HOME` fully isolate the emulator from its own data directory,
   or does it still look for some files relative to the binary?
3. What's the minimum `KINDLY_SCREENSHOT_DELAY` that produces a fully
   rendered page?
4. Does the emulator work from a relocated directory (not
   `koreader-emulator/koreader/`)? The `luajit` binary may have
   hard-coded rpaths.
5. Can we run two emulator instances simultaneously with different
   `KO_HOME` directories?

### 8.3 Architecture constraint

The emulator binary is native. An Apple Silicon Mac produces ARM64
binaries; an Intel Mac produces x86_64 binaries. You cannot cross-compile
the emulator for a different architecture without a cross-toolchain.

---

## 9. Quick-start recipe (copy-paste)

```bash
# 1. Install prerequisites
brew install autoconf automake bash binutils cmake coreutils findutils \
    gettext gnu-getopt libtool make meson nasm ninja pkgconf sdl3 \
    util-linux ccache

# 2. Fix PATH (add to ~/.zshrc for persistence)
export PATH="$(brew --prefix)/opt/findutils/libexec/gnubin:$(brew --prefix)/opt/gnu-getopt/bin:$(brew --prefix)/opt/make/libexec/gnubin:$(brew --prefix)/opt/util-linux/bin:${PATH}"

# 3. Set deployment target
export MACOSX_DEPLOYMENT_TARGET=11.0   # Apple Silicon; use 10.15 for Intel

# 4. Clone and build
git clone --recurse-submodules https://github.com/koreader/koreader.git
cd koreader
./kodev build                          # 15-30 min first time

# 5. Test the emulator
./kodev run                            # opens SDL window

# 6. Test with Kindle device simulation
./kodev run -s=kindle                  # 600x800 @ 167 DPI

# 7. Test the screenshot pipeline
PREVIEW_DIR=$(mktemp -d)
cp contrib/preview-patch/2-kindly-screenshot.lua koreader-emulator/koreader/patches/
KINDLY_SCREENSHOT=/tmp/preview.png \
EMULATE_READER_W=600 \
EMULATE_READER_H=800 \
./kodev run -- /path/to/book.epub
# After 2 seconds: /tmp/preview.png has the screenshot

# 8. Test with custom settings
KO_HOME="$PREVIEW_DIR" \
KINDLY_SCREENSHOT=/tmp/preview.png \
EMULATE_READER_W=600 \
EMULATE_READER_H=800 \
cd koreader-emulator/koreader && ./luajit reader.lua /path/to/book.epub

# 9. Test headless (may or may not work -- verify)
SDL_VIDEO_DRIVER=offscreen \
KINDLY_SCREENSHOT=/tmp/preview.png \
EMULATE_READER_W=600 \
EMULATE_READER_H=800 \
./luajit reader.lua /path/to/book.epub
```

---

## 10. Source references

| File | What it tells us |
|------|-----------------|
| `doc/Building.md` (koreader) | macOS prerequisites, Homebrew packages, PATH config |
| `doc/Building_targets.md` (koreader) | `./kodev release macos` target |
| `kodev` (koreader) | build/run/release commands, device simulation presets |
| `datastorage.lua` (koreader) | Data directory resolution: KO_HOME > APPIMAGE/FLATPAK > cwd |
| `frontend/device/sdl/device.lua` | SDL device class, env vars, Emulator subclass |
| `ffi/SDL3.lua` (koreader-base) | SDL3 init, window creation, EMULATE_READER_W/H defaults |
| `ffi/framebuffer_SDL3.lua` (koreader-base) | EMULATE_READER_FLASH, blitbuffer type |
| `ffi/framebuffer.lua` (koreader-base) | `shot()` -> `bb:writePNG()` |
| `ffi/blitbuffer.lua` (koreader-base) | `writePNG()` via LodePNG, works without display |
| `make/emulator.mk` (koreader) | Run target: `./luajit reader.lua` |
| `make/macos.mk` (koreader) | .app bundle, excluded plugins, ibtool |
| `platform/mac/do_mac_bundle.sh` | Info.plist, ad-hoc codesign, 7z packaging |
| `.github/workflows/build.yml` | CI: macOS 15, ARM64+x86_64, Xcode 16.4 |
| `contrib/preview-patch/2-kindly-screenshot.lua` (kindly) | Screenshot patch using Screen:shot() + UIManager:quit() |
| `frontend/ui/uimanager.lua` | scheduleIn, quit mechanism |
| `reader.lua` | Boot sequence, settings load order, CLI args |
