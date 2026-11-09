# Web remote

Mobile-first web app (Vite + TypeScript, no framework) served by the host. Visual language matches the
iOS remote (Harbor chassis / ivory / amber). Layers depend inward only:
`ui` → `services` → `state` / `api` → `core`. Nothing below `ui` touches the DOM.

## Tabs and layout

Primary tabs: **Deck · Catalogue · Settings**. Catalogue roots: Dirs · Albums · Artists · Lists.
Labels open as a drill-in (not a primary tab).

| Surface | Phone | Desktop (`min-width: 700px`) |
|---|---|---|
| Chrome | Tab bar; mini player above it when a track is loaded **and** you are not on Deck | Left sidebar; bottom now-bar when a track is loaded **and** you are not on Deck |
| Deck | Stacked stage + controls; sized to fit above the tab bar without scrolling; Up Next is a sheet | Larger stacked Deck + optional **Up Next** rail on the right (macOS-style); no bottom player |
| Catalogue / Settings | Full-screen lists | Content starts beside the sidebar (not a centered narrow column) |

The Deck stage is Turntable or Reel-to-Reel (preference in `localStorage` under `harbor.deckStyle`);
photos live in `public/deck/` (`*-portrait.jpg` / `*-wide.jpg`). Queue rail open/closed is
`ah.deck.queueRail`. Live player markup follows `PlayerMarkup` in `components/playerBindings.ts`.

The plugin rack's snapshot comes over the WebSocket (`rack`) into `AppState.rack`. The Deck toolbar
shows the fader button when the host has a rack (amber while plugins shape the sound); its sheet and
Settings → Rack repaint from the store, but not while a control is held. `components/rackControls.ts`
holds the path badge and the insert head with its power key. Parameters live in `ui/rack/`:

