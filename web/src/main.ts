import './styles.css';
import { api, artworkObjectUrl, artworkUrl, getToken, setToken, connectWs, haptic } from './api';
import { icons } from './icons';
import {
  closeOverlay,
  isDesktopUi,
  openActionMenu,
  openConfirmDialog,
  openNameDialog,
  openPanel,
  showToast,
} from './ui/overlay';

type Tab = 'library' | 'collections' | 'now' | 'settings';
type LibraryScope = 'albums' | 'artists' | 'folders';
type CollectionKind = 'playlist' | 'label' | null;

type Selection = {
  cataloguePath?: string;
  albumId?: string;
  artist?: string;
  folder?: string;
  title: string;
};

const app = document.querySelector<HTMLDivElement>('#app')!;

let tab: Tab = 'library';
let libraryScope: LibraryScope = 'albums';
let folderPath: string | null = null;
let folderStack: string[] = [];
/** Drill-into album (id) or artist (name), same idea as folderPath. */
let albumDrill: { id: string; title: string; artist: string } | null = null;
let artistDrill: string | null = null;
let collectionKind: CollectionKind = null;
let collectionId: string | null = null;
let collectionTitle: string | null = null;
let nowPlaying: Record<string, unknown> | null = null;
let items: unknown[] = [];
let searchQuery = '';
let playing = false;
let scrubbing = false;
let localPos = 0;
let posTimer: number | undefined;
let lastTrackId: string | null = null;
let playlistCache: Array<{ id: string; name: string; trackCount?: number }> = [];
let labelCache: Array<{ name: string; trackCount?: number }> = [];
let settingsPane: 'sources' | 'output' = 'sources';

function startPosClock(): void {
  window.clearInterval(posTimer);
  posTimer = window.setInterval(() => {
    if (!playing || scrubbing) return;
    localPos += 0.25;
    const dur = Number(nowPlaying?.durationSecs ?? 0);
    if (dur > 0 && localPos > dur) localPos = dur;
    paintScrub();
  }, 250);
}

function paintScrub(): void {
  if (scrubbing) return;
  document.querySelectorAll<HTMLInputElement>('input[data-seek]').forEach((seek) => {
    seek.value = String(localPos);
  });
  document.querySelectorAll('[data-time-pos]').forEach((el) => {
    el.textContent = fmtTime(localPos);
  });
}

async function boot(): Promise<void> {
  if (!getToken()) {
    renderPairing();
    return;
  }
  connectWs((msg) => {
    if (msg.type === 'nowPlaying') {
      const prevId = lastTrackId;
      const hadTrack = Boolean(nowPlaying?.track);
      nowPlaying = msg.payload as Record<string, unknown>;
      playing = nowPlaying?.state === 'playing';
      const track = nowPlaying?.track as Record<string, unknown> | null;
      lastTrackId = track?.id ? String(track.id) : null;
      const hasTrack = Boolean(track);
      if (!scrubbing) localPos = Number(nowPlaying?.positionSecs ?? 0);
      // Layout must rebuild when player chrome appears/disappears or track changes.
      if (hadTrack !== hasTrack || prevId !== lastTrackId) {
        renderApp();
        return;
      }
      updateNowChrome();
      paintScrub();
    }
  });
  try {
    nowPlaying = await api('/api/v1/now-playing');
    playing = nowPlaying?.state === 'playing';
    localPos = Number(nowPlaying?.positionSecs ?? 0);
    const track = nowPlaying?.track as Record<string, unknown> | null;
    lastTrackId = track?.id ? String(track.id) : null;
  } catch {
    setToken(null);
    renderPairing();
    return;
  }
  startPosClock();
  await refreshCaches();
  await loadLibrary();
  renderApp();
}

function updateNowChrome(): void {
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  document.querySelectorAll('.now-title').forEach((el) => {
    el.textContent = String(track?.title ?? 'Not Playing');
  });
  document.querySelectorAll('.now-artist').forEach((el) => {
    el.textContent = String(track?.artist ?? 'Choose something from Library');
  });
  document.querySelectorAll('.play-btn, [data-cmd="toggle"]').forEach((btn) => {
    btn.innerHTML = playing ? icons.pause : icons.play;
  });
  const dur = Number(nowPlaying?.durationSecs ?? 0) || 0;
  document.querySelectorAll<HTMLInputElement>('input[data-seek]').forEach((seek) => {
    if (dur > 0) seek.max = String(dur);
  });
  document.querySelectorAll('[data-time-end]').forEach((el) => {
    el.textContent = dur ? fmtTime(dur) : '--:--';
  });
  // Refresh mini play icon without rebuilding the whole bar.
  const miniToggle = document.querySelector('#miniToggle');
  if (miniToggle) miniToggle.innerHTML = playing ? icons.pauseSm : icons.playSm;
  // Desktop bar uses full play/pause glyphs inside .play-btn (handled above).
  markNowPlayingRows();
}

function renderPairing(): void {
  app.innerHTML = `
    <main class="pair-screen">
      <div class="pair-card">
        <div class="pair-mark">AH</div>
        <h1>Audio Harbor</h1>
        <p>Enter the 6-digit PIN from the host to pair this device.</p>
        <input id="pin" class="pin-input" inputmode="numeric" maxlength="6"
          placeholder="••••••" autocomplete="one-time-code" enterkeyhint="done" />
        <button id="pairBtn" class="btn-fill">Continue</button>
        <p id="pairErr" class="err" hidden></p>
      </div>
    </main>
  `;
  const pin = app.querySelector<HTMLInputElement>('#pin')!;
  const err = app.querySelector<HTMLParagraphElement>('#pairErr')!;
  const btn = app.querySelector<HTMLButtonElement>('#pairBtn')!;
  pin.focus();
  const submit = async () => {
    err.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch('/api/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.value.trim() }),
      });
      if (!res.ok) throw new Error('Incorrect PIN. Try again.');
      const data = (await res.json()) as { token: string };
      setToken(data.token);
      await boot();
    } catch (e) {
      err.hidden = false;
      err.textContent = e instanceof Error ? e.message : 'Pairing failed';
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', () => void submit());
  pin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
}

async function refreshCaches(): Promise<void> {
  try {
    const [pl, lb] = await Promise.all([
      api<{ playlists: Array<{ id: string; name: string; trackCount: number }> }>('/api/v1/playlists'),
      api<{ labels: Array<{ name: string; trackCount: number }> }>('/api/v1/labels'),
    ]);
    playlistCache = pl.playlists;
    labelCache = lb.labels;
  } catch {
    /* ignore */
  }
}

function libraryDrillPath(): string | null {
  if (libraryScope === 'folders') return folderPath;
  if (libraryScope === 'albums') return albumDrill?.id ?? null;
  if (libraryScope === 'artists') return artistDrill;
  return null;
}

function clearLibraryDrill(): void {
  folderPath = null;
  folderStack = [];
  albumDrill = null;
  artistDrill = null;
}

async function loadLibrary(): Promise<void> {
  if (searchQuery.trim()) {
    const res = await api<{ items: unknown[] }>(
      `/api/v1/search?q=${encodeURIComponent(searchQuery.trim())}`
    );
    items = res.items;
    return;
  }
  const drill = libraryDrillPath();
  const pathQ = drill ? `&path=${encodeURIComponent(drill)}` : '';
  const res = await api<{ items: unknown[] }>(
    `/api/v1/browse?scope=${libraryScope}${pathQ}`
  );
  items = res.items;
}

