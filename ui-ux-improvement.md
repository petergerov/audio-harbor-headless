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

### 4. ⬜ Live connection after waking the iPhone
`LiveUpdates` (`web/src/api/liveUpdates.ts`) reconnects only on `onclose`, after a fixed 2 s. Back from
the background, the remote shows a stale track / position until the dead socket is noticed; after a
reconnect the state is not reloaded, so missed messages stay missed.

**Fix:** on `visibilitychange` → visible, reconnect immediately and call `playback.refresh()`; refresh
after every reconnect; exponential backoff; a quiet "Connecting…" indicator instead of a silent freeze.

## 🟠 Interaction

### 5. ⬜ Volume slider floods the host
`playerControls.ts` sends one HTTP request per `input` event — with `step=0.01` up to ~100 per swipe.
Out-of-order answers make the slider jump back.

**Fix:** throttle (~80 ms), always send the latest value, drop answers older than the last request.

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

### 13. ⬜ Service worker update flow
`public/sw.js` serves `index.html` cache-first: after an update the old UI shows once, at worst with
missing asset files. Network-first for navigations, plus a "New version — reload" toast.

### 14. ⬜ Error toasts pile up
With the host gone, every action fails and toasts stack up. One "Host not reachable" status is calmer.

### 15. ⬜ Labels and Settings still wait for the network
The label detail renders from the store at once and refreshes behind (done with 2), but Settings panes
still fetch before they paint. Same pattern: paint from the store / a skeleton, fill in.
