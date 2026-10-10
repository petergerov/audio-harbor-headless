# Tune (MozAIk Labs) vs Audio Harbor Headless

Deep feature and product comparison. Sources: [mozaiklabs.fr](https://mozaiklabs.fr/) (Tune 1.0 RC claims, 2026) and Audio Harbor Headless **v1.1.2** (README, Architecture, shipped code). No listening-quality judgement — scope, architecture, and honesty of claims.

| | **Tune** | **Audio Harbor Headless** |
|---|---|---|
| Maker | MozAIk Labs | Audio Harbor / Gerov |
| Category | Multi-room music server + streaming hub | Headless audiophile media host |
| Competes as | Roon / Audirvana / JRiver alternative | Quiet host + phone remote for local high-res |
| Stage | 1.0 release candidate | v1.1.2 released |
| One-liner | Your library + your streaming subs + every room | Your folders → DAC or UPnP player; phone is the remote |

---

## 1. Product thesis

**Tune** widens the living-room stack: one install indexes local FLAC/DSD, pulls in Tidal/Qobuz/Deezer (and more), discovers AirPlay/Chromecast/BluOS/DLNA, and syncs multi-room zones. The promise is convenience without buying Sonos-style lock-in hardware.

**Audio Harbor Headless** narrows deliberately: one Node process, no desktop shell, native Exclusive/DoP on Core Audio / ALSA / WASAPI, optional UPnP renderer as a first-class *output*, optional DLNA *server*, Harbor web remote (Deck · Catalogue · Settings) plus Bonjour for the iOS app. No streaming accounts, no multi-room sync, no AirPlay/Chromecast. The promise is *hear the file, know the path*.

They overlap on “self-hosted local library + web UI + DLNA out/in.” They diverge on everything Tune adds for breadth and everything Harbor keeps for bit-perfect honesty at the host DAC.

---

## 2. Architecture (how the box thinks)

| Layer | Tune (public claims) | Audio Harbor Headless |
|---|---|---|
| Host process | App / Docker server (`renesenses/tune`, port 8888) | Single Node host (`serve`), API `:8787`, Bonjour `:8788` |
| Desktop UI on host | Native desktop software + optional server mode | **None** — host is GUI-less |
| Web client | Svelte 5, served by server | Vanilla TS Harbor UI (Deck stage, Catalogue, Settings) |
| Native remotes | SwiftUI iOS/macOS (TestFlight), Flutter Android | Audio Harbor iOS over Bonjour frame protocol v3 |
| Audio engine | “Intelligent pipeline”, bit-perfect passthrough, native transcoding **without FFmpeg** | C++ N-API `harbor_engine.node`: Mac / Linux / Windows **native only** (JUCE removed in v1.1.2) |
| Catalogue | Local + SMB, MusicBrainz enrichment, quality-aware album versions | SQLite + FTS5 over library roots; playlists & labels as path sets |
| Control plane | Zones / multi-room | One active output (local device **or** one `upnp:<UDN>`) |

---

## 3. Licensing and business model

| | Tune | Harbor Headless |
|---|---|---|
| Source | Source-available **BSL 1.1** | Open source on GitHub (project licence as published in repo) |
| Cost | Free tier + **optional Premium** (software licence, not content sub) | No product subscription |
| Streaming | Uses *your* Tidal/Qobuz/… accounts via official APIs; Tune does not host content | No streaming integration at all |
| Risk note | BSL / Premium boundaries matter for commercial reuse | Fewer product tiers; you run the host yourself |

---

## 4. Platforms and install

| | Tune | Harbor Headless |
|---|---|---|
| Host OS | macOS, Windows, Linux, **Docker** (recommended) | macOS (arm64/x64), Linux x64/arm64 (Pi), Windows |
| Packaging | Docker one-liner, Homebrew, Windows installer | GitHub Release prebuilts (Node 22 bundled), or `npm` / `install.sh` |
| Always-on NAS story | Strong (Docker + host network) | Strong on Pi/Linux; no first-class Docker image in the same marketing push |
| Discovery | Web at `localhost:8888` | mDNS `audioharbor.local:8787` + QR / PIN pairing |

---

## 5. Library and discovery

| Capability | Tune | Harbor Headless |
|---|---|---|
| Local folders | Yes | Yes (`library.roots`) |
| SMB / network shares | Yes (first-class) | Via OS mount into a root (not a dedicated SMB browser) |
| Formats (local) | FLAC, DSD, WAV (marketing) | FLAC, ALAC, WAV, AIFF, AAC/M4A, MP3, DSF, DFF, **SACD ISO** (incl. DST) |
| Metadata enrichment | MusicBrainz, hi-res artwork, edit in UI | Embedded tags + artwork hash cache; organize via remote |
| Quality-aware albums (CD vs Hi-Res vs DSD) | Yes | Manual / path / tag reality; no MusicBrainz “edition split” product |
| Live FS watch | Startup scan + real-time monitoring | Rescan / incremental by mtime |
| Federated search (local + streaming) | Yes | Local FTS only |
| Internet radio | Yes (FIP, France Inter, … + ICY) | No |
| Playlists | Hub across Tidal/Deezer/YouTube/local; transfer between services | Local playlists + labels; no cross-service transfer |

---

## 6. Streaming integrations

| Service | Tune | Harbor |
|---|---|---|
| Tidal | Full (HiRes FLAC, OAuth device) | — |
| Qobuz | Full (HiRes FLAC) | — |
| Deezer | Full (+ previews) | — |
| Spotify | Browse only | — |
| YouTube Music | Audio via Google OAuth | — |
| Amazon Music | Ultra HD (claimed) | — |

Harbor’s explicit non-goal: no account, no streaming core. If the library is mostly Spotify/Apple Music, Harbor is the wrong product; Tune is built for that mix.

---

## 7. Audio path — local DAC (the Harbor wedge)

This is where Headless invests and Tune’s public site stays thinner.

| Topic | Tune (claims) | Harbor Headless (shipped) |
|---|---|---|
| Local / USB output | Yes — “direct output without network” | Yes — Shared / Exclusive / DoP on **native** stacks |
| Exclusive mode | Not detailed as Core Audio hog / ALSA `hw:` / WASAPI Exclusive | First-class: hog / `hw:` / WASAPI Exclusive; rate follows file |
| DoP to USB DAC | Emphasised for **DLNA DSD renderers**; host-DAC DoP story not the hero | Native DoP on external DAC; otherwise labelled DSD→PCM |
| Silent resampling | Pipeline claims passthrough when device allows | Exclusive path refuses silent resample; badge always |
| Conversion badge | Implied by passthrough / transcoding story | Explicit `conversion_badge` on every path |
| SACD ISO | Not featured | Catalogue tracks from ISO; DST decode; DFF cache; same path to DAC or UPnP |
| Engine footprint | Not public | Native-only after JUCE removal — smaller build, no juceaide/X11 tax |

**Read:** If the listening chair is a USB DAC on the host machine and “bit-perfect Exclusive / real DoP / SACD ISO” is the job, Harbor is purpose-built. Tune’s marketing centre of gravity is multi-room + streaming + DLNA DSD to streamers.

---

## 8. Network audio — outputs and server

| Capability | Tune | Harbor Headless |
|---|---|---|
| DLNA/UPnP **renderer** as output | Yes (SSDP), multi-room groups | Yes — one renderer as `upnp:<UDN>`; planner (passthrough / WAV / DSD modes) |
| Gapless to renderer | Claimed native gapless | `SetNextAVTransportURI` when the player supports it |
| DSD to renderer | Bit-perfect DSF/DFF to capable DLNA; else PCM 176.4/24 | Per-player Auto / PCM / DoP; `network_stream` full vs wifi |
| AirPlay | Yes (mDNS) | No |
| Chromecast | Yes | No |
| BluOS / OAAT | Yes | No |
| Multi-room sync | Zone groups, synchronised house | **No** — single active output |
| UPnP **MediaServer** (share library) | Yes | Yes (`sharing.enabled`, start/stop without restart) |
| Typical streamer names in marketing | Eversolo, Lindemann, HiFi Rose, Bluesound, Cocktail Audio, … | Devialet / Naim / Linn / WiiM-class UPnP story in docs |

**Read:** Tune wins the living-room matrix (every protocol, every room). Harbor wins “this UPnP amp is just another output of *my* queue,” with DSD/DoP/wifi policy under host control — not a multi-room party product.

---

## 9. Remote experience

| | Tune | Harbor Headless |
|---|---|---|
| Web UI | Svelte 5, responsive | Harbor chassis/ivory/amber; Deck (Turntable/Reel), Catalogue, Settings |
| Phone | Native iOS + Android | Web first; iOS Audio Harbor via Bonjour |
| Desktop remote | Native apps + web | Wide web shell (sidebar, queue rail on Deck); no host desktop chrome |
| Pairing | Install / open `:8888` | PIN → token; tokens shared web/iOS; rate-limited PIN |
| Now Playing metaphor | Zones / multi-service library | Deck stage + Up Next rail (desktop) / sheet (phone) |
| Bottom player on Deck | N/A (different IA) | Hidden on Deck tab (full stage) |

---

## 10. Operations and honesty

| Topic | Tune | Harbor |
|---|---|---|
| Cloud dependency | Claims none for content hosting; streaming APIs still call vendor clouds when used | No vendor cloud; optional outbound only if you point at network players |
| Telemetry of plays | Not stated on homepage | Product stance: no account / no “what you play” cloud |
| Config | Docker volumes + app settings | `~/.audio-harbor-headless/config.toml` |
| Build complexity | Closed/source-available product binary | Engine + host buildable; Release workflow per platform |
| Maturity | RC, active tester community | Shipped releases; narrower feature surface |

---

## 11. Side-by-side scorecard (scope, not sound)

Legend: **●** strong / first-class · **◐** partial or secondary · **○** absent / non-goal

| Dimension | Tune | Harbor Headless |
|---|:---:|:---:|
| Local high-res library | ● | ● |
| Streaming aggregator | ● | ○ |
| Multi-room sync | ● | ○ |
| AirPlay / Chromecast / BluOS | ● | ○ |
| DLNA renderer output | ● | ● |
| DLNA media server | ● | ● |
| USB DAC Exclusive | ◐ | ● |
| Host DoP | ◐ | ● |
| SACD ISO / DST | ○ | ● |
| Explicit conversion badge | ◐ | ● |
| GUI-less always-on host | ◐ (Docker) | ● |
| Open collaboration licence | ◐ (BSL + Premium) | ● (public OSS) |
| Native mobile apps | ● | ◐ (iOS Bonjour; web Android) |
| Internet radio | ● | ○ |
| Playlist transfer across services | ● | ○ |

---

## 12. When to pick which

**Choose Tune** if you want one box for local + Tidal/Qobuz/Deezer, house-wide zones, AirPlay/Chromecast/BluOS, Docker on a NAS, and native phone apps — and you accept BSL/Premium and a broader, still-maturing RC surface.

**Choose Audio Harbor Headless** if the job is a quiet always-on host for *your* files: Exclusive/DoP on a USB DAC, honest badges, SACD ISO in-catalogue, one UPnP streamer as an output, Harbor remote (and Audio Harbor iOS) — and you do **not** want streaming or multi-room as the product centre.

**Unfair comparisons to avoid**

- Judging Harbor by missing Spotify/Tidal — out of scope by design.
- Judging Tune’s host-DAC Exclusive story from DLNA-DSD marketing alone — different emphasis.
- Declaring a sonic winner from feature lists.

---

## 13. Harbor’s own competitive note

Internal marketing already frames Tune Server as the closest OSS-shaped neighbour: same rough silhouette (API, DLNA out, web + iOS), broader on AirPlay/streaming/multiroom; Headless doubles down on native Exclusive/DoP, badge, and SACD ISO→network ([docs/marketing.md](marketing.md)).

**Wedge (Harbor):** *Roon-shaped control for people whose amp speaks UPnP — without a streaming subscription core, and with SACD ISO still in the library.*

**Wedge (Tune, from their site):** *Multi-room without proprietary speakers; your subs, your disks, Docker.*

---

## Sources

- [MozAIk Labs — Tune](https://mozaiklabs.fr/) (public marketing, 2026)
- [audio-harbor-headless](https://github.com/petergerov/audio-harbor-headless) README, Architecture, v1.1.2

*Indicative only. Tune features as claimed publicly; Harbor features as implemented in-tree.*
