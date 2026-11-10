# Audio Harbor Headless — 10 things most players can't do

*[Deutsch](top10.de.md)*

## 1. Your own studio plugins, played from the phone

EQ, room correction, a limiter: Audio Harbor runs the plugins you already own on a box with no screen, and you turn their knobs on your iPhone. Five good plugins are included for free, and the EQs have proper panels you can drag on. One key switches all the plugins off and on again with no gap, so you hear the difference straight away. If a plugin crashes, the music doesn't stop. It keeps playing without the effect and the rack comes back on its own.

**Behind it:**
- **CLAP, VST3, AU, LV2:** the four common formats for audio plugins, the same ones music studios use. AU only exists on the Mac, LV2 mostly on Linux.
- **LSP Plugins:** a free, open-source plugin collection. Its graphic EQ, parametric EQ, compressor, limiter and loudness compensation come included.
- **harbor-fx:** the plugins run in a separate program of their own. A crash there can't take the player down with it.
- **A/B bypass:** switching between the sound with and without the plugins, to compare the two.

## 2. DSD to a network streamer, bits untouched

Most players turn DSD into ordinary PCM before it goes over the network. Audio Harbor can pack the DSD bits into the stream, so a DSD DAC behind your streamer gets the original. If DSD drops out over Wi‑Fi, one switch sends a lighter stream instead.

**Behind it:**
- **DSD (Direct Stream Digital):** the format of the SACD. Instead of numbers for the loudness, it stores a very fast stream of single bits.
- **PCM (Pulse Code Modulation):** the "normal" digital audio, like on a CD or in FLAC: one number for the loudness, many thousands of times a second.
- **DoP (DSD over PCM):** a trick that packs the DSD bits into PCM packets. The equipment in between thinks it's PCM, and the DAC unpacks the original DSD again.
- **Wi‑Fi mode:** turns DSD into 44.1 kHz / 16-bit PCM (CD quality), about a third of the data.

## 3. Any network player works like a cable to your DAC

A streamer, an amp, a TV or a soundbar on your home network becomes an output, just like a DAC on a cable. It gets the file as it is when it can play it. When it can't, it gets a lossless copy made on the fly. Seeking works, songs follow each other without gaps where the player allows it, and you can move the music between the host and the network player without losing your place in the song.

**Behind it:**
- **UPnP / DLNA:** the shared language that network devices use to find each other and play media. A device that plays music is called a *renderer*.
- **SSDP:** the "is anybody there?" call of UPnP. Audio Harbor sends it every 30 seconds, so a player you switch on shows up within seconds.
- **GetProtocolInfo:** the player's list of formats it can play. Audio Harbor reads it and sends only what fits.
- **WAV on the fly:** for a format the player doesn't know, the host turns the file into WAV (uncompressed, lossless) while it plays.
- **HTTP Range:** the player can ask for any part of the file, which is what makes seeking work.
- **Gapless (SetNextAVTransportURI):** the player is told about the next song in advance, so there's no pause between tracks.

## 4. It tells you the truth about the sound

A badge on the player shows what your DAC really gets: the sample rate, the bit depth and the path. For example `96 kHz / 24-bit · Exclusive` means bit-perfect, and `44.1 → 48 kHz · Shared` means the computer is resampling. When you asked for the best path and didn't get it, it says so too, for example when the device isn't an external DAC or plugins are changing the sound. You never have to guess.

**Behind it:**
- **Sample rate (kHz):** how many times a second the sound is measured. CD: 44.1 kHz, hi-res: 96 or 192 kHz.
- **Bit depth:** how finely each measurement is stored. CD: 16-bit, hi-res: 24-bit.
- **Bit-perfect:** the DAC gets exactly the numbers in the file, with nothing changed on the way.
- **Resampling:** converting to another sample rate. It happens when the system runs at a different rate than the file, and it slightly changes the signal.
- **DAC (Digital-to-Analog Converter):** the device that turns the digital numbers into the sound for the amp or headphones.

## 5. SACD discs and DSD files, played straight

DSF, DFF and even whole SACD disc images play as tracks in the library. They go straight to a DSD DAC, or as clean PCM to a DAC that can't take DSD, with their own volume level so they aren't louder or quieter than your other music.

**Behind it:**
- **DSF / DFF:** the two file formats for DSD music.
- **SACD ISO:** a 1:1 copy of a whole Super Audio CD in one file. Audio Harbor finds the tracks in it on its own.
- **DST:** a lossless compression for DSD on SACDs, a bit like ZIP for audio. Audio Harbor unpacks it while it plays.
- **DSD→PCM:** converted with a high-quality linear-phase filter, which changes timing as little as possible, to 88.2 kHz / 24-bit.

