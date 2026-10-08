# Audio Harbor Headless

GUI-less audiophile media host for **macOS**, **Linux**, and **Windows**. Control everything from an iPhone (web remote / Bonjour). Also acts as a DLNA music server.

## Stack

| Layer | Tech |
|---|---|
| Audio engine | **C++ via Node-API** — JUCE + native (Core Audio / ALSA / WASAPI), runtime `output.backend` |
| Host | **TypeScript / Node** (Fastify) |
| Remote UI | **Vite + TypeScript** (mobile web) |

Release builds ship **both** stacks on Mac/Linux. You choose at runtime:

```toml
# ~/.audio-harbor-headless/config.toml
[output]
backend = "auto"    # auto | juce | native
# auto   → native (Exclusive/DoP-friendly)
# juce   → portable JUCE path on every OS
# native → Mac Core Audio | Linux ALSA | Windows WASAPI Exclusive/DoP
```

Or via API: `PUT /api/v1/output` with `{ "backend": "native" }`.

## Quick start

```bash
npm install
npm run build:engine   # pulls JUCE via CMake FetchContent, then builds harbor_engine.node
npm run build:web
npm run serve          # or: npm run harbor -- serve
```

Open the printed LAN URL on your iPhone (or scan the QR in the terminal).

```bash
npm run harbor -- pair     # show / rotate pairing PIN
npm run harbor -- rescan   # re-index library roots
```

Config lives at `~/.audio-harbor-headless/config.toml` (created from `config.example.toml` on first run).

Enable DLNA sharing with `sharing.enabled = true` (restart `harbor serve`). Bonjour remote (`_audioharbor._tcp`) starts when `remote.bonjour_enabled = true`.

### Prebuilt packages (ready to start)

GitHub Actions builds one archive **per platform** (JUCE + native on Mac/Linux/Windows) and attaches them to [Releases](https://github.com/petergerov/audio-harbor-headless/releases):

| Asset | Platform |
|---|---|
| `*-darwin-arm64.tar.gz` | Apple Silicon Mac |
| `*-linux-x64.tar.gz` | Linux Intel/AMD |
| `*-linux-arm64.tar.gz` | Raspberry Pi 64-bit / ARM64 |
| `*-win32-x64.zip` | Windows x64 |

```bash
# Example Raspberry Pi
curl -LO https://github.com/petergerov/audio-harbor-headless/releases/latest/download/audio-harbor-headless-0.1.0-linux-arm64.tar.gz
tar -xzf audio-harbor-headless-*-linux-arm64.tar.gz
cd audio-harbor-headless-*
sudo apt install -y libasound2   # JUCE uses ALSA on Linux
# Node 20.x required
./start.sh
```

Windows: unpack the `.zip` and run `start.cmd` (Node 20+).

Publish a release:

```bash
git tag v0.1.1 && git push origin v0.1.1   # triggers .github/workflows/release-packages.yml
```

Or locally:

```bash
npm run package:prebuilt                 # → dist/packages/*-<platform>.tar.gz
./create-package.sh                      # source-only (compile on device via install.sh)
```

### Output modes

- **Shared** — system / JUCE shared graph
- **Exclusive** — strongest with `backend = "native"` (Core Audio hog / ALSA `hw:` / WASAPI Exclusive)
- **DoP** — native DoP path; on JUCE, DSD→PCM with an honest badge

## Layout

```
host/     TypeScript daemon (API, library, DLNA, Bonjour)
engine/   C++ + N-API — JucePlayer + Mac/Linux/Win native (runtime switch)
web/      Mobile web remote
```

Check [JUCE licensing](https://juce.com/legal/juce-8-licence/) before distributing or selling.
