# macOS signed installer (CI)

The **Release packages** workflow builds a Developer ID–signed `.pkg` on each macOS runner (`darwin-arm64`, `darwin-x64`).

## GitHub secrets

Repo → **Settings → Secrets and variables → Actions**.

### Required (signing)

| Secret | Contents |
|---|---|
| `MACOS_CERTIFICATE` | Base64 of a `.p12` that contains **Developer ID Application** and **Developer ID Installer** |
| `MACOS_CERTIFICATE_PASSWORD` | Password for that `.p12` |

Export both identities from Keychain Access into one `.p12`, then:

```bash
base64 -i Certificates.p12 | pbcopy   # paste into MACOS_CERTIFICATE
```

Team ID in use locally: `C9LBGZNZ6P` (Petar Gerov).

### Recommended (notarization)

Either App Store Connect API key (preferred in CI):

| Secret | Contents |
|---|---|
| `APPLE_API_KEY_BASE64` | Base64 of the `.p8` AuthKey |
| `APPLE_API_KEY_ID` | Key ID (e.g. `AB12CD34EF`) |
| `APPLE_API_ISSUER` | Issuer UUID from App Store Connect |

Or Apple ID + app-specific password:

| Secret | Contents |
|---|---|
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | [appleid.apple.com](https://appleid.apple.com) app-specific password |
| `APPLE_TEAM_ID` | e.g. `C9LBGZNZ6P` |

When any notarization secret set is present, the workflow runs `notarytool` and staples the ticket. Use the workflow input **skip_notary** to force signed-only.

## Local

```bash
npm run package:macos
# or, with archive already built:
./create-macos-pkg.sh
```