async function loadCollectionTracks(): Promise<void> {
  if (!collectionId || !collectionKind) {
    items = [];
    return;
  }
  if (collectionKind === 'playlist') {
    const res = await api<{ tracks: unknown[]; name: string }>(
      `/api/v1/playlists/${encodeURIComponent(collectionId)}/tracks`
    );
    collectionTitle = res.name;
    items = res.tracks;
  } else {
    const res = await api<{ tracks: unknown[]; name: string }>(
      `/api/v1/labels/${encodeURIComponent(collectionId)}/tracks`
    );
    collectionTitle = res.name;
    items = res.tracks;
  }
}

function hasNowTrack(): boolean {
  return Boolean(nowPlaying?.track);
}

/** Mobile mini player — hide on full Now Playing to avoid doubling. */
function wantsMini(): boolean {
  return hasNowTrack() && tab !== 'now' && !isDesktopUi();
}

/** Compact header player — mobile only (desktop uses the bottom bar). */
function wantsHeaderPlayer(): boolean {
  return hasNowTrack() && !isDesktopUi() && (tab === 'library' || tab === 'collections');
}

/** Desktop Showboard-style bottom player — always on while a track is loaded. */
function wantsDesktopBar(): boolean {
  return hasNowTrack() && isDesktopUi();
}

function renderApp(): void {
  const mini = wantsMini();
  const bar = wantsDesktopBar();
  const wide = isDesktopUi();
  app.innerHTML = `
    <div class="app-shell layout ${mini ? '' : 'no-mini'} ${wide ? 'wide' : ''} ${bar ? 'has-bar' : ''}">
      ${wide ? renderSidebar() : ''}
      <div class="content-col">
        <main class="screen" id="main"></main>
        ${mini ? `<div class="mini-player" id="mini"></div>` : ''}
        ${
          wide
            ? ''
            : `<nav class="tab-bar" id="tabs">
          ${tabBtn('library', 'Library', icons.browse)}
          ${tabBtn('collections', 'Playlists', icons.library)}
          ${tabBtn('now', 'Playing', icons.now)}
          ${tabBtn('settings', 'Settings', icons.output)}
        </nav>`
        }
      </div>
      ${bar ? `<footer class="now-bar" id="nowBar" aria-label="Now Playing"></footer>` : ''}
    </div>
  `;

  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      haptic('light');
      tab = btn.dataset.tab as Tab;
      collectionKind = null;
      collectionId = null;
      if (tab === 'library') {
        clearLibraryDrill();
        await loadLibrary();
      }
      if (tab === 'collections') await refreshCaches();
      renderApp();
    });
  });

  app.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nav = btn.dataset.nav!;
      if (nav === 'library' || nav === 'collections' || nav === 'now' || nav === 'settings') {
        tab = nav;
        collectionKind = null;
        collectionId = null;
        if (tab === 'library') {
          clearLibraryDrill();
          await loadLibrary();
        }
        if (tab === 'collections') await refreshCaches();
        renderApp();
        return;
      }
      if (nav === 'playlist') {
        tab = 'collections';
        collectionKind = 'playlist';
        collectionId = btn.dataset.id!;
        collectionTitle = btn.dataset.name ?? null;
        await loadCollectionTracks();
        renderApp();
        return;
      }
      if (nav === 'label') {
        tab = 'collections';
        collectionKind = 'label';
        collectionId = btn.dataset.id!;
        collectionTitle = btn.dataset.id!;
        await loadCollectionTracks();
        renderApp();
      }
    });
  });

  app.querySelector('#sideNewPl')?.addEventListener('click', () => createPlaylist());

  const main = app.querySelector('#main')!;
  if (tab === 'library') renderLibrary(main);
  if (tab === 'collections') void renderCollections(main);
  if (tab === 'now') renderNow(main);
  if (tab === 'settings') void renderSettings(main);
  if (mini) paintMini();
  if (bar) paintDesktopBar();
  if (wantsHeaderPlayer()) paintHeaderPlayer();
}

function renderSidebar(): string {
  const pl = playlistCache
    .map(
      (p) => `
      <button type="button" class="side-row ${tab === 'collections' && collectionKind === 'playlist' && collectionId === p.id ? 'active' : ''}"
        data-nav="playlist" data-id="${escAttr(p.id)}" data-name="${escAttr(p.name)}">
        <i class="side-dot playlist" aria-hidden="true"></i>
        <span>${esc(p.name)}</span>
        <em>${p.trackCount ?? ''}</em>
      </button>`
    )
    .join('');
  const lb = labelCache
    .map(
      (l) => `
      <button type="button" class="side-row ${tab === 'collections' && collectionKind === 'label' && collectionId === l.name ? 'active' : ''}"
        data-nav="label" data-id="${escAttr(l.name)}">
        <i class="side-dot label" aria-hidden="true"></i>
        <span>${esc(l.name)}</span>
        <em>${l.trackCount ?? ''}</em>
      </button>`
    )
    .join('');
  const overview = tab === 'collections' && !collectionId;
  return `
    <aside class="sidebar" aria-label="Navigation">
      <div class="side-brand">Audio Harbor</div>
      <button type="button" class="side-row ${tab === 'library' ? 'active' : ''}" data-nav="library">${icons.browse}<span>Library</span></button>
      <button type="button" class="side-row ${overview ? 'active' : ''}" data-nav="collections">${icons.library}<span>Playlists &amp; Labels</span></button>
      <button type="button" class="side-row ${tab === 'now' ? 'active' : ''}" data-nav="now">${icons.now}<span>Now Playing</span></button>
      <div class="side-heading">
        <p class="side-label">Playlists</p>
        <button type="button" class="side-plus" id="sideNewPl" aria-label="New playlist" title="New playlist">+</button>
      </div>
      <div class="side-scroll">${pl || `<p class="side-empty">No playlists yet</p>`}</div>
      <div class="side-heading"><p class="side-label">Labels</p></div>
      <div class="side-scroll">${lb || `<p class="side-empty">No labels yet</p>`}</div>
      <div class="side-foot">
        <button type="button" class="side-row ${tab === 'settings' ? 'active' : ''}" data-nav="settings">${icons.output}<span>Settings</span></button>
      </div>
    </aside>
  `;
}

function tabBtn(id: Tab, label: string, icon: string): string {
  return `<button type="button" data-tab="${id}" class="${tab === id ? 'active' : ''}">
    ${icon}<span>${label}</span>
  </button>`;
}

function updateChrome(): void {
  const shell = app.querySelector('.app-shell');
  if (!shell) return;
  const wantMini = wantsMini();
  const wantBar = wantsDesktopBar();
  const wantHeader = wantsHeaderPlayer();
  const mini = app.querySelector('#mini');
  const bar = app.querySelector('#nowBar');
  const header = document.querySelector('#headerPlayer');
  if (wantMini !== Boolean(mini) || wantBar !== Boolean(bar) || wantHeader !== Boolean(header)) {
    renderApp();
    return;
  }
  shell.classList.toggle('no-mini', !wantMini);
  shell.classList.toggle('has-bar', wantBar);
  if (wantMini) paintMini();
  if (wantBar) paintDesktopBar();
  if (wantHeader) paintHeaderPlayer();
  if (tab === 'now') {
    const main = app.querySelector('#main');
    if (main) renderNow(main);
  }
}

function headerPlayerSlot(): string {
  if (!wantsHeaderPlayer()) return '';
  return `<div class="header-player" id="headerPlayer" aria-label="Now Playing"></div>`;
}

