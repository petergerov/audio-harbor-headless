# macOS signed installer (CI)

The **Release packages** workflow (`.github/workflows/release-packages.yml`) builds a Developer ID–signed `.pkg` on each macOS runner (`darwin-arm64`, `darwin-x64`) and, if credentials are configured, notarizes it with Apple.

To make that work, GitHub needs a few **secrets**. This guide walks you through getting every value, step by step.

**Overview**

| Step | What | Required? |
|---|---|---|
| 1 | Check the Developer ID certificates on your Mac | yes |
| 2 | Export them into one `.p12` file | yes |
| 3 | Add `MACOS_CERTIFICATE` + `MACOS_CERTIFICATE_PASSWORD` to GitHub | yes |
| 4 | Set up notarization (API key **or** Apple ID) | recommended |
| 5 | Run the workflow | – |
| 6 | Clean up | yes |

---

## Where secrets go in GitHub

Repo → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** → **New repository secret**.

- Use **Secrets**, not *Variables*. The workflow reads `secrets.*`, and variables are visible in plain text.
- Use **Repository secrets**, not *Environment secrets*. The jobs don't declare an `environment:`, so environment secrets would be empty for them.
- Names must match **exactly** (all caps, underscores).

Alternative from the terminal, if you have the GitHub CLI (`gh`) installed:

```bash
gh secret set SECRET_NAME            # prompts for the value
gh secret set SECRET_NAME < file.txt # reads the value from a file
```

---

## Step 1 — Check your Developer ID certificates

Open Terminal and run:

```bash
security find-identity -v | grep "Developer ID"
```

You need to see **both** of these lines:

```
"Developer ID Application: Petar Gerov (C9LBGZNZ6P)"
"Developer ID Installer: Petar Gerov (C9LBGZNZ6P)"
```

The value in parentheses (`C9LBGZNZ6P`) is your **Team ID**. Keep it in mind for step 4.

> **Which certificates do I need?** Only the two **Developer ID** ones. They are for apps distributed *outside* the App Store.
> Ignore these: *Apple Development* (local debugging), *Apple Distribution* and *3rd Party Mac Developer Installer* (both App Store only).

**Missing one?** Create it in Xcode: **Xcode → Settings → Accounts** → select your Apple ID → team → **Manage Certificates…** → **+** → *Developer ID Application* / *Developer ID Installer*. (Only the account holder of the team may create Developer ID certificates.)

---

## Step 2 — Export both certificates into one `.p12`

1. Open **Keychain Access** (Spotlight: "Keychain Access" / "Schlüsselbundverwaltung").
2. In the sidebar choose the **login** keychain, at the top choose the **My Certificates** tab.
   *Important:* only this tab exports the **private keys** together with the certificates. Without the keys the file can't sign anything.
3. Type `Developer ID` into the search field. Now only the two certificates are listed.
4. Click the first one, then **⌘-click** the second one, so both are selected.
   (Optional check: click the ▸ arrow — each should have a private key underneath.)
5. Right-click → **Export 2 items…**
6. File format: **Personal Information Exchange (.p12)**. Name: `Certificates.p12`, e.g. on the Desktop.
7. Choose a **password** for the file. Write it down — this is the value of `MACOS_CERTIFICATE_PASSWORD`.
8. macOS asks for your Mac login password to allow exporting the keys → enter it, click **Allow** (possibly twice, once per key).

Check that both certificates are in the file:

```bash
cd ~/Desktop
openssl pkcs12 -in Certificates.p12 -nokeys -legacy | grep "subject="
```

It asks for the `.p12` password. You should see one line with *Developer ID Application* and one with *Developer ID Installer*.
(If `-legacy` gives an error, run the command without it.)

---

## Step 3 — Add the signing secrets to GitHub

**`MACOS_CERTIFICATE`** — the `.p12` file as Base64 text:

```bash
cd ~/Desktop
base64 -i Certificates.p12 | pbcopy
```

