#!/usr/bin/env bash
# Import Developer ID certificates into a temporary keychain for GitHub Actions.
#
# Required env:
#   MACOS_CERTIFICATE          base64-encoded .p12 (Application + Installer)
#   MACOS_CERTIFICATE_PASSWORD password for the .p12
#
# Optional:
#   KEYCHAIN_PASSWORD          password for the temp keychain (random if unset)
#
# Exports:
#   HARBOR_KEYCHAIN_PATH
#   KEYCHAIN_PASSWORD
set -euo pipefail

if [[ -z "${MACOS_CERTIFICATE:-}" ]]; then
  echo "MACOS_CERTIFICATE secret is empty — cannot sign macOS packages." >&2
  exit 1
fi
if [[ -z "${MACOS_CERTIFICATE_PASSWORD:-}" ]]; then
  echo "MACOS_CERTIFICATE_PASSWORD secret is empty." >&2
  exit 1
fi

KEYCHAIN_PASSWORD="${KEYCHAIN_PASSWORD:-$(openssl rand -base64 32)}"
KEYCHAIN_PATH="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/harbor-signing.keychain-db"
CERT_PATH="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/harbor-signing.p12"

cleanup_partial() {
  rm -f "$CERT_PATH"
}
trap cleanup_partial EXIT

echo "$MACOS_CERTIFICATE" | base64 --decode > "$CERT_PATH"

# Recreate clean keychain each run
security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

security import "$CERT_PATH" \
  -k "$KEYCHAIN_PATH" \
  -P "$MACOS_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/productsign \
  -T /usr/bin/pkgbuild \
  -T /usr/bin/security

# Allow codesign/productsign without GUI prompt
security set-key-partition-list \
  -S apple-tool:,apple:,codesign:,productsign: \
  -s -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN_PATH"

# Prefer our keychain first
EXISTING="$(security list-keychains -d user | sed 's/"//g')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$KEYCHAIN_PATH" $EXISTING

echo "==> Imported signing identities:"
security find-identity -v -p codesigning "$KEYCHAIN_PATH"
security find-identity -v "$KEYCHAIN_PATH" | grep 'Developer ID' || true

# Persist for later steps / cleanup
{
  echo "HARBOR_KEYCHAIN_PATH=$KEYCHAIN_PATH"
  echo "KEYCHAIN_PASSWORD=$KEYCHAIN_PASSWORD"
} >> "${GITHUB_ENV:-/dev/null}"

export HARBOR_KEYCHAIN_PATH="$KEYCHAIN_PATH"
export KEYCHAIN_PASSWORD
echo "HARBOR_KEYCHAIN_PATH=$KEYCHAIN_PATH"