function renderLibrary(main: Element): void {
  const inFolder = libraryScope === 'folders' && Boolean(folderPath);
  const inAlbum = libraryScope === 'albums' && Boolean(albumDrill);
  const inArtist = libraryScope === 'artists' && Boolean(artistDrill);
  const drilled = inFolder || inAlbum || inArtist;

  let title = 'Library';
  let backLabel = '';
  if (inFolder) {
    title = folderPath!.split(/[/\\]/).filter(Boolean).pop() ?? 'Folders';
    backLabel = '‹ Folders';
  } else if (inAlbum && albumDrill) {
    title = albumDrill.title;
    backLabel = '‹ Albums';
  } else if (inArtist && artistDrill) {
    title = artistDrill;
    backLabel = '‹ Artists';
  }

  main.innerHTML = `
    ${
      drilled
        ? `<div class="nav-row">
            <button type="button" class="nav-link" id="backBtn">${backLabel}</button>
            <button type="button" class="nav-link accent" id="playDrill" ${items.length ? '' : 'disabled'}>Play</button>
          </div>`
        : ''
    }
    <div class="page-header">
      <h1 class="large-title">${esc(title)}</h1>
      ${headerPlayerSlot()}
    </div>
    ${
      inAlbum && albumDrill
        ? `<p class="drill-sub">${esc(albumDrill.artist)}</p>`
        : ''
    }
    ${
      drilled
        ? ''
        : `<div class="segmented">
      <button type="button" data-scope="albums" class="${libraryScope === 'albums' ? 'active' : ''}">Albums</button>
      <button type="button" data-scope="artists" class="${libraryScope === 'artists' ? 'active' : ''}">Artists</button>
      <button type="button" data-scope="folders" class="${libraryScope === 'folders' ? 'active' : ''}">Folders</button>
    </div>
    <div class="search-wrap">
      ${icons.search}
      <input id="search" type="search" enterkeyhint="search" placeholder="Songs, albums, artists"
        value="${esc(searchQuery)}" />
    </div>`
    }
    <div id="list" class="group"></div>
  `;

  main.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      libraryScope = (btn as HTMLElement).dataset.scope as LibraryScope;
      clearLibraryDrill();
      searchQuery = '';
      await loadLibrary();
      renderApp();
    });
  });
  main.querySelector('#backBtn')?.addEventListener('click', async () => {
    if (inFolder) {
      folderPath = folderStack.pop() ?? null;
    } else if (inAlbum) {
      albumDrill = null;
    } else if (inArtist) {
      artistDrill = null;
    }
    searchQuery = '';
    await loadLibrary();
    renderApp();
  });
  main.querySelector('#playDrill')?.addEventListener('click', () => {
    if (inAlbum && albumDrill) void playNow({ albumId: albumDrill.id });
    else if (inArtist && artistDrill) void playNow({ artist: artistDrill });
    else if (inFolder && folderPath) void playNow({ folder: folderPath });
  });
  const search = main.querySelector<HTMLInputElement>('#search');
  if (search) {
    let debounce: number | undefined;
    search.addEventListener('input', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(async () => {
        searchQuery = search.value;
        clearLibraryDrill();
        await loadLibrary();
        paintMediaList(main.querySelector('#list')!);
      }, 220);
    });
  }
  paintMediaList(main.querySelector('#list')!);
  if (wantsHeaderPlayer()) paintHeaderPlayer();
}

async function renderCollections(main: Element): Promise<void> {
  await refreshCaches();
  if (collectionKind && collectionId) {
    await loadCollectionTracks();
    renderCollectionDetail(main);
    return;
  }

  main.innerHTML = `
    <div class="nav-row">
      <span></span>
      <button type="button" class="nav-link accent" id="newPlaylist">New Playlist</button>
    </div>
    <div class="page-header">
      <h1 class="large-title">Playlists</h1>
      ${headerPlayerSlot()}
    </div>
    <p class="group-label">Playlists</p>
    <div class="group" id="plList"></div>
    <p class="group-label">Labels</p>
    <div class="group" id="lbList"></div>
  `;

  main.querySelector('#newPlaylist')?.addEventListener('click', () => createPlaylist());

  const plList = main.querySelector('#plList')!;
  if (!playlistCache.length) {
    plList.innerHTML = `<div class="empty"><strong>No Playlists</strong>Collect albums, artists, or songs for later.</div>`;
  } else {
    for (const p of playlistCache) {
      plList.appendChild(
        collectionRow('playlist', p.id, p.name, Number(p.trackCount ?? 0), () =>
          openPlaylistManage(p.id, p.name)
        )
      );
    }
  }

  const lbList = main.querySelector('#lbList')!;
  if (!labelCache.length) {
    lbList.innerHTML = `<div class="empty"><strong>No Labels</strong>Tag music with Add → Labels on any item.</div>`;
  } else {
    for (const l of labelCache) {
      lbList.appendChild(
        collectionRow('label', l.name, l.name, Number(l.trackCount ?? 0), () =>
          openLabelManage(l.name)
        )
      );
    }
  }
  if (wantsHeaderPlayer()) paintHeaderPlayer();
}

function collectionRow(
  kind: 'playlist' | 'label',
  id: string,
  name: string,
  count: number,
  onMore: () => void
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'row-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row has-icon';
  btn.innerHTML = rowHtml(
    kind,
    name,
    count === 0 ? 'Empty' : `${count} song${count === 1 ? '' : 's'}`,
    true
  );
  btn.addEventListener('click', async () => {
    collectionKind = kind;
    collectionId = id;
    collectionTitle = name;
    await loadCollectionTracks();
    renderApp();
  });
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'row-more';
  more.setAttribute('aria-label', 'More');
  more.innerHTML = `<span class="more-glyph">···</span>`;
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    onMore();
  });
  wrap.append(btn, more);
  return wrap;
}

function renderCollectionDetail(main: Element): void {
  const title = collectionTitle ?? 'Collection';
  const count = items.length;
  const firstArt = (() => {
    for (const raw of items) {
      const t = raw as Record<string, unknown>;
      if (t.artworkHash) return String(t.artworkHash);
    }
    return null;
  })();
  main.innerHTML = `
    <div class="nav-row">
      <button type="button" class="nav-link" id="backBtn">‹ Playlists</button>
      ${headerPlayerSlot()}
      ${
        collectionKind === 'playlist' || collectionKind === 'label'
          ? `<button type="button" class="nav-link" id="manageBtn" aria-label="Options">Edit</button>`
          : '<span></span>'
      }
    </div>
    <header class="collection-hero">
      <div class="collection-mosaic ${collectionKind ?? ''} ${firstArt ? 'has-art' : ''}" aria-hidden="true">
        ${firstArt ? coverHtml(firstArt, title) : `<span>${esc((title[0] ?? 'P').toUpperCase())}</span>`}
      </div>
      <div class="collection-hero-text">
        <p class="collection-kind">${collectionKind === 'label' ? 'Label' : 'Playlist'}</p>
        <h1 class="collection-title">${esc(title)}</h1>
        <p class="collection-meta">${count === 0 ? 'No songs' : `${count} song${count === 1 ? '' : 's'}`}</p>
        <div class="collection-actions ${collectionKind === 'playlist' ? '' : 'single'}">
          <button type="button" class="pill-btn primary" id="playAll" ${count ? '' : 'disabled'}>${icons.playSm}<span>Play</span></button>
          ${
            collectionKind === 'playlist'
              ? `<button type="button" class="pill-btn" id="addMusic"><span aria-hidden="true">+</span><span>Add Music</span></button>`
              : ''
          }
        </div>
      </div>
    </header>
    <div class="group" id="list"></div>
  `;

  main.querySelector('#backBtn')?.addEventListener('click', () => {
    collectionKind = null;
    collectionId = null;
    collectionTitle = null;
    renderApp();
  });
  main.querySelector('#manageBtn')?.addEventListener('click', () => {
    if (collectionKind === 'playlist' && collectionId) openPlaylistManage(collectionId, title);
    if (collectionKind === 'label' && collectionId) openLabelManage(collectionId);
  });
  main.querySelector('#playAll')?.addEventListener('click', () => {
    if (collectionKind === 'playlist' && collectionId) void playNow({ playlistId: collectionId });
    if (collectionKind === 'label' && collectionId) void playNow({ label: collectionId });
  });
  main.querySelector('#addMusic')?.addEventListener('click', () => {
    tab = 'library';
    renderApp();
    showToast('Pick music in Library, then use Add');
  });
  hydrateCovers(main);
  paintMediaList(main.querySelector('#list')!, true);
  if (wantsHeaderPlayer()) paintHeaderPlayer();
}