| Module | Job |
|---|---|
| `paramModel.ts` | No DOM. A parameter's kind (`toggle`, `choice` from the plugin's own option texts, `number`), its unit (from the plugin's text), its `Scale` — linear, logarithmic for Hz ranges, with a detent at the default — and which parameters only drive the plugin's window (graphs, zoom, analyzer…) and are left out |
| `paramGroups.ts` | No DOM. Groups by the plugin's module or a trailing number (named Band 1…, or 16 Hz… when the numbers are centre frequencies), finds the band's on switch (`Used`, `Filter type`, `Band on`, `… enable`) and whether it is in play |
| `paramControls.ts` | One `ParamControl` per kind — switch, select, slider with − / + and a value to tap and type, double tap for the default. A new kind is a new entry in `CONTROLS` |
| `paramRow.ts`, `paramSheet.ts` | A row per parameter (★ or a long press on the name pins it); the sheet: search, Main, bands in play, `+ Band` and *Show unused* |
| `knob.ts` | Pinned numbers as rotary knobs on the Deck sheet: drag up / down, arrow keys, double tap for the default |
| `paramSender.ts` | Sends one insert's changes, at most every 60 ms per parameter while a control moves (the last value always) — numbers, or text the plugin reads |
| `insertSheet.ts`, `insertView.ts` | An insert's sheet: *Panel* (when the remote knows the plugin) or *All*, both an `InsertView`; above them A/B, Undo, Reset |
| `paramList.ts` | The *All* view: search, Main, bands in play, `+ Band`, *Show unused* |
| `settingsHistory.ts` | Undo steps (changes within 0.8 s are one), A/B against the settings from when the sheet opened, reset — on the plugin's whole state, so every control is covered alike |
| `panels/` | `specs.ts` — a panel per shipped plugin, as data (`PanelSpec`: sections of knobs, rows, faders, EQ curve, band tabs, meter, note). `sections.ts` — a renderer per kind of section; a new kind is a new entry. `eqCurve.ts` — the curve and its points. `panelView.ts` — draws a spec and routes the plugin's answers to the sections that watch them |
| `eqResponse.ts` | No DOM. The EQ's response from its bands (RBJ biquads, slope as filters in series), log axis helpers, the plugin's texts read as numbers |
| `fader.ts`, `meter.ts`, `drag.ts` | Graphic EQ faders; the in / out / gain meter (polled while on screen); one pointer-drag helper for knobs, faders and EQ points |
| `presets.ts` | Rack preset chips (load), *Edited · Save*, and the menu: Save as New, Rename, Delete |

```
src/
  main.ts        composition root — the only place that names concrete classes
  app/           App (start, pairing, playback → screen updates), AppContext (what views get)
  core/          Store, escaping, formatting, device (viewport, haptics), deckStyle, errors
  api/           typed DTOs, HttpClient + TokenStore, one interface + Http… class per area,
                 LiveUpdates (WebSocket)
  state/         AppState (single source of truth) and pure selectors (`chromeFor` for layout)
  services/      Library, Collections, Playback (+ PlaybackClock), Navigator
  ui/
    shell.ts     layout (sidebar / tab bar, player chrome) and the current view
    views/       one View per tab (registry.ts), settings panes, media list, catalogueScopes
    components/  covers, rows, deck stage / chrome / queue rail, player bindings and controls
    sheets/      organize, playlist picker, labels, collection menu, item actions, queue (phone),
                 folder picker and SMB share dialog (Settings → Sources), plugin rack (Deck),
                 plugin picker and parameters (Settings → Rack)
    overlay.ts   sheets, dialogs and toasts
```

## Rules

- **State** lives in `Store<AppState>` and changes immutably; services write it, views read it.
- **Views** implement `View` (`render`, optional `onTrackChange`, `dispose`) and get an `AppContext`
  of interfaces (`Navigation`, `PlaybackActions`, `ItemActions`, …), never concrete services.
- **New tab or settings pane**: add the class and one entry in `views/registry.ts` or `SettingsView`'s
  `PANES`; the shell does not change.
- **New list row type**: add a presenter to `PRESENTERS` in `views/mediaList.ts` (first match wins).
  A presenter's `open` returns a promise when it starts a track; `mediaRow` shows the row as loading
  until it settles. Rows with `contextMenu` open their actions on a long press (touch) or right click.
- **Live player state** (title, play/pause, position, volume, badge, error, playing row) follows the
  markup contract in `components/playerBindings.ts` (`PlayerMarkup`). Any element carrying it stays
  current without re-rendering its view.
- **Rendering**: the shell builds its frame once (again only when the window crosses the desktop
  breakpoint). Navigation swaps the view inside `#main` (`enter-forward` / `enter-back` animate it);
  sidebar and tab bar are replaced only when their markup changes. Playback changes do the least that
  is needed: chrome appearing or going → the mini player / now bar is added or removed, the view stays;
  another track → chrome and `onTrackChange`; anything else → bindings. Lists therefore keep their
  scroll position while tracks change.
- **Navigation and history**: `Navigator` renders the destination at once and loads behind it.
  `LibraryService` keeps browsed levels and searches in memory (shown instantly, revalidated); until
  items arrive `library.loading` shows placeholder rows, a failed load `library.error` with *Try
  Again* (`collections.loading` / `error` likewise for an open label). Every move is a history entry
  (`state/route.ts` holds the route; `ui/browserHistory.ts` is the `HistoryPort`): drill-ins and tab
  switches push, segmented controls, search and settings panes replace. Entries keep their scroll
  position; back / forward and a reload restore the route. In-app back links step back through
  history when the previous entry is above. Tabs keep their place; tapping the active Catalogue tab
  goes to its top. Saved to the home screen on a phone, a swipe from the left edge goes back
  (`ui/edgeSwipe.ts`).
- **Live connection**: the host sends every snapshot when a socket opens, so `LiveUpdates` resyncs by
  reconnecting — at once when the page returns from the background (> 3 s), the network returns or
  the page comes back from the back-forward cache; after a drop with backoff (0.5 … 5 s), not while
  hidden. `AppState.connection` drives the "Connecting to Harbor…" pill
  (`components/connectionBanner.ts`, after 1.2 s).
- **Volume**: `PlaybackService.setVolume` moves the store at once and keeps one request in flight,
  always the latest level; snapshots defer to the local level while it sends and shortly after.
- **Deck queue**: shared paint/bind lives in `components/queueList.ts`. Desktop mounts
  `deckQueueRail`; phone opens `sheets/queueSheet.ts`.
- **Offline shell**: `public/sw.js` — only in a secure context (`localhost`, `127.0.0.1`), not over
  plain `http` to a phone. The page is network-first (cached copy when offline or after 4 s), the
  hashed `/assets/` are cache-first and pruned to what the current page links. Each time the push
  channel opens, `components/updateNotice.ts` compares the script the host's `index.html` links with
  the one running and offers *Reload* when they differ; `ui/reloadRemote.ts` drops the caches and
  reloads (also used by the About pane after a Software Update). While the host cannot be reached,
  `App.start` waits with the "Connecting…" pill and tries again every 2 s instead of asking for a code.
