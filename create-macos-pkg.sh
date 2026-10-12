#!/usr/bin/env bash
# Build a Developer ID–signed macOS .pkg for Audio Harbor Headless.
#
# Prerequisites:
#   - Built prebuilt archive (or pass --build)
#   - "Developer ID Application" + "Developer ID Installer" in the keychain
#
# Notarization (first match wins):
#   HARBOR_NOTARY_PROFILE          notarytool keychain profile
#   APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER
#   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#
# Output:
#   dist/packages/audio-harbor-headless-<ver>-darwin-<arch>.pkg
#   dist/packages/audio-harbor-headless-<ver>-darwin-<arch>.tar.gz  (binaries re-signed)
#   matching .sha256 files
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DO_BUILD=0
SKIP_NOTARY=0
REQUIRE_NOTARY=0
for arg in "$@"; do
  case "$arg" in
    --build|-b) DO_BUILD=1 ;;
    --skip-notary) SKIP_NOTARY=1 ;;
    --require-notary) REQUIRE_NOTARY=1 ;;
    -h|--help)
      cat <<'HELP'
Usage:
  ./create-macos-pkg.sh              # sign existing prebuilt archive + build .pkg
  ./create-macos-pkg.sh --build      # npm run package:prebuilt first
  ./create-macos-pkg.sh --skip-notary
  ./create-macos-pkg.sh --require-notary

Env:
  HARBOR_SIGN_APP / HARBOR_SIGN_INSTALLER
  HARBOR_NOTARY_PROFILE | APPLE_API_KEY_* | APPLE_ID + …
  HARBOR_INSTALL_PREFIX   default /usr/local/audio-harbor-headless
HELP
      exit 0
      ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
PLATFORM="darwin-${ARCH}"
NAME="audio-harbor-headless-${VERSION}-${PLATFORM}"
OUT_DIR="$ROOT/dist/packages"
INSTALL_PREFIX="${HARBOR_INSTALL_PREFIX:-/usr/local/audio-harbor-headless}"
ENTITLEMENTS="$ROOT/packaging/macos/entitlements.plist"
IDENTIFIER="com.gerov.audioharbor.headless"

log() { printf '==> %s\n' "$*"; }

detect_identity() {
  local kind="$1"
  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n "s/.*\"\\(Developer ID ${kind}: [^\"]*\\)\"/\\1/p" \
    | head -1
}

detect_installer_identity() {
  security find-identity -v 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Installer: [^"]*\)"/\1/p' \
    | head -1
}

SIGN_APP="${HARBOR_SIGN_APP:-$(detect_identity Application)}"
SIGN_PKG="${HARBOR_SIGN_INSTALLER:-$(detect_installer_identity)}"

if [[ -z "$SIGN_APP" ]]; then
  echo "No Developer ID Application identity found in the keychain." >&2
  exit 1
fi
if [[ -z "$SIGN_PKG" ]]; then
  echo "No Developer ID Installer identity found in the keychain." >&2
  exit 1
fi

log "Signing app as: $SIGN_APP"
log "Signing pkg as: $SIGN_PKG"

if [[ "$DO_BUILD" -eq 1 ]]; then
  log "Building prebuilt package"
  npm run package:prebuilt
fi

ARCHIVE="$OUT_DIR/${NAME}.tar.gz"
if [[ ! -f "$ARCHIVE" ]]; then
  log "Prebuilt archive missing — building"
  npm run package:prebuilt
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Expected $ARCHIVE after package:prebuilt" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harbor-macos-pkg.XXXXXX")"
API_KEY_TMP=""
cleanup() {
  rm -rf "$WORK"
  if [[ -n "$API_KEY_TMP" && -f "$API_KEY_TMP" ]]; then rm -f "$API_KEY_TMP"; fi
}
trap cleanup EXIT

log "Unpacking $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$WORK"
PAYLOAD="$WORK/$NAME"
if [[ ! -d "$PAYLOAD" ]]; then
  echo "Archive did not contain $NAME/" >&2
  exit 1
fi

sign_bin() {
  local path="$1"
  [[ -f "$path" ]] || return 0
  log "codesign $(basename "$path")"
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$SIGN_APP" \
    "$path"
  codesign --verify --verbose=2 "$path"
}

