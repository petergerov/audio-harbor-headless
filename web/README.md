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

The Deck stage is Turntable or Reel-to-Reel (preference in `localStorage` under `ah.deckStyle`);
photos live in `public/deck/` (`*-portrait.jpg` / `*-wide.jpg`). Queue rail open/closed is
`ah.deck.queueRail`. Live player markup follows `PlayerMarkup` in `components/playerBindings.ts`.

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
    sheets/      organize, playlist picker, labels, collection menu, queue (phone)
    overlay.ts   sheets, dialogs and toasts
```

## Rules

- **State** lives in `Store<AppState>` and changes immutably; services write it, views read it.
- **Views** implement `View` (`render`, optional `onTrackChange`, `dispose`) and get an `AppContext`
  of interfaces (`Navigation`, `PlaybackActions`, `ItemActions`, …), never concrete services.
- **New tab or settings pane**: add the class and one entry in `views/registry.ts` or `SettingsView`'s
  `PANES`; the shell does not change.
- **New list row type**: add a presenter to `PRESENTERS` in `views/mediaList.ts` (first match wins).
- **Live player state** (title, play/pause, position, volume, badge, error, playing row) follows the
  markup contract in `components/playerBindings.ts` (`PlayerMarkup`). Any element carrying it stays
  current without re-rendering its view.
- **Rendering**: navigation renders the shell. Playback changes do the least that is needed: chrome
  appearing or going → new layout; another track → chrome and `onTrackChange`; anything else → bindings.
  Lists therefore keep their scroll position while tracks change.
- **Deck queue**: shared paint/bind lives in `components/queueList.ts`. Desktop mounts
  `deckQueueRail`; phone opens `sheets/queueSheet.ts`.
