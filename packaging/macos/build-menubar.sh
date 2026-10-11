#!/usr/bin/env bash
# Build the "Audio Harbor.app" menu bar app (unsigned) for this Mac's CPU.
#
# Usage: packaging/macos/build-menubar.sh <out-dir> [version]
# Output: <out-dir>/Audio Harbor.app
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build-menubar.sh <out-dir> [version]}"
VERSION="${2:-0.0.0}"

APP="$OUT/Audio Harbor.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

sed "s/__VERSION__/${VERSION}/g" "$HERE/menubar/Info.plist" > "$APP/Contents/Info.plist"

swiftc -O \
  -target "$(uname -m)-apple-macos11.0" \
  -o "$APP/Contents/MacOS/AudioHarbor" \
  "$HERE/menubar/main.swift"

echo "$APP"
