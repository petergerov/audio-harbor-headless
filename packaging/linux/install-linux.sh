#!/usr/bin/env bash
# Install Audio Harbor Headless on Raspberry Pi OS / Debian / Ubuntu.
#
#   curl -fsSL https://github.com/petergerov/audio-harbor-headless/releases/latest/download/install-linux.sh | sudo bash
#
# Downloads the .deb for this CPU from GitHub Releases, installs it with apt
# and starts the service as the user who ran sudo (audioharbor@<user>).
#
# Env:
#   HARBOR_VERSION   release tag to install (e.g. v1.0.0) — default: latest
#   HARBOR_USER      user the service runs as — default: $SUDO_USER
set -euo pipefail

REPO="petergerov/audio-harbor-headless"

die() { echo "Error: $*" >&2; exit 1; }
log() { printf '==> %s\n' "$*"; }

[[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL … | sudo bash"
command -v apt-get >/dev/null 2>&1 || die "apt-get not found — this installer is for Debian-based systems. Use the .tar.gz from the release page."
command -v curl >/dev/null 2>&1 || die "curl not found — sudo apt install curl"

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64|arm64) ;;
  armhf|armel) die "32-bit ARM ($ARCH) is not supported — install the 64-bit Raspberry Pi OS (Pi 3 or newer)." ;;
  *) die "no package for CPU architecture $ARCH" ;;
esac

if [[ -n "${HARBOR_VERSION:-}" ]]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$HARBOR_VERSION"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi
log "Looking up release ($API)"
URL="$(curl -fsSL "$API" \
  | grep -o '"browser_download_url": *"[^"]*_'"$ARCH"'\.deb"' \
  | sed 's/.*"\(https[^"]*\)"/\1/' \
  | head -1 || true)"
[[ -n "$URL" ]] || die "no .deb for $ARCH in that release"

# apt reads the file as user _apt — keep it in a world-readable directory.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 755 "$TMP"
DEB="$TMP/$(basename "$URL")"
log "Downloading $(basename "$URL")"
curl -fL --progress-bar "$URL" -o "$DEB"
chmod 644 "$DEB"

USER_NAME="${HARBOR_USER:-${SUDO_USER:-}}"
log "Installing (apt)"
apt-get update -y
HARBOR_USER="$USER_NAME" DEBIAN_FRONTEND=noninteractive apt-get install -y "$DEB"

echo
log "Done"
echo "  Remote:   http://audioharbor.local:8787  (iPhone: open it in Safari, add to home screen)"
echo "  PIN:      audioharbor pair"
echo "  Music:    Settings → Sources → Add Folder in the remote"
if [[ -n "$USER_NAME" && "$USER_NAME" != "root" ]]; then
  echo "  Service:  sudo systemctl status|restart|stop audioharbor@$USER_NAME"
  echo "  QR code:  journalctl -u audioharbor@$USER_NAME -b --no-pager | tail -40"
  echo "  Log:      journalctl -u audioharbor@$USER_NAME -f"
fi
