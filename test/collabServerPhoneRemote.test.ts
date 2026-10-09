import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { REMOTE_CLOSE, REMOTE_SOCKET_PATH } from '../src/shared/phoneRemote.js';

/**
 * The phone relay on a real collab server: a presenter socket opens a
 * session, a phone joins with the code from the QR, commands travel phone →
 * presenter and state travels back — and a phone without a valid code or
 * device key gets nothing through.
 */

const DECK_ID = 'talk';

type Frame = Record<string, any>;

class Peer {
  readonly socket: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<(frame: Frame) => void> = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.closed = new Promise((resolve) => {
      this.socket.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  next(timeoutMs = 4000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a relay frame')), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async nextOfKind(kind: string, timeoutMs = 4000): Promise<Frame> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame.kind === kind) return frame;
    }
  }

  /** Resolves false if a frame of this kind arrives within the window. */
  async silentFor(kind: string, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return true;
      try {
        const frame = await this.next(left);
        if (frame.kind === kind) return false;
      } catch {
        return true;
      }
    }
  }

  close(): void {
    this.socket.close();
  }
}

describe('phone remote relay', () => {
  let rootDir: string;
  let server: RunningCollabServer;
  let peers: Peer[] = [];

  const seedDeck = async (id: string, access?: unknown) => {
    const dir = join(rootDir, id);
    await mkdir(dir, { recursive: true });
    await saveDeck(dir, parseDeck({
      ...emptyDeck('Phone talk'),
      slides: [
        { id: 's1', notes: 'Open with the demo.', elements: [] },
        { id: 's2', notes: 'Then the results.', elements: [] },
      ],
    }));
    await writeFile(join(dir, 'theme.css'), '/* theme */\n', 'utf8');
    if (access) await writeFile(join(dir, 'access.json'), JSON.stringify(access), 'utf8');
  };

  const url = (query: string) => `ws://127.0.0.1:${server.port}${REMOTE_SOCKET_PATH}?${query}`;

  const presenter = async (deckId = DECK_ID, headers: Record<string, string> = {}) => {
    const peer = new Peer(url(`role=presenter&deck=${encodeURIComponent(deckId)}`), headers);
    peers.push(peer);
    await peer.open();
    peer.send({ kind: 'open' });
    return peer;
  };

  const phone = async (headers: Record<string, string> = {}) => {
    const peer = new Peer(url('role=phone'), headers);
    peers.push(peer);
    await peer.open();
    return peer;
  };

  const pairedPhone = async (host: Peer) => {
    host.send({ kind: 'pair' });
    const { token } = await host.nextOfKind('pairing');
    const remote = await phone();
    remote.send({ kind: 'join', token });
    const joined = await remote.nextOfKind('joined');
    return { remote, token, device: joined.device as string, joined };
  };

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'phone-remote-'));
    await seedDeck(DECK_ID);
  });

  afterEach(async () => {
    for (const peer of peers) peer.close();
    peers = [];
    await server?.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('pairs a phone, relays its commands to the presenter and the presenter state back', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    const session = await host.nextOfKind('session');
    expect(session.resumed).toBe(false);
    expect(session.origins.length).toBeGreaterThan(0);

    const { remote, device, joined } = await pairedPhone(host);
    expect(joined.presenter).toBe(true);
    const deck = await remote.nextOfKind('deck');
    expect(deck.deckId).toBe(DECK_ID);
    expect(deck.deck.slides[0].notes).toBe('Open with the demo.');
    expect(deck.themeCss).toContain('theme');
    expect((await host.nextOfKind('phones')).count).toBe(1);

    remote.send({ kind: 'command', device, command: { type: 'next' } });
    expect((await host.nextOfKind('command')).command).toEqual({ type: 'next' });

    const now = Date.now();
    host.send({
      kind: 'state',
      state: { cursor: { slide: 1, step: 0 }, steps: 2, startedAt: now - 90_000, slideStartedAt: now - 5_000, blank: true },
      now,
    });
    const state = await remote.nextOfKind('state');
    expect(state.state.cursor).toEqual({ slide: 1, step: 0 });
    expect(state.state.blank).toBe(true);
    // Elapsed time survives the trip; absolute clocks do not matter.
    expect(Math.abs((state.now - state.state.startedAt) - 90_000)).toBeLessThan(1_000);
  });

  it('refuses a phone with a wrong code, and commands carrying a wrong device key', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    await host.nextOfKind('session');

    const stranger = await phone();
    stranger.send({ kind: 'join', token: 'A'.repeat(22) });
    expect((await stranger.nextOfKind('refused')).reason).toMatch(/expired|revoked/);
    expect((await stranger.closed).code).toBe(REMOTE_CLOSE.unpaired);

    const guesser = await phone();
    guesser.send({ kind: 'command', device: 'B'.repeat(22), command: { type: 'next' } });
    expect((await guesser.closed).code).toBe(REMOTE_CLOSE.unpaired);

    const { remote } = await pairedPhone(host);
    remote.send({ kind: 'command', device: 'C'.repeat(22), command: { type: 'next' } });
    expect((await remote.closed).code).toBe(REMOTE_CLOSE.unpaired);
    expect(await host.silentFor('command', 300)).toBe(true);
  });

  it('never relays commands a phone may not send', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    await host.nextOfKind('session');
    const { remote, device } = await pairedPhone(host);
    remote.send({ kind: 'command', device, command: { type: 'exit' } });
    remote.send({ kind: 'command', device, command: { type: 'swapDisplays' } });
    expect(await host.silentFor('command', 300)).toBe(true);
  });

  it('"Disconnect phones" closes paired phones and kills their keys and the code', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    await host.nextOfKind('session');
    const { remote, token, device } = await pairedPhone(host);

    host.send({ kind: 'revoke' });
    expect((await remote.closed).code).toBe(REMOTE_CLOSE.ended);

    const comeback = await phone();
    comeback.send({ kind: 'join', device });
    expect((await comeback.closed).code).toBe(REMOTE_CLOSE.unpaired);
    const rescan = await phone();
    rescan.send({ kind: 'join', token });
    expect((await rescan.closed).code).toBe(REMOTE_CLOSE.unpaired);

    // A fresh code from the same session works.
    const again = await pairedPhone(host);
    expect(again.token).not.toBe(token);
  });

  it('ends the pairing when the presentation ends', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    await host.nextOfKind('session');
    const { remote, device } = await pairedPhone(host);
    host.send({ kind: 'end' });
    expect((await remote.closed).code).toBe(REMOTE_CLOSE.ended);
    const comeback = await phone();
    comeback.send({ kind: 'join', device });
    expect((await comeback.closed).code).toBe(REMOTE_CLOSE.unpaired);
  });

  it('keeps the phone paired across a presenter reconnect with the session key', async () => {
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false });
    const host = await presenter();
    const session = await host.nextOfKind('session');
    const { remote, device } = await pairedPhone(host);

    host.close();
    expect((await remote.nextOfKind('presenter')).connected).toBe(false);
    remote.send({ kind: 'command', device, command: { type: 'next' } });
    expect((await remote.nextOfKind('presenter')).connected).toBe(false);

    const back = new Peer(url(`role=presenter&deck=${DECK_ID}`));
    peers.push(back);
    await back.open();
    back.send({ kind: 'open', resume: { session: session.session, key: session.key } });
    expect((await back.nextOfKind('session')).resumed).toBe(true);
    expect((await remote.nextOfKind('presenter')).connected).toBe(true);
    remote.send({ kind: 'command', device, command: { type: 'prev' } });
    expect((await back.nextOfKind('command')).command).toEqual({ type: 'prev' });

    // A wrong key opens a new session instead of taking over this one.
    const impostor = new Peer(url(`role=presenter&deck=${DECK_ID}`));
    peers.push(impostor);
    await impostor.open();
    impostor.send({ kind: 'open', resume: { session: session.session, key: 'K'.repeat(32) } });
    const other = await impostor.nextOfKind('session');
    expect(other.resumed).toBe(false);
    expect(other.session).not.toBe(session.session);
  });

  it('with --access, needs a login that can open the deck for presenter and phone alike', async () => {
    const OWNER = 'alice@tailnet.example';
    await seedDeck('private', { owner: OWNER, visibility: 'private', sharedWith: [] });
    server = await startCollabServer({
      rootDir, port: 0, host: '127.0.0.1', mediaRenditions: false, accessControl: { admin: 'admin@tailnet.example' },
    });
    const outsider = { 'tailscale-user-login': 'bob@tailnet.example' };
    const owner = { 'tailscale-user-login': OWNER };

    const refused = await presenter('private', outsider);
    expect((await refused.closed).code).toBe(REMOTE_CLOSE.forbidden);

    const host = await presenter('private', owner);
    await host.nextOfKind('session');
    host.send({ kind: 'pair' });
    const { token } = await host.nextOfKind('pairing');

    // The code alone is not access: somebody else's phone is refused.
    const bobsPhone = await phone(outsider);
    bobsPhone.send({ kind: 'join', token });
    expect((await bobsPhone.closed).code).toBe(REMOTE_CLOSE.forbidden);

    const alicesPhone = await phone(owner);
    alicesPhone.send({ kind: 'join', token });
    expect((await alicesPhone.nextOfKind('joined')).presenter).toBe(true);
  });
});
