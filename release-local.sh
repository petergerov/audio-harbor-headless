#!/usr/bin/env bash
# Build the release packages on this Mac and publish them as a GitHub release — the "Release
# packages" workflow without GitHub Actions (when its minutes run out, or simply from here).
#
#   ./release-local.sh                 # v<package.json version>: linux-arm64 + darwin-arm64
#   ./release-local.sh --platforms linux-arm64,linux-x64,darwin-arm64
#   ./release-local.sh --dry-run       # build and check, publish nothing
#   ./release-local.sh --draft         # publish as a draft release
#   ./release-local.sh --replace       # delete an existing release and tag of this version first
#
# Platforms:
#   linux-arm64   Raspberry Pi / ARM64 .deb + .tar.gz — Docker debian:bookworm, native on Apple Silicon
#   linux-x64     Intel / AMD .deb + .tar.gz — Docker, emulated: works, but takes much longer
#   darwin-arm64  Apple Silicon .pkg (Developer ID signed) + .tar.gz — on this Mac
#   (darwin-x64 and Windows need their own machines: use the workflow for those.)
#
# What it does:
#   1. Checks: gh signed in, HEAD pushed, the tag (v + package.json version) not taken, Docker running
#      for Linux, Developer ID certificates in the keychain for macOS.
#   2. Builds from a clean snapshot of HEAD (git archive) in a temporary folder — uncommitted changes
#      are not packaged, and the working tree and its node_modules stay as they are. With Node 22,
#      as the workflow (downloaded once to dist/release/.cache for the Mac build).
#   3. Collects the packages, their .sha256 files and install-linux.sh in dist/release/<tag>/ and
#      checks every checksum.
#   4. Creates the release on GitHub at HEAD — the workflow's release text plus GitHub's generated
#      notes — and uploads the packages.
#
# macOS notarization (else the .pkg is signed but not notarized, and Gatekeeper warns):
#   HARBOR_NOTARY_PROFILE=<keychain profile> — once:
#     xcrun notarytool store-credentials harbor-notary --apple-id <id> --team-id <team> --password <app-specific>
#   or APPLE_API_KEY_PATH / APPLE_API_KEY_ID / APPLE_API_ISSUER, or APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
#   APPLE_TEAM_ID (see create-macos-pkg.sh). --require-notary refuses to publish without it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PLATFORMS="linux-arm64,darwin-arm64"
DRY_RUN=0
DRAFT=0
REPLACE=0
REQUIRE_NOTARY=0
NODE_MAJOR=22

usage() { sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platforms) PLATFORMS="${2:?--platforms needs a list}"; shift ;;
    --platforms=*) PLATFORMS="${1#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --draft) DRAFT=1 ;;
    --replace) REPLACE=1 ;;
    --require-notary) REQUIRE_NOTARY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
has() { [[ ",$PLATFORMS," == *",$1,"* ]]; }

IFS=',' read -r -a PLATFORM_LIST <<< "$PLATFORMS"
for p in "${PLATFORM_LIST[@]}"; do
  case "$p" in
    linux-arm64|linux-x64|darwin-arm64) ;;
    darwin-x64|win32-x64) die "$p cannot be built here — use the GitHub workflow for it" ;;
    *) die "unknown platform: $p (linux-arm64, linux-x64, darwin-arm64)" ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
SHA="$(git rev-parse HEAD)"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"

# ---------------------------------------------------------------------------------------------
log "Checks for $TAG ($(git rev-parse --short HEAD), platforms: $PLATFORMS)"

command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not signed in: gh auth login"
[[ -n "$REPO" ]] || die "cannot tell the GitHub repository (gh repo view)"

git fetch -q origin
if ! git branch -r --contains "$SHA" | grep -q .; then
  die "HEAD $(git rev-parse --short HEAD) is not on GitHub — push it first (the release points at it)"
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Note: uncommitted changes are not in the release — it is built from HEAD."
fi

release_exists=0
gh release view "$TAG" >/dev/null 2>&1 && release_exists=1
tag_exists=0
git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 && tag_exists=1
if [[ $release_exists == 1 || $tag_exists == 1 ]] && [[ $REPLACE == 0 && $DRY_RUN == 0 ]]; then
  die "$TAG exists on GitHub already (release: $release_exists, tag: $tag_exists) — bump the version, or --replace"
fi

if has linux-arm64 || has linux-x64; then
  docker info >/dev/null 2>&1 || die "Docker is not running (needed for the Linux packages)"
