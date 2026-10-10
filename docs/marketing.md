# Audio Harbor Headless — Marketing

Internal brief for product page, GitHub, App Store, forums, and release notes.
Public homepage: [index.html](index.html). Technical detail: [ARCHITECTURE.md](ARCHITECTURE.md).

## One-liner

A music player without a screen: one process on Mac, Linux, or Windows plays your library to a local DAC or a UPnP / DLNA network player. Your phone is the remote.

## Elevator (30 s)

Audio Harbor Headless is the quiet host for folders you already own. It runs on a Mac, a Raspberry Pi, or a Windows box — no desktop UI. Exclusive and DoP on native Core Audio, ALSA, and WASAPI. A network amp or streamer is just another output. SACD ISO (including DST) plays locally and over the network. A badge always says which path the audio took. No streaming, no account, no cloud.

## Positioning

| | |
|---|---|
| **Category** | Headless audiophile media host |
| **For** | People with a local high-res library and a DAC or network player |
| **Against** | Silent resampling, subscription cores, and “play to UPnP” bolted on with bridges |
| **Promise** | Hear the file. Know the path. |
| **Proof** | Native Exclusive / DoP, conversion badge, SACD ISO → DSD / DoP / PCM to network players, optional DLNA server |

**Not competing as:** a Roon clone, a streaming aggregator, a smart-home hub, or a DSP suite.

## Audience

### Primary

1. **Local-library audiophiles** — FLAC / DSD / SACD ISO on disk; USB DAC or network amp (Naim, Linn, Devialet, WiiM, …). Want Exclusive / DoP and honesty about conversion.
2. **Roon-curious with UPnP gear** — like the headless-core + phone-remote idea, but their player is DLNA, not RAAT. Today they use bridges and lose metadata or setup time.
3. **Raspberry Pi / always-on hosts** — library on a NAS or attached disk; phone remote; bit-perfect ALSA when a DAC is on the Pi.

### Secondary

- Audio Harbor (Mac app) users who want the same rules on a headless machine or a network player.
- foobar2000 / JRiver users who want less UI and a phone-first remote without abandoning UPnP.

### Not for

- People whose library is mostly Spotify / Apple Music.
- Multiroom sync and party zones as the main job.
- Users who want EQ, room correction, or upsampling theatre in the main path.

## Message pillars

1. **No desktop UI — still hear the file**  
   The machine is the host; the phone is the remote. Shared by default; Exclusive / DoP when the DAC is ready.

2. **A network player is an output like a DAC**  
   Same queue, same library. Files untouched when the player lists the type; DSD as DSD, PCM, or DoP per player; gapless when the player can.

3. **Honest path**  
   Conversion badge always. No silent resampling on Exclusive. DSD→PCM labelled, never faked into laptop speakers.

4. **Local first, no account**  
   Your folders. SQLite catalogue. Optional DLNA share. Nothing leaves the machine.

5. **Same brand soul as Audio Harbor**  
   Same listening rules as the Mac app — without the SwiftUI shell.

## Competitive frame (short)

Use in “vs” threads and FAQ — not as attack copy on the homepage.

| Product | Overlap | Where Headless differs |
|---|---|---|
| **Roon** | Headless core + phone remote, signal-path honesty | Roon does not do UPnP/DLNA natively; no SACD ISO / DST DFF. Headless plays to UPnP as a first-class output and keeps SACD in-library. |
| **Audirvana Studio (Linux)** | Headless, remote app, UPnP, DSD, SACD ISO | Closed, subscription/license; DSP and streaming front and centre. Headless is local-first, web remote + Bonjour, no account. |
| **JRiver** | DLNA server + control point, DSD/DoPE, SACD | Desktop-first, many knobs. Headless is one quiet process and a phone remote. |
| **Lyrion + UPnP Bridge** | Server-side queue → UPnP players | Bridge setup per device; gapless often needs “flow”. Headless owns the control point and media planner end-to-end. |
| **Music Assistant** | Server queue, DLNA outputs | Smart-home breadth; DLNA capped / no DSD story. Headless is audiophile-narrow: Exclusive, DoP, SACD ISO. |
| **moOde / Volumio** | Pi, web UI, bit-perfect ALSA | They *are* the renderer. Headless *drives* network players and can also be the DLNA server. |
| **Tune Server** | Closest OSS shape (API, DLNA out, web + iOS) | Broader (AirPlay, streaming, multiroom). Headless doubles down on native Exclusive/DoP, badge, SACD ISO→network. |

**Wedge line:** *Roon for people whose amp speaks UPnP — without the subscription, and with SACD ISO still in the library.*

## Differentiation (claim → proof)

| Claim | Proof in product |
|---|---|
| Bit-perfect when the device allows | Native Exclusive (Core Audio hog / ALSA `hw:` / WASAPI Exclusive); rate follows the file |
| Real DSD, not theatre | DoP on local DAC; Auto / PCM / DoP per network player; badge when it becomes PCM |
| SACD without a separate rip step | ISO → catalogue tracks; DST decoded; DFF cache; same path to DAC or UPnP |
| Phone is enough | Web remote at `audioharbor.local`; Bonjour for Audio Harbor iOS; PIN pairing |
| Network player = output | SSDP discovery, `upnp:<UDN>`, Range-seekable WAV/DoP, SetNextAVTransportURI gapless |
| No silent surprises | `conversion_badge` on every path |

