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
let labelCache: string[] = [];
let detailTitle: string | null = null;

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
  await refreshCaches();
}

async function refreshCaches(): Promise<void> {
  try {
    const [pl, lb] = await Promise.all([
      api<{ playlists: Array<{ id: string; name: string }> }>('/api/v1/playlists'),
      api<{ labels: Array<{ name: string }> }>('/api/v1/labels'),
    ]);
    playlistCache = pl.playlists;
    labelCache = lb.labels.map((l) => l.name);
  } catch {
    /* ignore */
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
  const collectionMode = browseScope === 'playlists' || browseScope === 'labels';
  let title = 'Library';
  if (browseScope === 'folders' && folderPath) {
    title = folderPath.split(/[/\\]/).filter(Boolean).pop() ?? 'Folders';
  } else if (browseScope === 'playlists' && folderPath) {
    title = detailTitle ?? 'Playlist';
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

  const hideSearch = collectionMode && !inDetail;
  const showCollectionBar = collectionMode && inDetail;

  main.innerHTML = `
    <div class="nav-row">
      ${
        inDetail
          ? `<button type="button" class="nav-link" id="backBtn">‹ ${esc(backLabel)}</button>`
          : `<span></span>`
      }
      ${
        browseScope === 'playlists' && !inDetail
          ? `<button type="button" class="nav-link accent" id="newPlaylist">＋ New</button>`
          : `<span></span>`
      }
    </div>
    <h1 class="large-title">${esc(title)}</h1>
    ${
      showCollectionBar
        ? `<div class="collection-bar">
            <button type="button" class="pill-btn primary" id="playCollection">Play All</button>
            ${
              browseScope === 'playlists'
                ? `<button type="button" class="pill-btn" id="manageCollection">Manage</button>`
                : ''
            }
            <span class="collection-meta">${items.length} song${items.length === 1 ? '' : 's'}</span>
          </div>`
        : ''
    }
    <div class="segmented scroll">
      <button type="button" data-scope="albums" class="${browseScope === 'albums' ? 'active' : ''}">Albums</button>
      <button type="button" data-scope="artists" class="${browseScope === 'artists' ? 'active' : ''}">Artists</button>
      <button type="button" data-scope="folders" class="${browseScope === 'folders' ? 'active' : ''}">Folders</button>
      <button type="button" data-scope="playlists" class="${browseScope === 'playlists' ? 'active' : ''}">Playlists</button>
      <button type="button" data-scope="labels" class="${browseScope === 'labels' ? 'active' : ''}">Labels</button>
    </div>
    ${
      hideSearch
        ? ''
        : `<div class="search-wrap">
      ${icons.search}
      <input id="search" type="search" enterkeyhint="search" placeholder="Songs, albums, artists"
        value="${esc(searchQuery)}" />
    </div>`
    }
    <div class="group" id="list"></div>
  `;

  main.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      browseScope = (btn as HTMLElement).dataset.scope as BrowseScope;
      folderPath = null;
      folderStack = [];
      detailTitle = null;
      searchQuery = '';
      await loadBrowse();
      renderApp();
    });
  });

  main.querySelector('#backBtn')?.addEventListener('click', async () => {
    folderPath = folderStack.pop() ?? null;
    detailTitle = null;
    await loadBrowse();
    renderApp();
  });

  main.querySelector('#newPlaylist')?.addEventListener('click', () => {
    openNameSheet({
      title: 'New Playlist',
      placeholder: 'Name',
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        await api('/api/v1/playlists', { method: 'POST', body: { name } });
        toast(`Created “${name}”`);
        haptic();
        await loadBrowse();
        renderApp();
      },
    });
  });

  main.querySelector('#playCollection')?.addEventListener('click', () => {
    if (browseScope === 'playlists' && folderPath) void playNow({ playlistId: folderPath });
    if (browseScope === 'labels' && folderPath) void playNow({ label: folderPath });
  });

  main.querySelector('#manageCollection')?.addEventListener('click', () => {
    if (browseScope === 'playlists' && folderPath) {
      void openPlaylistManage(folderPath, detailTitle ?? 'Playlist');
    }
  });

  const search = main.querySelector<HTMLInputElement>('#search');
  if (search) {
    let debounce: number | undefined;
    search.addEventListener('input', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(async () => {
        searchQuery = search.value;
        await loadBrowse();
        paintList(main.querySelector('#list')!);
      }, 220);
    });
  }

  paintList(main.querySelector('#list')!);
}

