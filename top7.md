# Audio Harbor Headless — 7 things most players can't do

*[Deutsch](top7.de.md)*

## 1. Your own studio plugins, played from the phone

EQ, room correction, a limiter: Audio Harbor runs the plugins you already own (CLAP, VST3, AU on the Mac, LV2 on Linux) on a box with no screen, and you turn their knobs on your iPhone. Five good plugins are included for free, and the EQs have proper panels you can drag on. One key switches all the plugins off and on again with no gap, so you can hear the difference straight away (A/B). If a plugin crashes, the music doesn't stop. It keeps playing without the effect and the rack comes back on its own.

## 2. DSD to a network streamer, bits untouched

Most players turn DSD into ordinary PCM before it goes over the network. Audio Harbor can pack the DSD bits into the stream (DoP), so a DSD DAC behind your streamer gets the original DSD. If DSD drops out over Wi‑Fi, one switch sends a lighter stream instead.

## 3. Any network player works like a cable to your DAC

A streamer, an amp, a TV or a soundbar on your home network becomes an output, just like a DAC on a cable. It gets the file as it is when it can play it. When it can't, it gets a lossless copy made on the fly. Seeking works, songs follow each other without gaps where the player allows it, and you can move the music between the host and the network player without losing your place in the song.

## 4. It tells you the truth about the sound

A badge on the player shows what your DAC really gets: the sample rate, the bit depth and the path. For example `96 kHz / 24-bit · Exclusive` means bit-perfect, and `44.1 → 48 kHz · Shared` means the computer is resampling. When you asked for the best path and didn't get it, it says so too, for example when the device isn't an external DAC or plugins are changing the sound. You never have to guess.

## 5. SACD discs and DSD files, played straight

DSF, DFF and even whole SACD disc images (ISO, also the compressed DST kind) play as tracks in the library. They go straight to a DSD DAC (DoP), or as clean PCM to a DAC that can't take DSD, with its own volume level so it isn't louder or quieter than your other music.

## 6. A remote with no app and no setup

Open `audioharbor.local` on any phone, tablet or computer on the same network and you're in. There's no app to install, no account and no code to type. Add it to the iPhone home screen and it looks and feels like an app, with its own icon. It keeps working when the host gets a new address, and it reconnects by itself when the Wi‑Fi drops. If you prefer a native app, the Audio Harbor iOS app finds the host on its own.

## 7. A Raspberry Pi that runs like an appliance

One line in the terminal installs it, and it starts by itself at boot. After that you never need the terminal again:
- **Updates:** Settings → Software Update downloads, checks and installs the new version.
- **Music on a USB drive or a network share:** you add it from the phone.
- **Apple Lossless (ALAC):** it plays with its own built-in decoder, so the Pi doesn't need a large extra video toolkit (ffmpeg).

It also shares your library with other devices on the network (DLNA), so one Pi can serve the whole house.
