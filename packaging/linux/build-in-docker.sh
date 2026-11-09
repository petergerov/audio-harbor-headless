#!/usr/bin/env bash
# The release workflow's Linux job, run inside debian:bookworm (glibc 2.36, so the binaries also
# run on Raspberry Pi OS Bookworm and newer). Called by release-local.sh:
#
#   docker run --rm --platform linux/<arm64|amd64> \
#     -v <source snapshot>:/src:ro -v <output dir>:/out -v <this file>:/build.sh:ro \
#     debian:bookworm bash /build.sh
#
# /src is a plain copy of the commit (git archive); the packages land in /out.
set -euo pipefail
log() { printf '\n==> %s\n' "$*"; }

log "Build deps"
apt-get update -y >/dev/null
DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
  build-essential cmake ninja-build pkg-config python3 \
  libasound2-dev liblilv-dev lv2-dev libx11-dev libsndfile1-dev curl ca-certificates rsync xz-utils >/dev/null

log "Node 22"
case "$(uname -m)" in
  aarch64) NARCH=arm64 ;;
  x86_64) NARCH=x64 ;;
  *) echo "unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
NODE_TGZ="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-${NARCH}\.tar\.xz" | head -1)"
curl -fsSL "https://nodejs.org/dist/latest-v22.x/${NODE_TGZ}" | tar -xJ -C /usr/local --strip-components=1
node -v

log "Source"
mkdir -p /work
rsync -a /src/ /work/
cd /work

log "npm ci"
npm ci --no-audit --no-fund

log "Build"
npm run build

log "Plugins for the rack"
packaging/build-plugins.sh "$PWD"

log "Prune"
npm prune --omit=dev --no-audit --no-fund

log "Package (.tar.gz)"
chmod +x create-package.sh create-deb.sh start.sh install.sh
HARBOR_PLATFORM="linux-${NARCH}" ./create-package.sh --prebuilt

log "Package (.deb)"
./create-deb.sh

mkdir -p /out
cp -v dist/packages/*-linux-${NARCH}.tar.gz* dist/packages/*.deb* /out/
dpkg-deb -f /out/*_"$(dpkg --print-architecture)".deb Package Version Architecture Depends Recommends Suggests
