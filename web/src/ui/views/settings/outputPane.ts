import type { SettingsApi } from '../../../api/settingsApi';
import type { NetworkDsd, NetworkPlayerFormats, NetworkStream, OutputStatus } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../../core/html';
import { openConfirmDialog, showToast } from '../../overlay';
import type { Pane } from '../settingsView';

/** Players come and go: the list refreshes this often while the pane is open. */
const REFRESH_MS = 4000;

const isNetworkUid = (uid: string | null | undefined) => Boolean(uid?.startsWith('upnp:'));

/** How a network player reads in the device list. */
const networkPlayer = (name: string) => `${name} (Network player)`;

/** Local devices, then network players; a pick that is gone right now stays listed. */
function deviceOptions(output: OutputStatus, value: string): string {
  const option = (uid: string, label: string) =>
    `<option value="${escapeAttr(uid)}" ${uid === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  const local = output.devices.filter((d) => d.kind === 'local');
  const network = output.devices.filter((d) => d.kind === 'network');
  let html = option('', 'System Default');
  if (local.length) {
    html += `<optgroup label="This Host">${local
      .map((d) => option(d.uid, `${d.name}${d.isExternal ? ' · DAC' : ''}`))
      .join('')}</optgroup>`;
  }
  if (network.length) {
    html += `<optgroup label="Network Players">${network
      .map((d) => option(d.uid, networkPlayer(d.name)))
      .join('')}</optgroup>`;
  }
  if (value && !output.devices.some((d) => d.uid === value)) {
    const name = value === output.selectedUid ? (output.selectedName ?? 'Unknown device') : value;
    html += option(
      value,
      isNetworkUid(value) ? `${networkPlayer(name)} · not on the network` : `${name} · not connected`
    );
  }
  return html;
}

/** The choices in the pane that shape what a network player gets. */
interface NetworkChoice {
  stream: NetworkStream;
  dsd: NetworkDsd;
  /** What the picked player lists; undefined until it answered. */
  formats: NetworkPlayerFormats | undefined;
}

const PCM_88 = 'PCM 88.2 kHz / 24-bit';

/** What DSF, DFF and SACD become on the picked network player. */
function dsdNote({ stream, dsd, formats }: NetworkChoice): string {
  if (stream === 'wifi') {
    return 'Wi‑Fi: DSF, DFF and SACD play as PCM 44.1 kHz / 16-bit (about 1.4 Mbit/s), whatever DSD is set to.';
  }
  if (dsd === 'pcm') return `DSF, DFF and SACD play as ${PCM_88}.`;
  if (dsd === 'dop') {
    const volume =
      formats?.volume != null && formats.volume < 0.995
        ? ` The player's volume is at ${Math.round(formats.volume * 100)}\u00a0% now.`
        : '';
    return (
      'DoP packs DSD bit-perfect into 24-bit PCM (DSD64 → 176.4 kHz, about 8.5 Mbit/s). Only for a player ' +
      'that hands PCM untouched to a DAC that plays DoP: volume at 100\u00a0% or fixed, no resampling, no EQ. ' +
      'Otherwise it plays as loud noise — try it with the amp turned down. In DoP mode the remote leaves ' +
      `the player's volume alone.${volume}`
    );
  }
  if (!formats?.online || !formats.listed) {
    return `Auto sends DSF, DFF and SACD untouched when the player lists DSD, else as ${PCM_88}.`;
  }
  const native = formats.nativeDsd;
  if (!native.length) return `This player does not list DSD: DSF, DFF and SACD play as ${PCM_88}.`;
  const lists = `This player lists DSD (${formats.dsd.join(', ')})`;
  if (native.length === 2) return `${lists}: DSF, DFF and SACD go to it untouched.`;
  return native[0] === 'dsf'
    ? `${lists}: DSF goes to it untouched; DFF and SACD play as ${PCM_88}.`
    : `${lists}: DFF and SACD go to it untouched; DSF plays as ${PCM_88}.`;
}

/** What to know about a network pick: offline, discovery trouble, what gets sent. */
function outputNote(output: OutputStatus, deviceUid: string, choice: NetworkChoice): string {
  if (!isNetworkUid(deviceUid)) return '';
  const notes: string[] = [];
  if (deviceUid === output.selectedUid && !output.selectedAvailable) {
    notes.push(
      `${output.selectedName ?? 'This player'} is not on the network right now — it comes back by itself when it is on.`
    );
  }
  if (output.discoveryError) notes.push(`Searching for network players failed: ${output.discoveryError}.`);
  notes.push(
    'The player gets the file untouched when it takes the format, else WAV. Exclusive and DoP under Mode are for DACs on this host.'
  );
  notes.push(dsdNote(choice));
  return notes.map((n) => escapeHtml(n)).join('<br><br>');
}

