# Audio Harbor Headless — Implementation Plan

## Ziel

Ein **GUI-loser Media-Host** auf Mac, Linux und Windows: Ordner mounten, Output wählen, Library browsen, abspielen — alles vom iPhone. Zusätzlich als **DLNA Music Server**. Konzept wie [`../audio-harbor`](../audio-harbor), ohne SwiftUI-Shell.

### Produktentscheidungen

| ID | Entscheidung |
|---|---|
| **1C** | Steuerung: **Web-Remote zuerst** (Safari auf dem iPhone), dazu Bonjour-Kompatibilität mit der Audio-Harbor-iOS-App |
| **2B** | Qualität: **Audiophile Parität** — Exclusive / DoP / DSD, bit-perfect wo möglich |
| **Stack** | **C++ Audio-Engine** (native Core Audio / ALSA / WASAPI) + **TypeScript/Node Host** + **Vite Web-UI** |

Harbor-Swift bleibt Referenz für Regeln und Remote-Protokoll, nicht Runtime auf Linux.

---

## Architektur

```mermaid
flowchart LR
  subgraph clients [Clients]
    Safari[iPhone_Safari]
    HarborIOS[Harbor_iOS]
    DLNAClient[DLNA_Players]
  end
  subgraph host [TypeScript_Host]
    API[Fastify_HTTP_WS]
    Lib[SQLite_FTS_Library]
    Share[DLNA_MediaServer]
    Bonjour[Bonjour_Adapter]
    Bridge[EngineBridge_NAPI]
  end
  subgraph engine [Native_Engine]
    Play[PlaybackEngine]
    Dev[DeviceManager]
    DSD[DSD_DoP_PCM]
  end
  Safari --> API
  HarborIOS --> Bonjour
  DLNAClient --> Share
  API --> Lib
  API --> Bridge
  Bonjour --> Bridge
  Share --> Lib
  Bridge --> Play
  Play --> Dev
  Play --> DSD
```

### Schichten

| Schicht | Technologie | Aufgabe |
|---|---|---|
| Audio | C++ / N-API (`harbor_engine.node`) | Devices, Shared / Exclusive / DoP, DSD→PCM, Decode |
| Host | TypeScript / Node (Fastify) | Config, Library, API, Pairing, DLNA, Bonjour, Queue |
| UI | Vite + TypeScript | Mobile Web-Remote (iOS-ähnliche Oberfläche) |

### Engine-Kopplung (C-API)

Ein Prozess. Die native Library wird über Node-API geladen:

- `listDevices` / `setDevice` / `setOutputMode` / `setDsdPcmLevel`
- `load` / `play` / `pause` / `seek` / `stop` / `setVolume`
- `getState` (inkl. Stream-Rate, Device-Rate / -Bits, DoP) / `version`
- Network-Streams: `netStreamOpen` / `netStreamRead` (WAV / DoP für Netzwerk-Player), DST: `dstBegin` / `dstDecodeFrame` / `dstEnd`
- Events: `state`, `ended`, `deviceChange`

Domain-Typen (`Track`, `OutputMode`, Snapshots) leben in TypeScript; die Engine kennt Dateipfade, PCM/DSD-Buffers und Device-UIDs.

---

## Repo-Struktur

```
audio-harbor-headless/
  package.json                 # npm workspaces
  config.example.toml
  README.md
  docs/                        # Product homepage + Screenshots, ARCHITECTURE, LINUX, …
  implementation_plan.md
  host/                        # TypeScript daemon
    src/
      index.ts                 # CLI: serve | pair | rescan
      config.ts, paths.ts, pairing.ts, types.ts, power.ts, net.ts
      drives.ts                # USB-Laufwerke + SMB-Shares (Linux-Paket)
      system.ts                # CPU / Speicher / Platten für Settings → About
      update.ts                # Software Update aus der Remote
      resolution.ts            # Rate / Bits im Pfad-Badge
      api/server.ts            # Fastify REST + WebSocket
      library/                 # catalogue.ts (SQLite FTS), sacd.ts, dstDff.ts
      playback/service.ts      # Queue, transport, routing
      engine/bridge.ts         # N-API wrapper
      upnp/                    # MediaServer + Renderer-Control-Point
      remote/                  # bonjour.ts (Protokoll v4), rack, browse, settings, artwork, wire, mdns
  engine/                      # C++ + CMake + cmake-js
    CMakeLists.txt
    napi/binding.cpp
    src/
      HarborEngine.h/.cpp      # C ABI
      Player.h, PlayerFactory.cpp
      MacPlayer.cpp            # Core Audio Exclusive/DoP
      LinuxPlayer.cpp          # ALSA Exclusive/DoP
      WinPlayer.cpp            # WASAPI Exclusive/DoP
      DsdPipeline.cpp          # DSF / DFF, DoP pack, DSD→PCM
      PcmDecoder, FrameSource, PlaybackFeed, AHDSTDecoder
      StubPlayer.cpp           # Fallback
  web/                         # Vite mobile remote → host serves dist/ (siehe web/README.md)
    src/main.ts, app/, core/, api/, state/, services/, ui/
  packaging/                   # linux/ (.deb, systemd, Root-Helper), macos/ (.pkg, Menüleisten-App)
```

