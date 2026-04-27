#!/usr/bin/env bash
# kindly KOReader harness entrypoint.
#
# Modes:
#   --mode=boot-and-exit   Boot KOReader against KO_HOME, run patches,
#                          quit cleanly. Exit 0 means the config is
#                          parseable & non-fatal at startup; non-zero
#                          means a regression. Slice 2 contract.
#
#   --mode=preview         Same boot, plus the screenshot patch. Renders
#                          the first frame to $KINDLY_SCREENSHOT (PNG)
#                          and exits. Slice 3 contract.
#
# Required env (boot-and-exit, preview):
#   KO_HOME                Host bind mount with the test settings tree.
#                          Must be a directory; reader.lua reads
#                          $KO_HOME/settings.reader.lua.
#
# Optional env:
#   KINDLY_SCREENSHOT      (preview) PNG output path; the screenshot
#                          patch is no-op if unset.
#   KINDLY_SCREENSHOT_DELAY   (preview) seconds before snapshot. Default 2.
#   SDL_VIDEO_DRIVER       Driver. Default offscreen (set in Dockerfile).
#
# Exit codes:
#   0   success
#   1   reader.lua exited non-zero
#   2   bad usage (missing KO_HOME, unknown mode, etc.)
#  124  watchdog tripped (reader hung past 30s)

set -euo pipefail

MODE=""
EXTRA_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --mode=*) MODE="${arg#--mode=}" ;;
        *)        EXTRA_ARGS+=("$arg") ;;
    esac
done

if [[ -z "$MODE" ]]; then
    echo "entrypoint.sh: --mode=<boot-and-exit|preview> is required" >&2
    exit 2
fi

cd /opt/koreader

# Patches live next to settings.reader.lua. KO_HOME/patches/N-name.lua
# is loaded at priority N during reader.lua boot (spec §4.4 step 5).
install_patch() {
    local src="$1"
    if [[ -z "${KO_HOME:-}" ]]; then
        echo "entrypoint.sh: KO_HOME is required for mode=$MODE" >&2
        exit 2
    fi
    if [[ ! -d "$KO_HOME" ]]; then
        echo "entrypoint.sh: KO_HOME=$KO_HOME is not a directory" >&2
        exit 2
    fi
    mkdir -p "$KO_HOME/patches"
    cp "/opt/koreader-patches/$src" "$KO_HOME/patches/$src"
}

case "$MODE" in
    boot-and-exit)
        install_patch 2-kindly-boot-quit.lua
        export KINDLY_BOOT_AND_EXIT=1
        exec timeout --preserve-status 30 \
            ./luajit reader.lua "${EXTRA_ARGS[@]}"
        ;;
    preview)
        install_patch 2-kindly-screenshot.lua
        if [[ -z "${KINDLY_SCREENSHOT:-}" ]]; then
            echo "entrypoint.sh: KINDLY_SCREENSHOT=<path> required for mode=preview" >&2
            exit 2
        fi
        exec timeout --preserve-status 30 \
            ./luajit reader.lua "${EXTRA_ARGS[@]}"
        ;;
    *)
        echo "entrypoint.sh: unknown mode '$MODE'" >&2
        exit 2
        ;;
esac