function paintMediaList(list: Element, inCollection = false): void {
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = inCollection
      ? `<div class="empty"><strong>This Collection Is Empty</strong>Add music from your Library.</div>`
      : `<div class="empty"><strong>No Music</strong>Add a folder in Settings → Sources.</div>`;
    return;
  }

  const listingAlbums =
    tab === 'library' &&
    libraryScope === 'albums' &&
    !albumDrill &&
    !searchQuery.trim();
  const listingArtists =
    tab === 'library' &&
    libraryScope === 'artists' &&
    !artistDrill &&
    !searchQuery.trim();

  for (const raw of items) {
    const item = raw as Record<string, unknown>;

    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row has-icon';
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'row-more';
    more.innerHTML = `<span class="more-glyph">···</span>`;
    more.setAttribute('aria-label', 'Actions');

    let selection: Selection | null = null;
    let primary: (() => Promise<void>) | null = null;

    if (
      listingAlbums &&
      item.title &&
      item.artist &&
      item.id &&
      !item.cataloguePath
    ) {
      const title = String(item.title);
      const artist = String(item.artist);
      const id = String(item.id);
      const hash = item.artworkHash ? String(item.artworkHash) : null;
      const count = Number(item.trackCount ?? 0);
      btn.innerHTML = rowHtml(
        'album',
        title,
        count ? `${artist} · ${count} songs` : artist,
        true,
        hash,
        true
      );
      selection = { albumId: id, title };
      primary = async () => {
        albumDrill = { id, title, artist };
        searchQuery = '';
        await loadLibrary();
        renderApp();
      };
    } else if (
      listingArtists &&
      item.name &&
      !item.cataloguePath
    ) {
      const name = String(item.name);
      btn.innerHTML = rowHtml(
        'artist',
        name,
        `${item.trackCount ?? 0} song${Number(item.trackCount) === 1 ? '' : 's'}`,
        true
      );
      selection = { artist: name, title: name };
      primary = async () => {
        artistDrill = name;
        searchQuery = '';
        await loadLibrary();
        renderApp();
      };
    } else if (
      searchQuery &&
      item.title &&
      item.artist &&
      item.id &&
      !item.cataloguePath &&
      tab === 'library'
    ) {
      // Search hit that looks like an album row (rare) — open it.
      const hash = item.artworkHash ? String(item.artworkHash) : null;
      btn.innerHTML = rowHtml('album', String(item.title), String(item.artist), true, hash, true);
      selection = { albumId: String(item.id), title: String(item.title) };
      primary = async () => {
        albumDrill = {
          id: String(item.id),
          title: String(item.title),
          artist: String(item.artist),
        };
        searchQuery = '';
        libraryScope = 'albums';
        await loadLibrary();
        renderApp();
      };
    } else if (item.isDirectory) {
      btn.innerHTML = rowHtml('folder', String(item.name), 'Folder', true);
      selection = { folder: String(item.path), title: String(item.name) };
      primary = async () => {
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.path);
        searchQuery = '';
        await loadLibrary();
        renderApp();
      };
    } else if (item.cataloguePath || item.track || item.title) {
      const nested = item.track as Record<string, unknown> | null | undefined;
      const track = nested && typeof nested === 'object' ? nested : item;
      const path = String(track.cataloguePath ?? item.path ?? '');
      if (!path) continue;
      const labels = Array.isArray(track.labels)
        ? (track.labels as string[]).slice(0, 2).join(' · ')
        : '';
      const hash = track.artworkHash ? String(track.artworkHash) : null;
      const isNow = isNowPlayingPath(path);
      // Folder browse may send a formatted name ("01 Title" / multi-disc prefix).
      const title = String(item.name || track.title || 'Track');
      btn.innerHTML = rowHtml(
        'track',
        title,
        labels ? `${track.artist ?? ''} · ${labels}` : String(track.artist ?? ''),
        false,
        hash,
        false,
        isNow
      );
      wrap.dataset.path = path;
      if (isNow) {
        wrap.classList.add('playing');
        btn.classList.add('playing');
      }
      selection = {
        cataloguePath: path,
        title: String(track.title ?? item.name ?? 'Track'),
      };
      primary = async () => {
        // Queue the browse context so next/prev advance through album / artist / folder / collection.
        const body: Record<string, unknown> = { cataloguePath: path };
        if (inCollection && collectionKind === 'playlist' && collectionId) {
          body.playlistId = collectionId;
        } else if (inCollection && collectionKind === 'label' && collectionId) {
          body.label = collectionId;
        } else if (tab === 'library' && libraryScope === 'albums' && albumDrill) {
          body.albumId = albumDrill.id;
        } else if (tab === 'library' && libraryScope === 'artists' && artistDrill) {
          body.artist = artistDrill;
        } else if (tab === 'library' && libraryScope === 'folders' && folderPath) {
          body.folder = folderPath;
        }
        await playNow(body);
      };
    } else {
      continue;
    }

    btn.addEventListener('click', () => {
      if (primary) void primary();
    });
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selection) openOrganize(selection);
    });
    btn.addEventListener('contextmenu', (e) => {
      if (!selection) return;
      e.preventDefault();
      openOrganize(selection);
    });

    wrap.append(btn, more);
    list.appendChild(wrap);
  }

  hydrateCovers(list);
  markNowPlayingRows();
}

function nowPlayingPath(): string | null {
  const track = nowPlaying?.track as Record<string, unknown> | null | undefined;
  if (!track?.cataloguePath) return null;
  return String(track.cataloguePath);
}

function isNowPlayingPath(path: string): boolean {
  const cur = nowPlayingPath();
  return Boolean(cur && path && cur === path);
}

/** Highlight the playing track and show a speaker glyph (list may already be painted). */
function markNowPlayingRows(): void {
  const cur = nowPlayingPath();
  document.querySelectorAll<HTMLElement>('.row-wrap[data-path]').forEach((wrap) => {
    const path = wrap.dataset.path ?? '';
    const on = Boolean(cur && path === cur);
    wrap.classList.toggle('playing', on);
    const row = wrap.querySelector('.row');
    row?.classList.toggle('playing', on);
    const trail = wrap.querySelector('.row-trail');
    if (!trail) return;
    if (on) {
      trail.innerHTML = `<span class="playing-glyph" aria-label="Now playing">${icons.speaker}</span>`;
      trail.classList.add('playing');
    } else if (trail.classList.contains('playing')) {
      trail.innerHTML = '';
      trail.classList.remove('playing');
    }
  });
}

function coverHtml(hash: string | null | undefined, title: string): string {
  const initial = (title.trim()[0] ?? '•').toUpperCase();
  const url = artworkUrl(hash);
  if (url) {
    return `<img class="cover-img" src="${escAttr(url)}" alt="" loading="lazy" decoding="async" data-cover="${escAttr(String(hash))}" />`;
  }
  return `<span class="cover-fallback">${esc(initial)}</span>`;
}

