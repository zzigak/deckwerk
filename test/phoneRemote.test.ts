import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import {
  PAIRING_CODE_TTL_MS,
  PRESENTER_GRACE_MS,
  SESSION_MAX_LIFETIME_MS,
  classifySwipe,
  nextShownSlide,
  rebaseState,
  remoteCommand,
  remoteOrigin,
  remoteUrl,
  stepNoteSize,
  tokenFromHash,
} from '../src/shared/phoneRemote.js';
import { RemoteSessions, newSecret } from '../src/server/phoneRemote.js';
import { qrSvgMarkup } from '../src/renderer/collab/pairPhoneDialog.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('phone remote pairing tokens', () => {
  it('issues unguessable, URL-safe secrets', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => newSecret()));
    expect(secrets.size).toBe(200);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('admits a phone with the code shown and hands it its own device key', () => {
    const sessions = new RemoteSessions();
    const session = sessions.open('talk');
    const code = sessions.pairingCode(session);
    const joined = sessions.join(code.token);
    expect(joined?.session).toBe(session);
    expect(joined?.device).not.toBe(code.token);
    expect(sessions.authorizes(session, joined!.device)).toBe(true);
    expect(sessions.rejoin(joined!.device)).toBe(session);
  });

  it('refuses codes it never issued and device keys of other sessions', () => {
    const sessions = new RemoteSessions();
    const a = sessions.open('talk');
    const b = sessions.open('talk');
    sessions.pairingCode(a);
    expect(sessions.join('x'.repeat(22))).toBeNull();
    const joined = sessions.join(sessions.pairingCode(a).token)!;
    expect(sessions.authorizes(b, joined.device)).toBe(false);
    expect(sessions.authorizes(a, 'y'.repeat(22))).toBe(false);
  });

  it('lets the pairing code expire after its window but keeps joined phones', () => {
    const time = clock();
    const sessions = new RemoteSessions(time.now);
    const session = sessions.open('talk');
    const code = sessions.pairingCode(session);
    const joined = sessions.join(code.token)!;
    time.advance(PAIRING_CODE_TTL_MS + 1);
    expect(sessions.join(code.token)).toBeNull();
    expect(sessions.authorizes(session, joined.device)).toBe(true);
  });

  it('reuses a code with time left and replaces one about to expire', () => {
    const time = clock();
    const sessions = new RemoteSessions(time.now);
    const session = sessions.open('talk');
    const first = sessions.pairingCode(session);
    time.advance(60_000);
    expect(sessions.pairingCode(session).token).toBe(first.token);
    time.advance(PAIRING_CODE_TTL_MS - 90_000);
    const second = sessions.pairingCode(session);
    expect(second.token).not.toBe(first.token);
    expect(sessions.join(first.token)).toBeNull();
    expect(sessions.join(second.token)).not.toBeNull();
  });

  it('revokes every device key and the code on "Disconnect phones"', () => {
    const sessions = new RemoteSessions();
    const session = sessions.open('talk');
    const code = sessions.pairingCode(session);
    const one = sessions.join(code.token)!;
    const two = sessions.join(code.token)!;
    sessions.revoke(session);
    expect(sessions.authorizes(session, one.device)).toBe(false);
    expect(sessions.authorizes(session, two.device)).toBe(false);
    expect(sessions.rejoin(one.device)).toBeNull();
    expect(sessions.join(code.token)).toBeNull();
    // A fresh code works again afterwards.
    expect(sessions.join(sessions.pairingCode(session).token)).not.toBeNull();
  });

  it('ends with the presentation: nothing works after end()', () => {
    const sessions = new RemoteSessions();
    const session = sessions.open('talk');
    const code = sessions.pairingCode(session);
    const joined = sessions.join(code.token)!;
    sessions.end(session);
    expect(sessions.authorizes(session, joined.device)).toBe(false);
    expect(sessions.rejoin(joined.device)).toBeNull();
    expect(sessions.join(code.token)).toBeNull();
    expect(sessions.resume(session.id, session.key, 'talk')).toBeNull();
    expect(sessions.size).toBe(0);
  });

  it('holds a session through a presenter blip and expires it after the grace period', () => {
    const time = clock();
    const sessions = new RemoteSessions(time.now);
    const session = sessions.open('talk');
    const joined = sessions.join(sessions.pairingCode(session).token)!;
    sessions.presenterLeft(session);
    time.advance(PRESENTER_GRACE_MS - 1_000);
    expect(sessions.resume(session.id, 'wrong-key-wrong-key', 'talk')).toBeNull();
    expect(sessions.resume(session.id, session.key, 'other-deck')).toBeNull();
    expect(sessions.resume(session.id, session.key, 'talk')).toBe(session);
    expect(sessions.authorizes(session, joined.device)).toBe(true);

    sessions.presenterLeft(session);
    time.advance(PRESENTER_GRACE_MS);
    expect(sessions.authorizes(session, joined.device)).toBe(false);
    expect(sessions.expired()).toEqual([session]);
  });

  it('expires a forgotten session after its maximum lifetime', () => {
    const time = clock();
    const sessions = new RemoteSessions(time.now);
    const session = sessions.open('talk');
    const joined = sessions.join(sessions.pairingCode(session).token)!;
    time.advance(SESSION_MAX_LIFETIME_MS);
    expect(sessions.authorizes(session, joined.device)).toBe(false);
  });
});

