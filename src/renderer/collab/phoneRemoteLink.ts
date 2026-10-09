import {
  REMOTE_CLOSE,
  REMOTE_SOCKET_PATH,
  remoteOrigin,
  remoteUrl,
  type RelayToPresenter,
  type RemoteCommand,
  type RemoteState,
} from '@shared/phoneRemote.js';

/**
 * The presenting page's end of the phone relay (server/phoneRemote.ts).
 *
 * Opened the first time someone asks to pair a phone, and from then on for as
 * long as this page presents. It publishes where the show is and hands
 * commands from paired phones to whatever this page would do with its own
 * buttons — the page stays the authority; the relay only carries messages.
 *
 * A dropped socket is reopened with the session's key, so a laptop's network
 * blip mid-talk leaves the phone paired: the relay holds the session for a
 * minute (PRESENTER_GRACE_MS) waiting for exactly this page to come back.
 */

export interface PhoneLinkStatus {
  /** The relay socket is up and has a session. */
  online: boolean;
  /** What the QR should show, once the relay has issued a code. */
  pairing: { url: string; expiresAt: number } | null;
  /** Phones currently connected. */
  phones: number;
}

export interface PhoneRemoteLinkOptions {
  deckId: string;
  onCommand: (command: RemoteCommand) => void;
  onStatus: (status: PhoneLinkStatus) => void;
  /** The page whose origin and path the remote URL is built from. */
  pageUrl?: string;
  /** Override for tests; defaults to this page's own server. */
  socketUrl?: string;
}

export interface PhoneRemoteLink {
  status(): PhoneLinkStatus;
  /** Ask the relay for a pairing code (the current one when it has time left). */
  requestPairing(): void;
  publishState(state: RemoteState): void;
  /** The deck or its theme changed; phones re-read the snapshot. */
  deckChanged(): void;
  /** Revoke every phone and the code on screen. */
  disconnectPhones(): void;
  /** The presentation is over: tell the relay so the code dies now, not in a minute. */
  close(): void;
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];

export function createPhoneRemoteLink(options: PhoneRemoteLinkOptions): PhoneRemoteLink {
  const pageUrl = options.pageUrl ?? location.href;
  const page = new URL(pageUrl);
  const socketUrl = options.socketUrl
    ?? `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}${REMOTE_SOCKET_PATH}`
      + `?role=presenter&deck=${encodeURIComponent(options.deckId)}`;

  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let session: { id: string; key: string } | null = null;
  let origins: string[] = [];
  /** Whether a code has been asked for; a reconnect that lost the session asks again. */
  let wantPairing = false;
  let lastState: RemoteState | null = null;
  let current: PhoneLinkStatus = { online: false, pairing: null, phones: 0 };

  const update = (patch: Partial<PhoneLinkStatus>): void => {
    current = { ...current, ...patch };
    options.onStatus(current);
  };

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN && session) socket.send(JSON.stringify(message));
  };

  function connect(): void {
    if (closed) return;
    const ws = new WebSocket(socketUrl);
    socket = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ kind: 'open', ...(session ? { resume: { session: session.id, key: session.key } } : {}) }));
    });
    ws.addEventListener('message', (event) => {
      let message: RelayToPresenter;
      try {
        message = JSON.parse(String(event.data)) as RelayToPresenter;
      } catch {
        return;
      }
      if (message.kind === 'session') {
        attempt = 0;
        const lost = !message.resumed;
        session = { id: message.session, key: message.key };
        origins = message.origins;
        update({ online: true, ...(lost ? { pairing: null, phones: 0 } : {}) });
        if (lastState) send({ kind: 'state', state: lastState, now: Date.now() });
        if (wantPairing && (lost || !current.pairing)) send({ kind: 'pair' });
        return;
      }
      if (message.kind === 'pairing') {
        update({
          pairing: {
            url: remoteUrl(pageUrl, remoteOrigin(page.origin, origins), message.token),
            // The relay's clock, moved onto ours.
            expiresAt: Date.now() + (message.expiresAt - message.now),
          },
        });
        return;
      }
      if (message.kind === 'phones') {
        update({ phones: message.count });
        return;
      }
      if (message.kind === 'command') options.onCommand(message.command);
    });
    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      socket = null;
      update({ online: false });
      // Refused outright (no access to this deck): retrying cannot help.
      if (closed || event.code === REMOTE_CLOSE.forbidden) return;
      const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    });
  }

  connect();

  return {
    status: () => current,
    requestPairing() {
      wantPairing = true;
      send({ kind: 'pair' });
    },
    publishState(state) {
      lastState = state;
      send({ kind: 'state', state, now: Date.now() });
    },
    deckChanged() {
      send({ kind: 'deckChanged' });
    },
    disconnectPhones() {
      send({ kind: 'revoke' });
      update({ pairing: null, phones: 0 });
      // The code on screen died with the phones; put a fresh one up if the
      // panel is still asking for one.
      if (wantPairing) send({ kind: 'pair' });
    },
    close() {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      send({ kind: 'end' });
      socket?.close(1000, 'presentation ended');
      socket = null;
    },
  };
}