Config: `~/.audio-harbor-headless/config.toml` (aus `config.example.toml`).  
CLI: `harbor serve` · `harbor pair` · `harbor rescan`.

---

## TypeScript-Host

- **Runtime:** Node ≥ 22.5 (`node:sqlite`; Releases bringen Node 22 unter `runtime/` mit); Fastify REST + WebSocket
- **DB:** `node:sqlite` + FTS5 (Catalogue)
- **Metadata:** `music-metadata`
- **DLNA/SSDP:** eigenes Modul (ContentDirectory + HTTP Range)
- **Bonjour:** `bonjour-service`; Frame-Protokoll analog Harbor Remote v4 (`_audioharbor._tcp`)
- **Web:** statische Files aus `web/dist`; Pairing-PIN + QR in der Konsole, die PIN auch in der Remote (erstes Gerät, danach Settings → About)

### REST (Auszug)

`/api/v1/{health,pair,now-playing,queue,mounts,folders,drives,library,system,update,remotes/pin,browse,search,settings,play,transport,output,devices,playlists,labels,track-options,sharing,artwork,ws}`

---

## Native Audio-Engine

### macOS (`MacPlayer`)

- **Shared:** HAL Output Unit, ExtAudioFile Decode (PCM)
- **Exclusive:** Device hog + Nominal Sample Rate = Track; nur externe Interfaces (USB/TB/FW/PCI)
- **DoP:** DSD → High-Rate-PCM mit Markern; sonst DSD→PCM
- Hardware-Volume wo möglich; Conversion-Badge an den Host, dazu Nominal-Rate und physisches Format des Geräts

### Linux (`LinuxPlayer`)

- **Shared:** ALSA `default` (PipeWire/Pulse) oder das gewählte Gerät
- **Exclusive / DoP:** ALSA `hw:` / `plughw:`; schreibt das Sample-Format, das das Gerät nimmt
- FLAC / MP3 / WAV / AIFF über `dr_libs`, ALAC / AAC über ffmpeg; Rate / Bits des Geräts aus `hw_params` (hinter `plughw` aus `/proc/asound`)

### Windows (`WinPlayer`)

- **Shared / Exclusive / DoP** über WASAPI

### DSD-Pipeline

- DSF / DFF laden
- DoP-Packing
- DSD→PCM Multi-Stage Kaiser/sinc Decimation (~88.2 kHz), Gain 0 / +3 / +6 dB

### Audio-Backends

```toml
[output]
backend = "auto"   # auto | native → Core Audio / ALSA / WASAPI
```

---

## Web-Remote (iPhone)

Zielgefühl: native iOS-App im Harbor-Look (Chassis / Elfenbein / Amber). Details: [web/README.md](web/README.md).

- Tabs: **Deck · Catalogue · Settings**; Catalogue mit Dirs · Albums · Artists · Lists
- Deck: Turntable- oder Reel-to-Reel-Bühne, Scrubber, Transport, Volume, Pfad-Badge; Up Next als Sheet (Phone) oder rechte Leiste (Desktop)
- Mini Player über der Tab Bar, auf dem Desktop Seitenleiste + Bottom-Bar (nicht auf Deck)
- Settings: Sources (Ordner, Laufwerke, SMB, Rescan), Output, Sharing, About (Host-Status, PIN, Software Update)
- Pairing mit 6-stelliger PIN
- Safe Areas (Notch / Home Indicator)

---

## Umsetzungsreihenfolge & Status