function hydrateCovers(root: Element): void {
  root.querySelectorAll<HTMLImageElement>('img.cover-img').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const hash = img.dataset.cover;
        if (!hash) {
          img.replaceWith(fallbackSpan(img.alt || '•'));
          return;
        }
        // Retry via Authorization header (blob) if query-token load failed.
        void artworkObjectUrl(hash)
          .then((url) => {
            img.src = url;
          })
          .catch(() => {
            img.replaceWith(fallbackSpan(img.alt || '•'));
          });
      },
      { once: true }
    );
  });
}

function fallbackSpan(title: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cover-fallback';
  span.textContent = (title.trim()[0] ?? '•').toUpperCase();
  return span;
}

function rowHtml(
  kind: string,
  title: string,
  sub: string,
  chevron: boolean,
  artworkHash?: string | null,
  tinyThumb = false,
  nowPlayingRow = false
): string {
  const initial = (title.trim()[0] ?? '•').toUpperCase();
  const url = artworkUrl(artworkHash);
  const thumbClass = tinyThumb ? ' thumb' : '';
  const icon = url
    ? `<div class="row-icon ${kind}${thumbClass} has-art"><img class="cover-img" src="${escAttr(url)}" alt="" loading="lazy" decoding="async" data-cover="${escAttr(String(artworkHash))}" /></div>`
    : `<div class="row-icon ${kind}${thumbClass}">${esc(initial)}</div>`;
  let trail = `<span class="row-trail"></span>`;
  if (nowPlayingRow) {
    trail = `<span class="row-trail playing"><span class="playing-glyph" aria-label="Now playing">${icons.speaker}</span></span>`;
  } else if (chevron) {
    trail = `<span class="row-trail chevron">${icons.chevron}</span>`;
  }
  return `
    ${icon}
    <div class="row-text">
      <div class="row-title">${esc(title)}</div>
      <div class="row-sub">${esc(sub)}</div>
    </div>
    ${trail}
  `;
}

async function playNow(body: Record<string, unknown>): Promise<void> {
  haptic('medium');
  closeOverlay();
  const hadTrack = hasNowTrack();
  await api('/api/v1/play', { method: 'POST', body });
  nowPlaying = await api('/api/v1/now-playing');
  playing = nowPlaying?.state === 'playing';
  localPos = Number(nowPlaying?.positionSecs ?? 0);
  // Stay on Library / Playlists — never jump to Now Playing.
  if (
    !hadTrack ||
    wantsDesktopBar() !== Boolean(document.querySelector('#nowBar')) ||
    wantsHeaderPlayer() !== Boolean(document.querySelector('#headerPlayer'))
  ) {
    renderApp();
    return;
  }
  if (wantsDesktopBar()) paintDesktopBar();
  if (wantsHeaderPlayer()) paintHeaderPlayer();
  if (wantsMini()) paintMini();
  paintScrub();
  markNowPlayingRows();
}

function selectionBody(sel: Selection): Record<string, unknown> {
  return {
    cataloguePath: sel.cataloguePath,
    albumId: sel.albumId,
    artist: sel.artist,
    folder: sel.folder,
  };
}

function createPlaylist(): void {
  openNameDialog({
    title: 'New Playlist',
    placeholder: 'Name',
    confirmLabel: 'Create',
    onConfirm: async (name) => {
      const created = await api<{ id: string; name: string }>('/api/v1/playlists', {
        method: 'POST',
        body: { name },
      });
      showToast(`Created “${name}”`);
      haptic();
      await refreshCaches();
      tab = 'collections';
      collectionKind = 'playlist';
      collectionId = created.id;
      collectionTitle = created.name;
      await loadCollectionTracks();
      renderApp();
    },
  });
}

function openOrganize(sel: Selection): void {
  const groups: Array<Array<{ label: string; danger?: boolean; run: () => Promise<void> }>> = [
    [
      {
        label: 'Play',
        run: async () => playNow(selectionBody(sel)),
      },
    ],
    [
      {
        label: 'Add to Playlist…',
        run: async () => openPlaylistPicker(sel),
      },
      {
        label: 'Labels…',
        run: async () => openLabelEditor(sel),
      },
    ],
  ];
  if (collectionKind === 'playlist' && collectionId && sel.cataloguePath) {
    groups.push([
      {
        label: 'Remove from Playlist',
        danger: true,
        run: async () => {
          const path = sel.cataloguePath!;
          const id = collectionId!;
          await api(`/api/v1/playlists/${encodeURIComponent(id)}/items`, {
            method: 'DELETE',
            body: { cataloguePath: path },
          });
          showToast('Removed', {
            undo: async () => {
              await api(`/api/v1/playlists/${encodeURIComponent(id)}/items`, {
                method: 'POST',
                body: { cataloguePath: path },
              });
              await loadCollectionTracks();
              renderApp();
            },
          });
          await loadCollectionTracks();
          renderApp();
        },
      },
    ]);
  }
  if (collectionKind === 'label' && collectionId && sel.cataloguePath) {
    const label = collectionId;
    groups.push([
      {
        label: `Remove Label “${label}”`,
        danger: true,
        run: async () => {
          const path = sel.cataloguePath!;
          await api('/api/v1/labels/remove-items', {
            method: 'POST',
            body: { name: label, cataloguePath: path },
          });
          showToast('Label removed', {
            undo: async () => {
              await api('/api/v1/labels/items', {
                method: 'POST',
                body: { name: label, cataloguePath: path },
              });
              await loadCollectionTracks();
              renderApp();
            },
          });
          await loadCollectionTracks();
          renderApp();
        },
      },
    ]);
  }
  openActionMenu({ title: sel.title, subtitle: 'Play or organize', groups });
}

async function openPlaylistPicker(sel: Selection): Promise<void> {
  await refreshCaches();
  const rows = playlistCache
    .map(
      (p) => `
      <button type="button" class="picker-row" data-id="${escAttr(p.id)}">
        <span class="row-icon playlist">${esc((p.name[0] ?? 'P').toUpperCase())}</span>
        <span class="picker-text"><strong>${esc(p.name)}</strong></span>
        <span class="picker-add">Add</span>
      </button>`
    )
    .join('');

  openPanel({
    title: 'Add to Playlist',
    subtitle: sel.title,
    bodyHtml: `
      <div class="ah-group">
        <button type="button" class="picker-row create" id="pickerNewPl">
          <span class="row-icon create" aria-hidden="true">+</span>
          <span class="picker-text"><strong>New Playlist…</strong><span>Create and add</span></span>
        </button>
      </div>
      ${
        rows
          ? `<p class="ah-section">Playlists</p><div class="ah-group picker-list">${rows}</div>`
          : `<p class="picker-empty">No playlists yet.</p>`
      }
    `,
    bind: (root, close) => {
      root.querySelector('#pickerNewPl')?.addEventListener('click', () => {
        close();
        openNameDialog({
          title: 'New Playlist',
          placeholder: 'Name',
          initial: sel.title,
          confirmLabel: 'Create',
          onConfirm: async (name) => {
            const created = await api<{ id: string }>('/api/v1/playlists', {
              method: 'POST',
              body: { name },
            });
            await api(`/api/v1/playlists/${encodeURIComponent(created.id)}/items`, {
              method: 'POST',
              body: selectionBody(sel),
            });
            showToast(`Added to new playlist “${name}”`);
            haptic();
            await refreshCaches();
          },
        });
      });
      root.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
        el.addEventListener('click', async () => {
          const id = el.dataset.id!;
          const name = playlistCache.find((p) => p.id === id)?.name ?? 'playlist';
          try {
            await api(`/api/v1/playlists/${encodeURIComponent(id)}/items`, {
              method: 'POST',
              body: selectionBody(sel),
            });
            close();
            showToast(`Added to “${name}”`, {
              undo: async () => {
                if (sel.cataloguePath) {
                  await api(`/api/v1/playlists/${encodeURIComponent(id)}/items`, {
                    method: 'DELETE',
                    body: { cataloguePath: sel.cataloguePath },
                  });
                }
              },
            });
            haptic();
            await refreshCaches();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed', { error: true });
          }
        });
      });
    },
  });
}