describe('phone remote helpers', () => {
  it('builds the QR URL on the address the presenter reached the server on', () => {
    expect(remoteOrigin('https://deckbox.tail1234.ts.net', ['http://127.0.0.1:5800/', 'http://100.101.1.2:5800/']))
      .toBe('https://deckbox.tail1234.ts.net');
    expect(remoteOrigin('http://100.101.1.2:5800', [])).toBe('http://100.101.1.2:5800');
  });

  it('prefers a Tailscale address, then the LAN, when the presenter is on loopback', () => {
    const origins = ['http://127.0.0.1:5800/', 'http://192.168.1.20:5800/', 'http://100.88.0.4:5800/'];
    expect(remoteOrigin('http://127.0.0.1:5800', origins)).toBe('http://100.88.0.4:5800');
    expect(remoteOrigin('http://localhost:5800', origins.slice(0, 2))).toBe('http://192.168.1.20:5800');
    expect(remoteOrigin('http://127.0.0.1:5800', ['http://127.0.0.1:5800/'])).toBe('http://127.0.0.1:5800');
  });

  it('puts the code in the fragment, never the query', () => {
    const url = remoteUrl('http://127.0.0.1:5800/present.html?deck=talk&role=speaker', 'http://100.88.0.4:5800', 'abcDEF123_-abcDEF123_');
    expect(url).toBe('http://100.88.0.4:5800/remote.html#abcDEF123_-abcDEF123_');
    expect(tokenFromHash(new URL(url).hash)).toBe('abcDEF123_-abcDEF123_');
    expect(tokenFromHash('#short')).toBeNull();
    expect(tokenFromHash('#<script>alert(1)</script>')).toBeNull();
  });

  it('lets a phone drive the show but not end it or swap displays', () => {
    expect(remoteCommand({ type: 'next' })).toEqual({ type: 'next' });
    expect(remoteCommand({ type: 'goTo', slide: 3 })).toEqual({ type: 'goTo', slide: 3 });
    expect(remoteCommand({ type: 'exit' })).toBeNull();
    expect(remoteCommand({ type: 'swapDisplays' })).toBeNull();
  });

  it('carries elapsed time across clocks that disagree', () => {
    const state = { cursor: { slide: 0, step: 0 }, steps: 1, startedAt: 1_000, slideStartedAt: 5_000 };
    const moved = rebaseState(state, 10_000, 70_000);
    expect(70_000 - moved.startedAt).toBe(10_000 - state.startedAt);
    expect(70_000 - moved.slideStartedAt).toBe(10_000 - state.slideStartedAt);
  });

  it('only counts quick, clearly horizontal swipes', () => {
    expect(classifySwipe({ dx: -120, dy: 10, ms: 200 })).toBe('next');
    expect(classifySwipe({ dx: 120, dy: -15, ms: 200 })).toBe('prev');
    expect(classifySwipe({ dx: -30, dy: 0, ms: 100 })).toBeNull();
    expect(classifySwipe({ dx: -100, dy: 90, ms: 200 })).toBeNull();
    expect(classifySwipe({ dx: -200, dy: 0, ms: 1500 })).toBeNull();
  });

  it('steps the notes text size within bounds', () => {
    expect(stepNoteSize(18, 1)).toBe(21);
    expect(stepNoteSize(18, -1)).toBe(16);
    expect(stepNoteSize(14, -1)).toBe(14);
    expect(stepNoteSize(40, 1)).toBe(40);
    expect(stepNoteSize(17, 1)).toBe(21);
  });

  it('skips skipped slides and stops at the end of a range when looking ahead', () => {
    const deck = parseDeck({
      ...emptyDeck('Ahead'),
      slides: [{ id: 'a', elements: [] }, { id: 'b', elements: [], skipped: true }, { id: 'c', elements: [] }, { id: 'd', elements: [] }],
    });
    const at = (slide: number, range?: { start: number; end: number }) => ({
      cursor: { slide, step: 0 }, steps: 1, startedAt: 0, slideStartedAt: 0, ...(range ? { range } : {}),
    });
    expect(nextShownSlide(deck, at(0))).toBe(2);
    expect(nextShownSlide(deck, at(3))).toBe(-1);
    expect(nextShownSlide(deck, at(2, { start: 0, end: 2 }))).toBe(-1);
  });

  it('draws the QR code as a single crisp SVG path', () => {
    const svg = qrSvgMarkup('http://100.88.0.4:5800/remote.html#abcDEF123_-abcDEF123_');
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 (\d+) \1"/);
    expect(svg.match(/<path /g)).toHaveLength(1);
  });
});