/** A fixed choice in a select. */
const choice = (value: string, label: string, current: string) =>
  `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;

/** Effective mode and the path the current track takes. */
function statusCells(output: OutputStatus): string {
  const effective = output.selectedKind === 'network' ? 'Network' : output.effectiveMode;
  return `
    <div class="cell"><span>Effective</span><span class="value">${escapeHtml(effective)}</span></div>
    ${
      output.conversionBadge
        ? `<div class="cell"><span>Path</span><span class="value">${escapeHtml(output.conversionBadge)}</span></div>`
        : ''
    }`;
}

/** Device, mode, network stream and DSD; status; apply. */
export class OutputPane implements Pane {
  private refresh: number | undefined;

  constructor(private readonly settings: SettingsApi) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    // Asks the host to search for network players now; new ones show up within seconds.
    let output = await this.settings.discoverOutput();

    root.innerHTML = `
      <p class="group-label">Playback Destination</p>
      <div class="group">
        <div class="cell">
          <label for="device">Device</label>
          <select id="device">${deviceOptions(output, output.selectedUid ?? '')}</select>
        </div>
        <div class="cell">
          <label for="mode">Mode</label>
          <select id="mode">
            ${choice('shared', 'Shared', output.requestedMode)}
            ${choice('exclusive', 'Exclusive', output.requestedMode)}
            ${choice('dop', 'DoP', output.requestedMode)}
          </select>
        </div>
        <div class="cell" data-stream-cell>
          <label for="stream">Network Stream</label>
          <select id="stream">
            ${choice('full', 'Full', output.networkStream)}
            ${choice('wifi', 'Wi‑Fi', output.networkStream)}
          </select>
        </div>
        <div class="cell" data-dsd-cell>
          <label for="dsd">DSD</label>
          <select id="dsd">
            ${choice('auto', 'Auto', output.networkDsd)}
            ${choice('pcm', 'PCM', output.networkDsd)}
            ${choice('dop', 'DoP', output.networkDsd)}
          </select>
        </div>
      </div>
      <p class="footer-note" data-note></p>
      <p class="group-label">Status</p>
      <div class="group" data-status>${statusCells(output)}</div>
      <div class="group">
        <button type="button" class="cell cell-action" data-apply>Apply Changes</button>
      </div>
      <p class="footer-note">Exclusive and DoP work best with backend native (Core Audio / ALSA / WASAPI).</p>
    `;

    const device = required<HTMLSelectElement>(root, '#device');
    const mode = required<HTMLSelectElement>(root, '#mode');
    const stream = required<HTMLSelectElement>(root, '#stream');
    const dsd = required<HTMLSelectElement>(root, '#dsd');
    const streamCell = required(root, '[data-stream-cell]');
    const dsdCell = required(root, '[data-dsd-cell]');
    const note = required(root, '[data-note]');
    const status = required(root, '[data-status]');

    /** What each network player lists, as it answered. */
    const formats = new Map<string, NetworkPlayerFormats>();
    /** DSD was changed by hand since the device was picked — keep it. */
    let dsdTouched = false;

    // A network player has no Exclusive / DoP mode; it has the stream and DSD choices instead.
    const reflectPick = () => {
      const toNetwork = isNetworkUid(device.value);
      mode.disabled = toNetwork;
      streamCell.hidden = !toNetwork;
      dsdCell.hidden = !toNetwork;
      // Wi‑Fi makes every DSD track 44.1 kHz PCM.
      dsd.disabled = stream.value === 'wifi';
      note.innerHTML = outputNote(output, device.value, {
        stream: stream.value as NetworkStream,
        dsd: dsd.value as NetworkDsd,
        formats: formats.get(device.value),
      });
      note.hidden = !note.innerHTML;
    };

    const loadFormats = async (uid: string) => {
      if (!isNetworkUid(uid)) return;
      let answer: NetworkPlayerFormats;
      try {
        answer = await this.settings.networkFormats(uid);
      } catch {
        return;
      }
      formats.set(uid, answer);
      if (!root.isConnected || device.value !== uid) return;
      // Each player keeps its own DSD mode.
      if (!dsdTouched) dsd.value = answer.dsdMode;
      reflectPick();
    };

    device.addEventListener('change', () => {
      dsdTouched = false;
      const known = formats.get(device.value)?.dsdMode;
      dsd.value = device.value === output.selectedUid ? output.networkDsd : (known ?? 'auto');
      reflectPick();
      void loadFormats(device.value);
    });
    stream.addEventListener('change', reflectPick);
    dsd.addEventListener('change', () => {
      dsdTouched = true;
      reflectPick();
      // The note shows the player's volume for DoP.
      if (dsd.value === 'dop') void loadFormats(device.value);
    });
    reflectPick();
    void loadFormats(device.value);

    this.refresh = window.setInterval(async () => {
      if (!root.isConnected) {
        this.dispose();
        return;
      }
      try {
        output = await this.settings.output();
      } catch {
        return;
      }
      status.innerHTML = statusCells(output);
      if (document.activeElement === device) return;
      const value = device.value;
      device.innerHTML = deviceOptions(output, value);
      device.value = value;
      reflectPick();
    }, REFRESH_MS);

    const apply = async () => {
      const toNetwork = isNetworkUid(device.value);
      try {
        await this.settings.setOutput({
          deviceUid: device.value || null,
          mode: mode.value,
          networkStream: stream.value as NetworkStream,
          networkDsd: toNetwork ? (dsd.value as NetworkDsd) : undefined,
        });
        showToast('Output updated');
      } catch (err) {
        showToast(errorMessage(err, 'Could not change the output'), { error: true });
      }
      await this.render(root);
    };

    required(root, '[data-apply]').addEventListener('click', () => {
      // DoP goes out with Full only (Wi‑Fi makes DSD PCM).
      const dopNow =
        device.value === output.selectedUid && output.networkDsd === 'dop' && output.networkStream === 'full';
      const dopNext = isNetworkUid(device.value) && dsd.value === 'dop' && stream.value === 'full';
      // A player that changes the samples turns DoP into loud noise: ask when it is turned on.
      if (dopNext && !dopNow) {
        openConfirmDialog({
          title: 'Use DoP?',
          message:
            'If the player changes the samples — volume below 100\u00a0%, resampling, EQ — DoP plays as loud noise. Turn the amp down before the first DSD track.',
          confirmLabel: 'Use DoP',
          onConfirm: apply,
        });
        return;
      }
      void apply();
    });
  }

  dispose(): void {
    window.clearInterval(this.refresh);
    this.refresh = undefined;
  }
}
