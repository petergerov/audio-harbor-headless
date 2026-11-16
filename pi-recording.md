# Recording on the Raspberry Pi (S/PDIF in)

Plan for recording a digital source on the Pi **bit-perfect, in the format it arrives in**, using a **HiFiBerry Digi+ I/O** HAT as the S/PDIF input. Status: idea / plan, nothing built yet.

## Goal

- Record whatever arrives on the S/PDIF input (coax or optical) without resampling, dithering, gain or mixing. The samples on disk are the samples on the wire.
- Keep the source's format: sample rate, real bit depth (16 or 24), DSD sent as DoP, and Dolby / DTS bitstreams.
- Control it from the remote like playback (start / stop, meter, detected format). Recordings land in the library and play right away.

## Hardware: HiFiBerry Digi+ I/O

| | |
|---|---|
| Receiver / transmitter | Cirrus / Wolfson **WM8804** |
| Inputs | S/PDIF coax (RCA) and optical (TOSLINK) |
| Rates | 44.1 / 48 / 88.2 / 96 / 176.4 / 192 kHz; optical is often only reliable up to 96 kHz (depends on the transmitter and cable) |
| Word length | up to 24 bit |
| Driver | mainline kernel, `dtoverlay=hifiberry-digi` |

Setup on the Pi (`/boot/firmware/config.txt`):

```ini
dtoverlay=hifiberry-digi
# keep the on-board audio from taking card 0 if needed
# dtparam=audio=off
```

After a reboot `arecord -l` lists the card (`snd_rpi_hifiberry_digi`). Quick check:

```bash
arecord -D hw:CARD=sndrpihifiberry,DEV=0 -f S24_LE -r 44100 -c 2 -d 10 /tmp/test.wav
```

**Output stays on the SMSL over USB** (DoP, see the Pi notes). The HAT is used only as an input, so it does not get in the way of the current playback path. Its S/PDIF output is unused (or can be a second output later).

## Bit-perfect capture

S/PDIF is already digital, so bit-perfect means: don't touch the samples on the way to disk.

- Open the **`hw:` device**, never `plughw`, `default`, `dsnoop` or PipeWire / PulseAudio. These can convert rate or format without saying so.
- Ask for the hardware's native format (`S24_LE` / `S32_LE`, interleaved, 2 ch) and the exact rate of the incoming signal. Fail if ALSA cannot give exactly that; never fall back.
- No gain, no dither, no FX rack in the record path. The meters only read the stream.
- Store as **FLAC** (lossless, tags, seekable). For very long takes use **RF64/WAV** as an option (no 4 GB limit, no encoder load).
- Write with a lock-free ring buffer between the ALSA capture thread and the writer thread, so a slow SD card or USB disk never causes an overrun. Count overruns (`-EPIPE`) and show them in the UI. A take with overruns is no longer bit-perfect and must say so.

## The catch: sample rate detection

HiFiBerry documents that the Digi+ I/O **does not detect the input rate on its own**. The capture rate is whatever the application asks for. If it does not match the signal, the recording is wrong (clicks, wrong speed or silence).

The WM8804 knows the incoming rate (S/PDIF status register), but the kernel driver does not expose it as an ALSA control. Options, from simplest to cleanest:

1. **Manual:** the remote offers a rate (44.1 / 48 / 88.2 / 96 / 176.4 / 192). Works today, but the user must know the source's rate.
2. **Read the WM8804 status from userspace:** the regmap debugfs (`/sys/kernel/debug/regmap/<bus>-003b/registers`) can read registers the driver marks as volatile directly from the chip. Needs root / debugfs and **must be checked on the Pi first**: are the status registers volatile, is the frequency field usable, and does it follow changes of the input?
3. **Kernel patch:** a read-only ALSA control "S/PDIF In Rate" in the `wm8804` driver. Cleanest for userspace (plain `amixer` / `snd_ctl` read), but a patched kernel or out-of-tree module is costly to maintain on a Pi that updates itself.
4. **Probing (fallback):** open at a candidate rate, capture ~200 ms, check for valid data (PLL locked, no all-zero / garbage), try the next rate. Slower and less sure; only a fallback.

Plan: start with **1**, test **2** on the real Pi, add **4** if 2 does not work. **3** only if nothing else works.

A rate change mid-take (e.g. the source moves to the next track at another rate) must end the current file and start a new one at the new rate.

## Keeping the source format

### Bit depth

S/PDIF always carries up to 24 bit. A CD source fills only the top 16, and the lower 8 are zero. The recorder watches the low bits over the whole take:

- all low 8 bits zero → write **16-bit FLAC** (identical data, smaller file)
- else → **24-bit FLAC**

Decide at the end of the take (re-encode the header, or write 24-bit while recording and transcode losslessly afterwards). Never truncate a take that has any non-zero low bits.

### DSD over DoP

A DoP source (e.g. an SACD player or streamer sending DSD64 as 176.4 kHz / 24-bit PCM) carries markers `0x05` / `0xFA` in the top byte, alternating per frame. The recorder:

- detects a steady marker pattern (e.g. ≥ 32 consecutive frames on both channels)
- unpacks the 16 DSD bits per frame and writes a native **`.dsf`** (DSD64 at 176.4 kHz, DSD128 at 352.8 kHz, which S/PDIF usually cannot carry)
- falls back to PCM if the pattern breaks

`engine/src/DsdPipeline.cpp` already packs DoP for playback (same markers), so the format logic is there to mirror.

### Dolby / DTS bitstreams (IEC 61937)

When the S/PDIF channel status says "non-audio", the data is a compressed bitstream, not PCM. Save it raw (e.g. `.ac3` / `.dts`, or the raw IEC 61937 frames) instead of writing noise to a FLAC. If channel status cannot be read (see rate detection), detect the IEC 61937 sync words (`0xF872` / `0x4E1F`) in the data.

