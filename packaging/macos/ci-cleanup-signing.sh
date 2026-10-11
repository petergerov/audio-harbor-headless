#!/usr/bin/env bash
# Remove the temporary signing keychain created by ci-import-signing.sh.
set -euo pipefail

KEYCHAIN_PATH="${HARBOR_KEYCHAIN_PATH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/harbor-signing.keychain-db}"
if [[ -f "$KEYCHAIN_PATH" ]]; then
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  echo "==> Removed $KEYCHAIN_PATH"
fi
rm -f "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/harbor-signing.p12" 2>/dev/null || true
