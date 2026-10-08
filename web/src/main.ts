import './styles.css';
import { api, artworkObjectUrl, getToken, setToken, connectWs, haptic } from './api';
import { icons } from './icons';

type Tab = 'browse' | 'now' | 'mounts' | 'output';
type BrowseScope = 'albums' | 'artists' | 'folders' | 'playlists' | 'labels';

type Selection = {
  cataloguePath?: string;
  albumId?: string;
  artist?: string;
  folder?: string;
  title: string;
};

const app = document.querySelector<HTMLDivElement>('#app')!;

let tab: Tab = 'browse';
let browseScope: BrowseScope = 'albums';
let folderPath: string | null = null;
let folderStack: string[] = [];
let nowPlaying: Record<string, unknown> | null = null;
let items: unknown[] = [];
let searchQuery = '';
let playing = false;
let scrubbing = false;
let localPos = 0;
let posTimer: number | undefined;
let lastTrackId: string | null = null;
let playlistCache: Array<{ id: string; name: string }> = [];

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
  const seek = document.querySelector<HTMLInputElement>('#seek');
  const times = document.querySelectorAll('.time-row span');
  if (!seek || scrubbing) return;
  seek.value = String(localPos);
  if (times[0]) times[0].textContent = fmtTime(localPos);
}

