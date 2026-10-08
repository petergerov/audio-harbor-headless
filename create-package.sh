#!/usr/bin/env bash
# Create install archives for Audio Harbor Headless.
#
# Modes:
#   ./create-package.sh              # source package (compile on device via install.sh)
#   ./create-package.sh --prebuilt   # ready-to-run (includes build + production node_modules)
#
# Prebuilt platform is auto-detected, or set explicitly:
#   HARBOR_PLATFORM=linux-arm64 ./create-package.sh --prebuilt
#
# Output: dist/packages/audio-harbor-headless-<ver>-<platform>[-src].tar.gz
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE="source"
for arg in "$@"; do
  case "$arg" in
    --prebuilt|-p) MODE="prebuilt" ;;
    --source|-s) MODE="source" ;;
    -h|--help)
      cat <<'HELP'
Usage:
  ./create-package.sh              # source package (compile on device)
  ./create-package.sh --prebuilt   # ready-to-run for this OS/CPU

  HARBOR_PLATFORM=linux-arm64 ./create-package.sh --prebuilt

Output: dist/packages/audio-harbor-headless-<ver>-<platform>.tar.gz
HELP
      exit 0
      ;;
  esac
done

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '0.1.0')"
STAMP="$(date -u +%Y%m%d)"

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os" in
    darwin) os="darwin" ;;
    linux) os="linux" ;;
    mingw*|msys*|cygwin*) os="win32" ;;
    *) os="$os" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l|armhf) arch="armv7" ;;
  esac
  # Node on Windows reports win32 via process.platform
  if [[ "${OS:-}" == "Windows_NT" ]] || node -p "process.platform" 2>/dev/null | grep -qi win32; then
    os="win32"
    arch="$(node -p "process.arch" 2>/dev/null || echo x64)"
  fi
  echo "${os}-${arch}"
}

PLATFORM="${HARBOR_PLATFORM:-$(detect_platform)}"
NODE_VER="$(node -p "process.versions.node" 2>/dev/null || echo unknown)"
NODE_ABI="$(node -p "process.versions.modules" 2>/dev/null || echo unknown)"

if [[ "$MODE" == "prebuilt" ]]; then
  NAME="audio-harbor-headless-${VERSION}-${PLATFORM}"
else
  NAME="audio-harbor-headless-${VERSION}-src-${STAMP}"
fi

OUT_DIR="$ROOT/dist/packages"
STAGE="$OUT_DIR/stage/$NAME"
ARCHIVE="$OUT_DIR/${NAME}.tar.gz"

log() { printf '==> %s\n' "$*"; }

log "Mode=$MODE platform=$PLATFORM node=$NODE_VER (ABI $NODE_ABI)"
rm -rf "$OUT_DIR/stage"
mkdir -p "$STAGE"

if [[ "$MODE" == "prebuilt" ]]; then
  if [[ ! -f "$ROOT/host/dist/index.js" ]]; then
    echo "host/dist missing — run: npm run build" >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/web/dist" ]]; then
    echo "web/dist missing — run: npm run build:web" >&2
    exit 1
  fi
  ENGINE=""
  for candidate in \
    "$ROOT/engine/build/Release/harbor_engine.node" \
    "$ROOT/engine/build/Debug/harbor_engine.node" \
    "$ROOT/engine/build/harbor_engine.node" \
    "$ROOT/engine/build/Release/harbor_engine.node.node"
  do
    if [[ -f "$candidate" ]]; then ENGINE="$candidate"; break; fi
  done
  # Windows cmake-js may emit harbor_engine.node in Release/
  if [[ -z "$ENGINE" ]]; then
    ENGINE="$(find "$ROOT/engine/build" -name 'harbor_engine.node' 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "$ENGINE" || ! -f "$ENGINE" ]]; then
    echo "harbor_engine.node missing — run: npm run build:engine" >&2
    exit 1
  fi
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "node_modules missing — run: npm ci && npm prune --omit=dev" >&2
    exit 1
  fi

  # App runtime tree
  rsync -a \
    --exclude '.git/' \
    --exclude 'dist/packages/' \
    --exclude '.idea/' \
    --exclude '.DS_Store' \
    --exclude '*.sqlite' \
    --exclude '.cache/' \
    --exclude 'config.toml' \
    --exclude 'engine/src/' \
    --exclude 'engine/napi/' \
    --exclude 'engine/third_party/' \
    --exclude 'engine/scripts/' \
    --exclude 'host/src/' \
    --exclude 'web/src/' \
    --exclude 'web/index.html' \
    --exclude '**/*.map' \
    --exclude '**/cmake-js/' \
    --exclude '**/node-addon-api/' \
    --exclude '**/typescript/' \
    --exclude '**/tsx/' \
    --exclude '**/@types/' \
    --exclude '**/.bin/tsc' \
    --exclude '**/.bin/tsx' \
    "$ROOT/" "$STAGE/"

  # Ensure engine binary is where index.js expects it
  mkdir -p "$STAGE/engine/build/Release"
  cp -f "$ENGINE" "$STAGE/engine/build/Release/harbor_engine.node"

  cat > "$STAGE/PLATFORM.txt" <<EOF