| # | Schritt | Status |
|---|---|---|
| 1 | Scaffold — npm workspace, Fastify, C++ N-API, Config, CLI | done |
| 2 | Library — Roots, Scan, SQLite+FTS, Browse/Search API | done |
| 3 | Shared Playback — Engine + Queue/Transport/WebSocket | done |
| 4 | Web UI — Mounts, Browse, Play, Output, Now Playing (iOS-UI) | done |
| 5 | Mac Exclusive + DoP + DSD-Pipeline + Badges | done |
| 6 | Linux Exclusive/hw + DoP/PCM-Fallback | done (Basis) |
| 7 | DLNA Music Server — Sharing an/aus | done |
| 8 | UPnP Renderer als Output | done (Discovery + SetNext) |
| 9 | Bonjour Remote für Harbor-iOS | done (Protokoll v4, artwork + trackOptions/edit, Settings, Rack) |
| 10 | Windows WASAPI, JUCE entfernt — nur native Stacks | done |
| 11 | Pakete: signiertes macOS-`.pkg` + Menüleisten-App, Linux-`.deb` + systemd + Installer | done |
| 12 | Laufwerke + SMB-Shares aus der Remote (Linux-Paket) | done |
| 13 | Software Update aus der Remote (Linux-Paket) | done (ab 1.0.3) |
| 14 | Pfad-Badge mit Rate / Bits — lokaler DAC und Netzwerk-Player | done (1.0.5 / 1.0.6) |
| 15 | Plugin-Rack Stufe 1: `harbor-fx` (CLAP, LV2), Vorausrechnen, A/B, Absturz-Neustart, Web-Remote | done (Mac + Linux; Windows folgt) |
| 16 | Mitgelieferte Plugins (Linux, macOS): LSP Plugins als CLAP ohne UI — Graphic EQ, Parametric EQ, Mastering-Kompressor, Limiter, Loudness Compensator | done |
| 17 | Parameter-UX: Bedienelement je Art, Bänder, getippte Werte, Drehregler (A); eigene Panels für die mitgelieferten Plugins mit EQ-Kurve, Fadern, Band-Tabs, Pegel (B); A/B pro Plugin, Undo, Reset, Live-Modus, Rack-Presets (C) | done |
| 18 | Verbinden ohne Code als Standard; Code in Settings einschaltbar | done |
| 19 | Plugin-Rack Stufe 2: VST3 (Mac + Linux), AU (Mac); Scan parallel im Hintergrund; ein Eintrag je Plugin über die Formate | done |
| 20 | Plugin-Rack Stufe 3: Werks-Presets der Plugins (AU, VST3, CLAP, LV2, LSP), Bonjour-Protokoll 4 für die iOS-App, bearbeiteter WAV-Stream für Netzwerk-Player | done |
| 21 | Plugin-Rack Stufe 4 (Mac): Original-Editoren der Plugins (CLAP, VST3, AU v2/v3) in Fenstern auf dem Bildschirm des Hosts; AUv3-Erweiterungen laden jetzt | done (Linux-Desktop, Windows folgen) |

---

## Bewusst raus (v1)

- SwiftUI / StoreKit
- Streaming-Services (Qobuz, Tidal, …)
- iPhone als lokaler Player („Listen on iPhone“)
- Rust- oder Go-Host
- App-Sandbox-Bookmarks (Daemon: Host-Rechte + Config-Pfade)

---

## Plugin-Rack (fremde Plugins)

Ziel: die Plugins, die der Nutzer schon hat, im Signalweg von Headless — bedient aus der Web-Remote
und aus der iOS-App, ohne Bildschirm am Host. Eigene Module (EQ mit AutoEQ-Import, Faltung) kommen
später ins selbe Rack.

| Format | Plattform | Host-Bibliothek |
|---|---|---|
| LV2 | Linux / Pi (LSP, x42, Calf, ZAM per `apt`, auch ARM) | lilv |
| CLAP | alle | Header (MIT, vendored) |
| VST3 | Mac, Linux (x64, arm64); Windows folgt | VST3-SDK, nur Interfaces + Hosting-Helfer (MIT, vendored) |
| AU | Mac (AUv2, AUv3) | AudioToolbox |

Kein JUCE — jedes Format bekommt einen schlanken eigenen Host.

**Prozess `harbor-fx`:** Die Plugins laufen in einem eigenen Programm neben der Engine, nicht in Node
und nicht im Audio-Thread. Die Engine startet es und spricht über stdin / stdout (Frames mit Länge und
Typ): Audio-Blöcke als Float, Steuerung als JSON. Stürzt ein Plugin ab, stirbt nur `harbor-fx`; die
Engine spielt trocken weiter, das Badge sagt es, und der nächste Befehl startet `harbor-fx` mit der
gespeicherten Kette neu. Der Plugin-Scan läuft in einem eigenen kurzlebigen `harbor-fx --scan`.

