# Audio Harbor Headless — Docs

Product homepage (same visual system as [Audio Harbor](https://github.com/petergerov/audio-harbor/tree/main/docs)):

- **[index.html](index.html)** — open locally or via GitHub Pages (Harbor Deck · Catalogue · Settings remote, screenshots, platforms, releases)
- **[images/web/shots/](images/web/shots/)** — the gallery's screenshots: `desktop-*` (1280×800 at 2×) and `phone-*` (390×844 at 3×) as WebP, the large lightbox versions under `lb/`

```bash
open docs/index.html
# or: python3 -m http.server -d docs 8080
```

Technical install and config notes live in the root [README](../README.md). How engine, host and web remote fit together: [ARCHITECTURE.md](ARCHITECTURE.md) (native Core Audio / ALSA / WASAPI — no JUCE). Positioning, copy, and competitive frame: [marketing.md](marketing.md). Feature deep-dive vs Tune (MozAIk Labs): [tune-audioharbor.md](tune-audioharbor.md). Linux / Raspberry Pi install: [LINUX.md](LINUX.md). Wi‑Fi on the Pi (CLI, beginners, German): [raspberry-pi.md](raspberry-pi.md).