This copies a long block of text to the clipboard (nothing is printed — that's normal). In GitHub: **New repository secret** → Name `MACOS_CERTIFICATE` → paste with ⌘V → **Add secret**.

**`MACOS_CERTIFICATE_PASSWORD`** — the password you chose in step 2, item 7.

With only these two secrets the workflow already produces a **signed** `.pkg`. Without notarization, however, macOS Gatekeeper still shows a warning when users open it — so do step 4 as well.

---

## Step 4 — Notarization (recommended)

Choose **one** of the two options. Option A is preferred for CI.

### Option A — App Store Connect API key (preferred)

You need three values: the key file (`.p8`), the **Key ID** and the **Issuer ID**.

1. Open [appstoreconnect.apple.com](https://appstoreconnect.apple.com) and sign in.
2. Go to **Users and Access** → tab **Integrations** → **App Store Connect API** (left) → **Team Keys**.
   (First time: you may have to click **Request Access** and accept the terms — account holder only.)
3. At the top of that page you'll see the **Issuer ID** (looks like `69a6de7e-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Copy it → this is `APPLE_API_ISSUER`.
4. Click **+** (Generate API Key). Name: e.g. `GitHub notarization`. Access: **Developer** is enough. → **Generate**.
5. The new key appears in the list. The **Key ID** column (10 characters, e.g. `AB12CD34EF`) → this is `APPLE_API_KEY_ID`.
6. Click **Download** next to the key. You get a file `AuthKey_AB12CD34EF.p8`.
   ⚠️ **You can download it only once.** If you lose it, revoke the key and create a new one.
7. Convert the file to Base64:

   ```bash
   cd ~/Downloads
   base64 -i AuthKey_AB12CD34EF.p8 | pbcopy
   ```

   → paste as `APPLE_API_KEY_BASE64`.

| Secret | Value | Where from |
|---|---|---|
| `APPLE_API_KEY_BASE64` | Base64 of the `.p8` file | step 7 |
| `APPLE_API_KEY_ID` | e.g. `AB12CD34EF` | step 5 |
| `APPLE_API_ISSUER` | UUID | step 3 |

### Option B — Apple ID + app-specific password

1. Open [account.apple.com](https://account.apple.com) (formerly appleid.apple.com) and sign in.
2. **Sign-In and Security** → **App-Specific Passwords** → **+** / Generate.
3. Label: e.g. `GitHub notarization` → you get a password like `abcd-efgh-ijkl-mnop`. Copy it right away; it's shown only once.

| Secret | Value |
|---|---|
| `APPLE_ID` | your Apple ID email (the one in your developer account) |
| `APPLE_APP_SPECIFIC_PASSWORD` | the `abcd-efgh-ijkl-mnop` password from step 3 |
| `APPLE_TEAM_ID` | `C9LBGZNZ6P` (from step 1) |

### How the workflow decides

- `APPLE_API_KEY_BASE64` **or** `APPLE_ID` is set → it signs **and must** notarize (fails if notarization fails).
- Neither is set → it only signs.
- Workflow input **skip_notary** checked → it only signs, even if the secrets exist.

---

## Step 5 — Run the workflow

GitHub → **Actions** → **Release packages** → **Run workflow**:

- **tag**: e.g. `v1.0.6` (must start with `v` + a digit)
- **draft**: check it if you want to review the release before publishing
- **skip_notary**: leave unchecked

In the log of the macOS jobs, the step **Import macOS signing certificate** should list both Developer ID identities. The `.pkg` files then appear in the GitHub Release.

---

## Step 6 — Clean up

The `.p12` and `.p8` files contain your **private keys**. Once the secrets are in GitHub:

```bash
rm ~/Desktop/Certificates.p12
rm ~/Downloads/AuthKey_*.p8
```

(Or store them in a password manager.) **Never commit them to the repo.**

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `zsh: command not found: pbcop` | Typo — it's `pbcopy`. |
| `MACOS_CERTIFICATE secret is empty` | Secret name misspelled, or stored as *Variable* / *Environment secret* instead of *Repository secret*. |
| `No Developer ID Installer identity found` | The `.p12` only contains one certificate → repeat step 2 and select **both**. |
| `security import` fails / wrong password | `MACOS_CERTIFICATE_PASSWORD` doesn't match the password from step 2. |
| Signing fails with "no private key" | Exported from the *Certificates* tab instead of *My Certificates* → repeat step 2. |
| Notarization: 401 / unauthorized | Key ID / Issuer swapped, or key revoked. With Option B: use an app-specific password, not your normal Apple ID password. |

---

## Local build

```bash
npm run package:macos
# or, with archive already built:
./create-macos-pkg.sh
```

Locally the script uses the certificates from your login keychain. For notarization it accepts the same `APPLE_*` variables, or a stored notarytool profile:

```bash
xcrun notarytool store-credentials Harbor   # one-time, interactive
HARBOR_NOTARY_PROFILE=Harbor ./create-macos-pkg.sh
```