async function boot(): Promise<void> {
  if (!getToken()) {
    renderPairing();
    return;
  }
  connectWs((msg) => {
    if (msg.type === 'nowPlaying') {
      const prevId = lastTrackId;
      nowPlaying = msg.payload as Record<string, unknown>;
      playing = nowPlaying?.state === 'playing';
      const track = nowPlaying?.track as Record<string, unknown> | null;
      lastTrackId = track?.id ? String(track.id) : null;
      if (!scrubbing) localPos = Number(nowPlaying?.positionSecs ?? 0);
      if (tab === 'now') {
        // Full re-render only when track identity changes; else live-update chrome
        if (prevId !== lastTrackId) renderApp();
        else {
          updateNowChrome();
          paintScrub();
        }
      } else updateChrome();
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
  await loadBrowse();
  renderApp();
}

function updateNowChrome(): void {
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  const title = document.querySelector('.now-title');
  const artist = document.querySelector('.now-artist');
  const playBtn = document.querySelector('.play-btn');
  if (title) title.textContent = String(track?.title ?? 'Not Playing');
  if (artist) {
    artist.textContent = String(track?.artist ?? 'Choose something from Library');
  }
  if (playBtn) playBtn.innerHTML = playing ? icons.pause : icons.play;
  const seek = document.querySelector<HTMLInputElement>('#seek');
  const dur = Number(nowPlaying?.durationSecs ?? 0) || 0;
  if (seek && dur > 0) seek.max = String(dur);
  const end = document.querySelectorAll('.time-row span')[1];
  if (end) end.textContent = dur ? fmtTime(dur) : '--:--';
  paintMini();
}

function renderPairing(): void {
  app.innerHTML = `
    <main class="pair-screen">
      <div class="pair-card">
        <div class="pair-mark">AH</div>
        <h1>Audio Harbor</h1>
        <p>Enter the 6-digit PIN from the host to pair this iPhone.</p>
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
      pin.select();
    }
  };

  btn.addEventListener('click', () => void submit());
  pin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void submit();
  });
}

async function loadBrowse(): Promise<void> {
  if (searchQuery.trim()) {
    const res = await api<{ items: unknown[] }>(
      `/api/v1/search?q=${encodeURIComponent(searchQuery.trim())}`
    );
    items = res.items;
    return;
  }
  const pathQ = folderPath ? `&path=${encodeURIComponent(folderPath)}` : '';
  const res = await api<{ items: unknown[] }>(`/api/v1/browse?scope=${browseScope}${pathQ}`);
  items = res.items;
  if (browseScope === 'playlists' || browseScope === 'labels') {
    try {
      const pl = await api<{ playlists: Array<{ id: string; name: string }> }>('/api/v1/playlists');
      playlistCache = pl.playlists;
    } catch {
      /* ignore */
    }
  }
}

function renderApp(): void {
  const hasTrack = Boolean(nowPlaying?.track);
  app.innerHTML = `
    <div class="app-shell ${hasTrack ? '' : 'no-mini'}">
      <main class="screen" id="main"></main>
      ${hasTrack ? `<div class="mini-player" id="mini"></div>` : ''}
      <nav class="tab-bar" id="tabs">
        ${tabBtn('browse', 'Library', icons.browse)}
        ${tabBtn('now', 'Playing', icons.now)}
        ${tabBtn('mounts', 'Folders', icons.library)}
        ${tabBtn('output', 'Output', icons.output)}
      </nav>
    </div>
  `;

  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      haptic('light');
      tab = btn.dataset.tab as Tab;
      if (tab === 'browse') await loadBrowse();
      renderApp();
    });
  });

  const main = app.querySelector('#main')!;
  if (tab === 'browse') renderBrowse(main);
  if (tab === 'now') renderNow(main);
  if (tab === 'mounts') void renderMounts(main);
  if (tab === 'output') void renderOutput(main);
  if (hasTrack) paintMini();
}

function tabBtn(id: Tab, label: string, icon: string): string {
  return `<button type="button" data-tab="${id}" class="${tab === id ? 'active' : ''}">
    ${icon}<span>${label}</span>
  </button>`;
}

function updateChrome(): void {
  const shell = app.querySelector('.app-shell');
  if (!shell) return;
  const hasTrack = Boolean(nowPlaying?.track);
  shell.classList.toggle('no-mini', !hasTrack);
  let mini = app.querySelector('#mini');
  if (hasTrack && !mini) {
    mini = document.createElement('div');
    mini.className = 'mini-player';
    mini.id = 'mini';
    shell.insertBefore(mini, app.querySelector('#tabs'));
  }
  if (!hasTrack && mini) mini.remove();
  if (hasTrack) paintMini();
  if (tab === 'now') {
    const main = app.querySelector('#main');
    if (main) renderNow(main);
  }
}

function renderBrowse(main: Element): void {
  const inDetail = Boolean(folderPath);
  let title = 'Library';
  if (browseScope === 'folders' && folderPath) {
    title = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? 'Folders';
  } else if (browseScope === 'playlists' && folderPath) {
    title = 'Playlist';
  } else if (browseScope === 'labels' && folderPath) {
    title = folderPath;
  } else if (browseScope === 'playlists') title = 'Playlists';
  else if (browseScope === 'labels') title = 'Labels';

  const backLabel =
    browseScope === 'folders'
      ? 'Folders'
      : browseScope === 'playlists'
        ? 'Playlists'
        : browseScope === 'labels'
          ? 'Labels'
          : 'Back';

  main.innerHTML = `
    <div class="nav-row">
      ${
        inDetail
          ? `<button type="button" class="nav-link" id="backBtn">‹ ${esc(backLabel)}</button>`
          : `<span></span>`
      }
      ${
        browseScope === 'playlists' && !inDetail
          ? `<button type="button" class="nav-link" id="newPlaylist">New</button>`
          : browseScope === 'playlists' && inDetail
            ? `<button type="button" class="nav-link" id="playlistMenu">Edit</button>`
            : `<span></span>`
      }
    </div>
    <h1 class="large-title">${esc(title)}</h1>
    <div class="segmented scroll">
      <button type="button" data-scope="albums" class="${browseScope === 'albums' ? 'active' : ''}">Albums</button>
      <button type="button" data-scope="artists" class="${browseScope === 'artists' ? 'active' : ''}">Artists</button>
      <button type="button" data-scope="folders" class="${browseScope === 'folders' ? 'active' : ''}">Folders</button>
      <button type="button" data-scope="playlists" class="${browseScope === 'playlists' ? 'active' : ''}">Playlists</button>
      <button type="button" data-scope="labels" class="${browseScope === 'labels' ? 'active' : ''}">Labels</button>
    </div>
    <div class="search-wrap">
      ${icons.search}
      <input id="search" type="search" enterkeyhint="search" placeholder="Songs, albums, artists"
        value="${esc(searchQuery)}" />
    </div>
    <div class="group" id="list"></div>
  `;

  main.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      browseScope = (btn as HTMLElement).dataset.scope as BrowseScope;
      folderPath = null;
      folderStack = [];
      searchQuery = '';
      await loadBrowse();
      renderApp();
    });
  });

  main.querySelector('#backBtn')?.addEventListener('click', async () => {
    folderPath = folderStack.pop() ?? null;
    await loadBrowse();
    renderApp();
  });

  main.querySelector('#newPlaylist')?.addEventListener('click', () => {
    void createPlaylistFlow();
  });

  main.querySelector('#playlistMenu')?.addEventListener('click', () => {
    if (!folderPath) return;
    void openPlaylistEditSheet(folderPath);
  });

  const search = main.querySelector<HTMLInputElement>('#search')!;
  let debounce: number | undefined;
  search.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(async () => {
      searchQuery = search.value;
      await loadBrowse();
      paintList(main.querySelector('#list')!);
    }, 220);
  });

  paintList(main.querySelector('#list')!);
}

function paintList(list: Element): void {
  list.innerHTML = '';
  if (!items.length) {
    const emptyMsg =
      browseScope === 'playlists'
        ? `<div class="empty"><strong>No Playlists</strong>Tap New to create one, then add albums or songs.</div>`
        : browseScope === 'labels'
          ? `<div class="empty"><strong>No Labels</strong>Tag songs from the ··· menu on any album or track.</div>`
          : `<div class="empty"><strong>No Music</strong>Add a folder on the Folders tab, then come back here.</div>`;
    list.innerHTML = emptyMsg;
    return;
  }

  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const row = document.createElement('div');
    row.className = 'row-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row has-icon';

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'row-more';
    more.setAttribute('aria-label', 'More');
    more.textContent = '···';

    let selection: Selection | null = null;
    let primary: (() => Promise<void>) | null = null;

    if (item.kind === 'playlist' && item.id) {
      btn.innerHTML = rowHtml('playlist', String(item.name), `${item.trackCount ?? 0} songs`, true);
      primary = async () => {
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.id);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
      selection = { albumId: undefined, title: String(item.name) };
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        void openPlaylistEditSheet(String(item.id), String(item.name));
      });
    } else if (item.kind === 'label' && item.name) {
      btn.innerHTML = rowHtml('label', String(item.name), `${item.trackCount ?? 0} songs`, true);
      primary = async () => {
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.name);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
      selection = { title: String(item.name) };
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        void playNow({ label: String(item.name) });
      });
    } else if (
      (browseScope === 'albums' || searchQuery) &&
      item.title &&
      item.artist &&
      item.id &&
      !item.cataloguePath
    ) {
      btn.innerHTML = rowHtml('album', String(item.title), String(item.artist), true);
      selection = { albumId: String(item.id), title: String(item.title) };
      primary = async () => playNow({ albumId: String(item.id) });
    } else if (
      browseScope === 'artists' &&
      item.name &&
      !item.cataloguePath &&
      item.kind !== 'label' &&
      item.kind !== 'playlist'
    ) {
      btn.innerHTML = rowHtml(
        'artist',
        String(item.name),
        `${item.trackCount ?? 0} songs`,
        true
      );
      selection = { artist: String(item.name), title: String(item.name) };
      primary = async () => playNow({ artist: String(item.name) });
    } else if (item.isDirectory) {
      btn.innerHTML = rowHtml('folder', String(item.name), 'Folder', true);
      selection = { folder: String(item.path), title: String(item.name) };
      primary = async () => {
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.path);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
    } else if (item.cataloguePath || item.track) {
      const track = (item.track as Record<string, unknown>) ?? item;
      const path = String(track.cataloguePath ?? item.path ?? '');
      btn.innerHTML = rowHtml(
        'track',
        String(track.title ?? item.name),
        String(track.artist ?? ''),
        false
      );
      selection = { cataloguePath: path, title: String(track.title ?? item.name) };
      primary = async () => playNow({ cataloguePath: path });
    } else {
      continue;
    }

    btn.addEventListener('click', () => {
      if (primary) void primary();
    });
    if (selection && item.kind !== 'playlist' && item.kind !== 'label') {
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        void openAddSheet(selection!);
      });
    } else if (item.kind === 'label') {
      /* play via more already */
    } else if (!more.onclick) {
      more.style.visibility = 'hidden';
    }

    row.appendChild(btn);
    row.appendChild(more);
    list.appendChild(row);
  }
}

function rowHtml(
  kind: string,
  title: string,
  sub: string,
  chevron: boolean
): string {
  const initial = (title.trim()[0] ?? '•').toUpperCase();
  return `
    <div class="row-icon ${kind}">${esc(initial)}</div>
    <div class="row-text">
      <div class="row-title">${esc(title)}</div>
      <div class="row-sub">${esc(sub)}</div>
    </div>
    ${chevron ? `<span class="chevron">${icons.chevron}</span>` : `<span></span>`}
  `;
}

async function playNow(body: Record<string, unknown>): Promise<void> {
  haptic('medium');
  await api('/api/v1/play', { method: 'POST', body });
  tab = 'now';
  nowPlaying = await api('/api/v1/now-playing');
  playing = nowPlaying?.state === 'playing';
  renderApp();
}

async function createPlaylistFlow(): Promise<void> {
  const name = window.prompt('Playlist name');
  if (!name?.trim()) return;
  await api('/api/v1/playlists', { method: 'POST', body: { name: name.trim() } });
  haptic();
  await loadBrowse();
  renderApp();
}

async function openPlaylistEditSheet(id: string, name?: string): Promise<void> {
  const plName = name ?? 'Playlist';
  showSheet(plName, [
    {
      label: 'Play',
      run: async () => playNow({ playlistId: id }),
    },
    {
      label: 'Rename…',
      run: async () => {
        const next = window.prompt('Rename playlist', plName);
        if (!next?.trim()) return;
        await api(`/api/v1/playlists/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { name: next.trim() },
        });
        await loadBrowse();
        renderApp();
      },
    },
    {
      label: 'Delete',
      danger: true,
      run: async () => {
        if (!window.confirm(`Delete “${plName}”?`)) return;
        await api(`/api/v1/playlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
        folderPath = null;
        await loadBrowse();
        renderApp();
      },
    },
  ]);
}

async function openAddSheet(sel: Selection): Promise<void> {
  if (!playlistCache.length) {
    try {
      const pl = await api<{ playlists: Array<{ id: string; name: string }> }>('/api/v1/playlists');
      playlistCache = pl.playlists;
    } catch {
      playlistCache = [];
    }
  }
  const actions: Array<{ label: string; danger?: boolean; run: () => Promise<void> }> = [
    {
      label: 'Play',
      run: async () =>
        playNow({
          cataloguePath: sel.cataloguePath,
          albumId: sel.albumId,
          artist: sel.artist,
          folder: sel.folder,
        }),
    },
    {
      label: 'New Playlist…',
      run: async () => {
        const name = window.prompt('Playlist name', sel.title);
        if (!name?.trim()) return;
        const created = await api<{ id: string }>('/api/v1/playlists', {
          method: 'POST',
          body: { name: name.trim() },
        });
        await api(`/api/v1/playlists/${encodeURIComponent(created.id)}/items`, {
          method: 'POST',
          body: {
            cataloguePath: sel.cataloguePath,
            albumId: sel.albumId,
            artist: sel.artist,
            folder: sel.folder,
          },
        });
        haptic();
        playlistCache = [];
      },
    },
  ];
  for (const p of playlistCache) {
    actions.push({
      label: `Add to “${p.name}”`,
      run: async () => {
        await api(`/api/v1/playlists/${encodeURIComponent(p.id)}/items`, {
          method: 'POST',
          body: {
            cataloguePath: sel.cataloguePath,
            albumId: sel.albumId,
            artist: sel.artist,
            folder: sel.folder,
          },
        });
        haptic();
      },
    });
  }
  actions.push({
    label: 'Add Label…',
    run: async () => {
      const name = window.prompt('Label name');
      if (!name?.trim()) return;
      await api('/api/v1/labels/items', {
        method: 'POST',
        body: {
          name: name.trim(),
          cataloguePath: sel.cataloguePath,
          albumId: sel.albumId,
          artist: sel.artist,
          folder: sel.folder,
        },
      });
      haptic();
    },
  });
  if (browseScope === 'playlists' && folderPath && sel.cataloguePath) {
    actions.push({
      label: 'Remove from Playlist',
      danger: true,
      run: async () => {
        await api(`/api/v1/playlists/${encodeURIComponent(folderPath!)}/items`, {
          method: 'DELETE',
          body: { cataloguePath: sel.cataloguePath },
        });
        await loadBrowse();
        renderApp();
      },
    });
  }
  if (browseScope === 'labels' && folderPath && sel.cataloguePath) {
    actions.push({
      label: 'Remove Label',
      danger: true,
      run: async () => {
        await api('/api/v1/labels/items', {
          method: 'DELETE',
          body: { name: folderPath, cataloguePath: sel.cataloguePath },
        });
        await loadBrowse();
        renderApp();
      },
    });
  }
  showSheet(sel.title, actions);
}

function showSheet(
  title: string,
  actions: Array<{ label: string; danger?: boolean; run: () => Promise<void> }>
): void {
  document.getElementById('actionSheet')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'actionSheet';
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-label="${esc(title)}">
      <p class="sheet-title">${esc(title)}</p>
      <div class="sheet-actions"></div>
      <button type="button" class="sheet-cancel">Cancel</button>
    </div>
  `;
  const box = wrap.querySelector('.sheet-actions')!;
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = a.danger ? 'sheet-btn danger' : 'sheet-btn';
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      wrap.remove();
      try {
        await a.run();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : String(err));
      }
    });
    box.appendChild(b);
  }
  wrap.querySelector('.sheet-cancel')?.addEventListener('click', () => wrap.remove());
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) wrap.remove();
  });
  document.body.appendChild(wrap);
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
        <input id="seek" type="range" min="0" max="${Math.max(dur, 1)}" step="0.1" value="${localPos}" ${track ? '' : 'disabled'} />
        <div class="time-row"><span>${fmtTime(localPos)}</span><span>${dur ? fmtTime(dur) : '--:--'}</span></div>
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
        <input id="vol" type="range" min="0" max="1" step="0.01" value="${Number(nowPlaying?.volume ?? 0.8)}" />
        ${icons.volMax}
      </div>
    </section>
  `;

  if (track?.artworkHash) {
    void artworkObjectUrl(String(track.artworkHash))
      .then((url) => {
        const slot = main.querySelector('#artSlot');
        if (slot) slot.innerHTML = `<img src="${url}" alt="" />`;
      })
      .catch(() => undefined);
  }

  main.querySelectorAll('[data-cmd]').forEach((btn) => {
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

  main.querySelector('#vol')?.addEventListener('input', async (e) => {
    const level = Number((e.target as HTMLInputElement).value);
    nowPlaying = await api('/api/v1/transport', {
      method: 'POST',
      body: { command: 'setVolume', level },
    });
  });

  const seek = main.querySelector<HTMLInputElement>('#seek');
  seek?.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek?.addEventListener('input', () => {
    localPos = Number(seek.value);
    const t0 = document.querySelector('.time-row span');
    if (t0) t0.textContent = fmtTime(localPos);
  });
  const commitSeek = async () => {
    const seconds = Number(seek?.value ?? 0);
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
  seek?.addEventListener('pointerup', () => void commitSeek());
  seek?.addEventListener('change', () => void commitSeek());
}

async function renderMounts(main: Element): Promise<void> {
  const mounts = (await api('/api/v1/mounts')) as Array<{ path: string; displayName: string }>;
  main.innerHTML = `
    <h1 class="large-title">Folders</h1>
    <p class="group-label">On This Host</p>
    <div class="group" id="mountList"></div>
    <p class="group-label">Add Folder</p>
    <div class="group">
      <form id="addMount" class="cell" style="display:flex; gap:8px;">
        <input name="path" type="text" placeholder="/path/to/music" required autocomplete="off" />
        <button class="btn-text" type="submit">Add</button>
      </form>
    </div>
    <div class="group">
      <button type="button" class="cell" id="rescan"><span>Update Library</span><span class="value">Rescan</span></button>
    </div>
    <p class="footer-note">Paths must exist on the Mac or Linux host running Harbor.</p>
  `;

  const list = main.querySelector('#mountList')!;
  if (!mounts.length) {
    list.innerHTML = `<div class="empty" style="padding:28px 16px"><strong>No Folders</strong>Add a music directory to get started.</div>`;
  }
  for (const m of mounts) {
    const row = document.createElement('div');
    row.className = 'cell';
    row.innerHTML = `
      <div class="row-text" style="text-align:left">
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
      alert(err instanceof Error ? err.message : 'Could not add folder');
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
    <h1 class="large-title">Output</h1>
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
    <div class="group" style="margin-top:20px">
      <button type="button" class="cell" id="apply"><span style="color:var(--tint);font-weight:600">Apply Changes</span><span></span></button>
    </div>
    <p class="footer-note">Exclusive and DoP require an external DAC on Mac, or an ALSA hw: device on Linux.</p>
  `;

  main.querySelector('#apply')!.addEventListener('click', async () => {
    const deviceUid = (main.querySelector('#device') as HTMLSelectElement).value || null;
    const mode = (main.querySelector('#mode') as HTMLSelectElement).value;
    await api('/api/v1/output', { method: 'PUT', body: { deviceUid, mode } });
    await renderOutput(main);
  });
}

function paintMini(): void {
  const mini = document.querySelector('#mini');
  if (!mini) return;
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  if (!track) return;
  mini.innerHTML = `
    <div class="mini-art" id="miniArt">${icons.musicSm}</div>
    <button type="button" class="mini-text" id="miniOpen">
      <strong>${esc(String(track.title ?? ''))}</strong>
      <span>${esc(String(track.artist ?? ''))}</span>
    </button>
    <div class="mini-actions">
      <button type="button" id="miniToggle" aria-label="Play/Pause">${playing ? icons.pauseSm : icons.playSm}</button>
      <button type="button" id="miniNext" aria-label="Next">${icons.next}</button>
    </div>
  `;

  if (track.artworkHash) {
    void artworkObjectUrl(String(track.artworkHash))
      .then((url) => {
        const slot = mini.querySelector('#miniArt');
        if (slot) slot.innerHTML = `<img src="${url}" alt="" />`;
      })
      .catch(() => undefined);
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
  mini.querySelector('#miniNext')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    haptic('light');
    nowPlaying = await api('/api/v1/transport', { method: 'POST', body: { command: 'next' } });
    playing = nowPlaying?.state === 'playing';
    updateChrome();
  });
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

void boot();