function hasLabelSelection(sel: Selection): boolean {
  return Boolean(sel.cataloguePath || sel.albumId || sel.artist || sel.folder);
}

async function openLabelEditor(sel: Selection): Promise<void> {
  if (!hasLabelSelection(sel)) {
    showToast('Cannot label this item', { error: true });
    return;
  }
  await refreshCaches();
  let current: string[] = [];
  if (sel.cataloguePath) {
    try {
      const opt = await api<{ trackLabels: string[] }>(
        `/api/v1/track-options?path=${encodeURIComponent(sel.cataloguePath)}`
      );
      current = opt.trackLabels ?? [];
    } catch {
      current = [];
    }
  }
  let known = [...new Set([...labelCache.map((l) => l.name), ...current])].sort((a, b) =>
    a.localeCompare(b)
  );

  const renderChips = () =>
    current
      .map(
        (n) =>
          `<button type="button" class="chip on" data-remove="${escAttr(n)}">${esc(n)} <span aria-hidden="true">×</span></button>`
      )
      .join('');

  const renderKnown = () =>
    known
      .filter((n) => !current.includes(n))
      .map((n) => `<button type="button" class="chip" data-add="${escAttr(n)}">${esc(n)}</button>`)
      .join('');

  let addFn: ((name: string) => Promise<boolean>) | null = null;

  openPanel({
    title: 'Labels',
    subtitle: sel.title,
    primaryLabel: 'Done',
    onPrimary: async () => {
      const input = document.querySelector<HTMLInputElement>('#labelInput');
      const pending = input?.value.trim() ?? '';
      if (pending && addFn) {
        const ok = await addFn(pending);
        if (!ok) return;
      }
      closeOverlay();
    },
    bodyHtml: `
      <form class="ah-form label-add-form" id="labelForm">
        <input class="ah-input" id="labelInput" type="text" placeholder="New label" enterkeyhint="done" autocomplete="off" aria-label="New label" />
        <button type="submit" class="ah-add-btn" id="labelAddBtn">Add</button>
      </form>
      <p class="ah-section">On This Item</p>
      <div class="chip-row" id="currentChips">${renderChips() || `<span class="picker-empty">No labels on this item yet.</span>`}</div>
      <p class="ah-section">Suggestions</p>
      <div class="chip-row" id="knownChips">${renderKnown() || `<span class="picker-empty">Type a new label above.</span>`}</div>
    `,
    bind: (root) => {
      const input = root.querySelector<HTMLInputElement>('#labelInput')!;
      const refreshUi = () => {
        const cur = root.querySelector('#currentChips');
        const kn = root.querySelector('#knownChips');
        if (cur)
          cur.innerHTML =
            renderChips() || `<span class="picker-empty">No labels on this item yet.</span>`;
        if (kn)
          kn.innerHTML =
            renderKnown() || `<span class="picker-empty">Type a new label above.</span>`;
        bindChips();
      };
      const add = async (name: string): Promise<boolean> => {
        const trimmed = name.trim();
        if (!trimmed) {
          input.focus();
          return false;
        }
        try {
          await api('/api/v1/labels/items', {
            method: 'POST',
            body: { name: trimmed, ...selectionBody(sel) },
          });
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Could not add label', { error: true });
          return false;
        }
        if (!current.includes(trimmed)) current.push(trimmed);
        if (!known.includes(trimmed)) {
          known = [...known, trimmed].sort((a, b) => a.localeCompare(b));
        }
        input.value = '';
        showToast(`Labeled “${trimmed}”`);
        haptic();
        await refreshCaches();
        refreshUi();
        return true;
      };
      addFn = add;
      const remove = async (name: string) => {
        try {
          await api('/api/v1/labels/remove-items', {
            method: 'POST',
            body: {
              name,
              ...selectionBody(sel),
            },
          });
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Could not remove label', { error: true });
          return;
        }
        current = current.filter((n) => n !== name);
        showToast('Label removed');
        await refreshCaches();
        refreshUi();
      };
      const bindChips = () => {
        root.querySelectorAll<HTMLElement>('[data-add]').forEach((el) => {
          el.addEventListener('click', () => void add(el.dataset.add ?? ''));
        });
        root.querySelectorAll<HTMLElement>('[data-remove]').forEach((el) => {
          el.addEventListener('click', () => void remove(el.dataset.remove ?? ''));
        });
      };
      root.querySelector('#labelForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        void add(input.value);
      });
      bindChips();
      queueMicrotask(() => input.focus());
    },
  });
}

function openPlaylistManage(id: string, name: string): void {
  openActionMenu({
    title: name,
    subtitle: 'Playlist',
    groups: [
      [
        { label: 'Play', run: async () => playNow({ playlistId: id }) },
        {
          label: 'Open',
          run: async () => {
            tab = 'collections';
            collectionKind = 'playlist';
            collectionId = id;
            collectionTitle = name;
            await loadCollectionTracks();
            renderApp();
          },
        },
      ],
      [
        {
          label: 'Rename…',
          run: async () => {
            openNameDialog({
              title: 'Rename Playlist',
              initial: name,
              confirmLabel: 'Save',
              onConfirm: async (next) => {
                await api(`/api/v1/playlists/${encodeURIComponent(id)}`, {
                  method: 'PATCH',
                  body: { name: next },
                });
                if (collectionId === id) collectionTitle = next;
                showToast('Playlist renamed');
                await refreshCaches();
                renderApp();
              },
            });
          },
        },
      ],
      [
        {
          label: 'Delete Playlist…',
          danger: true,
          run: async () => {
            openConfirmDialog({
              title: `Delete “${name}”?`,
              message: 'Songs stay in your library.',
              confirmLabel: 'Delete Playlist',
              onConfirm: async () => {
                await api(`/api/v1/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
                if (collectionId === id) {
                  collectionId = null;
                  collectionKind = null;
                }
                showToast('Playlist deleted');
                await refreshCaches();
                renderApp();
              },
            });
          },
        },
      ],
    ],
  });
}

function openLabelManage(name: string): void {
  openActionMenu({
    title: name,
    subtitle: 'Label',
    groups: [
      [
        { label: 'Play', run: async () => playNow({ label: name }) },
        {
          label: 'Open',
          run: async () => {
            tab = 'collections';
            collectionKind = 'label';
            collectionId = name;
            collectionTitle = name;
            await loadCollectionTracks();
            renderApp();
          },
        },
      ],
      [
        {
          label: 'Rename…',
          run: async () => {
            openNameDialog({
              title: 'Rename Label',
              initial: name,
              confirmLabel: 'Save',
              onConfirm: async (next) => {
                await api(`/api/v1/labels/${encodeURIComponent(name)}`, {
                  method: 'PATCH',
                  body: { name: next },
                });
                if (collectionKind === 'label' && collectionId === name) {
                  collectionId = next;
                  collectionTitle = next;
                }
                showToast('Label renamed');
                await refreshCaches();
                renderApp();
              },
            });
          },
        },
      ],
      [
        {
          label: 'Delete Label…',
          danger: true,
          run: async () => {
            openConfirmDialog({
              title: `Delete “${name}”?`,
              message: 'Removes this label from all songs. Songs stay in your library.',
              confirmLabel: 'Delete Label',
              onConfirm: async () => {
                await api(`/api/v1/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
                if (collectionKind === 'label' && collectionId === name) {
                  collectionId = null;
                  collectionKind = null;
                  collectionTitle = null;
                }
                showToast('Label deleted');
                await refreshCaches();
                renderApp();
              },
            });
          },
        },
      ],
    ],
  });
}

async function renderSettings(main: Element): Promise<void> {
  main.innerHTML = `
    <h1 class="large-title">Settings</h1>
    <div class="segmented">
      <button type="button" data-pane="sources" class="${settingsPane === 'sources' ? 'active' : ''}">Sources</button>
      <button type="button" data-pane="output" class="${settingsPane === 'output' ? 'active' : ''}">Output</button>
    </div>
    <div id="settingsBody"></div>
  `;
  main.querySelectorAll('[data-pane]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      settingsPane = (btn as HTMLElement).dataset.pane as 'sources' | 'output';
      await renderSettings(main);
    });
  });
  const body = main.querySelector('#settingsBody')!;
  if (settingsPane === 'sources') await renderMounts(body);
  else await renderOutput(body);
}

