#!/usr/bin/env bash
# Slice 7/8 — compile kindly to a single self-contained binary.
#
# Usage:
#   ./scripts/build-binary.sh                       # host target (default)
#   ./scripts/build-binary.sh darwin-arm64          # explicit target
#   ./scripts/build-binary.sh linux-x64             # cross-compile
#   ./scripts/build-binary.sh darwin-x64
#   ./scripts/build-binary.sh windows-x64           # best-effort, untested
#
# Output: dist/kindly-<target>[.exe]
#
# Bun's --compile mode bundles the JS + runtime into one executable.
# JSON imports (`with { type: "json" }`) are embedded; filesystem reads via
# import.meta.dir are NOT — that's what Slice 7 verifies.

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    case "$(uname -sm)" in
        "Darwin arm64")  TARGET="darwin-arm64" ;;
        "Darwin x86_64") TARGET="darwin-x64" ;;
        "Linux x86_64")  TARGET="linux-x64" ;;
        "Linux aarch64") TARGET="linux-arm64" ;;
        *) echo "unknown host: $(uname -sm); pass target explicitly" >&2; exit 2 ;;
    esac
fi

case "$TARGET" in
    darwin-arm64|darwin-x64|linux-x64|linux-arm64) EXT="" ;;
    windows-x64)                                   EXT=".exe" ;;
    *) echo "unsupported target: $TARGET" >&2; exit 2 ;;
esac

OUT="dist/kindly-${TARGET}${EXT}"
mkdir -p dist

echo "→ bun build --compile --target=bun-${TARGET} src/cli.ts -o ${OUT}"
bun build --compile --target="bun-${TARGET}" src/cli.ts --outfile "$OUT"

ls -lh "$OUT"
printf 'built %s\n' "$OUT"