platform=$PLATFORM
node=$NODE_VER
node_abi=$NODE_ABI
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mode=prebuilt
EOF

  cat > "$STAGE/README-INSTALL.txt" <<EOF
Audio Harbor Headless — prebuilt ($PLATFORM)
===========================================

Requirements:
  - Node.js ${NODE_VER%%.*}.x (ABI $NODE_ABI) — same major as this build
  - macOS: nothing else
  - Linux: libasound2 (ALSA); Raspberry Pi OS / Debian: sudo apt install libasound2
  - Prebuilt packages include JUCE + native (Core Audio / ALSA / WASAPI)

1. Unpack this archive
2. Optional: copy config.example.toml → ~/.audio-harbor-headless/config.toml
3. Start:
     ./start.sh
   Windows:
     start.cmd

Commands: ./start.sh pair | rescan
EOF

else
  # Source package — compile on target
  rsync -a \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude '**/node_modules/' \
    --exclude 'dist/' \
    --exclude 'engine/build/' \
    --exclude 'host/dist/' \
    --exclude 'web/dist/' \
    --exclude '.idea/' \
    --exclude '.DS_Store' \
    --exclude '*.sqlite' \
    --exclude '.cache/' \
    --exclude 'DerivedData/' \
    --exclude 'dist/packages/' \
    --exclude 'config.toml' \
    "$ROOT/" "$STAGE/"

  cat > "$STAGE/README-INSTALL.txt" <<'EOF'
Audio Harbor Headless — source package
======================================

1. ./install.sh     # deps + compile native engine for THIS machine
2. Edit ~/.audio-harbor-headless/config.toml
3. ./start.sh
EOF
fi

cp -f "$ROOT/install.sh" "$ROOT/start.sh" "$ROOT/create-package.sh" "$STAGE/" 2>/dev/null || true
# Windows helper
cat > "$STAGE/start.cmd" <<'EOF'
@echo off
setlocal
cd /d "%~dp0"
if not exist "host\dist\index.js" (
  echo Not built. Use a prebuilt package or run install on this machine.
  exit /b 1
)
if not exist "%USERPROFILE%\.audio-harbor-headless\config.toml" (
  mkdir "%USERPROFILE%\.audio-harbor-headless" 2>nul
  copy /Y config.example.toml "%USERPROFILE%\.audio-harbor-headless\config.toml" >nul
  echo Created %%USERPROFILE%%\.audio-harbor-headless\config.toml
)
set NODE_ENV=production
if "%~1"=="" (
  node host\dist\index.js serve
) else (
  node host\dist\index.js %*
)
EOF

chmod +x "$STAGE/install.sh" "$STAGE/start.sh" "$STAGE/create-package.sh" 2>/dev/null || true

mkdir -p "$OUT_DIR"
tar -C "$OUT_DIR/stage" -czf "$ARCHIVE" "$NAME"

# Zip for Windows convenience when packaging win32
if [[ "$PLATFORM" == win32-* ]] || [[ "$MODE" == "prebuilt" && "$PLATFORM" == win32-x64 ]]; then
  ZIP="$OUT_DIR/${NAME}.zip"
  if command -v zip >/dev/null 2>&1; then
    (cd "$OUT_DIR/stage" && zip -qr "$ZIP" "$NAME")
    log "Also created $ZIP"
  fi
fi

rm -rf "$OUT_DIR/stage"

if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
fi

log "Created $ARCHIVE"
ls -lh "$ARCHIVE"
echo
if [[ "$MODE" == "prebuilt" ]]; then
  echo "Ready-to-run for $PLATFORM / Node $NODE_VER"
  echo "  tar -xzf $(basename "$ARCHIVE") && cd $NAME && ./start.sh"
else
  echo "Source package — on target: tar -xzf … && ./install.sh && ./start.sh"
fi
echo