## Taglines and headlines

**Primary**

- No desktop UI. Still hear the *file*.
- Your folders. Your files. No cloud required.
- Put the library in harbor.

**Alternates**

- One process. Phone remote. Honest path to the DAC.
- Exclusive when the DAC is ready. Shared for everything else.
- Play to the amp like to a USB DAC.
- Local high-res. No account. No resampling theatre.

**Hero trust line** (product page)

> No streaming · No account · Web remote + Bonjour · Shared by default · Exclusive when the DAC is ready

## Copy bank

### Short description (≤160 chars)

GUI-less audiophile host for Mac, Linux & Windows. Exclusive / DoP, UPnP players, SACD ISO, phone remote. No streaming, no account.

### GitHub About

Headless audiophile media host — native Exclusive/DoP, UPnP outputs, DLNA server, web + Bonjour remote.

### Release blurb template

```
Audio Harbor Headless <version>

Play your local library from a quiet host on Mac, Linux, or Windows.
Steer from Safari or the Audio Harbor iOS app. Outputs: USB DAC
(Shared / Exclusive / DoP) or UPnP / DLNA network players.

Highlights this release:
- …

Prebuilt: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64
Docs: https://petergerov.github.io/audio-harbor-headless/
```

### Forum opener (Audiophile Style / Reddit / Roon community)

> I built a headless host for people who keep their own FLAC/DSD/SACD library and play to a USB DAC *or* a UPnP amp. Same idea as a core + phone remote — but UPnP is first-class, SACD ISO (DST) stays in the library, and Exclusive/DoP on native stacks come with an honest conversion badge. No streaming, no account. Looking for feedback from anyone running Naim / Linn / Devialet / WiiM-style renderers.

### Objection handlers

| Objection | Answer |
|---|---|
| “Just use Roon.” | If every endpoint is Roon Ready, do. If the amp is UPnP-only, Roon needs a bridge. Headless speaks UPnP natively and keeps SACD ISO. |
| “Audirvana already does Linux headless.” | Yes — with a license and a streaming/DSP product around it. Headless is local-first and open on GitHub. |
| “DLNA is broken / not gapless.” | Many players are. We use SetNextAVTransportURI when the device has it, plan media from GetProtocolInfo, and fall back cleanly with a badge — not a silent resample. |
| “Why no Qobuz/Tidal?” | On purpose. Streaming dilutes the local-first promise. The job is the files on disk. |
| “Is Exclusive safe as default?” | No — Shared is the daily driver. Exclusive/DoP when a dedicated DAC is the point of the machine. |

## Brand voice

- Calm, precise, slightly dry. Prefer short sentences.
- Prefer “host”, “path”, “badge”, “folders you already own” over “ecosystem”, “AI”, “revolutionary”.
- Never claim bit-perfect when the path converts (DSD→PCM, Wi‑Fi downsample). Name the path.
- Same visual soul as Audio Harbor: warm paper, gold accent — see [index.html](index.html). Avoid purple SaaS gradients and dark-mode default marketing.

**Words to use:** host, remote, Exclusive, DoP, badge, local, folders, network player, honest  
**Words to avoid:** unlimited, magical, AI-powered, bit-perfect (without path), Roon-killer

## Channels and assets

| Channel | Asset | CTA |
|---|---|---|
| Product page | [docs/index.html](index.html) | Download release / GitHub |
| GitHub README | root README + Releases | `./start.sh` / pair |
| Audio Harbor (Mac) | Cross-link in docs | “Same rules, headless host” |
| Forums / Reddit | Short opener above | Feedback + renderer reports |
| iOS App Store (remote) | Point at Bonjour host | Pair with PIN |

Screenshots / clips that sell:

1. Terminal: `./start.sh` → `audioharbor.local` + QR  
2. Phone: album play → now playing + conversion badge  
3. Settings: output list with `(Network player)` and DSD Auto / PCM / DoP  
4. Badge strip: Shared → Exclusive → DoP (same track)

## Launch checklist

- [ ] Product page matches this brief (hero, pillars, formats, platforms)
- [ ] README “Network players” section linked from any UPnP forum post
- [ ] Release notes use the blurb template
- [ ] One demo clip: play album on USB DAC, switch to UPnP, badge updates, position retained
- [ ] Known-good renderer list (community-sourced) before claiming “works with X”
- [ ] LICENSE decision public if “open source” stays a homepage claim
## Out of scope (for now)

Do not market as included until built:

- Multiroom sync / zone groups  
- Qobuz, Tidal, or other streaming  
- AirPlay / Chromecast outputs  
- Desktop GUI shell  
- Upsampling / EQ / room correction as a selling point