# Notarization rejects any Mach-O without a Developer ID signature, so sign
# every executable / dylib / addon in the payload, not just the known ones.
while IFS= read -r -d '' f; do
  if file -b "$f" | grep -qE '^Mach-O .*(executable|shared library|bundle)'; then
    sign_bin "$f"
  fi
done < <(find "$PAYLOAD" -type f -print0)

# Refresh tar.gz so the release archive also carries Developer ID binaries
log "Rewriting signed archive $ARCHIVE"
tar -C "$WORK" -czf "$ARCHIVE" "$NAME"
if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
fi

COMP_ROOT="$WORK/component"
mkdir -p "$COMP_ROOT$(dirname "$INSTALL_PREFIX")"
cp -a "$PAYLOAD" "$COMP_ROOT$INSTALL_PREFIX"

mkdir -p "$COMP_ROOT/usr/local/bin"
ln -sf "$INSTALL_PREFIX/start.sh" "$COMP_ROOT/usr/local/bin/audioharbor"

# Menu bar app: start / stop, QR code, Settings
MENUBAR_APP="$COMP_ROOT/Applications/Audio Harbor.app"
log "Building menu bar app"
mkdir -p "$COMP_ROOT/Applications"
"$ROOT/packaging/macos/build-menubar.sh" "$COMP_ROOT/Applications" "$VERSION"
codesign --force --options runtime --timestamp --sign "$SIGN_APP" "$MENUBAR_APP"
codesign --verify --strict --verbose=2 "$MENUBAR_APP"

SCRIPTS="$WORK/scripts"
mkdir -p "$SCRIPTS"
cat > "$SCRIPTS/postinstall" <<EOF
#!/bin/bash
set -e
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$INSTALL_PREFIX" 2>/dev/null || true
fi
chmod +x "$INSTALL_PREFIX/start.sh" "$INSTALL_PREFIX/install.sh" 2>/dev/null || true

# (Re)open the menu bar app for the logged-in user, so an update takes effect.
CONSOLE_USER="\$(stat -f %Su /dev/console)"
if [[ -n "\$CONSOLE_USER" && "\$CONSOLE_USER" != "root" ]]; then
  pkill -x AudioHarbor 2>/dev/null || true
  # The old server keeps running old code otherwise; the app starts the new one.
  "$INSTALL_PREFIX/start.sh" stop >/dev/null 2>&1 || true
  CONSOLE_UID="\$(id -u "\$CONSOLE_USER")"
  launchctl asuser "\$CONSOLE_UID" sudo -u "\$CONSOLE_USER" open -g "/Applications/Audio Harbor.app" || true
fi
exit 0
EOF
chmod +x "$SCRIPTS/postinstall"

COMPONENT_PKG="$WORK/audio-harbor-headless-component.pkg"
log "Building component package"
# Install the app to /Applications even if a copy was moved elsewhere (no relocation).
COMPONENT_PLIST="$WORK/component.plist"
pkgbuild --analyze --root "$COMP_ROOT" "$COMPONENT_PLIST"
i=0
while /usr/libexec/PlistBuddy -c "Print :$i" "$COMPONENT_PLIST" >/dev/null 2>&1; do
  /usr/libexec/PlistBuddy -c "Delete :$i:BundleIsRelocatable" "$COMPONENT_PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :$i:BundleIsRelocatable bool false" "$COMPONENT_PLIST"
  i=$((i + 1))
done

pkgbuild \
  --root "$COMP_ROOT" \
  --component-plist "$COMPONENT_PLIST" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  --scripts "$SCRIPTS" \
  "$COMPONENT_PKG"

DIST_XML="$WORK/distribution.xml"
sed "s/__VERSION__/${VERSION}/g" "$ROOT/packaging/macos/distribution.xml" > "$DIST_XML"
cp -f "$ROOT/packaging/macos/welcome.html" "$WORK/welcome.html"

UNSIGNED_PKG="$WORK/${NAME}.unsigned.pkg"
log "Building product archive"
productbuild \
  --distribution "$DIST_XML" \
  --resources "$WORK" \
  --package-path "$WORK" \
  "$UNSIGNED_PKG"

FINAL_PKG="$OUT_DIR/${NAME}.pkg"
mkdir -p "$OUT_DIR"
log "productsign → $FINAL_PKG"
productsign --sign "$SIGN_PKG" --timestamp "$UNSIGNED_PKG" "$FINAL_PKG"

