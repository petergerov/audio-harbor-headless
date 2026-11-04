import { errorMessage } from '../../core/errors';
import { escapeAttr, required } from '../../core/html';
import { openPanel, showToast } from '../overlay';

export interface ShareForm {
  server: string;
  share: string;
  domain: string;
  user: string;
  password: string;
  name: string;
}

/** Same rule as the host's helper: letters, digits, . _ - */
function nameFrom(share: string): string {
  return (
    share
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+|-+$/g, '')
      .slice(0, 32) || 'share'
  );
}

/** Server, share and login of an SMB share; `onConfirm` mounts it — its error shows and the form stays. */
export function openShareDialog(opts: {
  onConfirm: (form: ShareForm) => Promise<void>;
  /** A known share (one mounted by hand): server and share are set and cannot be changed. */
  known?: { server: string; share: string; name: string };
}): void {
  const known = opts.known;
  const primaryLabel = known ? 'Set Up' : 'Add';
  let busy = false;
  let form: HTMLFormElement | null = null;
  let close = () => {};
  const submit = async () => {
    if (!form || busy) return;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const value = (key: string) => String(data.get(key) ?? '').trim();
    const share = value('share').replace(/^\/+|\/+$/g, '');
    const values: ShareForm = {
      server: value('server').replace(/^(smb:)?\/+/i, '').replace(/\/.*$/, ''),
      share,
      domain: value('domain'),
      user: value('user'),
      password: String(data.get('password') ?? ''),
      name: value('name') || nameFrom(share),
    };
    busy = true;
    const button = document.querySelector<HTMLButtonElement>('#ah-overlay [data-primary]');
    if (button) button.textContent = 'Connecting…';
    try {
      await opts.onConfirm(values);
      close();
    } catch (err) {
      // Stays open: fix the password or server and try again.
      showToast(errorMessage(err, 'Could not mount the share'), { error: true });
    } finally {
      busy = false;
      if (button) button.textContent = primaryLabel;
    }
  };

  const fixed = (value: string | undefined) =>
    value === undefined ? '' : `value="${escapeAttr(value)}" readonly`;
  openPanel({
    title: known ? `Auto-Mount //${known.server}/${known.share}` : 'Network Share',
    subtitle: known ? 'The login for the share — Harbor mounts it on its own from now on' : 'SMB — NAS, Windows, macOS, Samba',
    primaryLabel,
    bodyHtml: `
      <form class="ah-form share-form" autocomplete="off">
        <input class="ah-input" name="server" required placeholder="Server — nas.local or 192.168.1.10"
          aria-label="Server" autocapitalize="off" spellcheck="false" ${fixed(known?.server)} />
        <input class="ah-input" name="share" required placeholder="Share — music" aria-label="Share"
          autocapitalize="off" spellcheck="false" ${fixed(known?.share)} />
        <input class="ah-input" name="user" placeholder="User (empty: guest)" aria-label="User"
          autocapitalize="off" spellcheck="false" />
        <input class="ah-input" name="password" type="password" placeholder="Password" aria-label="Password" />
        <input class="ah-input" name="domain" placeholder="Domain / workgroup (optional)" aria-label="Domain"
          autocapitalize="off" spellcheck="false" />
        <input class="ah-input" name="name" placeholder="Name on the host (default: share)" aria-label="Name"
          pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,31}" autocapitalize="off" spellcheck="false"
          ${known ? `value="${escapeAttr(known.name)}"` : ''} />
        <p class="share-note">Mounted read-only under /mnt/harbor and kept in /etc/fstab. The password is stored for root only, not in fstab.</p>
        <button type="submit" hidden></button>
      </form>
    `,
    onPrimary: submit,
    bind: (root, closePanel) => {
      close = closePanel;
      form = required<HTMLFormElement>(root, 'form');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submit();
      });
      queueMicrotask(() => form?.querySelector<HTMLInputElement>(known ? '[name=user]' : '[name=server]')?.focus());
    },
  });
}
