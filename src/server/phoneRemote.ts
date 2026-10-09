import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PAIRING_CODE_REFRESH_MS,
  PAIRING_CODE_TTL_MS,
  PhoneMessageSchema,
  PRESENTER_GRACE_MS,
  PresenterMessageSchema,
  REMOTE_CLOSE,
  SESSION_MAX_LIFETIME_MS,
  rebaseState,
  type RelayToPhone,
  type RelayToPresenter,
  type RemoteDeckSnapshot,
  type RemoteState,
} from '../shared/phoneRemote.js';

/**
 * The server half of presenting from a phone: who is paired with which
 * presentation, and the socket relay between them. See shared/phoneRemote.ts
 * for the model; this file holds the secrets and the sockets.
 *
 * Kept out of collabServer.ts on purpose. The relay never touches a room, a
 * transaction or a deck file — it only reads a snapshot to show the phone —
 * so the collaboration server needs nothing more than to hand it its
 * upgrades and tell it who may open which deck.
 */

/** 128 bits from the OS CSPRNG, URL-safe: unguessable, and short enough for a small QR. */
export function newSecret(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

export interface RemoteSession {
  id: string;
  deckId: string;
  /** Proves a reconnecting presenter socket is the page that opened this session. */
  key: string;
  createdAt: number;
  /** The code the QR shows right now, if one has been shown. */
  code: { token: string; expiresAt: number } | null;
  /** Device keys handed to phones that joined. */
  devices: Set<string>;
  /** When the presenter's socket dropped; null while it is connected. */
  presenterGoneAt: number | null;
  ended: boolean;
}

/**
 * Token bookkeeping with no sockets in it, so issuing, expiry and revocation
 * are testable against a fake clock.
 */
export class RemoteSessions {
  private readonly sessions = new Map<string, RemoteSession>();
  private readonly byCode = new Map<string, RemoteSession>();
  private readonly byDevice = new Map<string, RemoteSession>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly secret: () => string = () => newSecret(),
  ) {}

  /** A new session for a presentation that is starting. */
  open(deckId: string): RemoteSession {
    const session: RemoteSession = {
      id: this.secret(),
      deckId,
      key: newSecret(24),
      createdAt: this.now(),
      code: null,
      devices: new Set(),
      presenterGoneAt: null,
      ended: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** The presenter's page coming back after a dropped socket. */
  resume(id: string, key: string, deckId: string): RemoteSession | null {
    const session = this.sessions.get(id);
    if (!session || !this.live(session) || session.key !== key || session.deckId !== deckId) return null;
    session.presenterGoneAt = null;
    return session;
  }

  get(id: string): RemoteSession | undefined {
    return this.sessions.get(id);
  }

  /** Whether anything about this session may still be used. */
  live(session: RemoteSession): boolean {
    const now = this.now();
    if (session.ended) return false;
    if (now >= session.createdAt + SESSION_MAX_LIFETIME_MS) return false;
    if (session.presenterGoneAt !== null && now >= session.presenterGoneAt + PRESENTER_GRACE_MS) return false;
    return true;
  }

  /**
   * The code to put in the QR. Showing the panel again reuses a code with
   * time left, so two glances at it do not invalidate a phone mid-scan; one
   * close to expiry is replaced first.
   */
  pairingCode(session: RemoteSession): { token: string; expiresAt: number } {
    const now = this.now();
    if (session.code && session.code.expiresAt - now > PAIRING_CODE_REFRESH_MS) return session.code;
    if (session.code) this.byCode.delete(session.code.token);
    session.code = { token: this.secret(), expiresAt: now + PAIRING_CODE_TTL_MS };
    this.byCode.set(session.code.token, session);
    return session.code;
  }

  /** A phone scanning the QR: its own device key, or null if the code is no good. */
  join(token: string): { session: RemoteSession; device: string } | null {
    const session = this.byCode.get(token);
    if (!session || !session.code || session.code.token !== token) return null;
    if (!this.live(session) || this.now() >= session.code.expiresAt) return null;
    const device = this.secret();
    session.devices.add(device);
    this.byDevice.set(device, session);
    return { session, device };
  }

  /** A paired phone reconnecting with the key its join handed it. */
  rejoin(device: string): RemoteSession | null {
    const session = this.byDevice.get(device);
    if (!session || !session.devices.has(device) || !this.live(session)) return null;
    return session;
  }

  /** Checked on every command, not just at join: revocation must bite immediately. */
  authorizes(session: RemoteSession, device: string): boolean {
    return this.byDevice.get(device) === session && session.devices.has(device) && this.live(session);
  }

  /** "Disconnect phones": every device key and the current code stop working. */
  revoke(session: RemoteSession): void {
    for (const device of session.devices) this.byDevice.delete(device);
    session.devices.clear();
    if (session.code) this.byCode.delete(session.code.token);
    session.code = null;
  }

  presenterLeft(session: RemoteSession): void {
    session.presenterGoneAt = this.now();
  }

  end(session: RemoteSession): void {
    this.revoke(session);
    session.ended = true;
    this.sessions.delete(session.id);
  }

  /** Sessions that are no longer live but have not been ended yet. */
  expired(): RemoteSession[] {
    return [...this.sessions.values()].filter((session) => !this.live(session));
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface PhoneRemoteRelayOptions {
  /**
   * Whether this connection may see this deck at all. On an `--access`
   * server that is the same tailnet-identity check every deck route makes:
   * a code proves the presenter's say-so, it does not stand in for access.
   */
  authorize: (request: IncomingMessage, deckId: string) => Promise<boolean>;
  /** The deck as the phone should render it. */
  snapshot: (deckId: string) => Promise<RemoteDeckSnapshot>;
  /** Addresses this server answers on, for a presenter that reached it on loopback. */
  origins: () => string[];
  now?: () => number;
}

/** Enough for a presenter, a co-presenter and a spare; a crowd is a mistake. */
const MAX_PHONES_PER_SESSION = 8;
/** A socket that has not said who it is by now is not going to. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

interface PhoneSocket {
  socket: WebSocket;
  device: string;
}

export class PhoneRemoteRelay {
  readonly sessions: RemoteSessions;
  private readonly now: () => number;
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
  private readonly presenters = new Map<string, WebSocket>();
  private readonly phones = new Map<string, Set<PhoneSocket>>();
  /** The latest state per session, on the server's clock. */
  private readonly states = new Map<string, RemoteState>();
  private readonly deckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly options: PhoneRemoteRelayOptions) {
    this.now = options.now ?? (() => Date.now());
    this.sessions = new RemoteSessions(this.now);
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref?.();
  }

  /** Take an HTTP upgrade for REMOTE_SOCKET_PATH. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const role = url.searchParams.get('role');
    const deckId = url.searchParams.get('deck');
    if (role !== 'presenter' && role !== 'phone') {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (role === 'presenter') this.bindPresenter(ws, request, deckId);
      else this.bindPhone(ws, request);
    });
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const timer of this.deckTimers.values()) clearTimeout(timer);
    this.deckTimers.clear();
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
  }

  /* --- presenter ----------------------------------------------------------- */

  private bindPresenter(ws: WebSocket, request: IncomingMessage, deckId: string | null): void {
    let session: RemoteSession | null = null;
    const timeout = setTimeout(() => ws.close(4000, 'no open frame'), FIRST_FRAME_TIMEOUT_MS);
    // Frames are handled strictly in order: the access check on `open` is
    // asynchronous, and a `pair` behind it must not see a half-open session.
    let queue = Promise.resolve();
    ws.on('message', (raw) => {
      queue = queue.then(() => handle(raw)).catch(() => ws.close(1011, 'relay error'));
    });

    const handle = async (raw: unknown): Promise<void> => {
      let message;
      try {
        message = PresenterMessageSchema.parse(JSON.parse(String(raw)));
      } catch {
        return;
      }
      if (message.kind === 'open') {
        if (session) return;
        clearTimeout(timeout);
        if (!deckId || !(await this.options.authorize(request, deckId))) {
          ws.close(REMOTE_CLOSE.forbidden, 'you do not have access to this deck');
          return;
        }
        if (ws.readyState !== ws.OPEN) return;
        const resumed = message.resume
          ? this.sessions.resume(message.resume.session, message.resume.key, deckId)
          : null;
        session = resumed ?? this.sessions.open(deckId);
        // One presenter socket per session: a page that reconnected while its
        // old socket was still half-dead replaces it.
        const previous = this.presenters.get(session.id);
        this.presenters.set(session.id, ws);
        if (previous && previous !== ws) previous.close(4000, 'replaced');
        sendTo(ws, {
          kind: 'session',
          session: session.id,
          key: session.key,
          resumed: Boolean(resumed),
          origins: this.options.origins(),
        });
        sendTo(ws, { kind: 'phones', count: this.phones.get(session.id)?.size ?? 0 });
        if (resumed) this.toPhones(session.id, { kind: 'presenter', connected: true });
        return;
      }
      if (!session || !this.sessions.live(session)) return;
      switch (message.kind) {
        case 'pair': {
          const code = this.sessions.pairingCode(session);
          sendTo(ws, { kind: 'pairing', token: code.token, expiresAt: code.expiresAt, now: this.now() });
          return;
        }
        case 'state': {
          const state = rebaseState(message.state, message.now, this.now());
          this.states.set(session.id, state);
          this.toPhones(session.id, { kind: 'state', state, now: this.now() });
          return;
        }
        case 'deckChanged':
          this.scheduleDeck(session);
          return;
        case 'revoke':
          this.disconnectPhones(session, 'The presenter disconnected this phone.');
          sendTo(ws, { kind: 'phones', count: 0 });
          return;
        case 'end':
          this.endSession(session, 'The presentation ended.');
          return;
      }
    };

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!session || this.presenters.get(session.id) !== ws) return;
      this.presenters.delete(session.id);
      if (session.ended) return;
      this.sessions.presenterLeft(session);
      this.toPhones(session.id, { kind: 'presenter', connected: false });
      // Look again once the grace period is up, rather than on the next sweep.
      setTimeout(() => this.sweep(), PRESENTER_GRACE_MS + 50).unref?.();
    });
  }

  /* --- phone --------------------------------------------------------------- */

  private bindPhone(ws: WebSocket, request: IncomingMessage): void {
    let joined: { session: RemoteSession; entry: PhoneSocket } | null = null;
    const timeout = setTimeout(() => ws.close(4000, 'no join frame'), FIRST_FRAME_TIMEOUT_MS);
    const refuse = (code: number, reason: string): void => {
      sendTo(ws, { kind: 'refused', reason });
      ws.close(code, reason);
    };
    let queue = Promise.resolve();
    ws.on('message', (raw) => {
      queue = queue.then(() => handle(raw)).catch(() => ws.close(1011, 'relay error'));
    });

    const handle = async (raw: unknown): Promise<void> => {
      let message;
      try {
        message = PhoneMessageSchema.parse(JSON.parse(String(raw)));
      } catch {
        // Before it has joined, a socket that cannot speak the protocol is
        // shown the door; after, a stray frame is dropped like anywhere else.
        if (!joined) refuse(REMOTE_CLOSE.unpaired, 'not a remote');
        return;
      }
      if (message.kind === 'join') {
        if (joined) return;
        clearTimeout(timeout);
        let session: RemoteSession | null = null;
        let device: string | null = null;
        if (message.device) {
          session = this.sessions.rejoin(message.device);
          device = session ? message.device : null;
        }
        if (!session && message.token) {
          const fresh = this.sessions.join(message.token);
          if (fresh) ({ session, device } = fresh);
        }
        if (!session || !device) {
          refuse(REMOTE_CLOSE.unpaired, 'This pairing code has expired or was revoked.');
          return;
        }
        if (!(await this.options.authorize(request, session.deckId))) {
          refuse(REMOTE_CLOSE.forbidden, 'You do not have access to this presentation.');
          return;
        }
        const set = this.phones.get(session.id) ?? new Set<PhoneSocket>();
        if (set.size >= MAX_PHONES_PER_SESSION) {
          refuse(REMOTE_CLOSE.unpaired, 'Too many phones are paired with this presentation.');
          return;
        }
        if (ws.readyState !== ws.OPEN) return;
        const entry = { socket: ws, device };
        set.add(entry);
        this.phones.set(session.id, set);
        joined = { session, entry };
        sendTo(ws, { kind: 'joined', device, presenter: this.presenters.has(session.id) });
        try {
          sendTo(ws, { kind: 'deck', ...(await this.options.snapshot(session.deckId)) });
        } catch {
          // The deck is unreadable right now; the next deckChanged retries.
        }
        const state = this.states.get(session.id);
        if (state) sendTo(ws, { kind: 'state', state, now: this.now() });
        this.countPhones(session.id);
        return;
      }
      // A command: the device key on the frame, not the socket it came in on,
      // is what is checked — a revoked key stops working on its very next press.
      if (!joined || !this.sessions.authorizes(joined.session, message.device)
        || message.device !== joined.entry.device) {
        refuse(REMOTE_CLOSE.unpaired, 'This phone is no longer paired.');
        return;
      }
      const presenter = this.presenters.get(joined.session.id);
      if (!presenter) {
        sendTo(ws, { kind: 'presenter', connected: false });
        return;
      }
      sendTo(presenter, { kind: 'command', command: message.command });
    };

    ws.on('close', () => {
      clearTimeout(timeout);
      if (!joined) return;
      this.phones.get(joined.session.id)?.delete(joined.entry);
      this.countPhones(joined.session.id);
    });
  }

  /* --- sessions ------------------------------------------------------------ */

  private countPhones(sessionId: string): void {
    const presenter = this.presenters.get(sessionId);
    if (presenter) sendTo(presenter, { kind: 'phones', count: this.phones.get(sessionId)?.size ?? 0 });
  }

  private toPhones(sessionId: string, message: RelayToPhone): void {
    for (const phone of this.phones.get(sessionId) ?? []) sendTo(phone.socket, message);
  }

  /** Edits during a talk can arrive many to the second; phones need the last one. */
  private scheduleDeck(session: RemoteSession): void {
    if (this.deckTimers.has(session.id)) return;
    this.deckTimers.set(session.id, setTimeout(() => {
      this.deckTimers.delete(session.id);
      if (!this.phones.get(session.id)?.size) return;
      void this.options.snapshot(session.deckId).then(
        (snapshot) => this.toPhones(session.id, { kind: 'deck', ...snapshot }),
        () => {},
      );
    }, 300));
  }

  private disconnectPhones(session: RemoteSession, reason: string): void {
    this.sessions.revoke(session);
    for (const phone of this.phones.get(session.id) ?? []) {
      sendTo(phone.socket, { kind: 'refused', reason });
      phone.socket.close(REMOTE_CLOSE.ended, reason);
    }
    this.phones.delete(session.id);
  }

  private endSession(session: RemoteSession, reason: string): void {
    this.disconnectPhones(session, reason);
    this.sessions.end(session);
    this.states.delete(session.id);
    const timer = this.deckTimers.get(session.id);
    if (timer) clearTimeout(timer);
    this.deckTimers.delete(session.id);
    this.presenters.delete(session.id);
  }

  private sweep(): void {
    for (const session of this.sessions.expired()) this.endSession(session, 'The presentation ended.');
  }
}

function sendTo(socket: WebSocket, message: RelayToPhone | RelayToPresenter): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
