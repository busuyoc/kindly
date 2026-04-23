# KOReader preview patch for kindly

A KOReader user patch that takes a screenshot and exits. Used by
kindly's GUI to render pixel-accurate previews of how settings will
look on the device.

## How it works

1. Copy `2-kindly-screenshot.lua` to `<koreader>/patches/`
2. Set `KINDLY_SCREENSHOT=/path/to/output.png`
3. Run KOReader (emulator or device)
4. After 2 seconds, the patch captures the framebuffer as PNG and exits

The patch is a priority-2 (late) user patch — it runs after UIManager
is ready. The 2-second delay gives the reader time to render the
first page.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KINDLY_SCREENSHOT` | Yes | — | Output PNG path. Patch is no-op if unset. |
| `KINDLY_SCREENSHOT_DELAY` | No | `2` | Seconds to wait before capture. |

## Emulator usage

```bash
# Build KOReader emulator (once)
cd koreader && ./kodev build

# Preview a book with custom settings
cp settings.reader.lua koreader-emulator/koreader/
cp contrib/preview-patch/2-kindly-screenshot.lua koreader-emulator/koreader/patches/

EMULATE_READER_W=600 EMULATE_READER_H=800 \
KINDLY_SCREENSHOT=/tmp/preview.png \
./kodev run -- /path/to/sample.epub

# preview.png now contains the exact rendering
```

## Integration with kindly GUI (planned)

The GUI will orchestrate this automatically:

1. Write a temp `settings.reader.lua` with the Setup's settings applied
2. Copy this patch to the emulator's `patches/` dir
3. Spawn the emulator with `KINDLY_SCREENSHOT` set
4. Read the output PNG and display it in the preview pane
5. Clean up temp files

No emulation layer to build — KOReader IS the renderer.

## Safety

The patch checks for `KINDLY_SCREENSHOT` on load. If the env var is
absent, the patch does nothing — safe to leave in `patches/`
permanently. It won't interfere with normal reading.
