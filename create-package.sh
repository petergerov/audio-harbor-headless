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

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '1.0.0')"
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

# Official Node binary matching the ABI of harbor_engine.node.
# Must be >= 22.5 (host uses node:sqlite / DatabaseSync).
BUNDLE_NODE_VER="${HARBOR_BUNDLE_NODE:-22.23.3}"

bundle_nodejs() {
  local ver="$1" plat="$2" dest="$3"
  local name url tmp arch_dir
  case "$plat" in
    darwin-arm64) name="node-v${ver}-darwin-arm64"; url="https://nodejs.org/dist/v${ver}/${name}.tar.gz" ;;
    darwin-x64)   name="node-v${ver}-darwin-x64";   url="https://nodejs.org/dist/v${ver}/${name}.tar.gz" ;;
    linux-x64)    name="node-v${ver}-linux-x64";    url="https://nodejs.org/dist/v${ver}/${name}.tar.gz" ;;
    linux-arm64)  name="node-v${ver}-linux-arm64";  url="https://nodejs.org/dist/v${ver}/${name}.tar.gz" ;;
    win32-x64)    name="node-v${ver}-win-x64";      url="https://nodejs.org/dist/v${ver}/${name}.zip" ;;
    *)
      log "No official Node bundle mapping for $plat — skipping runtime/"
      return 0
      ;;
  esac

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/harbor-node.XXXXXX")"
  log "Bundling Node v${ver} ($name)"
  if [[ "$plat" == win32-* ]]; then
    curl -fsSL "$url" -o "$tmp/node.zip"
    if command -v unzip >/dev/null 2>&1; then
      unzip -q "$tmp/node.zip" -d "$tmp"
    else
      # PowerShell fallback on GitHub windows runners
      powershell.exe -NoProfile -Command "Expand-Archive -Path '$tmp/node.zip' -DestinationPath '$tmp' -Force"
    fi
    mkdir -p "$dest"
    # Official zip is flat: node.exe at root of extracted folder
    if [[ -f "$tmp/$name/node.exe" ]]; then
      cp -f "$tmp/$name/node.exe" "$dest/node.exe"
      # Keep LICENSE for redistribution compliance
      [[ -f "$tmp/$name/LICENSE" ]] && cp -f "$tmp/$name/LICENSE" "$dest/NODE-LICENSE"
    else
      find "$tmp" -name 'node.exe' -exec cp -f {} "$dest/node.exe" \;
    fi
  else
    curl -fsSL "$url" -o "$tmp/node.tar.gz"
    tar -xzf "$tmp/node.tar.gz" -C "$tmp"
    mkdir -p "$dest/bin"
    cp -f "$tmp/$name/bin/node" "$dest/bin/node"
    chmod +x "$dest/bin/node"
    [[ -f "$tmp/$name/LICENSE" ]] && cp -f "$tmp/$name/LICENSE" "$dest/NODE-LICENSE"
  fi
  rm -rf "$tmp"
}