function bindPlayerControls(root: Element): void {
  root.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      haptic('medium');
      const command = (btn as HTMLElement).dataset.cmd!;
      nowPlaying = await api('/api/v1/transport', { method: 'POST', body: { command } });
      playing = nowPlaying?.state === 'playing';
      localPos = Number(nowPlaying?.positionSecs ?? localPos);
      updateNowChrome();
      paintScrub();
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[data-vol]').forEach((vol) => {
    vol.addEventListener('input', async () => {
      const level = Number(vol.value);
      nowPlaying = await api('/api/v1/transport', {
        method: 'POST',
        body: { command: 'setVolume', level },
      });
    });
  });

  root.querySelectorAll<HTMLInputElement>('input[data-seek]').forEach((seek) => {
    seek.addEventListener('pointerdown', () => {
      scrubbing = true;
    });
    seek.addEventListener('input', () => {
      localPos = Number(seek.value);
      document.querySelectorAll('[data-time-pos]').forEach((el) => {
        el.textContent = fmtTime(localPos);
      });
    });
    const commitSeek = async () => {
      const seconds = Number(seek.value ?? 0);
      localPos = seconds;
      scrubbing = false;
      nowPlaying = await api('/api/v1/transport', {
        method: 'POST',
        body: { command: 'seek', seconds },
      });
      playing = nowPlaying?.state === 'playing';
      localPos = Number(nowPlaying?.positionSecs ?? seconds);
      paintScrub();
    };
    seek.addEventListener('pointerup', () => void commitSeek());
    seek.addEventListener('change', () => void commitSeek());
  });
}

function fillArtwork(slot: Element | null, hash: string | null | undefined): void {
  if (!slot || !hash) return;
  const url = artworkUrl(hash);
  if (url) {
    slot.innerHTML = `<img class="cover-img" src="${escAttr(url)}" alt="" data-cover="${escAttr(hash)}" />`;
    hydrateCovers(slot);
  } else {
    void artworkObjectUrl(hash)
      .then((blobUrl) => {
        slot.innerHTML = `<img src="${blobUrl}" alt="" />`;
      })
      .catch(() => undefined);
  }
}

function renderNow(main: Element): void {
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  const badge = nowPlaying?.conversionBadge
    ? `<span class="now-badge">${esc(String(nowPlaying.conversionBadge))}</span>`
    : '';
  const dur = Number(nowPlaying?.durationSecs ?? 0) || 0;
  localPos = Number(nowPlaying?.positionSecs ?? localPos);
  main.innerHTML = `
    <section class="now-screen">
      <div class="artwork" id="artSlot">${icons.music}</div>
      <div class="now-meta">
        <h2 class="now-title">${esc(String(track?.title ?? 'Not Playing'))}</h2>
        <p class="now-artist">${esc(String(track?.artist ?? 'Choose something from Library'))}</p>
        ${badge}
      </div>
      <div class="scrub">
        <input data-seek type="range" min="0" max="${Math.max(dur, 1)}" step="0.1" value="${localPos}" ${track ? '' : 'disabled'} />
        <div class="time-row"><span data-time-pos>${fmtTime(localPos)}</span><span data-time-end>${dur ? fmtTime(dur) : '--:--'}</span></div>
      </div>
      <div class="transport">
        <button type="button" class="icon-btn" data-cmd="previous" ${track ? '' : 'disabled'}>${icons.prev}</button>
        <button type="button" class="play-btn" data-cmd="toggle" ${track ? '' : 'disabled'}>
          ${playing ? icons.pause : icons.play}
        </button>
        <button type="button" class="icon-btn" data-cmd="next" ${track ? '' : 'disabled'}>${icons.next}</button>
      </div>
      <div class="volume-row">
        ${icons.volMin}
        <input data-vol type="range" min="0" max="1" step="0.01" value="${Number(nowPlaying?.volume ?? 0.8)}" />
        ${icons.volMax}
      </div>
    </section>
  `;

  fillArtwork(main.querySelector('#artSlot'), track?.artworkHash ? String(track.artworkHash) : null);
  bindPlayerControls(main);
}

