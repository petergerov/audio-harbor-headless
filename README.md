# Audio Harbor Headless

GUI-less audiophile media host for **macOS**, **Linux**, and **Windows**. Control everything from an iPhone (web remote / Bonjour). Plays to UPnP / DLNA network players like to a DAC, and also acts as a DLNA music server.

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

Open `http://audioharbor.local:8787` on your iPhone (or scan the QR in the terminal; the IP URL printed next to it works too).

```bash
npm run harbor -- pair     # show / rotate pairing PIN
npm run harbor -- rescan   # re-index library roots
```

Config lives at `~/.audio-harbor-headless/config.toml` (created from `config.example.toml` on first run).

Enable DLNA sharing with `sharing.enabled = true` (restart `harbor serve`). Bonjour remote (`_audioharbor._tcp`) starts when `remote.bonjour_enabled = true`.

### Name on the network

The host answers to **`audioharbor.local`** over mDNS / Bonjour, so the remote is at `http://audioharbor.local:8787`. The QR code uses that name, so an app saved to the iPhone home screen keeps working when the host gets a new IP. The web remote (`_http._tcp`) and the Bonjour remote are announced on it, IPv4 only.

- When another device already answers to the name, the host takes `audioharbor-2.local` (then `-3` …) and says so at start.
- Change it or turn it off with `server.local_hostname` (`""` = off).
- For the bare name `audioharbor` through the router's DNS (e.g. `audioharbor.fritz.box`), give the machine that hostname — on a Raspberry Pi `sudo hostnamectl set-hostname audioharbor`.

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

Prebuilt archives **bundle Node.js 22** under `runtime/` — you do not need a system Node install. `./start.sh` uses the bundled binary so it always matches `harbor_engine.node` (requires Node ≥22.5 for `node:sqlite`). macOS typically needs **11 Big Sur or newer**.

```bash
# Example Raspberry Pi
curl -LO https://github.com/petergerov/audio-harbor-headless/releases/latest/download/audio-harbor-headless-1.0.0-linux-arm64.tar.gz
tar -xzf audio-harbor-headless-*-linux-arm64.tar.gz
cd audio-harbor-headless-*
sudo apt install -y libasound2   # JUCE uses ALSA on Linux
# Node 22+ is bundled in prebuilt packages
./start.sh
```

Windows: unpack the `.zip` and run `start.cmd` (bundled Node 22, or system Node 22+).

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

### Network players (UPnP / DLNA)

A UPnP / DLNA renderer on the home network — a streamer, an amp such as a Devialet Expert, some TVs and soundbars — is an output like a DAC. The host stays the player with library and queue; the renderer pulls the audio over HTTP. Same behaviour as [Audio Harbor](https://github.com/petergerov/audio-harbor/blob/main/docs/UPNP.md).

- **Pick it** under Settings → Output → Device (listed under *Network Players*, marked `(Network player)`), or `PUT /api/v1/output` with `{ "deviceUid": "upnp:uuid:…" }`. The host searches all the time (SSDP M-SEARCH every 30 s, NOTIFY alive / byebye); a new player shows up within seconds. The pick is stored by UDN and comes back after the player's power cycle; while it is off, its name stays in the list.
- **What is sent:**

  | File | Goes to the player as |
  |---|---|
  | FLAC, WAV, AIFF, ALAC / AAC (M4A), MP3 the player lists (`GetProtocolInfo`) | the file itself, untouched |
  | a format the player does not list | WAV at the file's rate (16-bit sources stay 16-bit, else 24-bit) |
  | DSF, DFF, SACD ISO (also DST) | by the player's **DSD** setting, below |

  WAV is made on the fly with a computed `Content-Length`, so `Range` requests map to frames and seeking works.
- **Network stream** (`output.network_stream`, shown under Output once a network player is picked): `full` sends the best the player takes; `wifi` turns only DSD / SACD into 44.1 kHz / 16-bit PCM (about 1.4 instead of 4.2 Mbit/s), whatever DSD is set to. Use it when DSD drops out over Wi‑Fi.
- **DSD** (Settings → Output → DSD for a network player, stored per player in `network.dsd_modes`):

  | DSD | DSF, DFF and SACD go to the player as |
  |---|---|
  | **Auto** (default) | the DSD file untouched (`audio/x-dsf`, `audio/x-dff`; an SACD track as its extracted DFF) when the player lists DSD in `GetProtocolInfo`; else PCM |
  | **PCM** | PCM WAV, ~88.2 kHz / 24-bit, with `dsd_pcm_level` applied |
  | **DoP** | DoP in a 24-bit WAV at DSD rate / 16 (DSD64 → 176.4 kHz, about 8.5 Mbit/s; DSD128 → 352.8 kHz) — the DSD bits untouched, for a DAC behind the player that plays DoP |

  Output shows which DSD types the picked player lists. **DoP works only when the player hands PCM through bit-perfect:** volume at 100 % or fixed, no resampling, no EQ or room correction. Otherwise the DAC gets PCM and plays loud noise — try it with the amp turned down. While DoP is on (with Full), the host leaves the player's volume alone: no `SetVolume`, and the remotes show no volume. The web remote asks before it turns DoP on.
- **Gapless** with `SetNextAVTransportURI` when the player has it; otherwise tracks change with a short gap.
- **Volume** from the web remote and the iPhone remote sets the player's volume (RenderingControl); a knob on the device shows up in the remote. Not with DSD set to DoP (above).
- Exclusive and DoP under Mode are for DACs on this host and are greyed out for a network player (DSD to a network player: see DSD above). Moving between this host and a network player carries the current track over at the same position; changing Network stream or DSD reloads a DSD track at the same position.
- **Player gone** (off, Wi‑Fi drop): playback stops with a message; once it is back, Play loads the track again where it was.
- The host is kept from idle sleep while a player streams (`caffeinate` on macOS, `systemd-inhibit` on Linux).
- **Firewall:** players connect *in* to `network.media_port` (default 49153, any free port when taken). On macOS 15+ allow **Local Network** access for the terminal / Node when asked, or players are not found.

```toml
[output]
device_uid = "upnp:uuid:…"   # a network player
network_stream = "full"      # full | wifi

[network]
media_port = 49153

[network.dsd_modes]          # per player: auto | pcm | dop (missing = auto)
"upnp:uuid:…" = "dop"
```

API: `PUT /api/v1/output` takes `networkStream` and `networkDsd` (stored for the picked player); `GET /api/v1/output/formats?uid=upnp:uuid:…` tells which DSD types a player lists, its volume and its DSD mode.

## Layout

```
host/     TypeScript daemon (API, library, DLNA server, network players, Bonjour)
engine/   C++ + N-API — JucePlayer + Mac/Linux/Win native (runtime switch)
web/      Mobile web remote
```

Check [JUCE licensing](https://juce.com/legal/juce-8-licence/) before distributing or selling.