fi
NOTARY_ARG=""
if has darwin-arm64; then
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || die "darwin-arm64 is built on an Apple Silicon Mac"
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" \
    || die "no 'Developer ID Application' certificate in the keychain (see packaging/macos/README.md)"
  security find-identity -v 2>/dev/null | grep -q "Developer ID Installer" \
    || die "no 'Developer ID Installer' certificate in the keychain"
  if [[ -n "${HARBOR_NOTARY_PROFILE:-}${APPLE_API_KEY_ID:-}${APPLE_ID:-}" ]]; then
    NOTARY_ARG="--require-notary"
  elif [[ $REQUIRE_NOTARY == 1 ]]; then
    die "--require-notary, but no notarization credentials (HARBOR_NOTARY_PROFILE, APPLE_API_KEY_*, APPLE_ID…)"
  else
    NOTARY_ARG="--skip-notary"
    echo "Note: no notarization credentials — the .pkg is signed, not notarized (Gatekeeper warns on first open)."
  fi
fi

# ---------------------------------------------------------------------------------------------
OUT="$ROOT/dist/release/$TAG"
CACHE="$ROOT/dist/release/.cache"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/harbor-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
rm -rf "$OUT"
mkdir -p "$OUT" "$CACHE"

log "Source snapshot of HEAD"
mkdir -p "$TMP/src"
git archive --format=tar "$SHA" | tar -x -C "$TMP/src"

build_linux() {
  local plat="$1" docker_arch
  case "$plat" in
    linux-arm64) docker_arch="linux/arm64" ;;
    linux-x64) docker_arch="linux/amd64" ;;
  esac
  log "$plat in Docker debian:bookworm ($docker_arch)"
  local buildlog="$OUT/build-$plat.log"
  if ! docker run --rm --platform "$docker_arch" \
    -v "$TMP/src:/src:ro" \
    -v "$OUT:/out" \
    -v "$ROOT/packaging/linux/build-in-docker.sh:/build.sh:ro" \
    debian:bookworm bash /build.sh > "$buildlog" 2>&1; then
    tail -20 "$buildlog" >&2 || true
    die "$plat build failed — see $buildlog"
  fi
  grep -E '^==>|^Package:|^Version:|^Architecture:|^Recommends:|^Suggests:' "$buildlog" || true
}

node22() {
  local dir
  dir="$(find "$CACHE" -maxdepth 1 -type d -name "node-v${NODE_MAJOR}.*-darwin-arm64" 2>/dev/null | head -1)"
  if [[ -z "$dir" ]]; then
    local name
    name="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/" | grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.gz" | head -1)"
    [[ -n "$name" ]] || die "cannot find Node ${NODE_MAJOR} for darwin-arm64 on nodejs.org"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$name" | tar -xz -C "$CACHE"
    dir="$CACHE/${name%.tar.gz}"
  fi
  echo "$dir/bin"
}

