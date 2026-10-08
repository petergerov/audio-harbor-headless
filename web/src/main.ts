import './styles.css';
import { api, getToken, setToken, connectWs } from './api';

type Tab = 'browse' | 'now' | 'mounts' | 'output';

const app = document.querySelector<HTMLDivElement>('#app')!;
let tab: Tab = 'browse';
let browseScope: 'albums' | 'artists' | 'folders' = 'albums';
let folderPath: string | null = null;
let nowPlaying: Record<string, unknown> | null = null;
let items: unknown[] = [];

async function boot(): Promise<void> {
  if (!getToken()) {
    renderPairing();
    return;
  }
  connectWs((msg) => {
    if (msg.type === 'nowPlaying') {
      nowPlaying = msg.payload as Record<string, unknown>;
      if (tab === 'now') render();
      updateMini();
    }
  });
  try {
    nowPlaying = await api('/api/v1/now-playing');
  } catch {
    setToken(null);
    renderPairing();
    return;
  }
  await loadBrowse();
  render();
}

function renderPairing(): void {
  app.innerHTML = `
    <main class="shell pair">
      <p class="brand">Audio Harbor</p>
      <h1>Pair this phone</h1>
      <p class="lede">Enter the 6-digit PIN shown in the host terminal.</p>
      <input id="pin" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="one-time-code" />
      <button id="pairBtn" class="primary">Pair</button>
      <p id="pairErr" class="err" hidden></p>
    </main>
  `;
  const pin = app.querySelector<HTMLInputElement>('#pin')!;
  const err = app.querySelector<HTMLParagraphElement>('#pairErr')!;
  app.querySelector('#pairBtn')!.addEventListener('click', async () => {
    err.hidden = true;
    try {
      const res = await fetch('/api/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin.value.trim() }),
      });
      if (!res.ok) throw new Error('Wrong PIN');
      const data = (await res.json()) as { token: string };
      setToken(data.token);
      await boot();
    } catch (e) {
      err.hidden = false;
      err.textContent = e instanceof Error ? e.message : 'Pairing failed';
    }
  });
}

async function loadBrowse(): Promise<void> {
  if (browseScope === 'folders') {
    const q = folderPath ? `?scope=folders&path=${encodeURIComponent(folderPath)}` : '?scope=folders';
    const res = await api<{ items: unknown[] }>(`/api/v1/browse${q}`);
    items = res.items;
  } else {
    const res = await api<{ items: unknown[] }>(`/api/v1/browse?scope=${browseScope}`);
    items = res.items;
  }
}

function render(): void {
  app.innerHTML = `
    <div class="shell">
      <header class="top">
        <p class="brand">Audio Harbor</p>
        <div class="tabs">
          <button data-tab="browse" class="${tab === 'browse' ? 'active' : ''}">Browse</button>
          <button data-tab="now" class="${tab === 'now' ? 'active' : ''}">Now</button>
          <button data-tab="mounts" class="${tab === 'mounts' ? 'active' : ''}">Mounts</button>
          <button data-tab="output" class="${tab === 'output' ? 'active' : ''}">Output</button>
        </div>
      </header>
      <main id="main"></main>
      <footer class="mini" id="mini"></footer>
    </div>
  `;
  app.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      tab = (btn as HTMLElement).dataset.tab as Tab;
      if (tab === 'browse') await loadBrowse();
      render();
    });
  });
  const main = app.querySelector('#main')!;
  if (tab === 'browse') renderBrowse(main);
  if (tab === 'now') renderNow(main);
  if (tab === 'mounts') void renderMounts(main);
  if (tab === 'output') void renderOutput(main);
  updateMini();
}

function renderBrowse(main: Element): void {
  main.innerHTML = `
    <div class="scopes">
      <button data-scope="albums" class="${browseScope === 'albums' ? 'active' : ''}">Albums</button>
      <button data-scope="artists" class="${browseScope === 'artists' ? 'active' : ''}">Artists</button>
      <button data-scope="folders" class="${browseScope === 'folders' ? 'active' : ''}">Folders</button>
    </div>
    <input id="search" class="search" placeholder="Search" />
    <ul class="list" id="list"></ul>
  `;
  main.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      browseScope = (btn as HTMLElement).dataset.scope as typeof browseScope;
      folderPath = null;
      await loadBrowse();
      render();
    });
  });
  const list = main.querySelector('#list')!;
  const search = main.querySelector<HTMLInputElement>('#search')!;
  search.addEventListener('change', async () => {
    const q = search.value.trim();
    if (!q) {
      await loadBrowse();
    } else {
      const res = await api<{ items: unknown[] }>(`/api/v1/search?q=${encodeURIComponent(q)}`);
      items = res.items;
    }
    paintList(list);
  });
  paintList(list);
}

function paintList(list: Element): void {
  list.innerHTML = '';
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    const li = document.createElement('li');
    if (browseScope === 'albums' && item.title) {
      li.innerHTML = `<strong>${esc(String(item.title))}</strong><span>${esc(String(item.artist))}</span>`;
      li.addEventListener('click', async () => {
        await api('/api/v1/play', { method: 'POST', body: { albumId: item.id } });
        tab = 'now';
        nowPlaying = await api('/api/v1/now-playing');
        render();
      });
    } else if (browseScope === 'artists' && item.name) {
      li.innerHTML = `<strong>${esc(String(item.name))}</strong><span>${item.trackCount} tracks</span>`;
      li.addEventListener('click', async () => {
        await api('/api/v1/play', { method: 'POST', body: { artist: item.name } });
        tab = 'now';
        nowPlaying = await api('/api/v1/now-playing');
        render();
      });
    } else if (item.isDirectory) {
      li.innerHTML = `<strong>${esc(String(item.name))}</strong><span>Folder</span>`;
      li.addEventListener('click', async () => {
        folderPath = String(item.path);
        await loadBrowse();
        render();
      });
    } else if (item.cataloguePath || item.track) {
      const track = (item.track as Record<string, unknown>) ?? item;
      li.innerHTML = `<strong>${esc(String(track.title ?? item.name))}</strong><span>${esc(String(track.artist ?? ''))}</span>`;
      li.addEventListener('click', async () => {
        await api('/api/v1/play', {
          method: 'POST',
          body: { cataloguePath: track.cataloguePath ?? item.path },
        });
        tab = 'now';
        nowPlaying = await api('/api/v1/now-playing');
        render();
      });
    } else {
      continue;
    }
    list.appendChild(li);
  }
}