function paintHeaderPlayer(): void {
  const el = document.querySelector('#headerPlayer');
  if (!el) return;
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  if (!track) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <button type="button" class="header-player-main" id="headerPlayerOpen" aria-label="Open Now Playing">
      <div class="header-player-art" id="headerArt">${icons.musicSm}</div>
      <span class="header-player-text">
        <strong class="now-title">${esc(String(track.title ?? ''))}</strong>
        <span class="now-artist">${esc(String(track.artist ?? ''))}</span>
      </span>
    </button>
    <div class="header-player-actions">
      <button type="button" data-cmd="previous" aria-label="Previous">${icons.prev}</button>
      <button type="button" class="play-btn" data-cmd="toggle" aria-label="${playing ? 'Pause' : 'Play'}">
        ${playing ? icons.pauseSm : icons.playSm}
      </button>
      <button type="button" data-cmd="next" aria-label="Next">${icons.next}</button>
    </div>
  `;
  fillArtwork(
    el.querySelector('#headerArt'),
    track.artworkHash ? String(track.artworkHash) : null
  );
  el.querySelector('#headerPlayerOpen')?.addEventListener('click', () => {
    haptic('light');
    tab = 'now';
    renderApp();
  });
  bindPlayerControls(el);
}

function paintDesktopBar(): void {
  const el = document.querySelector('#nowBar');
  if (!el) return;
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  if (!track) {
    el.innerHTML = '';
    return;
  }
  const dur = Number(nowPlaying?.durationSecs ?? 0) || 0;
  const badge = nowPlaying?.conversionBadge
    ? `<span class="now-bar-badge">${esc(String(nowPlaying.conversionBadge))}</span>`
    : '';
  el.innerHTML = `
    <button type="button" class="now-bar-track" id="nowBarOpen" aria-label="Open Now Playing">
      <div class="now-bar-art" id="nowBarArt">${icons.musicSm}</div>
      <span class="now-bar-text">
        <strong class="now-title">${esc(String(track.title ?? ''))}</strong>
        <span class="now-artist">${esc(String(track.artist ?? ''))}</span>
      </span>
    </button>
    <div class="now-bar-center">
      <div class="now-bar-transport">
        <button type="button" data-cmd="previous" aria-label="Previous">${icons.prev}</button>
        <button type="button" class="play-btn" data-cmd="toggle" aria-label="${playing ? 'Pause' : 'Play'}">
          ${playing ? icons.pause : icons.play}
        </button>
        <button type="button" data-cmd="next" aria-label="Next">${icons.next}</button>
      </div>
      <div class="now-bar-scrub">
        <span data-time-pos>${fmtTime(localPos)}</span>
        <input data-seek type="range" min="0" max="${Math.max(dur, 1)}" step="0.1" value="${localPos}" />
        <span data-time-end>${dur ? fmtTime(dur) : '--:--'}</span>
      </div>
    </div>
    <div class="now-bar-aside">
      ${badge}
      <div class="now-bar-vol">
        ${icons.volMin}
        <input data-vol type="range" min="0" max="1" step="0.01" value="${Number(nowPlaying?.volume ?? 0.8)}" aria-label="Volume" />
      </div>
    </div>
  `;
  fillArtwork(
    el.querySelector('#nowBarArt'),
    track.artworkHash ? String(track.artworkHash) : null
  );
  el.querySelector('#nowBarOpen')?.addEventListener('click', () => {
    haptic('light');
    tab = 'now';
    renderApp();
  });
  bindPlayerControls(el);
}

async function renderMounts(main: Element): Promise<void> {
  const mounts = (await api('/api/v1/mounts')) as Array<{ path: string; displayName: string }>;
  main.innerHTML = `
    <p class="group-label">On This Host</p>
    <div class="group" id="mountList"></div>
    <p class="group-label">Add Folder</p>
    <div class="group">
      <form id="addMount" class="cell form-cell">
        <input name="path" type="text" placeholder="/path/to/music" required autocomplete="off"
          autocapitalize="off" spellcheck="false" aria-label="Folder path" />
        <button class="btn-text" type="submit">Add</button>
      </form>
    </div>
    <div class="group">
      <button type="button" class="cell" id="rescan"><span>Update Library</span><span class="value">Rescan</span></button>
    </div>
    <p class="footer-note">Paths must exist on the host running Harbor.</p>
  `;

  const list = main.querySelector('#mountList')!;
  if (!mounts.length) {
    list.innerHTML = `<div class="empty compact"><strong>No Folders</strong>Add a music directory to get started.</div>`;
  }
  for (const m of mounts) {
    const row = document.createElement('div');
    row.className = 'cell';
    row.innerHTML = `
      <div class="row-text">
        <div class="row-title">${esc(m.displayName)}</div>
        <div class="row-sub">${esc(m.path)}</div>
      </div>
      <button type="button" class="btn-text danger" data-path="${escAttr(m.path)}">Remove</button>
    `;
    row.querySelector('button')!.addEventListener('click', async () => {
      await api('/api/v1/mounts', { method: 'DELETE', body: { path: m.path } });
      await renderMounts(main);
    });
    list.appendChild(row);
  }

  main.querySelector('#addMount')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    try {
      await api('/api/v1/mounts', { method: 'POST', body: { path: String(fd.get('path')) } });
      await renderMounts(main);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not add folder', { error: true });
    }
  });

  main.querySelector('#rescan')!.addEventListener('click', async () => {
    await api('/api/v1/library/rescan', { method: 'POST', body: {} });
    const btn = main.querySelector('#rescan .value');
    if (btn) btn.textContent = 'Done';
    window.setTimeout(() => {
      if (btn) btn.textContent = 'Rescan';
    }, 1200);
  });
}

async function renderOutput(main: Element): Promise<void> {
  const output = (await api('/api/v1/output')) as {
    devices: Array<{
      uid: string;
      name: string;
      isExternal: boolean;
      supportsExclusive: boolean;
      supportsDop: boolean;
    }>;
    selectedUid: string | null;
    requestedMode: string;
    effectiveMode: string;
    conversionBadge: string | null;
  };

  main.innerHTML = `
    <p class="group-label">Playback Destination</p>
    <div class="group">
      <div class="cell">
        <label for="device">Device</label>
        <select id="device">
          <option value="">System Default</option>
          ${output.devices
            .map(
              (d) =>
                `<option value="${escAttr(d.uid)}" ${output.selectedUid === d.uid ? 'selected' : ''}>${esc(d.name)}${d.isExternal ? ' · DAC' : ''}</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="cell">
        <label for="mode">Mode</label>
        <select id="mode">
          <option value="shared" ${output.requestedMode === 'shared' ? 'selected' : ''}>Shared</option>
          <option value="exclusive" ${output.requestedMode === 'exclusive' ? 'selected' : ''}>Exclusive</option>
          <option value="dop" ${output.requestedMode === 'dop' ? 'selected' : ''}>DoP</option>
        </select>
      </div>
    </div>
    <p class="group-label">Status</p>
    <div class="group">
      <div class="cell"><span>Effective</span><span class="value">${esc(output.effectiveMode)}</span></div>
      ${
        output.conversionBadge
          ? `<div class="cell"><span>Path</span><span class="value">${esc(output.conversionBadge)}</span></div>`
          : ''
      }
    </div>
    <div class="group">
      <button type="button" class="cell cell-action" id="apply">Apply Changes</button>
    </div>
    <p class="footer-note">Exclusive and DoP work best with backend native (Core Audio / ALSA / WASAPI).</p>
  `;

  main.querySelector('#apply')!.addEventListener('click', async () => {
    const deviceUid = (main.querySelector('#device') as HTMLSelectElement).value || null;
    const mode = (main.querySelector('#mode') as HTMLSelectElement).value;
    await api('/api/v1/output', { method: 'PUT', body: { deviceUid, mode } });
    showToast('Output updated');
    await renderOutput(main);
  });
}

function paintMini(): void {
  const mini = document.querySelector('#mini');
  if (!mini) return;
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  if (!track) return;
  const wide = mini.classList.contains('now-bar');
  mini.innerHTML = `
    <div class="mini-art" id="miniArt">${icons.musicSm}</div>
    <button type="button" class="mini-text" id="miniOpen" aria-label="Open Now Playing">
      <strong>${esc(String(track.title ?? ''))}</strong>
      <span>${esc(String(track.artist ?? ''))}</span>
    </button>
    <div class="mini-actions">
      ${wide ? `<button type="button" id="miniPrev" aria-label="Previous">${icons.prev}</button>` : ''}
      <button type="button" id="miniToggle" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? icons.pauseSm : icons.playSm}</button>
      <button type="button" id="miniNext" aria-label="Next">${icons.next}</button>
    </div>
  `;

  if (track.artworkHash) {
    const hash = String(track.artworkHash);
    const slot = mini.querySelector('#miniArt');
    const url = artworkUrl(hash);
    if (slot && url) {
      slot.innerHTML = `<img class="cover-img" src="${escAttr(url)}" alt="" data-cover="${escAttr(hash)}" />`;
      hydrateCovers(slot);
    }
  }

  mini.querySelector('#miniOpen')?.addEventListener('click', () => {
    haptic('light');
    tab = 'now';
    renderApp();
  });
  mini.querySelector('#miniToggle')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    haptic('medium');
    nowPlaying = await api('/api/v1/transport', { method: 'POST', body: { command: 'toggle' } });
    playing = nowPlaying?.state === 'playing';
    updateChrome();
  });
  for (const [sel, command] of [
    ['#miniNext', 'next'],
    ['#miniPrev', 'previous'],
  ] as const) {
    mini.querySelector(sel)?.addEventListener('click', async (e) => {
      e.stopPropagation();
      haptic('light');
      nowPlaying = await api('/api/v1/transport', { method: 'POST', body: { command } });
      playing = nowPlaying?.state === 'playing';
      updateChrome();
    });
  }
}

function fmtTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escAttr(s: string): string {
  return esc(s).replaceAll("'", '&#39;');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

window.addEventListener('resize', () => {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  const wantWide = isDesktopUi();
  if (shell.classList.contains('wide') !== wantWide) renderApp();
});

void boot();