build_darwin() {
  log "darwin-arm64 on this Mac (Node ${NODE_MAJOR})"
  local node_bin src="$TMP/darwin-arm64"
  node_bin="$(node22)"
  cp -R "$TMP/src" "$src"
  (
    cd "$src"
    export PATH="$node_bin:$PATH"
    echo "node $(node -v)"
    npm ci --no-audit --no-fund
    npm run build
    packaging/build-plugins.sh "$PWD"
    npm prune --omit=dev --no-audit --no-fund
    chmod +x create-package.sh start.sh install.sh create-macos-pkg.sh
    HARBOR_PLATFORM=darwin-arm64 ./create-package.sh --prebuilt
    # shellcheck disable=SC2086
    ./create-macos-pkg.sh $NOTARY_ARG
  ) > "$OUT/build-darwin-arm64.log" 2>&1 || die "darwin-arm64 build failed — see $OUT/build-darwin-arm64.log"
  cp "$src"/dist/packages/*-darwin-arm64.* "$OUT/"
  grep -E '^==>' "$OUT/build-darwin-arm64.log" | tail -6 || true
}

has linux-arm64 && build_linux linux-arm64
has linux-x64 && build_linux linux-x64
has darwin-arm64 && build_darwin

# ---------------------------------------------------------------------------------------------
log "Packages"
if has linux-arm64 || has linux-x64; then
  cp "$ROOT/packaging/linux/install-linux.sh" "$OUT/"
fi
expect=()
has linux-arm64 && expect+=("audio-harbor-headless_${VERSION}_arm64.deb" "audio-harbor-headless-${VERSION}-linux-arm64.tar.gz")
has linux-x64 && expect+=("audio-harbor-headless_${VERSION}_amd64.deb" "audio-harbor-headless-${VERSION}-linux-x64.tar.gz")
has darwin-arm64 && expect+=("audio-harbor-headless-${VERSION}-darwin-arm64.pkg" "audio-harbor-headless-${VERSION}-darwin-arm64.tar.gz")
assets=()
for f in "${expect[@]}"; do
  [[ -f "$OUT/$f" && -f "$OUT/$f.sha256" ]] || die "missing $f (or its .sha256)"
  (cd "$OUT" && shasum -a 256 -c "$f.sha256" >/dev/null) || die "checksum mismatch: $f"
  assets+=("$OUT/$f" "$OUT/$f.sha256")
  printf '  %-58s %s\n' "$f" "$(du -h "$OUT/$f" | cut -f1)"
done
[[ -f "$OUT/install-linux.sh" ]] && assets+=("$OUT/install-linux.sh")

# The workflow's release text, then GitHub's notes for the commits since the last release.
cat > "$OUT/notes.md" <<EOF
Prebuilt **ready-to-start** packages (Node ${NODE_MAJOR}), built locally with \`release-local.sh\`.

| Asset | Platform |
|---|---|
| \`*-darwin-arm64.pkg\` | Apple Silicon Mac — signed installer |
| \`*-darwin-arm64.tar.gz\` | Apple Silicon Mac (portable) |
| \`*_arm64.deb\` | Raspberry Pi 64-bit / ARM64 — Debian package with systemd service |
| \`*_amd64.deb\` | Linux x86_64 — Debian package with systemd service |
| \`install-linux.sh\` | one-line installer for the \`.deb\` |
| \`*-linux-x64.tar.gz\` | Linux x86_64 (portable) |
| \`*-linux-arm64.tar.gz\` | Raspberry Pi 64-bit / ARM64 Linux (portable) |

This release has: **${PLATFORMS//,/, }**.

**macOS:** prefer the \`.pkg\` (Developer ID signed). Installs to \`/usr/local/audio-harbor-headless\` and adds \`audioharbor\` on \`PATH\`.
**Portable:** unpack a \`.tar.gz\` → \`./start.sh\`. **Node.js is bundled** under \`runtime/\`.
**Raspberry Pi OS / Debian / Ubuntu:** \`curl -fsSL https://github.com/${REPO}/releases/latest/download/install-linux.sh | sudo bash\` — installs the \`.deb\` to \`/opt/audio-harbor-headless\` and starts service \`audioharbor@<user>\`. Built on Debian 12 (glibc 2.32+): Raspberry Pi OS Bookworm or newer, Debian 12+, Ubuntu 22.04+.
Portable Linux: \`sudo apt install libasound2\` if ALSA is missing.
EOF
if generated="$(gh api "repos/$REPO/releases/generate-notes" -f tag_name="$TAG" -f target_commitish="$SHA" -q .body 2>/dev/null)"; then
  printf '\n%s\n' "$generated" >> "$OUT/notes.md"
fi

if [[ $DRY_RUN == 1 ]]; then
  log "Dry run: nothing published"
  echo "Packages and notes are in $OUT"
  exit 0
fi

# ---------------------------------------------------------------------------------------------
if [[ $REPLACE == 1 ]]; then
  if [[ $release_exists == 1 ]]; then
    log "Deleting the existing release $TAG and its tag"
    gh release delete "$TAG" --cleanup-tag -y
  elif [[ $tag_exists == 1 ]]; then
    log "Deleting the existing tag $TAG"
    git push -q origin ":refs/tags/$TAG"
  fi
fi

log "Release $TAG on GitHub"
draft_arg=""
[[ $DRAFT == 1 ]] && draft_arg="--draft"
# shellcheck disable=SC2086
gh release create "$TAG" "${assets[@]}" \
  --repo "$REPO" --target "$SHA" --title "$TAG" --notes-file "$OUT/notes.md" $draft_arg

log "Done"
gh release view "$TAG" --repo "$REPO" --json url,isDraft,assets \
  -q '"\(.url)  (draft: \(.isDraft))", (.assets[] | "  \(.name)  \(.size / 1048576 | floor) MB")'
