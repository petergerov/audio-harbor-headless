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

# Prefer bundled Node (prebuilt packages) so ABI always matches harbor_engine.node.
NODE_BIN=""
if [[ -x "$ROOT/runtime/bin/node" ]]; then
  NODE_BIN="$ROOT/runtime/bin/node"
elif [[ -x "$ROOT/runtime/node" ]]; then
  NODE_BIN="$ROOT/runtime/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  echo "Node.js not found. Use a prebuilt package (includes runtime/), or install Node 22 LTS." >&2
  exit 1
fi

MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$MAJOR" -lt 22 ]]; then
  echo "Node $("$NODE_BIN" -v) is too old — need Node >= 22 (node:sqlite)." >&2
  exit 1
fi

if [[ -f "$ROOT/PLATFORM.txt" ]]; then
  BUILT_ABI="$(grep '^node_abi=' "$ROOT/PLATFORM.txt" | cut -d= -f2 || true)"
  CUR_ABI="$("$NODE_BIN" -p 'process.versions.modules')"
  if [[ -n "$BUILT_ABI" && "$BUILT_ABI" != "unknown" && "$BUILT_ABI" != "$CUR_ABI" ]]; then
    echo "Warning: package built for Node ABI $BUILT_ABI, this Node is ABI $CUR_ABI ($("$NODE_BIN" -v))." >&2
    if [[ "$NODE_BIN" != "$ROOT/runtime/bin/node" && "$NODE_BIN" != "$ROOT/runtime/node" ]]; then
      echo "Install Node 22 LTS, or use a prebuilt package that includes runtime/." >&2
    fi
  fi
fi

if [[ ! -f "$ROOT/host/dist/index.js" ]]; then
  echo "Not built yet. Use a prebuilt GitHub Release package, or run ./install.sh." >&2
  exit 1
fi

ENGINE_NODE="$ROOT/engine/build/Release/harbor_engine.node"
if [[ ! -f "$ENGINE_NODE" ]]; then
  ENGINE_NODE="$ROOT/engine/build/harbor_engine.node"
fi
if [[ ! -f "$ENGINE_NODE" ]]; then
  echo "Native engine missing. Use a prebuilt package for this OS/CPU, or ./install.sh." >&2
  exit 1
fi

# GitHub Release downloads get com.apple.quarantine — Gatekeeper then blocks the
# unsigned harbor_engine.node ("Apple could not verify…"). Clear it on macOS.
if [[ "$(uname -s)" == "Darwin" ]]; then
  for f in "$ENGINE_NODE" "$NODE_BIN"; do
    [[ -f "$f" ]] || continue
    if xattr -p com.apple.quarantine "$f" >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "$f" 2>/dev/null || true
    fi
  done
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$ENGINE_NODE" >/dev/null 2>&1 || true
    # Bundled node is already signed by Node.js; only ad-hoc if quarantine stripped it oddly.
  fi
fi

if [[ ! -f "$HOME/.audio-harbor-headless/config.toml" ]]; then
  mkdir -p "$HOME/.audio-harbor-headless"
  cp "$ROOT/config.example.toml" "$HOME/.audio-harbor-headless/config.toml"
  echo "Created ~/.audio-harbor-headless/config.toml — set library.roots before playing."
fi

export NODE_ENV="${NODE_ENV:-production}"
exec "$NODE_BIN" "$ROOT/host/dist/index.js" "$CMD" "$@"
