# Audio Harbor Headless

GUI-less audiophile media host for **macOS**, **Linux**, and **Windows**. Control everything from an iPhone (web remote / Bonjour). Also acts as a DLNA music server.

**Product page:** [docs/index.html](docs/index.html) — same brand design as [Audio Harbor](https://github.com/petergerov/audio-harbor/tree/main/docs).

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
| `*-darwin-arm64.tar.gz` | Apple Silicon Mac (M1 and later) |
| `*-darwin-x64.tar.gz` | Intel Mac |
| `*-linux-x64.tar.gz` | Linux Intel/AMD |
| `*-linux-arm64.tar.gz` | Raspberry Pi 64-bit / ARM64 |
| `*-win32-x64.zip` | Windows x64 |

Intel and Apple Silicon Macs both use the native Core Audio path (`backend = "native"`). Pick the archive that matches `uname -m` (`arm64` vs `x86_64`).

Prebuilt archives **bundle Node.js 20** under `runtime/` — you do not need a system Node install. `./start.sh` uses the bundled binary so it always matches `harbor_engine.node`. macOS typically needs **11 Big Sur or newer**.

```bash
# Example Raspberry Pi
curl -LO https://github.com/petergerov/audio-harbor-headless/releases/latest/download/audio-harbor-headless-1.0.0-linux-arm64.tar.gz
tar -xzf audio-harbor-headless-*-linux-arm64.tar.gz
cd audio-harbor-headless-*
sudo apt install -y libasound2   # JUCE uses ALSA on Linux
# Node 20.x required
./start.sh
```

Windows: unpack the `.zip` and run `start.cmd` (Node 20+).

Publish a release (manual only):

1. Push `main` with the commits you want
2. GitHub → **Actions** → **Release packages** → **Run workflow**
3. Enter tag (e.g. `v1.0.1`) — optional: draft

Or locally:

```bash
npm run package:prebuilt                 # → dist/packages/*-<platform>.tar.gz
./create-package.sh                      # source-only (compile on device via install.sh)
```

### Playlists & labels

Same idea as Audio Harbor: playlists and labels are sets of catalogue paths.

- Web remote: **Playlists** / **Labels** tabs; **···** on album, artist, folder, or track → add to playlist or label (albums/artists/folders expand to their tracks).
- API: `GET/POST /api/v1/playlists`, `POST /api/v1/playlists/:id/items`, `POST /api/v1/labels/items`, `POST /api/v1/play` with `playlistId` or `label`.
- Bonjour: browse `playlists` / `labels`, `playSelection.playlist` / `.label`, existing `trackOptions` / `editTrack`.

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