function paintList(list: Element): void {
  list.innerHTML = '';
  if (!items.length) {
    const emptyMsg =
      browseScope === 'playlists'
        ? `<div class="empty"><strong>No Playlists Yet</strong>Create one, then use <em>Add</em> on any album or song.</div>`
        : browseScope === 'labels'
          ? `<div class="empty"><strong>No Labels Yet</strong>Open <em>Add</em> on a song or album and pick a label.</div>`
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
    more.setAttribute('aria-label', 'Add to playlist or label');
    more.innerHTML = `<span class="more-glyph">＋</span>`;

    let selection: Selection | null = null;
    let primary: (() => Promise<void>) | null = null;
    let moreHandler: (() => void) | null = null;

    if (item.kind === 'playlist' && item.id) {
      const count = Number(item.trackCount ?? 0);
      btn.innerHTML = rowHtml(
        'playlist',
        String(item.name),
        count === 0 ? 'Empty' : `${count} song${count === 1 ? '' : 's'}`,
        true
      );
      primary = async () => {
        detailTitle = String(item.name);
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.id);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
      moreHandler = () => void openPlaylistManage(String(item.id), String(item.name));
      more.setAttribute('aria-label', 'Manage playlist');
      more.innerHTML = `<span class="more-glyph">···</span>`;
    } else if (item.kind === 'label' && item.name) {
      const count = Number(item.trackCount ?? 0);
      btn.innerHTML = rowHtml(
        'label',
        String(item.name),
        count === 0 ? 'Empty' : `${count} song${count === 1 ? '' : 's'}`,
        true
      );
      primary = async () => {
        detailTitle = String(item.name);
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.name);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
      moreHandler = () => void playNow({ label: String(item.name) });
      more.setAttribute('aria-label', 'Play label');
      more.innerHTML = `<span class="more-glyph play">${icons.playSm}</span>`;
    } else if (
      (browseScope === 'albums' || searchQuery) &&
      item.title &&
      item.artist &&
      item.id &&
      !item.cataloguePath
    ) {
      btn.innerHTML = rowHtml('album', String(item.title), String(item.artist), false);
      selection = { albumId: String(item.id), title: String(item.title) };
      primary = async () => playNow({ albumId: String(item.id) });
      moreHandler = () => void openOrganizeSheet(selection!);
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
        false
      );
      selection = { artist: String(item.name), title: String(item.name) };
      primary = async () => playNow({ artist: String(item.name) });
      moreHandler = () => void openOrganizeSheet(selection!);
    } else if (item.isDirectory) {
      btn.innerHTML = rowHtml('folder', String(item.name), 'Folder', true);
      selection = { folder: String(item.path), title: String(item.name) };
      primary = async () => {
        detailTitle = null;
        if (folderPath) folderStack.push(folderPath);
        folderPath = String(item.path);
        searchQuery = '';
        await loadBrowse();
        renderApp();
      };
      moreHandler = () => void openOrganizeSheet(selection!);
    } else if (item.cataloguePath || item.track) {
      const track = (item.track as Record<string, unknown>) ?? item;
      const path = String(track.cataloguePath ?? item.path ?? '');
      const labels = Array.isArray(track.labels)
        ? (track.labels as string[]).slice(0, 2).join(' · ')
        : '';
      btn.innerHTML = rowHtml(
        'track',
        String(track.title ?? item.name),
        labels ? `${track.artist ?? ''} · ${labels}` : String(track.artist ?? ''),
        false
      );
      selection = { cataloguePath: path, title: String(track.title ?? item.name) };
      primary = async () => playNow({ cataloguePath: path });
      moreHandler = () => void openOrganizeSheet(selection!);
    } else {
      continue;
    }

    btn.addEventListener('click', () => {
      if (primary) void primary();
    });
    if (moreHandler) {
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        haptic('light');
        moreHandler!();
      });
    } else {
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
  closeSheet();
  await api('/api/v1/play', { method: 'POST', body });
  tab = 'now';
  nowPlaying = await api('/api/v1/now-playing');
  playing = nowPlaying?.state === 'playing';
  renderApp();
}

function selectionBody(sel: Selection): Record<string, unknown> {
  return {
    cataloguePath: sel.cataloguePath,
    albumId: sel.albumId,
    artist: sel.artist,
    folder: sel.folder,
  };
}

