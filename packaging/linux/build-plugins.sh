#!/usr/bin/env bash
# Builds the plugins the Linux package ships for the rack: LSP Plugins as one CLAP file,
# without their UI, so they need only libsndfile — not the ~240 MB of X11 / OpenGL / cairo
# the distribution packages pull in on a Pi without a desktop.
#
#   packaging/linux/build-plugins.sh [ROOT]
#
# Writes ROOT/plugins/clap/lsp-plugins.clap and ROOT/plugins/LICENSES/ (ROOT: the repo).
# Needs: build-essential, pkg-config, libsndfile1-dev, curl.
set -euo pipefail

ROOT="$(cd "${1:-$(dirname "$0")/../..}" && pwd)"
LSP_VERSION="1.2.35"
LSP_SHA256="2c95ec7bb219d561ea3db36051b6c732133bcd76426fb836b1dd850dc4b5bb6c"
LSP_URL="https://github.com/lsp-plugins/lsp-plugins/releases/download/${LSP_VERSION}/lsp-plugins-src-${LSP_VERSION}.tar.gz"
OUT="$ROOT/plugins"
STAMP="$OUT/.lsp-version"

log() { printf '==> %s\n' "$*"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "build-plugins.sh builds the Linux plugins; skipping on $(uname -s)" >&2
  exit 0
fi
if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$LSP_VERSION" && -f "$OUT/clap/lsp-plugins.clap" ]]; then
  log "LSP Plugins $LSP_VERSION already built"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harbor-plugins.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

log "Downloading LSP Plugins $LSP_VERSION"
curl -fsSL -o "$WORK/lsp.tar.gz" "$LSP_URL"
echo "$LSP_SHA256  $WORK/lsp.tar.gz" | sha256sum -c - >/dev/null || {
  echo "Checksum mismatch for $LSP_URL" >&2
  exit 1
}
tar -xzf "$WORK/lsp.tar.gz" -C "$WORK"

log "Building LSP Plugins (CLAP, no UI)"
(
  cd "$WORK/lsp-plugins"
  make config FEATURES="clap" PREFIX=/usr >/dev/null
  make -j"$(nproc)" >/dev/null
  make install DESTDIR="$WORK/install" >/dev/null
)

rm -rf "$OUT/clap" "$OUT/LICENSES"
mkdir -p "$OUT/clap" "$OUT/LICENSES"
install -m 644 "$WORK/install/usr/lib/clap/lsp-plugins.clap" "$OUT/clap/lsp-plugins.clap"
install -m 644 "$WORK/lsp-plugins/COPYING.LESSER" "$OUT/LICENSES/lsp-plugins-COPYING.LESSER"
install -m 644 "$WORK/lsp-plugins/COPYING" "$OUT/LICENSES/lsp-plugins-COPYING"
cat > "$OUT/LICENSES/README" <<EOF
lsp-plugins.clap — LSP Plugins ${LSP_VERSION} (https://lsp-plug.in), LGPL-3.0-or-later.
Built without the UI from the unmodified source release:
${LSP_URL}
sha256 ${LSP_SHA256}
Build: make config FEATURES="clap" && make (packaging/linux/build-plugins.sh)
EOF
echo "$LSP_VERSION" > "$STAMP"
log "Plugins in $OUT/clap ($(du -sh "$OUT/clap/lsp-plugins.clap" | cut -f1))"
