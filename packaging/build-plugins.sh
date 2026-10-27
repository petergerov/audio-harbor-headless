#!/usr/bin/env bash
# Builds the plugins the Linux and macOS packages ship for the rack: LSP Plugins as one CLAP
# file, without their UI, and LSP's own presets (made for that UI) for the rack to load. On Linux it needs only libsndfile — not the ~240 MB of X11 / OpenGL /
# cairo the distribution packages pull in on a Pi without a desktop; on macOS only system
# frameworks (AudioToolbox).
#
#   packaging/build-plugins.sh [ROOT]
#
# Writes ROOT/plugins/clap/lsp-plugins.clap, ROOT/plugins/presets/lsp/<plugin id>/*.preset and
# ROOT/plugins/LICENSES/ (ROOT: the repo).
# Needs: a C++ compiler, curl; Linux: make, pkg-config, libsndfile1-dev; macOS: GNU make ≥ 4.4
# as gmake (brew install make).
set -euo pipefail

ROOT="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
LSP_VERSION="1.2.35"
LSP_SHA256="2c95ec7bb219d561ea3db36051b6c732133bcd76426fb836b1dd850dc4b5bb6c"
LSP_URL="https://github.com/lsp-plugins/lsp-plugins/releases/download/${LSP_VERSION}/lsp-plugins-src-${LSP_VERSION}.tar.gz"
OUT="$ROOT/plugins"
STAMP="$OUT/.lsp-version"

log() { printf '==> %s\n' "$*"; }

case "$(uname -s)" in
  Linux)
    MAKE=make
    JOBS="$(nproc)"
    CLAP_DIR="usr/lib/clap"
    sha256() { sha256sum -c - >/dev/null; }
    ;;
  Darwin)
    # LSP's x86 SIMD code (AVX2, AVX-512 inline assembly) does not assemble for macOS x86_64:
    # Intel Macs get the rack without shipped plugins.
    if [[ "$(uname -m)" != "arm64" ]]; then
      echo "LSP Plugins do not build for Intel Macs; skipping (the rack takes installed plugins)" >&2
      exit 0
    fi
    MAKE=gmake
    JOBS="$(sysctl -n hw.ncpu)"
    CLAP_DIR="Library/Audio/Plug-Ins/CLAP"
    sha256() { shasum -a 256 -c - >/dev/null; }
    command -v gmake >/dev/null || { echo "GNU make missing — brew install make" >&2; exit 1; }
    ;;
  *)
    echo "build-plugins.sh builds for Linux and macOS; skipping on $(uname -s)" >&2
    exit 0
    ;;
esac
PRESETS="$OUT/presets/lsp"
built() { [[ -f "$STAMP" && "$(cat "$STAMP")" == "$LSP_VERSION" && -f "$OUT/clap/lsp-plugins.clap" ]]; }
if built && [[ -d "$PRESETS" ]]; then
  log "LSP Plugins $LSP_VERSION already built"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harbor-plugins.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

log "Downloading LSP Plugins $LSP_VERSION"
curl -fsSL -o "$WORK/lsp.tar.gz" "$LSP_URL"
echo "$LSP_SHA256  $WORK/lsp.tar.gz" | sha256 || {
  echo "Checksum mismatch for $LSP_URL" >&2
  exit 1
}
tar -xzf "$WORK/lsp.tar.gz" -C "$WORK"

# LSP's presets, by plugin: each plugin's metadata names its folder under res/main/presets
# (LSP_CLAP_URI("para_equalizer_x16_stereo") … "plugins/….xml", "equalizer/parametric/stereo").
copy_presets() {
  local src="$WORK/lsp-plugins/modules" id folder dir files
  rm -rf "$PRESETS"
  mkdir -p "$PRESETS"
  perl -0777 -ne 'while (/LSP_CLAP_URI\("([^"]+)"\).*?"[^"]*\.xml",\s*(?:"([^"]*)"|NULL)/gs) { print "$1 $2\n" if $2 }' \
    "$src"/*/src/main/meta/*.cpp |
    while read -r id folder; do
      dir="$(find "$src" -type d -path "*/res/main/presets/$folder" | head -n 1)"
      # Whole presets only: a .patch (Room Builder) changes a few ports and needs LSP's files.
      files=()
      [[ -n "$dir" ]] && while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$dir" -maxdepth 1 -name '*.preset' -print0)
      ((${#files[@]})) || continue
      mkdir -p "$PRESETS/in.lsp-plug.$id"
      cp "${files[@]}" "$PRESETS/in.lsp-plug.$id/"
    done
  log "LSP presets for $(ls "$PRESETS" | wc -l | tr -d ' ') plugins in $PRESETS"
}

if built; then
  copy_presets
  exit 0
fi

log "Building LSP Plugins (CLAP, no UI)"
(
  cd "$WORK/lsp-plugins"
  "$MAKE" config FEATURES="clap" PREFIX=/usr >/dev/null
  "$MAKE" -j"$JOBS" >/dev/null
  "$MAKE" install DESTDIR="$WORK/install" >/dev/null
)

rm -rf "$OUT/clap" "$OUT/LICENSES"
mkdir -p "$OUT/clap" "$OUT/LICENSES"
install -m 755 "$WORK/install/$CLAP_DIR/lsp-plugins.clap" "$OUT/clap/lsp-plugins.clap"
if [[ "$(uname -s)" == "Darwin" ]]; then
  # Its own id still names the build folder; harmless for dlopen, but not for a package.
  install_name_tool -id "@rpath/lsp-plugins.clap" "$OUT/clap/lsp-plugins.clap" 2>/dev/null
  # Apple silicon loads only signed code: ad hoc here, Developer ID in create-macos-pkg.sh.
  codesign --force --sign - "$OUT/clap/lsp-plugins.clap"
fi
install -m 644 "$WORK/lsp-plugins/COPYING.LESSER" "$OUT/LICENSES/lsp-plugins-COPYING.LESSER"
install -m 644 "$WORK/lsp-plugins/COPYING" "$OUT/LICENSES/lsp-plugins-COPYING"
cat > "$OUT/LICENSES/README" <<EOF
lsp-plugins.clap — LSP Plugins ${LSP_VERSION} (https://lsp-plug.in), LGPL-3.0-or-later.
Built without the UI from the unmodified source release:
${LSP_URL}
sha256 ${LSP_SHA256}
Build: make config FEATURES="clap" && make (packaging/build-plugins.sh)
EOF
copy_presets
echo "$LSP_VERSION" > "$STAMP"
log "Plugins in $OUT/clap ($(du -sh "$OUT/clap/lsp-plugins.clap" | cut -f1))"
