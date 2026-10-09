import './pairPhone.css';
import qrcode from 'qrcode-generator';
import type { PhoneLinkStatus, PhoneRemoteLink } from './phoneRemoteLink.js';

/**
 * "Pair phone": the QR code a presenter scans to turn their phone into the
 * clicker and notes screen, with the link spelled out, who is connected, and
 * "Disconnect phones".
 *
 * Built on the shared `.app-dialog` chrome. It can be open over the audience
 * surface (presenting in one window), so it swallows its own clicks and keys:
 * pressing "Done" must not also advance the slide behind it. For the same
 * reason it closes itself shortly after a phone connects — the code should
 * not sit on a projector longer than it takes to scan it.
 */

/** A QR code as crisp SVG: one path, white quiet zone, scales to any size. */
export function qrSvgMarkup(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code for the phone remote">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

function phonesLabel(count: number): string {
  return count === 1 ? 'Phone connected' : `${count} phones connected`;
}

export interface PairPhoneDialog {
  update(status: PhoneLinkStatus): void;
  close(): void;
  readonly closed: boolean;
}

/** How long "Phone connected" stays up before the panel gets out of the way. */
const CLOSE_AFTER_PAIRED_MS = 1200;

export function openPairPhoneDialog(link: PhoneRemoteLink, onClose: () => void): PairPhoneDialog {
  const backdrop = document.createElement('div');
  backdrop.className = 'app-dialog-backdrop pair-phone-backdrop';
  const dialog = document.createElement('section');
  dialog.className = 'app-dialog pair-phone-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'pair-phone-title');
  dialog.innerHTML = `
    <h2 id="pair-phone-title">Pair phone</h2>
    <p class="pair-phone-lede">Scan with your phone's camera to use it as a clicker with notes, previews and timers.</p>
    <div class="pair-phone-code" aria-live="polite"></div>
    <div class="pair-phone-link"><code></code><button type="button" class="pair-phone-copy">Copy link</button></div>
    <p class="pair-phone-status" aria-live="polite"></p>
    <div class="app-dialog-actions">
      <button type="button" class="pair-phone-disconnect danger">Disconnect phones</button>
      <button type="button" class="pair-phone-done primary">Done</button>
    </div>
  `;
  backdrop.appendChild(dialog);

  const codeHost = dialog.querySelector<HTMLElement>('.pair-phone-code')!;
  const linkText = dialog.querySelector<HTMLElement>('.pair-phone-link code')!;
  const copy = dialog.querySelector<HTMLButtonElement>('.pair-phone-copy')!;
  const statusLine = dialog.querySelector<HTMLElement>('.pair-phone-status')!;
  const disconnect = dialog.querySelector<HTMLButtonElement>('.pair-phone-disconnect')!;
  const done = dialog.querySelector<HTMLButtonElement>('.pair-phone-done')!;

  let closed = false;
  let shownUrl: string | null = null;
  let phonesAtOpen = link.status().phones;
  let autoClose: ReturnType<typeof setTimeout> | null = null;
  let latest = link.status();

  function close(): void {
    if (closed) return;
    closed = true;
    if (autoClose) clearTimeout(autoClose);
    clearInterval(refresh);
    backdrop.remove();
    onClose();
  }

  function render(status: PhoneLinkStatus): void {
    latest = status;
    const url = status.pairing?.url ?? null;
    if (url !== shownUrl) {
      shownUrl = url;
      if (url) codeHost.innerHTML = qrSvgMarkup(url);
      else codeHost.replaceChildren(Object.assign(document.createElement('span'), {
        className: 'pair-phone-placeholder',
        textContent: status.online ? 'Making a code…' : 'Connecting to the server…',
      }));
      linkText.textContent = url ?? '';
      copy.disabled = !url;
    }
    const minutes = status.pairing ? Math.max(1, Math.round((status.pairing.expiresAt - Date.now()) / 60_000)) : 0;
    statusLine.classList.toggle('connected', status.phones > 0);
    statusLine.textContent = !status.online
      ? 'Waiting for the server…'
      : status.phones > 0
        ? `${phonesLabel(status.phones)}.`
        : status.pairing ? `Waiting for a phone. This code works for ${minutes} min.` : '';
    disconnect.disabled = status.phones === 0;
    if (status.phones > phonesAtOpen && !autoClose) {
      autoClose = setTimeout(close, CLOSE_AFTER_PAIRED_MS);
    }
    phonesAtOpen = Math.min(phonesAtOpen, status.phones);
  }

  // Keep the code fresh while the panel is up; the relay hands back the same
  // code until it is close to expiry, so this never invalidates a scan.
  const refresh = setInterval(() => {
    link.requestPairing();
    render(latest);
  }, 30_000);

  copy.addEventListener('click', () => {
    if (shownUrl) void navigator.clipboard?.writeText(shownUrl).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
    }, () => {});
  });
  disconnect.addEventListener('click', () => {
    link.disconnectPhones();
    phonesAtOpen = 0;
  });
  done.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    event.stopPropagation();
    if (event.target === backdrop) close();
  });
  for (const type of ['pointerdown', 'dblclick'] as const) {
    backdrop.addEventListener(type, (event) => event.stopPropagation());
  }
  backdrop.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  document.body.appendChild(backdrop);
  render(link.status());
  link.requestPairing();
  done.focus();

  return {
    update: (status) => { if (!closed) render(status); },
    close,
    get closed() { return closed; },
  };
}