# Copy ROOT → STAGE with excludes.
# Prefer tar on Windows (GitHub windows-latest has no rsync). Elsewhere: rsync if present, else tar.
stage_tree() {
  local excludes=("$@")
  local pat
  local use_rsync=0
  mkdir -p "$STAGE"

  if [[ "$PLATFORM" != win32-* ]] && [[ "${OS:-}" != "Windows_NT" ]] \
    && command -v rsync >/dev/null 2>&1; then
    use_rsync=1
  fi

  if [[ "$use_rsync" -eq 1 ]]; then
    local rsync_args=(-a)
    for pat in "${excludes[@]}"; do
      rsync_args+=(--exclude "$pat")
    done
    rsync "${rsync_args[@]}" "$ROOT/" "$STAGE/"
    return
  fi

  log "Staging with tar (rsync unavailable or Windows)"
  local tar_excludes=(--exclude='.git' --exclude='./.git')
  for pat in "${excludes[@]}"; do
    pat="${pat%/}"
    tar_excludes+=(--exclude="$pat" --exclude="./$pat")
  done
  (
    cd "$ROOT"
    tar -cf - "${tar_excludes[@]}" .
  ) | (
    cd "$STAGE"
    tar -xf -
  )
}

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
  stage_tree \
    '.git/' \
    'dist/packages/' \
    '.idea/' \
    '.DS_Store' \
    '*.sqlite' \
    '.cache/' \
    'config.toml' \
    'engine/src/' \
    'engine/napi/' \
    'engine/third_party/' \
    'engine/scripts/' \
    'host/src/' \
    'web/src/' \
    'web/index.html' \
    '*.map' \
    '**/cmake-js/' \
    '**/node-addon-api/' \
    '**/typescript/' \
    '**/tsx/' \
    '**/@types/' \
    '**/.bin/tsc' \
    '**/.bin/tsx'

  # Ensure engine binary is where index.js expects it
  mkdir -p "$STAGE/engine/build/Release"
  cp -f "$ENGINE" "$STAGE/engine/build/Release/harbor_engine.node"

  # Ship a matching Node runtime so users need no system Node (and ABI always matches).
  mkdir -p "$STAGE/runtime"
  bundle_nodejs "$BUNDLE_NODE_VER" "$PLATFORM" "$STAGE/runtime"

  cat > "$STAGE/PLATFORM.txt" <<EOF
platform=$PLATFORM
node=$NODE_VER
node_abi=$NODE_ABI
node_bundle=$BUNDLE_NODE_VER
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mode=prebuilt
EOF

  cat > "$STAGE/README-INSTALL.txt" <<EOF
Audio Harbor Headless — prebuilt ($PLATFORM)
===========================================

This package includes Node.js ${BUNDLE_NODE_VER} under runtime/ — no system Node required.

Also needed:
  - macOS: nothing else
  - Linux: libasound2 (ALSA); Raspberry Pi OS / Debian: sudo apt install libasound2
  - Prebuilt packages use native audio (Core Audio / ALSA / WASAPI)

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
  stage_tree \
    '.git/' \
    'node_modules/' \
    '**/node_modules/' \
    'dist/' \
    'engine/build/' \
    'host/dist/' \
    'web/dist/' \
    '.idea/' \
    '.DS_Store' \
    '*.sqlite' \
    '.cache/' \
    'DerivedData/' \
    'dist/packages/' \
    'config.toml'

  cat > "$STAGE/README-INSTALL.txt" <<'EOF'
Audio Harbor Headless — source package
======================================

1. ./install.sh     # deps + compile native engine for THIS machine
2. Edit ~/.audio-harbor-headless/config.toml
3. ./start.sh
EOF
fi

cp -f "$ROOT/install.sh" "$ROOT/start.sh" "$ROOT/create-package.sh" "$STAGE/" 2>/dev/null || true
# Windows helper — prefers bundled runtime\node.exe
cat > "$STAGE/start.cmd" <<'EOF'
@echo off
setlocal
cd /d "%~dp0"
if not exist "host\dist\index.js" (
  echo Not built. Use a prebuilt package or run install on this machine.
  exit /b 1
)
set "NODE_BIN=node"
if exist "runtime\node.exe" set "NODE_BIN=%~dp0runtime\node.exe"
if not exist "%USERPROFILE%\.audio-harbor-headless\config.toml" (
  mkdir "%USERPROFILE%\.audio-harbor-headless" 2>nul
  copy /Y config.example.toml "%USERPROFILE%\.audio-harbor-headless\config.toml" >nul
  echo Created %%USERPROFILE%%\.audio-harbor-headless\config.toml
)
set NODE_ENV=production
if "%~1"=="" (
  "%NODE_BIN%" host\dist\index.js serve
) else (
  "%NODE_BIN%" host\dist\index.js %*
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