### Channel status / metadata

The S/PDIF channel status also says pre-emphasis (some early CDs) and copy bits. Save pre-emphasis as a tag (`PRE_EMPHASIS=1`) so playback can apply de-emphasis later. Do not change the samples.

## Architecture in Audio Harbor

No capture path exists yet; `engine/src/LinuxPlayer.cpp` only plays through ALSA.

### Engine (C++, `engine/src/`)

- `Recorder.h` – interface (start, stop, status, meters), like `Player.h`
- `LinuxRecorder.cpp` – ALSA `hw:` capture thread (`SND_PCM_STREAM_CAPTURE`, MMAP or read, ~100 ms period), ring buffer, writer thread
- `RecordSink` – FLAC (libFLAC) / RF64 / DSF / raw writers
- `StreamSniffer` – detects bit depth, DoP, IEC 61937 and silence on the fly
- `StubRecorder.cpp` for macOS / Windows (or Core Audio / WASAPI capture later)
- N-API: `startRecording(opts)`, `stopRecording()`, `recordingStatus()`, `recordingMeters()` in `engine/napi/binding.cpp` and `engine/index.d.ts`

### Host (TypeScript, `host/src/`)

- `recording/service.ts` – state machine (idle → armed → recording → finalizing), file naming, rate detection (WM8804 read or probing), track split, rescan after finalize
- API (in `api/server.ts`, same style as the rest of `/api/v1`):
  - `GET  /api/v1/recording` – state, detected format, elapsed, file, overruns
  - `POST /api/v1/recording/start` – `{ rate?: number | "auto", split?: "none" | "silence" }`
  - `POST /api/v1/recording/stop`
  - `GET  /api/v1/recording/meters` – peak / RMS per channel (like `/api/v1/rack/meters`)
  - `GET  /api/v1/recording/inputs` – capture devices with their rates
- Config (`config.example.toml`):

```toml
[recording]
enabled = false
# ALSA capture device; "" = first S/PDIF input found
device = "hw:CARD=sndrpihifiberry,DEV=0"
# auto = read / probe the input rate; or a fixed rate in Hz
rate = "auto"
# folder for takes; should be inside a library root so they show up after the rescan
folder = "~/Music/Recordings"
format = "flac"          # flac | rf64
split = "none"           # none | silence
silence_db = -70         # threshold for track split
silence_seconds = 2.0
```

### Remote (`web/`)

- Record view: big Record / Stop button, elapsed time, peak meters, detected format badge (`96 kHz · 24 bit`, `CD · 16 bit`, `DSD64 · DoP`, `Dolby Digital`), overrun warning, "no signal" / "not locked" state.
- After stop: the take shows in the library (folder view) with a link to play it.

### Optional: monitoring

Pass the input through to the current output (SMSL) while recording. Only bit-perfect when the output can run at the same rate; otherwise monitoring is off or resampled, and the recording itself stays untouched either way.

## Files and naming

```
Recordings/
  2026-11-16 20-15-03 (96k-24)/
    01.flac
    02.flac       # with split = "silence"
  2026-11-16 21-40-10 (DSD64)/
    take.dsf
```

Tags: `DATE`, `SOURCE=S/PDIF coax`, `SAMPLERATE`, `BITS`, `PRE_EMPHASIS` when set, `OVERRUNS` when > 0.

## Disk and load

| Format | Data rate | 1 hour |
|---|---|---|
| 44.1 kHz / 16 bit (FLAC ~60 %) | ~0.85 Mbit/s | ~0.4 GB |
| 96 kHz / 24 bit (FLAC ~65 %) | ~3 Mbit/s | ~1.3 GB |
| 192 kHz / 24 bit (FLAC ~65 %) | ~6 Mbit/s | ~2.7 GB |
| DSD64 (.dsf) | 5.6 Mbit/s | ~2.5 GB |

FLAC at level 5 is easy work for a Pi 4 / 5. Prefer a USB SSD to the SD card for long or hi-res takes. Check free space before starting and stop cleanly (finish the file) when the disk is nearly full.

## Steps

1. **Pi check** (needs the HAT fitted): overlay, `arecord` at each rate from a known source, compare against the source file (e.g. play a test FLAC from another player over S/PDIF and `sox`/`cmp` the samples after aligning).
2. **Rate detection:** test reading the WM8804 status through regmap debugfs; decide between option 2 and 4.
3. **Engine:** `LinuxRecorder` + FLAC writer + overrun count, N-API binding.
4. **Host:** service, API, config, rescan after finalize.
5. **Remote:** record view with meters and format badge.
6. **Format sniffing:** 16 / 24-bit decision, DoP → DSF, IEC 61937 → raw.
7. **Extras:** split on silence, monitoring, pre-emphasis tag.

## Open questions

- Is the WM8804's rate / lock status readable from userspace on the current Pi kernel?
- How does the driver behave when the input signal is lost or changes rate during capture (error, silence, or wrong data)?
- Can the HAT run alongside the SMSL on USB without clock / IRQ issues on the Pi 5?
- Does optical work at 176.4 / 192 kHz with the actual sources here?
- DSD128 over DoP needs 352.8 kHz, which S/PDIF usually cannot carry. Only DSD64 is expected.

## Testing

- Bit-perfect proof: play a known file into the input, record, then compare the recorded samples with the original after trimming the start offset. They must be identical (`cmp` on raw PCM, or the FLAC MD5 of the trimmed take).
- DoP proof: send a DSF over DoP, record, compare the DSD bits in the new `.dsf` with the source.
