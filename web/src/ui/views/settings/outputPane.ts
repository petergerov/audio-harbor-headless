import type { SettingsApi } from '../../../api/settingsApi';
import type { NetworkStream, OutputStatus } from '../../../api/types';
import { errorMessage } from '../../../core/errors';
import { escapeAttr, escapeHtml, required } from '../../../core/html';
import { showToast } from '../../overlay';
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

/** What to know about a network pick: offline, discovery trouble, what gets sent. */
function outputNote(output: OutputStatus, deviceUid: string): string {
  if (!isNetworkUid(deviceUid)) return '';
  const notes: string[] = [];
  if (deviceUid === output.selectedUid && !output.selectedAvailable) {
    notes.push(
      `${output.selectedName ?? 'This player'} is not on the network right now — it comes back by itself when it is on.`
    );
  }
  if (output.discoveryError) notes.push(`Searching for network players failed: ${output.discoveryError}.`);
  notes.push(
    'The player gets the file untouched when it takes the format, else 24-bit WAV. DSD and SACD play as PCM: 88.2 kHz / 24-bit (Full) or 44.1 kHz / 16-bit (Wi‑Fi, about 1.4 instead of 4.2 Mbit/s). Exclusive and DoP are for DACs on this host.'
  );
  return notes.map((n) => escapeHtml(n)).join('<br><br>');
}

/** A fixed choice in a select. */
const choice = (value: string, label: string, current: string) =>
  `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;

/** Device, mode and network stream; status; apply. */
export class OutputPane implements Pane {
  private refresh: number | undefined;

  constructor(private readonly settings: SettingsApi) {}

  async render(root: HTMLElement): Promise<void> {
    this.dispose();
    // Asks the host to search for network players now; new ones show up within seconds.
    let output = await this.settings.discoverOutput();
    const network = output.selectedKind === 'network';

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
      </div>
      <p class="footer-note" data-note></p>
      <p class="group-label">Status</p>
      <div class="group">
        <div class="cell"><span>Effective</span><span class="value">${escapeHtml(network ? 'Network' : output.effectiveMode)}</span></div>
        ${
          output.conversionBadge
            ? `<div class="cell"><span>Path</span><span class="value">${escapeHtml(output.conversionBadge)}</span></div>`
            : ''
        }
      </div>
      <div class="group">
        <button type="button" class="cell cell-action" data-apply>Apply Changes</button>
      </div>
      <p class="footer-note">Exclusive and DoP work best with backend native (Core Audio / ALSA / WASAPI).</p>
    `;

    const device = required<HTMLSelectElement>(root, '#device');
    const mode = required<HTMLSelectElement>(root, '#mode');
    const stream = required<HTMLSelectElement>(root, '#stream');
    const streamCell = required(root, '[data-stream-cell]');
    const note = required(root, '[data-note]');

    // A network player has no Exclusive / DoP; it has the stream choice instead.
    const reflectPick = () => {
      const toNetwork = isNetworkUid(device.value);
      mode.disabled = toNetwork;
      streamCell.hidden = !toNetwork;
      note.innerHTML = outputNote(output, device.value);
      note.hidden = !note.innerHTML;
    };
    device.addEventListener('change', reflectPick);
    reflectPick();

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
      if (document.activeElement === device) return;
      const value = device.value;
      device.innerHTML = deviceOptions(output, value);
      device.value = value;
      reflectPick();
    }, REFRESH_MS);

    required(root, '[data-apply]').addEventListener('click', async () => {
      try {
        await this.settings.setOutput({
          deviceUid: device.value || null,
          mode: mode.value,
          networkStream: stream.value as NetworkStream,
        });
        showToast('Output updated');
      } catch (err) {
        showToast(errorMessage(err, 'Could not change the output'), { error: true });
      }
      await this.render(root);
    });
  }

  dispose(): void {
    window.clearInterval(this.refresh);
    this.refresh = undefined;
  }
}
