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

### 6. ✅ Tapping a track: no immediate feedback
`PlaybackService.play()` awaits `play` and then `refresh` before the row is marked playing.

**Fix:** when a row's `onOpen` returns a promise (a track starting, a jump in the queue), `mediaRow`
marks it `pending` until the promise settles: the row stays lit and its trail spins (fading in after
0.1 s, so a quick host shows no flash); then the playing mark takes over, or the error toast shows.

### 7. ✅ Long press on iPhone
`mediaRow.ts` used the `contextmenu` event; iOS Safari does not fire it on a long press, so the actions
sheet was only reachable via `···`.

**Fix:** own long press on touch (0.48 s, cancelled when the finger drifts > 10 px, i.e. a scroll):
the row lights up while held, then a haptic and the actions sheet; the click after lifting is not a
tap. Right click still works; Android, which fires both, opens the sheet once. Rows no longer select
text or show the iOS callout on a long press.

### 8. ✅ Gestures
**Done** (`ui/swipe.ts` — one touch-swipe helper: the first clear move decides, the page does not
scroll during a swipe, the click after lifting is dropped, sliders never start one):
- Mini player: swipe left → next track, right → previous (it follows the finger, slides out and the
  new track slides in from the other side); swipe up → Deck.
- Deck (phone): pull down → back where you came from (else Catalogue); it follows the finger.
- A flick commits only after some distance (45 px across, 50 px down), so a short twitch does nothing.

### 9. ✅ Back key closes sheets
**Done:** an open sheet has a history entry of its own on top of the screen's (`BrowserHistory` as
`OverlayHistory`). The back key (Android, browser) closes the sheet and the screen stays, scroll and
all. A sheet closed in the UI (button, backdrop, swipe) takes its entry away, so the next back leaves
the screen as expected; a sheet action that navigates takes the sheet's entry over (no stray entry);
a sheet replacing another keeps the one entry.

### 10. ✅ View Transitions
**Done:** where the browser has View Transitions (Safari 18+, Chrome), `Shell.render` swaps the screen
inside `document.startViewTransition`: one level deeper slides in from the right, one level up from
the left, another tab cross-fades. The tab bar, mini player, now bar, sidebar and pills have their own
`view-transition-name`, so they stay put while the screen moves. The scroll position is set inside
the swap (`afterSwap`), so back still lands exactly. No animation with *Reduce Motion*, for a page in
the background, or when Safari's own swipe back already animated it (`hasUAVisualTransition`);
browsers without View Transitions keep the fade-in.

### 11. ✅ Long lists
`paintMediaList` built every row on its own — one HTML parse and ~8 listeners per row (24 000 for a
folder of 3000 tracks) — and the browser laid out all of them.

**Fix:** `paintRows` (`components/mediaRow.ts`) parses all rows in one go and binds one set of
listeners per list (tap, `···`, long press, right click, found by the row's index); covers retry
through one capturing listener per list. `.row-wrap` has `content-visibility: auto`, so rows off
screen skip layout and paint. Library, labels, playlists overview and the queue use it.

Measured (3000-track folder, from memory, tap → painted, desktop Chrome): **~440 ms → ~110 ms**.
Scroll restore to y = 90 000 in that list still lands exactly.

### 12. ✅ Needless work while playing
Every position tick (4× per second) ran `syncDeckStage` twice and read `localStorage` twice
(`loadDeckStyle`), and rewrote every label and attribute whether it changed or not.

**Fix:**
- The deck style is read once and kept in memory; one stage sync per tick; labels, the progress
  property and the stage's texts are written only when they change.
- `PlaybackClock` counts from the last reported position and its timestamp instead of adding up
  ticks: exact however late a tick comes, and it does nothing while the page is hidden.
- Found on the way: a snapshot the remote makes itself (play / pause flipped at once, a volume
  change) carries the last *reported* position, so the time jumped back — on every step of a volume
  drag. The clock now keeps running from where it is for those.

Measured on the Deck while playing: 0 `localStorage` reads (was ~32 per 4 s), 0 DOM changes while
hidden, the position right at once when the page comes back.

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

### 14. ✅ Error toasts piled up
With the host gone, every action failed and toasts stacked up, each in the browser's own words.

**Fix:** a request that gets no answer at all throws `HostUnreachableError` ("Harbor cannot be
reached"); the same toast again only stays longer instead of stacking; while the "Connecting…" pill
shows (`body.host-offline`), failure toasts stay quiet and the player controls dim.

Measured: 5 quick taps on *Next* with the host gone → 1 toast; with the pill showing → none.

### 15. ✅ Settings waited for the network
Sources, Output and About fetched before they painted anything.

**Fix:** Sources and Output show what they showed last at once and refresh behind it (Sources paints
again only when the answer differs, so a field being typed into stays); About paints from the
settings the host pushes. A pane with nothing to show after 120 ms gets placeholder rows.

Tested with a slow host (600 ms): placeholders at 250 ms, then the pane; every later visit to
Sources, Output and About paints in the same moment as the tap.

## Also

### 16. ✅ Home-screen icon
"Add to Home Screen" showed a plain blue square: `web/public/icon-180.png` was a placeholder.

**Fix:** the Headless icon (`docs/images/web/icon-180.png`, as on the product page), its transparent
corners filled black so iOS rounds it cleanly: `icon-180.png` (apple-touch-icon) and `icon-192.png`
(manifest); favicons 32 / 64 for the browser tab; manifest colours the chassis (`#12100e`). iOS keeps
the icon it saw when the remote was added — remove the home-screen app and add it again to get it. A
512 px icon (Android splash) needs a larger master than the 180 px one in the repo.