async function openOrganizeSheet(sel: Selection): Promise<void> {
  await refreshCaches();
  const destructive: Array<{ label: string; danger?: boolean; run: () => Promise<void> }> = [];
  if (browseScope === 'playlists' && folderPath && sel.cataloguePath) {
    destructive.push({
      label: 'Remove from This Playlist',
      danger: true,
      run: async () => {
        await api(`/api/v1/playlists/${encodeURIComponent(folderPath!)}/items`, {
          method: 'DELETE',
          body: { cataloguePath: sel.cataloguePath },
        });
        toast('Removed from playlist');
        await loadBrowse();
        renderApp();
      },
    });
  }
  if (browseScope === 'labels' && folderPath && sel.cataloguePath) {
    destructive.push({
      label: `Remove Label “${folderPath}”`,
      danger: true,
      run: async () => {
        await api('/api/v1/labels/items', {
          method: 'DELETE',
          body: { name: folderPath, cataloguePath: sel.cataloguePath },
        });
        toast('Label removed');
        await loadBrowse();
        renderApp();
      },
    });
  }

  showActionSheet({
    title: sel.title,
    subtitle: 'Play or organize',
    groups: [
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
          label: 'Add Label…',
          run: async () => openLabelPicker(sel),
        },
      ],
      destructive,
    ].filter((g) => g.length > 0),
  });
}

async function openPlaylistPicker(sel: Selection): Promise<void> {
  await refreshCaches();
  const rows = playlistCache
    .map(
      (p) => `
      <button type="button" class="picker-row" data-id="${esc(p.id)}">
        <span class="row-icon playlist">${esc((p.name[0] ?? 'P').toUpperCase())}</span>
        <span class="picker-text">
          <strong>${esc(p.name)}</strong>
        </span>
        <span class="picker-add">Add</span>
      </button>`
    )
    .join('');

  showPanelSheet({
    title: 'Add to Playlist',
    subtitle: sel.title,
    bodyHtml: `
      <button type="button" class="picker-row create" id="pickerNewPl">
        <span class="row-icon playlist">＋</span>
        <span class="picker-text"><strong>New Playlist</strong><span>Create and add</span></span>
      </button>
      <div class="picker-list">${rows || `<p class="picker-empty">No playlists yet — create one above.</p>`}</div>
    `,
    bind: (root, close) => {
      root.querySelector('#pickerNewPl')?.addEventListener('click', () => {
        close();
        openNameSheet({
          title: 'New Playlist',
          placeholder: 'Name',
          initial: sel.title,
          confirmLabel: 'Create & Add',
          onConfirm: async (name) => {
            const created = await api<{ id: string }>('/api/v1/playlists', {
              method: 'POST',
              body: { name },
            });
            await api(`/api/v1/playlists/${encodeURIComponent(created.id)}/items`, {
              method: 'POST',
              body: selectionBody(sel),
            });
            toast(`Added to “${name}”`);
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
            toast(`Added to “${name}”`);
            haptic();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Failed', true);
          }
        });
      });
    },
  });
}

async function openLabelPicker(sel: Selection): Promise<void> {
  await refreshCaches();
  const chips = labelCache
    .map(
      (name) =>
        `<button type="button" class="chip" data-label="${esc(name)}">${esc(name)}</button>`
    )
    .join('');

  showPanelSheet({
    title: 'Add Label',
    subtitle: sel.title,
    bodyHtml: `
      <form class="sheet-form" id="labelForm">
        <label class="field-label" for="labelInput">Label</label>
        <input id="labelInput" class="sheet-input" type="text" enterkeyhint="done"
          placeholder="e.g. Favorites" autocomplete="off" />
        <button type="submit" class="sheet-primary">Add Label</button>
      </form>
      ${
        chips
          ? `<p class="field-label soft">Or choose existing</p><div class="chip-row">${chips}</div>`
          : `<p class="picker-empty">No labels yet — type a name above.</p>`
      }
    `,
    bind: (root, close) => {
      const input = root.querySelector<HTMLInputElement>('#labelInput')!;
      const submit = async (name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await api('/api/v1/labels/items', {
            method: 'POST',
            body: { name: trimmed, ...selectionBody(sel) },
          });
          close();
          toast(`Labeled “${trimmed}”`);
          haptic();
          await refreshCaches();
          if (browseScope === 'labels') {
            await loadBrowse();
            renderApp();
          }
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Failed', true);
        }
      };
      root.querySelector('#labelForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        void submit(input.value);
      });
      root.querySelectorAll<HTMLElement>('[data-label]').forEach((el) => {
        el.addEventListener('click', () => void submit(el.dataset.label ?? ''));
      });
      queueMicrotask(() => input.focus());
    },
  });
}

