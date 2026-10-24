#!/usr/bin/env bash
# Build a Debian package (.deb) for Audio Harbor Headless on Linux
# (Raspberry Pi OS, Debian, Ubuntu). Wraps the prebuilt archive:
#
#   /opt/audio-harbor-headless/                app + bundled Node
#   /usr/bin/audioharbor                       → start.sh
#   /usr/lib/systemd/system/audioharbor@.service
#   /usr/libexec/audio-harbor-headless/harbor-drive   root helper: drives → /etc/fstab
#   /usr/libexec/audio-harbor-headless/harbor-update  root helper: installs a newer release
#   /etc/sudoers.d/audio-harbor-headless              lets the service run them
#
# The service runs as the installing user (audioharbor@<user>), so config,
# catalogue and PIN stay in ~/.audio-harbor-headless like a manual start.
#
# Usage:
#   ./create-deb.sh            # wrap dist/packages/*-linux-<arch>.tar.gz
#   ./create-deb.sh --build    # npm run package:prebuilt first
#
# Output: dist/packages/audio-harbor-headless_<ver>_<amd64|arm64>.deb (+ .sha256)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build|-b) DO_BUILD=1 ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

log() { printf '==> %s\n' "$*"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "create-deb.sh runs on Linux (needs dpkg-deb)." >&2
  exit 1
fi
command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb not found." >&2; exit 1; }

case "$(uname -m)" in
  x86_64|amd64) ARCH="x64"; DEB_ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64"; DEB_ARCH="arm64" ;;
  *) echo "Unsupported CPU $(uname -m) — .deb is built for amd64 and arm64." >&2; exit 1 ;;
esac

VERSION="$(node -p "require('./package.json').version")"
NAME="audio-harbor-headless-${VERSION}-linux-${ARCH}"
OUT_DIR="$ROOT/dist/packages"
ARCHIVE="$OUT_DIR/${NAME}.tar.gz"
DEB="$OUT_DIR/audio-harbor-headless_${VERSION}_${DEB_ARCH}.deb"
PREFIX="/opt/audio-harbor-headless"

if [[ "$DO_BUILD" -eq 1 ]]; then
  npm run package:prebuilt
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "$ARCHIVE missing — run: ./create-deb.sh --build" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harbor-deb.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/pkg"

log "Staging $NAME → $PREFIX"
mkdir -p "$PKG$PREFIX" "$PKG/usr/bin" "$PKG/usr/lib/systemd/system" "$PKG/DEBIAN" \
  "$PKG/usr/libexec/audio-harbor-headless" "$PKG/etc/sudoers.d"
tar -xzf "$ARCHIVE" -C "$WORK"
cp -a "$WORK/$NAME/." "$PKG$PREFIX/"
# Source-build and Windows helpers have no use in the installed package.
rm -f "$PKG$PREFIX/install.sh" "$PKG$PREFIX/create-package.sh" "$PKG$PREFIX/start.cmd"
chmod 755 "$PKG$PREFIX/start.sh"

ln -s "$PREFIX/start.sh" "$PKG/usr/bin/audioharbor"
install -m 644 "$ROOT/packaging/linux/audioharbor@.service" "$PKG/usr/lib/systemd/system/"
install -m 755 "$ROOT/packaging/linux/harbor-drive" "$ROOT/packaging/linux/harbor-update" \
  "$PKG/usr/libexec/audio-harbor-headless/"
install -m 440 "$ROOT/packaging/linux/sudoers" "$PKG/etc/sudoers.d/audio-harbor-headless"
if command -v visudo >/dev/null 2>&1; then
  visudo -cqf "$PKG/etc/sudoers.d/audio-harbor-headless" || { echo "sudoers file invalid" >&2; exit 1; }
fi
install -m 755 "$ROOT/packaging/linux/debian/postinst" "$ROOT/packaging/linux/debian/prerm" "$PKG/DEBIAN/"

# Lowest glibc the shipped binaries accept (bundled Node needs 2.28).
GLIBC_MIN="2.28"
if command -v objdump >/dev/null 2>&1; then
  found="$(objdump -T "$PKG$PREFIX/engine/build/Release/harbor_engine.node" "$PKG$PREFIX/engine/build/Release/harbor-fx" \
    "$PKG$PREFIX/runtime/bin/node" 2>/dev/null \
    | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1 || true)"
  [[ -n "$found" ]] && GLIBC_MIN="$found"
fi
log "Requires glibc >= $GLIBC_MIN"

cat > "$PKG/DEBIAN/control" <<EOF
Package: audio-harbor-headless
Version: ${VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Petar Gerov <peter@gerov.com>
Depends: libc6 (>= ${GLIBC_MIN}), libstdc++6, libasound2t64 | libasound2, liblilv-0-0, sudo, util-linux, curl, ca-certificates
Recommends: cifs-utils
Suggests: lsp-plugins-lv2, x42-plugins
Section: sound
Priority: optional
Homepage: https://github.com/petergerov/audio-harbor-headless
Installed-Size: $(du -sk "$PKG" | cut -f1)
Description: GUI-less audiophile media host with an iPhone web remote
 Plays a music library to ALSA DACs (shared, exclusive, DoP) and to
 UPnP / DLNA network players, and shares the library as a DLNA server.
 Control it from a phone at http://audioharbor.local:8787.
 .
 Runs as a systemd service per user: audioharbor@<user>.
EOF

mkdir -p "$OUT_DIR"
dpkg-deb --root-owner-group --build "$PKG" "$DEB" >/dev/null
(cd "$OUT_DIR" && sha256sum "$(basename "$DEB")" > "$(basename "$DEB").sha256")

log "Created $DEB"
ls -lh "$DEB"
echo
echo "Install: sudo apt install ./$(basename "$DEB")"
