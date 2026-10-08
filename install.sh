#!/usr/bin/env bash
# First-time setup on Raspberry Pi / Linux ARM (or any Linux host).
# Usage: ./install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1" >&2
    exit 1
  fi
}

install_apt_deps() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found — install Node 20+, cmake, g++, make, libasound2-dev yourself"
    return 0
  fi
  log "Installing system packages (sudo)"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential \
    cmake \
    pkg-config \
    libasound2-dev \
    curl \
    ca-certificates
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [[ "$major" -ge 20 ]]; then
      log "Node $(node -v) OK"
      return 0
    fi
    log "Node $(node -v) is too old (need >= 20)"
  else
    log "Node.js not found"
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log "Installing Node.js 20 via NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  else
    echo "Please install Node.js >= 20 and re-run ./install.sh" >&2
    exit 1
  fi
}

log "Audio Harbor Headless — install ($ROOT)"
install_apt_deps
ensure_node
need_cmd node
need_cmd npm
need_cmd cmake
need_cmd g++

log "npm install"
npm install

log "Build engine + web + host (native engine for this CPU)"
npm run build

log "Ensure config"
mkdir -p "$HOME/.audio-harbor-headless"
if [[ ! -f "$HOME/.audio-harbor-headless/config.toml" ]]; then
  cp "$ROOT/config.example.toml" "$HOME/.audio-harbor-headless/config.toml"
  echo "Wrote $HOME/.audio-harbor-headless/config.toml — edit library.roots"
fi

chmod +x "$ROOT/start.sh" "$ROOT/install.sh" 2>/dev/null || true

log "Done"
echo
echo "Next:"
echo "  1. Edit ~/.audio-harbor-headless/config.toml  (library.roots = [\"/path/to/music\"])"
echo "  2. ./start.sh"
echo "  3. Pair from iPhone (PIN is printed) or open the LAN URL"
echo
