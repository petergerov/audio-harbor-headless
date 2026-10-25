# Audio Harbor Headless

GUI-less audiophile media host for **macOS**, **Linux**, and **Windows**. Control everything from an iPhone (web remote / Bonjour). Plays to UPnP / DLNA network players like to a DAC, and also acts as a DLNA music server. Runs the plugins you already have — CLAP and VST3, AU on the Mac, LV2 on Linux / Raspberry Pi — in a rack you steer from the phone.

**Product page:** [docs/index.html](docs/index.html), with screenshots of the remote on desktop and phone — same brand design as [Audio Harbor](https://github.com/petergerov/audio-harbor/tree/main/docs).

## Stack

| Layer | Tech |
|---|---|
| Audio engine | **C++ via Node-API** — native Core Audio / ALSA / WASAPI |
| Plugin rack | **harbor-fx**, its own process — CLAP, VST3 (SDK subset, MIT), AU (AudioToolbox) on macOS, LV2 (lilv) on Linux |
| Host | **TypeScript / Node** (Fastify) |
| Remote UI | **Vite + TypeScript** (mobile web) |

Audio uses the OS stack (`output.backend = "auto"` or `"native"`):

```toml
# ~/.audio-harbor-headless/config.toml
[output]
backend = "auto"    # auto | native → Core Audio / ALSA / WASAPI
```

## Quick start

```bash
npm install
npm run build:engine   # builds harbor_engine.node (native Core Audio / ALSA / WASAPI)
npm run build:web
npm run serve          # or: npm run harbor -- serve
```

Open `http://audioharbor.local:8787` on your iPhone (or scan the QR in the terminal; the IP URL printed next to it works too). **No code is needed**: any phone, tablet or the Audio Harbor iOS app on the same network connects at once. To let in only paired devices, turn on **Settings → About → Require Pairing Code** (`remote.require_pairing = true`): the device that turns it on stays connected, every other one pairs once with the PIN shown there. With the code on and no device paired yet, the remote fills in the PIN itself. A host that already had paired devices before the code became optional keeps asking for it.

```bash
npm run harbor -- pair     # show / rotate pairing PIN
npm run harbor -- rescan   # re-index library roots
```

At start the host scans the library roots in the background (only changed files); Settings → Sources → Rescan does it again with live progress.

Config lives at `~/.audio-harbor-headless/config.toml` (created from `config.example.toml` on first run).

DLNA sharing (`Share Library on the Network` in Settings, or `sharing.enabled` in the config) starts and stops while the host runs — no restart. Bonjour remote (`_audioharbor._tcp`) starts when `remote.bonjour_enabled = true`.

### Name on the network

The host answers to **`audioharbor.local`** over mDNS / Bonjour, so the remote is at `http://audioharbor.local:8787`. The QR code uses that name, so an app saved to the iPhone home screen keeps working when the host gets a new IP. The web remote (`_http._tcp`) and the Bonjour remote are announced on it, IPv4 only.

- When another device already answers to the name, the host takes `audioharbor-2.local` (then `-3` …) and says so at start.
- Change it or turn it off with `server.local_hostname` (`""` = off).
- For the bare name `audioharbor` through the router's DNS (e.g. `audioharbor.fritz.box`), give the machine that hostname — on a Raspberry Pi `sudo hostnamectl set-hostname audioharbor`.

### Prebuilt packages (ready to start)

GitHub Actions builds one archive **per platform** (native audio on Mac/Linux/Windows) and attaches them to [Releases](https://github.com/petergerov/audio-harbor-headless/releases). A release holds the platforms ticked when it was built — all but Windows by default, so the `.zip` is only there when Windows was ticked:

| Asset | Platform |
|---|---|
| `*-darwin-arm64.pkg` | Apple Silicon Mac — **signed installer** |
| `*-darwin-x64.pkg` | Intel Mac — **signed installer** |
| `*-darwin-arm64.tar.gz` | Apple Silicon Mac (portable) |
| `*-darwin-x64.tar.gz` | Intel Mac (portable) |
| `*_arm64.deb` | Raspberry Pi 64-bit / ARM64 — **Debian package + systemd service** |
| `*_amd64.deb` | Linux Intel/AMD — **Debian package + systemd service** |
| `install-linux.sh` | one-line installer for the `.deb` |
| `*-linux-x64.tar.gz` | Linux Intel/AMD (portable) |
| `*-linux-arm64.tar.gz` | Raspberry Pi 64-bit / ARM64 (portable) |
| `*-win32-x64.zip` | Windows x64 |

Intel and Apple Silicon Macs both use the native Core Audio path (`backend = "native"`). Prefer the `.pkg` on Mac; for portable installs pick the `.tar.gz` that matches `uname -m` (`arm64` vs `x86_64`).

Prebuilt archives **bundle Node.js 22** under `runtime/` — you do not need a system Node install. `./start.sh` uses the bundled binary so it always matches `harbor_engine.node` (requires Node ≥22.5 for `node:sqlite`). macOS typically needs **11 Big Sur or newer**.

#### Raspberry Pi / Debian / Ubuntu

```bash
curl -fsSL https://github.com/petergerov/audio-harbor-headless/releases/latest/download/install-linux.sh | sudo bash
```

Installs to `/opt/audio-harbor-headless` and runs as systemd service `audioharbor@<user>` (starts at boot; config stays in `~/.audio-harbor-headless`). Needs 64-bit Raspberry Pi OS Bookworm or newer, Debian 12+ or Ubuntu 22.04+.

Later versions install from the remote: Settings → About → **Software Update** → Install (downloads the release `.deb` for this CPU from GitHub, checks its checksum and restarts the service). A Mac or a portable install sees the new version there and installs it by hand.

On the `.deb`, Settings → Sources → **Drives & Network Shares** sets up a USB drive or an SMB share (an `/etc/fstab` entry under `/mnt/harbor`) and adds its music folder, without a terminal.

Service, USB drives, music on a network share (several hosts, one library), update, removal, portable `.tar.gz`, troubleshooting and building the `.deb`: **[docs/LINUX.md](docs/LINUX.md)**.

Windows: unpack the `.zip` and run `start.cmd` (bundled Node 22, or system Node 22+).

Publish a release (manual only):

1. Push `main` with the commits you want
2. Set macOS signing secrets (once) — see [packaging/macos/README.md](packaging/macos/README.md)
3. GitHub → **Actions** → **Release packages** → **Run workflow**
4. Enter tag (e.g. `v1.0.6`), tick the platforms (all but Windows by default) — optional: draft / skip notarization

The macOS jobs import **Developer ID** certificates from secrets, sign binaries, build a `.pkg`, and notarize when App Store Connect / Apple ID secrets are present.

Or locally:

```bash
npm run package:prebuilt                 # → dist/packages/*-<platform>.tar.gz
npm run package:macos                    # signed .pkg (Developer ID; Apple Silicon/Intel host)
npm run package:deb                      # .deb (Linux host with dpkg-deb)
./create-package.sh                      # source-only (compile on device via install.sh)
```

macOS `.pkg` installs to `/usr/local/audio-harbor-headless`, adds `audioharbor` on `PATH`, and installs the **Audio Harbor** menu bar app in `/Applications`:

- Menu bar: start / stop the server, QR code for the iPhone (and the pairing PIN when the code is on), open the remote or Settings, config file, log.
- Toggles in the menu: *Start Server When App Opens* and *Open at Login* (macOS 13+).
- Server output goes to `~/.audio-harbor-headless/harbor.log`. Quitting the app stops a server it started.
- Terminal: start with `audioharbor`, stop with Ctrl+C or `audioharbor stop` (also `pair`, `rescan`).

### Web remote (Deck · Catalogue · Settings)

The Vite remote matches the Harbor look of the iOS / macOS app: Deck (Turntable or Reel-to-Reel stage), Catalogue (Dirs · Albums · Artists · Lists), and Settings. On a phone the Deck fits above the tab bar without scrolling; on a wide desktop the content sits beside the sidebar, Up Next is a right rail on Deck, and the bottom player stays off while you are on Deck. Details: [web/README.md](web/README.md).

Settings has five panes:

- **Sources** — music folders (add, remove, Update Library / Rescan with progress); on the Linux package also USB drives and SMB shares.
- **Output** — device, mode, network stream and DSD for network players, DSD as PCM gain, and the current path.
- **Rack** — the plugin rack: add, order, switch and remove plugins, their knobs, and the A/B bypass (see [Plugin rack](#plugin-rack)).
- **Sharing** — the DLNA music server.
- **About** — the host's CPU, memory and disk space, **Require Pairing Code** (off: no code on this network) and, with it on, the PIN for another device, the version and **Software Update**.

### Playlists & labels

Same idea as Audio Harbor: playlists and labels are sets of catalogue paths.

- Web remote: Catalogue → **Lists** (playlists); labels open as a drill-in. **···** on album, artist, folder, or track → add to playlist or label (albums/artists/folders expand to their tracks).
- API: `GET/POST /api/v1/playlists`, `POST /api/v1/playlists/:id/items`, `POST /api/v1/labels/items`, `POST /api/v1/play` with `playlistId` or `label`.
- Bonjour: browse `playlists` / `labels`, `playSelection.playlist` / `.label`, existing `trackOptions` / `editTrack`.

### Output modes

- **Shared** — system mixer path on the OS stack
- **Exclusive** — Core Audio hog / ALSA `hw:` / WASAPI Exclusive
- **DoP** — native DoP into a DSD DAC (DSD→PCM with a badge when the path cannot do DoP)

The Deck badge (also the bottom player and Settings → Output → Path) shows what the DAC gets — the rate and bits the device runs at, then the path:

| Badge | Means |
|---|---|
| `96 kHz / 24-bit · Exclusive` | the file's rate, bit-perfect |
| `44.1 → 48 kHz / 24-bit · Shared` | the system resamples to the rate the device is set to (Audio MIDI Setup on a Mac); Exclusive avoids that |
| `DSD→PCM 88.2 kHz / 24-bit · Exclusive` | DSD as PCM |
| `DoP DSD64` | DoP into the DAC |
| `… · Shared (no external DAC)` | Exclusive / DoP asked for, but the device is not an external DAC |
| `… · FX` / `… · FX bypassed` | the [plugin rack](#plugin-rack) shapes the sound / holds plugins but passes the sound on (A/B) |

macOS reads the device's rate and physical format; Linux the `hw:` format (significant bits, e.g. 24 in a 32-bit sample), or in Shared what the card runs at behind `plughw` (`/proc/asound/card*/pcm*p/sub*/hw_params`, the sample width). Windows shows the path only.

### Plugin rack

Inserts on the local output, steered from the remote — the plugins you already own: EQ, headphone or room correction, a limiter.

- **Included** on Linux (`.deb`, `.tar.gz`, `install.sh`) and macOS (`.pkg`, `.tar.gz`): [LSP Plugins](https://lsp-plug.in), free (LGPL), built without their UI — one CLAP file (8–11 MB) that needs only `libsndfile` on Linux (instead of ~240 MB of desktop libraries from the distribution packages) and only system frameworks on macOS. **Settings → Rack → Add Plugin** lists five first, by their job:

  | Job | Plugin |
  |---|---|
  | Graphic EQ | LSP Graphic Equalizer x16 Stereo |
  | Parametric EQ | LSP Parametric Equalizer x16 Stereo |
  | Mastering Compressor | LSP Multiband Compressor Stereo x8 |
  | Mastering Limiter | LSP Limiter Stereo (true peak, oversampling) |
  | Loudness Compensation | LSP Loudness Compensator Stereo — equal-loudness curves, so quiet listening keeps its bass and treble |

  The other ~110 LSP stereo effects (crossovers, clippers, dynamics, …) follow under *LSP*.
- **Formats**:

  | Format | Where | Found in |
  |---|---|---|
  | CLAP | macOS, Linux | `~/Library/Audio/Plug-Ins/CLAP`, `/Library/Audio/Plug-Ins/CLAP`; `~/.clap`, `/usr/lib/clap`; `CLAP_PATH` |
  | VST3 | macOS, Linux | `~/Library/Audio/Plug-Ins/VST3`, `/Library/Audio/Plug-Ins/VST3`; `~/.vst3`, `/usr/lib/vst3`, `/usr/local/lib/vst3`; `VST3_PATH` |
  | AU | macOS | every installed effect Audio Unit (AUv2 and AUv3 app extensions) |
  | LV2 | Linux, Pi | where lilv looks (`/usr/lib/lv2`, `~/.lv2`, `LV2_PATH`), e.g. `sudo apt install x42-plugins` |

  Stereo effects only (2 in, 2 out). A plugin installed in several formats is listed once, in the first of CLAP, VST3, AU, LV2 (*also AU, VST3* below it). The first scan opens every plugin once, each in its own harbor-fx, six at a time — about two minutes for 1,000 plugins; later scans open only new or updated ones (`~/.audio-harbor-headless/plugins.json`). A plugin built only for Intel Macs, one that crashes, or one that waits for a licence window (no answer in 20 s) is left out. Windows comes later.
- **Remote**: the fader button on the Deck (amber while plugins shape the sound) opens the rack — the path, one key that takes the whole rack out and back in for an **A/B** without a gap, the presets, each plugin's power key and up to six pinned knobs as rotary knobs. **Settings → Rack** adds plugins from the ones installed on the host, orders and removes them, and keeps the **presets** (*Headphones*, *Speakers* — the whole rack under a name: Save as New, Save when *Edited*, Rename, Delete). Plugin editors (their own windows) are not shown: the host has no screen.
- **A plugin's sheet** (*Open*): the five shipped plugins have their own **panel** — the graphic EQ as faders, the parametric EQ as a curve with points to drag (frequency sideways, gain up and down), the compressor with a tab per band, the limiter with its knobs, and a live **meter** (in, out, gain change) for the dynamics. **All** shows every parameter with the control its kind wants: switches, choices with the plugin's names, sliders on the right scale (log for Hz, a detent at the default) with − / +, a value to tap and type ("-3.5 dB", "1.2 kHz"), double tap for the default; display-only parameters hidden, bands grouped, unused bands behind *+ Band*. Above both: **A/B** (before ↔ now since the sheet opened), **Undo**, **Reset** to the plugin's defaults. While a knob moves, the rack renders with a short lead, so the change is heard within a moment.
- **Sound**: with plugins the DAC stays exclusive at the file's rate (`… · Exclusive · FX`); the plugins change the sound, so it is not bit-perfect. DSD plays as PCM while the rack holds plugins (from the next track). **An empty rack is bit-perfect and plays DoP**, as before. Network players get the file without plugins for now (`Network · no FX`).
- **Safe**: plugins run in **harbor-fx**, a process of their own. A plugin that crashes does not stop the music — it plays on dry and the rack comes back by itself; three crashes in half a minute stop the rack until you change it. Changes are heard after about 0.2 s (the rack renders ahead, so a slow plugin causes no dropouts); latency is compensated.
- **Kept** in `~/.audio-harbor-headless/rack.json`: the plugins, their order, switches, pinned knobs, every setting and the presets.
- **API**: `GET /api/v1/rack`, `PUT /api/v1/rack/bypass`, `GET /api/v1/rack/plugins[?rescan=1]`, `POST /api/v1/rack/inserts`, `DELETE /api/v1/rack/inserts/:id`, `POST …/:id/move`, `PUT …/:id/bypass`, `GET …/:id/params`, `PUT …/:id/params/:param`, `PUT …/:id/pinned`, `GET/PUT …/:id/state`, `POST …/:id/reset`, `GET /api/v1/rack/meters`, presets under `/api/v1/rack/presets` (`POST` save, `POST …/:id/load`, `PUT …/:id/save`, `PUT …/:id` rename, `DELETE`); the WebSocket pushes `rack`.

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
- **Shown on the Deck** (and in the bottom player, and as Path under Settings → Output): what goes to the player and at what resolution:

  | Badge | Means |
  |---|---|
  | `FLAC 44.1 kHz / 24-bit · Network` | the file untouched (`MP3 44.1 kHz · Network` for lossy files, which have no bit depth) |
  | `PCM 48 kHz / 24-bit · Network` | a format the player does not list, as WAV |
  | `DSD64 · Network` | the DSD file untouched |
  | `DSD→PCM 88.2 kHz / 24-bit · Network` | DSD as PCM |
  | `Wi‑Fi PCM 44.1 kHz / 16-bit · Network` | DSD on **Wi‑Fi** stream |
  | `DoP DSD64 · Network` | DoP; the WAV runs at DSD rate / 16 (DSD64 → 176.4 kHz / 24-bit) |

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
engine/   C++ + N-API — Mac / Linux / Windows native players
web/      Mobile web remote
```

How the parts fit together — ports, data on disk, the engine, network players, flows: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