**Vorausrechnen:** Der Track liegt dekodiert im Speicher (`PlaybackFeed`). Ein FX-Worker in der Engine
rechnet ~200 ms vor der Wiedergabe in einen Ringpuffer; die Player lesen von dort statt aus dem
trockenen Puffer. Prozessgrenze und langsame Plugins machen so keine Aussetzer; ein Regler wirkt nach
~200 ms. Seek leert den Ring und setzt die Plugins zurück. Plugin-Latenz wird ausgeglichen (die ersten
`latency` Frames verworfen, am Ende mit Stille nachgefüttert).

**A/B:** Trocken und bearbeitet liegen beide bereit; die Engine blendet am Ausgang in ~10 ms um. Die
Plugins laufen beim Umgehen weiter, damit das Zurückschalten ohne Einschwingen klingt.

**Regeln wie in der Mac-App:** Exclusive bleibt auf der Rate der Datei („· Exclusive · FX“); jeder
neue Track bereitet die Plugins auf seine Rate vor. Mit Inserts im Rack wird DSD zu PCM (kein DoP).
Leeres Rack = bit-perfect, unverändert wie heute. Netzwerk-Player bekommen mit Plugins im Rack ein
24-Bit-WAV durch dieselbe Kette („PCM … · Network · FX“, ab Stufe 3); ohne Plugins die Datei wie bisher.

**Host:** `rack.ts` hält Kette, Zustand der Plugins und Presets in `rack.json` (Config-Ordner).
REST `/api/v1/rack` (lesen, Kette setzen, Bypass, Parameter, Plugin-Liste, Presets), Änderungen per
WebSocket. Die Remote setzt nur gescannte, installierte Plugins ein — nichts wird hochgeladen.

**Web-Remote:** Rack-Knopf auf dem Deck (bernstein, solange Plugins den Klang formen) → Sheet mit Pfad,
A/B-Taste, Inserts mit Power-Taste, Presets. Settings → Rack: Plugins hinzufügen / sortieren / entfernen,
automatische Parameter-Seite pro Plugin (Wertetext vom Plugin), bis zu sechs angepinnte Regler.

### Stufen

1. **done** — `harbor-fx` (CLAP überall, LV2 auf Linux), Vorausrechnen, Absturz-Neustart; REST + WebSocket;
   Web-Remote mit Rack-Sheet und Parameter-Seite. Mac + Linux; Windows (Prozess-Start, WinPlayer) folgt.
   Geprüft: `npm run test:fx -w @harbor/engine`; CLAP mit FabFilter Pro-Q 4, TAL-Chorus-LX, Octaver 82 (Mac);
   LV2 mit LSP Parametric EQ / Limiter und x42-eq im Container (arm64).
2. **done** — VST3 (Mac, Linux), AU (Mac, AUv2 + AUv3). Scan: sechs Plugins parallel, je in eigenem
   Prozess, nur neue / geänderte; Start im Hintergrund. Im Picker ein Eintrag je Plugin (CLAP vor VST3 vor
   AU vor LV2). Geprüft: Pro-Q 4 / Pro-L 2 (VST3, AU), BritChannel, AUPeakLimiter, voller Scan von ~1000
   Plugins in ~2 min (Intel-only, abstürzende und auf Lizenzfenster wartende bleiben draußen); VST3 auf
   Linux arm64 mit LSP als VST3 im Container.
3. **done** — Rack-Presets; Werks-Presets der Plugins (AU: Factory + `.aupreset`; VST3: Programmliste +
   `.vstpreset`; CLAP: Preset-Discovery + `preset-load`; LV2: `pset:Preset`; LSP: die `.preset`-Dateien seiner
   UI, mitgeliefert unter `plugins/presets/lsp/`), im Plugin-Sheet gruppiert und durchsuchbar, Undo-fähig;
   Bonjour-Protokoll 4 (`getRack` / `setRack` / `loadRackPreset`, Topic `rack`) nach den Regeln der Mac-App;
   bearbeiteter 24-Bit-WAV-Stream für Netzwerk-Player (`FxFrameSource`: Vorlauf bei Sprüngen, Latenz
   ausgeglichen, Bypass = Datei unverändert). Geprüft: `npm run test:fx` (mit `net-fx-test.js`), Simulator,
   Pro-Q 4 (166 CLAP-Presets), bx_masterdesk / SPL / Softube (VST3), Apple- und Valhalla-AUs, LSP, x42 (LV2).
   Offen: Ein Regler wirkt beim Netzwerk-Player erst, wenn der Player gespielt hat, was er schon geholt hat;
   LSP-Sampler und Impuls-Reverbs als LV2 hängen harbor-fx auf, wenn sie aus der Kette genommen werden.
