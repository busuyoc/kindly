#!/usr/bin/env bash
# Slice 1 — build the KOReader harness image.
#
# Usage:
#   ./build.sh                                  # build kindly-koreader:dev (master)
#   ./build.sh v2025.10                         # build kindly-koreader:v2025.10
#   ./build.sh v2025.10 my-tag:custom           # custom output tag
#
# Cold build is dominated by ./kodev build inside the container (~15-30 min
# the first time; ~2 min cached via Docker layer cache).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REF="${1:-master}"
TAG="${2:-kindly-koreader:${REF#v}}"
if [[ "$TAG" == "kindly-koreader:master" ]]; then
    TAG="kindly-koreader:dev"
fi

cd "$HERE"
docker build --build-arg KOREADER_REF="$REF" -t "$TAG" .
printf 'built %s (KOReader ref: %s)\n' "$TAG" "$REF"
