#!/usr/bin/env bash
# Slice 1 — build the KOReader harness image.
#
# Usage:
#   ./build.sh                                  # build kindly-koreader:dev (pinned ref)
#   ./build.sh v2025.10                         # build kindly-koreader:2025.10
#   ./build.sh master                           # build kindly-koreader:dev from upstream HEAD
#   ./build.sh v2025.10 my-tag:custom           # custom output tag
#
# Default upstream ref is pinned to a tagged release (W46-S2): kindly trusts
# whatever bytes the local docker daemon has tagged kindly-koreader:dev, so
# defaulting to a moving `master` would amount to silent supply-chain trust
# every rebuild. `master` is still available as an explicit opt-in for
# contributors tracking upstream.
#
# Cold build is dominated by ./kodev build inside the container (~15-30 min
# the first time; ~2 min cached via Docker layer cache).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_REF=v2025.10
REF="${1:-$DEFAULT_REF}"
TAG="${2:-kindly-koreader:${REF#v}}"
# Default ref (and the legacy `master` alias) → :dev so existing callers
# (preview.ts, tests/harness/*) pick up the build without re-tagging. Explicit
# refs get a ref-named tag so cross-version matrix work can run multiple
# builds in parallel.
if [[ -z "${2:-}" && ( "$REF" == "$DEFAULT_REF" || "$REF" == "master" ) ]]; then
    TAG="kindly-koreader:dev"
fi

cd "$HERE"
docker build --build-arg KOREADER_REF="$REF" -t "$TAG" .
printf 'built %s (KOReader ref: %s)\n' "$TAG" "$REF"