4. Original-Editoren auf dem Bildschirm des Hosts. **Mac done**: harbor-fx dreht auf dem echten Main-Thread den
   Cocoa-Run-Loop (nur mit angemeldetem Bildschirm), Nachrichten kommen über `CFRunLoopPerformBlock`; Fenster pro
   Insert — CLAP `clap.gui`, VST3 `IPlugView` + `IPlugFrame` (`performEdit` an den Prozessor), AU: View-Controller
   (AUv3), Cocoa-UI (AUv2), sonst die generische Ansicht. Web-Remote: „Open the Plugin Window“ im Sheet; offen
   liest der Host die Einstellungen alle 1,5 s zurück. Nebenbei: AUv3-Erweiterungen (BYOD, jj-breeze …) starten
   jetzt, auch im Scan. Geprüft: Pro-Q 4 (CLAP), Pro-L 2 (VST3), BritChannel, AUPeakLimiter, jj-breeze, BYOD.
   Offen: Linux-Desktop (X11: CLAP/VST3/LV2 mit Timer- und FD-Unterstützung), Windows (Rack läuft dort noch nicht).
5. Eigene Module: parametrischer EQ (AutoEQ / REW-Import), Gain / Balance, Crossfeed, Faltung.

---

## Erfolgskriterien

- Mac: bit-perfect FLAC → externer DAC (Exclusive, Rate-Match)
- Mac: DSF via DoP oder sauberer PCM-Fallback
- Linux: Playback + Output-Wahl; Exclusive wo `hw:` verfügbar
- iPhone Safari: Folder → Browse → Play unter 60 s
- DLNA-Client sieht dieselbe Library
- Harbor-iOS kann per Bonjour denselben Host steuern (Protokoll v4)

---

## Build & Run

```bash
npm install
npm run build:engine
npm run build:web
npm run build:host
npm run harbor -- serve
```

LAN-URL + QR + Pairing-PIN erscheinen in der Konsole.  
Config: `~/.audio-harbor-headless/config.toml` — DLNA via `sharing.enabled = true`.

---

## Offene Folgearbeiten

### Erledigt (Fortsetzung)

- UPnP/DIDL/SSDP nutzen LAN-IP (`URLBase`, media URLs, M-SEARCH replies)
- Web: Live-Scrub + Positions-Clock, PWA Manifest + Apple Touch Icon
- Linux: FLAC / MP3 / WAV / AIFF via `dr_libs` (`PcmDecoder`)
- DFF-Laden + DSD→PCM Kaiser/sinc Multi-Stage (näher Harbor-FIR)
- Artists-Browse im DLNA ContentDirectory
- UPnP `SetNextAVTransportURI` für Gapless-Vorbereitung
- Bonjour: Artwork-Frames + `trackOptions` / `editTrack`
- Web: Artwork-Blob-Cache + `navigator.vibrate` Haptics
- SACD ISO: Stereo-TOC Listing + uncompressed Extract → cached DFF
- SACD/DFF DST: AHDSTDecoder vendored + extract → cached DFF
- ALAC/AAC: Mac via ExtAudioFile; Linux via ffmpeg/ffprobe Fallback
- UPnP DIDL: bitrate / sampleFrequency / bitsPerSample / nrAudioChannels + DLNA flags
- Web: Service Worker offline shell (`sw.js`)
- DST-komprimierte `.dff` → dekodierter DFF-Cache (`cache/dst-dff`)
- Renderer-HTTP: MIME aus dem Format des Catalogue-Tracks

### Noch offen

1. Harbor-FIR Feintuning (flat to 25 kHz, ≥ 120 dB Stopband-Messung)
2. Native ALAC ohne ffmpeg auf Linux (libalac)
3. Windows: Rate / Bits des Geräts im Pfad-Badge (heute nur der Pfad)
4. Software Update für macOS-`.pkg` und portable Installationen (heute nur Hinweis + Release Notes)
5. Plugin-Rack Stufen 2–5 — siehe [Plugin-Rack (fremde Plugins)](#plugin-rack-fremde-plugins); Windows für Stufe 1
