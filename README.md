# Audio Harbor Headless

GUI-less audiophile media host for **macOS** and **Linux**. Control everything from an iPhone (web remote first; Bonjour / Audio Harbor iOS later). Also acts as a DLNA music server.

## Stack

| Layer | Tech |
|---|---|
| Audio engine | **C++ via Node-API** — Core Audio (macOS Exclusive/DoP) · ALSA (Linux) · optional JUCE |
| Host | **TypeScript / Node** (Fastify) |
| Remote UI | **Vite + TypeScript** (mobile web) |

## Quick start

```bash
npm install
npm run build:engine   # native addon (cmake-js). Optional: HARBOR_WITH_JUCE=1
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

### Output modes

- **Shared** — system mixer path (default)
- **Exclusive** — Mac: Core Audio hog + rate match on external DACs; Linux: ALSA `hw:` device
- **DoP** — DSD packed as high-rate PCM for capable DACs; otherwise DSD→PCM (~88.2 kHz) with honest badge

## Layout

```
host/     TypeScript daemon (API, library, DLNA, Bonjour)
engine/   C++ audio engine + N-API bindings (Mac Core Audio / Linux ALSA)
web/      Mobile web remote
```

## Optional JUCE

```bash
HARBOR_WITH_JUCE=1 npm run build:engine
```

Check [JUCE licensing](https://juce.com/legal/juce-8-licence/) before distributing or selling.