function openPlaylistManage(id: string, name: string): void {
  showActionSheet({
    title: name,
    subtitle: 'Playlist',
    groups: [
      [
        {
          label: 'Play',
          run: async () => playNow({ playlistId: id }),
        },
        {
          label: 'Open',
          run: async () => {
            detailTitle = name;
            folderPath = id;
            folderStack = [];
            searchQuery = '';
            browseScope = 'playlists';
            await loadBrowse();
            renderApp();
          },
        },
      ],
      [
        {
          label: 'Rename…',
          run: async () => {
            openNameSheet({
              title: 'Rename Playlist',
              placeholder: 'Name',
              initial: name,
              confirmLabel: 'Save',
              onConfirm: async (next) => {
                await api(`/api/v1/playlists/${encodeURIComponent(id)}`, {
                  method: 'PATCH',
                  body: { name: next },
                });
                if (folderPath === id) detailTitle = next;
                toast('Playlist renamed');
                await loadBrowse();
                renderApp();
              },
            });
          },
        },
      ],
      [
        {
          label: 'Delete Playlist',
          danger: true,
          run: async () => {
            showActionSheet({
              title: `Delete “${name}”?`,
              subtitle: 'Songs stay in your library.',
              groups: [
                [
                  {
                    label: 'Delete Playlist',
                    danger: true,
                    run: async () => {
                      await api(`/api/v1/playlists/${encodeURIComponent(id)}`, {
                        method: 'DELETE',
                      });
                      if (folderPath === id) {
                        folderPath = null;
                        detailTitle = null;
                      }
                      toast('Playlist deleted');
                      await loadBrowse();
                      renderApp();
                    },
                  },
                ],
              ],
            });
          },
        },
      ],
    ],
  });
}

function openNameSheet(opts: {
  title: string;
  placeholder: string;
  initial?: string;
  confirmLabel: string;
  onConfirm: (name: string) => Promise<void>;
}): void {
  showPanelSheet({
    title: opts.title,
    bodyHtml: `
      <form class="sheet-form" id="nameForm">
        <input id="nameInput" class="sheet-input" type="text" enterkeyhint="done"
          placeholder="${esc(opts.placeholder)}" value="${esc(opts.initial ?? '')}" autocomplete="off" />
        <button type="submit" class="sheet-primary">${esc(opts.confirmLabel)}</button>
      </form>
    `,
    bind: (root, close) => {
      const input = root.querySelector<HTMLInputElement>('#nameInput')!;
      root.querySelector('#nameForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) {
          input.focus();
          return;
        }
        try {
          await opts.onConfirm(name);
          close();
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Failed', true);
        }
      });
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    },
  });
}

function closeSheet(): void {
  document.getElementById('actionSheet')?.remove();
}

function showActionSheet(opts: {
  title: string;
  subtitle?: string;
  groups: Array<Array<{ label: string; danger?: boolean; run: () => Promise<void> }>>;
}): void {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.id = 'actionSheet';
  wrap.className = 'sheet-backdrop';
  const groupsHtml = opts.groups
    .map((group, gi) => {
      const buttons = group
        .map(
          (a, ai) =>
            `<button type="button" class="sheet-btn ${a.danger ? 'danger' : ''}" data-g="${gi}" data-a="${ai}">${esc(a.label)}</button>`
        )
        .join('');
      return `<div class="sheet-group">${buttons}</div>`;
    })
    .join('');
  wrap.innerHTML = `
    <div class="sheet-stack" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="sheet">
        <p class="sheet-title">${esc(opts.title)}</p>
        ${opts.subtitle ? `<p class="sheet-sub">${esc(opts.subtitle)}</p>` : ''}
        ${groupsHtml}
      </div>
      <button type="button" class="sheet-cancel">Cancel</button>
    </div>
  `;
  wrap.querySelectorAll<HTMLButtonElement>('[data-g]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const g = Number(btn.dataset.g);
      const a = Number(btn.dataset.a);
      const action = opts.groups[g]?.[a];
      if (!action) return;
      closeSheet();
      try {
        await action.run();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), true);
      }
    });
  });
  wrap.querySelector('.sheet-cancel')?.addEventListener('click', () => closeSheet());
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeSheet();
  });
  document.body.appendChild(wrap);
}

function showPanelSheet(opts: {
  title: string;
  subtitle?: string;
  bodyHtml: string;
  bind: (root: HTMLElement, close: () => void) => void;
}): void {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.id = 'actionSheet';
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet-stack" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="sheet sheet-panel">
        <div class="sheet-panel-head">
          <p class="sheet-title">${esc(opts.title)}</p>
          ${opts.subtitle ? `<p class="sheet-sub">${esc(opts.subtitle)}</p>` : ''}
        </div>
        <div class="sheet-panel-body">${opts.bodyHtml}</div>
      </div>
      <button type="button" class="sheet-cancel">Cancel</button>
    </div>
  `;
  const close = () => closeSheet();
  wrap.querySelector('.sheet-cancel')?.addEventListener('click', close);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  document.body.appendChild(wrap);
  opts.bind(wrap.querySelector('.sheet-panel') as HTMLElement, close);
}

function toast(message: string, error = false): void {
  document.getElementById('toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = error ? 'toast error' : 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.classList.add('show'), 10);
  window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 280);
  }, 2200);
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