log "Verifying package signature"
pkgutil --check-signature "$FINAL_PKG"

# Fills NOTARY_AUTH with notarytool credential args; returns 1 if none are configured.
NOTARY_AUTH=()
resolve_notary_auth() {
  if [[ -n "${HARBOR_NOTARY_PROFILE:-}" ]]; then
    log "Notarizing with keychain profile: $HARBOR_NOTARY_PROFILE"
    NOTARY_AUTH=(--keychain-profile "$HARBOR_NOTARY_PROFILE")
    return 0
  fi

  if [[ -n "${APPLE_API_KEY_BASE64:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    API_KEY_TMP="$(mktemp "${TMPDIR:-/tmp}/AuthKey.XXXXXX.p8")"
    echo "$APPLE_API_KEY_BASE64" | base64 --decode > "$API_KEY_TMP"
    export APPLE_API_KEY_PATH="$API_KEY_TMP"
  fi

  if [[ -n "${APPLE_API_KEY_PATH:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
    log "Notarizing with App Store Connect API key $APPLE_API_KEY_ID"
    NOTARY_AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
    return 0
  fi

  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    log "Notarizing with Apple ID $APPLE_ID (team $APPLE_TEAM_ID)"
    NOTARY_AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
    return 0
  fi

  for candidate in "AC_PASSWORD" "notarytool" "Harbor" "AudioHarbor" "Developer ID"; do
    if xcrun notarytool history --keychain-profile "$candidate" >/dev/null 2>&1; then
      log "Notarizing with keychain profile: $candidate"
      NOTARY_AUTH=(--keychain-profile "$candidate")
      return 0
    fi
  done

  return 1
}

# notarytool exits 0 even when Apple rejects the upload, so check the status
# and print Apple's log on failure.
notarize_pkg() {
  local pkg="$1" out status sub_id
  out="$(xcrun notarytool submit "$pkg" "${NOTARY_AUTH[@]}" --wait 2>&1)" || true
  echo "$out"
  status="$(echo "$out" | sed -n 's/^ *status: //p' | tail -1)"
  sub_id="$(echo "$out" | sed -n 's/^ *id: //p' | tail -1)"
  if [[ "$status" != "Accepted" ]]; then
    echo "Notarization failed (status: ${status:-unknown})." >&2
    if [[ -n "$sub_id" ]]; then
      echo "==> Apple notarization log for $sub_id" >&2
      xcrun notarytool log "$sub_id" "${NOTARY_AUTH[@]}" >&2 || true
    fi
    return 1
  fi
}

# The ticket comes from Apple's CloudKit, which drops connections now and then
# (error 68 / -1005) and may not have a fresh ticket yet (error 65): retry.
staple_pkg() {
  local pkg="$1" attempt
  for attempt in 1 2 3 4 5; do
    if xcrun stapler staple "$pkg"; then
      return 0
    fi
    if [[ "$attempt" -lt 5 ]]; then
      log "Stapling failed (attempt $attempt/5) — retrying in $((attempt * 15)) s"
      sleep $((attempt * 15))
    fi
  done
  echo "Stapling failed after 5 attempts (package is notarized; staple later with: xcrun stapler staple $pkg)." >&2
  return 1
}

if [[ "$SKIP_NOTARY" -eq 0 ]]; then
  if resolve_notary_auth; then
    notarize_pkg "$FINAL_PKG" || exit 1
    log "Stapling notarization ticket"
    staple_pkg "$FINAL_PKG" || exit 1
    spctl --assess --type install -vv "$FINAL_PKG" || true
  else
    msg="No notarization credentials — package is signed but not notarized."
    if [[ "$REQUIRE_NOTARY" -eq 1 ]]; then
      echo "$msg" >&2
      exit 1
    fi
    log "$msg"
  fi
fi

if command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$(basename "$FINAL_PKG")" > "$(basename "$FINAL_PKG").sha256")
fi

log "Created $FINAL_PKG"
ls -lh "$FINAL_PKG"
echo
echo "Install:  sudo installer -pkg $FINAL_PKG -target /"
echo "Binary:   $INSTALL_PREFIX/start.sh   (symlink: /usr/local/bin/audioharbor)"
