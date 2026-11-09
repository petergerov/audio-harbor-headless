# Web remote — UI / UX improvements

Review of the web remote (`web/src`) for smoothness and overall UX. Ordered by impact.
Status: ✅ done · 🚧 in progress · ⬜ open.

## 🔴 Highest impact

### 1. ✅ Navigation rebuilds the whole layout and replays its entry animations
`Shell.render()` (`web/src/ui/shell.ts`) replaced the entire `innerHTML` — sidebar, tab bar, mini
player — on every tab switch and every drill-in. Consequences:
- `.screen { animation: fade-up }` replayed on every render,
- the mini player slid in again (`mini-in`) on every tap — reads as flicker,
- a track starting (mini player / now bar appearing) re-rendered the screen and lost the list's scroll.

**Fix:** build the frame once; navigation swaps only `#main`, chrome changes only toggle the mini
player / bar / sidebar / tab bar. Entry animations play only when a part actually appears.

### 2. ✅ No feedback until the host answers
`Navigator.browse()` awaited `library.load()` before rendering. Tapping an album on a Raspberry Pi
with a large library showed nothing for a moment.

**Fix:** render the destination at once (title, back link) with a skeleton list; fill it when the
items arrive. Levels already seen come from an in-memory cache instantly and are revalidated in the
background (stale-while-revalidate); an unchanged answer does not repaint. A failed load shows an
error state with *Try Again* instead of an unhandled rejection.

### 3. ✅ No back gesture / back button, scroll position lost
The app did not use the History API: browser back, Android back and the iOS swipe-back did not match
app navigation; as a home-screen app (standalone) iOS has no back gesture at all. Going back from an
album landed at the top of the list.

**Fix:**
- Every navigation is a history entry (`pushState`); segmented controls, search and settings panes
  replace the current entry. `popstate` restores the route (and the search query).
- Scroll position is stored per entry and restored on back / forward.
- In-app back links use `history.back()` when the previous entry is the parent, so the stack does not
  grow.
- Standalone (home-screen) on touch: swipe from the left edge goes back, with the page following the
  finger. In a Safari tab the native gesture is used.
- Tabs keep their place (iOS behaviour): switching Deck → Catalogue returns to the album you were in;
  tapping the active Catalogue tab again pops to the top level (and scrolls to the top).
- A reload keeps the current place (route lives in `history.state`).

### 4. ✅ Live connection after waking the iPhone
`LiveUpdates` (`web/src/api/liveUpdates.ts`) reconnected only on `onclose`, after a fixed 2 s. Back from
the background, the remote showed a stale track / position until the dead socket was noticed.

**Fix:** the host sends every snapshot when a socket opens, so a fresh socket is a full resync.
- Back from the background after more than 3 s (`visibilitychange`), on `online` and on a
  back-forward-cache restore: drop the socket and open a new one at once. A short hide keeps the socket.
- After a drop: backoff 0.5 / 1 / 2 / 3 / 5 s; no attempts while the page is hidden.
- `AppState.connection`; a quiet "Connecting to Harbor…" pill at the top when the host is out of reach
  for more than 1.2 s (`ui/components/connectionBanner.ts`).

## 🟠 Interaction

### 5. ✅ Volume slider flooded the host
`playerControls.ts` sent one HTTP request per `input` event — with `step=0.01` up to ~100 per swipe;
out-of-order answers made the slider jump back.

**Fix:** `PlaybackService.setVolume` moves the store at once and sends one request at a time, always
the latest level (≥ 60 ms apart). While it sends, and 0.7 s after, snapshots keep the local level, so
nothing pulls the slider back. Measured: 101 slider events → 8 requests, the last one the final level.

### 6. ⬜ Tapping a track: no immediate feedback
`PlaybackService.play()` awaits `play` and then `refresh` before the row is marked playing.

**Fix:** mark the row as "loading" at once (spinner or pulsing speaker glyph).

### 7. ⬜ Long press on iPhone
`mediaRow.ts` uses the `contextmenu` event; iOS Safari does not fire it reliably on long press, so
the actions sheet is only reachable via `···`.

**Fix:** own long-press via touch events and a timer (cancel on move).

### 8. ⬜ Gestures
Swipe left / right on the mini player for next / previous, swipe up opens the Deck; swipe down on the
Deck goes back. The swipe-to-dismiss logic of the sheets (`overlay.ts`) can be reused.

### 9. ⬜ Android back closes sheets
With history in place (3), opening a sheet could push an entry so Android back / browser back closes
the sheet instead of leaving the screen.

## 🟡 Polish and performance

### 10. ⬜ View Transitions
`document.startViewTransition()` for drill-in / back (slide in / out; Safari 18+, others fall back to
the plain swap). A few lines now that navigation swaps only `#main`.

### 11. ⬜ Long lists
`paintMediaList` builds every row at once; folders / artists with thousands of tracks jank.
`content-visibility: auto` with `contain-intrinsic-size` on `.row-wrap` helps a lot; chunked rendering
or virtualisation beyond that.

### 12. ⬜ Needless work while playing
Every position tick (4× per second) runs `syncDeckStage` and `loadDeckStyle()` (i.e. `localStorage`)
twice — via `paintPosition` and `labelPosition`. Cache the style, sync the stage once per tick.

### 13. ✅ Service worker update flow
`public/sw.js` served `index.html` cache-first. Seen while testing 4: after a host restart with a new
build, the cached `index.html` asked for the old `assets/index-*.js`; the host answered with the SPA
fallback (HTML) and the module failed to load — a blank remote until the cache was cleared.

**Fix:**
- The page is network-first (the cached copy when offline, or when the host takes longer than 4 s);
  hashed `/assets/` stay cache-first and are pruned to what the current page links. Cache `v2` drops
  the old one.
- Each time the push channel opens, the remote compares the script the host's `index.html` links
  with its own; when they differ, a "New version of the remote · Reload" pill offers the new build.
- Offline start: the remote no longer shows the pairing screen when the host cannot be reached (and
  no longer stays blank with a stored token) — it waits with the "Connecting…" pill and starts by
  itself when the host is back.

Tested: build A cached → host restarted with build B → pill on the open page, Reload loads B and
prunes A's script; plain reload after an update loads the new build; reload with the host down shows
the cached shell, then the app once the host returns.

### 14. ⬜ Error toasts pile up
With the host gone, every action fails and toasts stack up. The "Connecting…" pill (4) now says it
once; actions could stay quiet (or disabled) while `AppState.connection` is not `open`.

### 15. ⬜ Labels and Settings still wait for the network
The label detail renders from the store at once and refreshes behind (done with 2), but Settings panes
still fetch before they paint. Same pattern: paint from the store / a skeleton, fill in.
