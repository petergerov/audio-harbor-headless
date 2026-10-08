#!/usr/bin/env bash
# Run Audio Harbor Headless (prebuilt package or after ./install.sh).
# Usage:
#   ./start.sh              # serve
#   ./start.sh pair
#   ./start.sh rescan
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CMD="${1:-serve}"
shift || true

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 20 LTS, then retry." >&2
  exit 1
fi

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$MAJOR" -lt 20 ]]; then
  echo "Node $(node -v) is too old — need Node >= 20." >&2
  exit 1
fi

if [[ -f "$ROOT/PLATFORM.txt" ]]; then
  # Warn if ABI differs from build (prebuilt packages)
  BUILT_ABI="$(grep '^node_abi=' "$ROOT/PLATFORM.txt" | cut -d= -f2 || true)"
  CUR_ABI="$(node -p 'process.versions.modules')"
  if [[ -n "$BUILT_ABI" && "$BUILT_ABI" != "unknown" && "$BUILT_ABI" != "$CUR_ABI" ]]; then
    echo "Warning: package built for Node ABI $BUILT_ABI, this Node is ABI $CUR_ABI ($(node -v))." >&2
    echo "Install Node 20 LTS if the engine fails to load." >&2
  fi
fi

if [[ ! -f "$ROOT/host/dist/index.js" ]]; then
  echo "Not built yet. Use a prebuilt GitHub Release package, or run ./install.sh." >&2
  exit 1
fi

ENGINE_NODE="$ROOT/engine/build/Release/harbor_engine.node"
if [[ ! -f "$ENGINE_NODE" && ! -f "$ROOT/engine/build/harbor_engine.node" ]]; then
  echo "Native engine missing. Use a prebuilt package for this OS/CPU, or ./install.sh." >&2
  exit 1
fi

if [[ ! -f "$HOME/.audio-harbor-headless/config.toml" ]]; then
  mkdir -p "$HOME/.audio-harbor-headless"
  cp "$ROOT/config.example.toml" "$HOME/.audio-harbor-headless/config.toml"
  echo "Created ~/.audio-harbor-headless/config.toml — set library.roots before playing."
fi

export NODE_ENV="${NODE_ENV:-production}"
exec node "$ROOT/host/dist/index.js" "$CMD" "$@"