## 6. A remote with no app and no setup

Open `audioharbor.local` on any phone, tablet or computer on the same network and you're in. There's no app to install, no account and no code to type. Add it to the iPhone home screen and it looks and feels like an app, with its own icon. It keeps working when the host gets a new address, and it reconnects by itself when the Wi‑Fi drops. If you prefer a native app, the Audio Harbor iOS app finds the host on its own.

**Behind it:**
- **mDNS / Bonjour:** lets devices call each other by name instead of by IP address. That's why `audioharbor.local` works and keeps working when the router hands out a new address.
- **PWA (Progressive Web App):** a website that installs like an app on the home screen, with its own icon and full screen.
- **Service worker:** a small helper in the browser that keeps the remote's files, so it opens fast and recognises a new version.
- **WebSocket:** a connection that stays open, so the host can push every change (track, volume, position) to the remote at once.
- **Bonjour service `_audioharbor._tcp`:** the address card the iOS app looks for to find the host on its own.

## 7. A Raspberry Pi that runs like an appliance

One line in the terminal installs it, and it starts by itself at boot. After that you never need the terminal again:
- **Updates:** Settings → Software Update downloads, checks and installs the new version.
- **Music on a USB drive or a network share:** you add it from the phone.
- **Apple Lossless (ALAC):** it plays with its own built-in decoder, so the Pi doesn't need a large extra video toolkit.

It also shares your library with other devices on the network, so one Pi can serve the whole house.

**Behind it:**
- **.deb package:** the standard install package of Debian and Raspberry Pi OS, installed with `apt`.
- **systemd:** the part of Linux that starts services at boot and restarts them when they crash.
- **SHA-256 checksum:** a fingerprint of the download. If a single byte is wrong, the update is refused.
- **ALAC (Apple Lossless):** Apple's lossless format in `.m4a` files. Audio Harbor uses Apple's own open-source decoder instead of **ffmpeg**, a huge media toolkit that pulls in almost 180 extra packages.
- **DLNA media server (ContentDirectory):** the library shows up on TVs, streamers and other apps, which can browse it and play from it.

## 8. One library, every room

Put your music on a NAS, or share it from one host, and every Audio Harbor in the house plays the same library: a Pi in the living room, a Mac in the study, another Pi in the kitchen. Each one mounts the share and adds it with a few taps. DSD, SACD images and everything else play from the share just like from a local drive.

**Behind it:**
- **NAS (Network Attached Storage):** a small storage box on the network that keeps files for every device.
- **SMB / CIFS:** the file-sharing language of Windows, also spoken by most NAS boxes and Macs. On Linux it's mounted with `cifs-utils`.
- **Read-only mount:** the share is attached so that Audio Harbor can read it but never change or delete anything.
- **fstab with automount:** the share comes back by itself after a restart, and the Pi doesn't hang at boot when the NAS is off.

## 9. Bit-perfect on Mac, Linux and Windows alike

One player, three systems, the same rules. In Exclusive mode Audio Harbor takes the DAC for itself, so no other app or system sound gets mixed in, and the sound goes to the DAC unchanged. On the Mac it also switches the DAC to each file's own sample rate. No hidden resampling.

**Behind it:**
- **Shared vs. Exclusive:** in *Shared* every program plays at once and the system mixes them, often with resampling. In *Exclusive* Audio Harbor has the DAC to itself.
- **Core Audio (hog mode):** the Mac's sound system. *Hog mode* is Apple's name for "this device belongs to one program only".
- **ALSA (`hw:` device):** the sound system of Linux. A `hw:` device goes straight to the hardware, past every mixer.
- **WASAPI Exclusive:** the same on Windows: the program talks to the DAC directly, past the Windows mixer.

## 10. A remote that looks like hi-fi, not like a spreadsheet

The player screen is a turntable or a reel-to-reel deck. The catalogue opens by folders, albums, artists or playlists, and search stays at the top wherever you are. It moves like a native app: swipe back, smooth transitions, no waiting for lists you've already seen. On a computer the queue sits beside the player, as in the Mac app. Playlists and labels are shared with the Audio Harbor iOS app.

**Behind it:**
- **View Transitions:** a browser feature that slides and fades smoothly from one screen to the next, as in an iPhone app.
- **Cache with refresh in the background:** lists you've already opened appear at once, and the remote quietly checks for changes behind them.
- **Swipe back from the edge:** as in iOS, also in the app saved to the home screen.
- **Labels:** tags for your own groups, like "Party" or "Late night", that cut across albums and artists.