function renderNow(main: Element): void {
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  const badge = nowPlaying?.conversionBadge
    ? `<p class="badge">${esc(String(nowPlaying.conversionBadge))}</p>`
    : '';
  main.innerHTML = `
    <section class="now">
      <p class="eyebrow">Now playing</p>
      <h1>${esc(String(track?.title ?? 'Nothing playing'))}</h1>
      <p class="meta">${esc(String(track?.artist ?? ''))}${track?.album ? ' · ' + esc(String(track.album)) : ''}</p>
      ${badge}
      <div class="transport">
        <button data-cmd="previous">Prev</button>
        <button data-cmd="toggle" class="primary">Play/Pause</button>
        <button data-cmd="next">Next</button>
      </div>
      <label class="vol">Volume
        <input type="range" min="0" max="1" step="0.01" value="${Number(nowPlaying?.volume ?? 0.8)}" id="vol" />
      </label>
    </section>
  `;
  main.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const command = (btn as HTMLElement).dataset.cmd!;
      nowPlaying = await api('/api/v1/transport', { method: 'POST', body: { command } });
      render();
    });
  });
  main.querySelector('#vol')!.addEventListener('change', async (e) => {
    const level = Number((e.target as HTMLInputElement).value);
    nowPlaying = await api('/api/v1/transport', {
      method: 'POST',
      body: { command: 'setVolume', level },
    });
  });
}

async function renderMounts(main: Element): Promise<void> {
  const mounts = (await api('/api/v1/mounts')) as Array<{ path: string; displayName: string }>;
  main.innerHTML = `
    <section class="mounts">
      <h1>Library folders</h1>
      <ul class="list" id="mountList"></ul>
      <form id="addMount">
        <input name="path" placeholder="/path/to/music" required />
        <button class="primary" type="submit">Add</button>
      </form>
      <button id="rescan" class="ghost">Rescan</button>
    </section>
  `;
  const list = main.querySelector('#mountList')!;
  for (const m of mounts) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${esc(m.displayName)}</strong><span>${esc(m.path)}</span>
      <button data-path="${esc(m.path)}" class="ghost danger">Remove</button>`;
    li.querySelector('button')!.addEventListener('click', async () => {
      await api('/api/v1/mounts', { method: 'DELETE', body: { path: m.path } });
      await renderMounts(main);
    });
    list.appendChild(li);
  }
  main.querySelector('#addMount')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target as HTMLFormElement);
    await api('/api/v1/mounts', { method: 'POST', body: { path: String(fd.get('path')) } });
    await renderMounts(main);
  });
  main.querySelector('#rescan')!.addEventListener('click', async () => {
    await api('/api/v1/library/rescan', { method: 'POST', body: {} });
  });
}

async function renderOutput(main: Element): Promise<void> {
  const output = (await api('/api/v1/output')) as {
    devices: Array<{ uid: string; name: string; isExternal: boolean; supportsExclusive: boolean; supportsDop: boolean }>;
    selectedUid: string | null;
    requestedMode: string;
    effectiveMode: string;
    conversionBadge: string | null;
  };
  main.innerHTML = `
    <section class="output">
      <h1>Output</h1>
      <label>Device
        <select id="device">
          <option value="">System default</option>
          ${output.devices
            .map(
              (d) =>
                `<option value="${esc(d.uid)}" ${output.selectedUid === d.uid ? 'selected' : ''}>${esc(d.name)}${d.isExternal ? ' · DAC' : ''}</option>`
            )
            .join('')}
        </select>
      </label>
      <label>Mode
        <select id="mode">
          <option value="shared" ${output.requestedMode === 'shared' ? 'selected' : ''}>Shared</option>
          <option value="exclusive" ${output.requestedMode === 'exclusive' ? 'selected' : ''}>Exclusive</option>
          <option value="dop" ${output.requestedMode === 'dop' ? 'selected' : ''}>DoP</option>
        </select>
      </label>
      <p class="meta">Effective: ${esc(output.effectiveMode)}${output.conversionBadge ? ' · ' + esc(output.conversionBadge) : ''}</p>
      <button id="apply" class="primary">Apply</button>
    </section>
  `;
  main.querySelector('#apply')!.addEventListener('click', async () => {
    const deviceUid = (main.querySelector('#device') as HTMLSelectElement).value || null;
    const mode = (main.querySelector('#mode') as HTMLSelectElement).value;
    await api('/api/v1/output', { method: 'PUT', body: { deviceUid, mode } });
    await renderOutput(main);
  });
}

function updateMini(): void {
  const mini = document.querySelector('#mini');
  if (!mini) return;
  const track = (nowPlaying?.track as Record<string, unknown> | null) ?? null;
  mini.innerHTML = track
    ? `<button type="button" id="miniOpen"><strong>${esc(String(track.title))}</strong> · ${esc(String(track.artist ?? ''))}</button>`
    : `<span>Idle</span>`;
  document.querySelector('#miniOpen')?.addEventListener('click', () => {
    tab = 'now';
    render();
  });
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

void boot();
