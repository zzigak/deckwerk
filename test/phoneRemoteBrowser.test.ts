import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Presenting from a phone, end to end in real renderers: the presentation
 * opens with its Pair phone code up, the remote page is opened from the URL
 * that code carries, and pressing Next on the remote advances the audience —
 * through the server relay, the only path a real phone has.
 */

const DECK_ID = 'phone-talk';
const SLIDES = ['ALPHA SLIDE', 'BRAVO SLIDE', 'CHARLIE SLIDE'];
const NOTES = ['Welcome everyone.', 'Point at the bravo chart.', 'Thank you.'];

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
const pages: Cdp[] = [];

afterEach(async () => {
  for (const page of pages.splice(0)) page.close();
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  workDir = '';
});

const AUDIENCE_PROBE = `(() => ({
  slide: document.querySelector('#stage .slide')?.textContent?.trim() ?? null,
  stageOpacity: document.querySelector('#stage .stage')?.style.opacity ?? null,
  dialog: Boolean(document.querySelector('.pair-phone-dialog')),
  link: document.querySelector('.pair-phone-link code')?.textContent ?? '',
  status: document.querySelector('.pair-phone-status')?.textContent ?? '',
}))()`;

interface AudienceReading {
  slide: string | null;
  stageOpacity: string | null;
  dialog: boolean;
  link: string;
  status: string;
}

const REMOTE_PROBE = `(() => ({
  connection: document.getElementById('remote')?.dataset.connection ?? null,
  slide: document.getElementById('slide-label')?.textContent ?? null,
  notes: document.getElementById('notes')?.textContent ?? null,
  current: document.querySelector('#current-preview .slide')?.textContent?.trim() ?? null,
  next: document.querySelector('#next-preview .slide')?.textContent?.trim() ?? null,
  blank: !document.getElementById('blank-badge')?.hidden,
  overlay: document.getElementById('overlay')?.hidden === false
    ? document.getElementById('overlay-title')?.textContent : null,
}))()`;

interface RemoteReading {
  connection: string | null;
  slide: string | null;
  notes: string | null;
  current: string | null;
  next: string | null;
  blank: boolean;
  overlay: string | null;
}

describe.skipIf(!electronBinary)('phone remote', () => {
  it('pairs from the QR link and advances the presentation from the phone', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'phone-remote-browser-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Phone talk');
    deck.slides = SLIDES.map((text, index) => ({
      ...deck.slides[0],
      id: `s${index + 1}`,
      name: text,
      notes: NOTES[index],
      elements: [{
        id: `t${index + 1}`, type: 'text' as const, x: 160, y: 400, w: 1600, h: 200,
        rot: 0, z: 1, opacity: 1, class: [], style: {},
        html: text, align: 'center' as const, valign: 'middle' as const,
      }],
    }));
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '/* phone */\n', 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, port: 0, host: '127.0.0.1', clientDir: await collabClientDir(), mediaRenditions: false,
    });

    // Present in one window with the pairing code up, as "Present with phone
    // remote" does.
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}&slide=1&pair=1`,
      profileDir,
    );
    const audienceTarget = await findTarget(browser.debugPort, (t) => t.url.includes('present.html'), browser.log);
    const audience = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
    pages.push(audience);

    const paired = await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'the presentation never showed a pairing code',
      (value) => value.slide === 'ALPHA SLIDE' && value.link.includes('/remote.html#'),
      30_000,
    );
    expect(paired.dialog).toBe(true);
    expect(paired.status).toMatch(/Waiting for a phone/);
    const remoteUrl = paired.link;
    // The code rides in the fragment and nowhere else.
    expect(new URL(remoteUrl).search).toBe('');

    // The "phone": a second renderer opened on exactly the URL the QR encodes.
    await audience.evaluate<boolean>(`Boolean(window.open(${JSON.stringify(remoteUrl)}, 'phone'))`);
    const remoteTarget = await findTarget(browser.debugPort, (t) => t.url.includes('/remote.html'), browser.log);
    const remote = await Cdp.connect(remoteTarget.webSocketDebuggerUrl!);
    pages.push(remote);

    const live = await eventually(
      async () => remote.evaluate<RemoteReading>(REMOTE_PROBE),
      'the remote never connected to the presentation',
      (value) => value.connection === 'live' && value.current === 'ALPHA SLIDE',
      30_000,
    );
    expect(live.slide).toBe('Slide 1 / 3');
    expect(live.notes).toBe(NOTES[0]);
    expect(live.next).toBe('BRAVO SLIDE');

    // The code leaves the audience's screen once a phone has joined.
    await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'the pairing panel stayed on the presentation after the phone joined',
      (value) => !value.dialog,
    );

    // Next on the phone moves the presentation, and the phone follows.
    await remote.evaluate(`document.getElementById('next').click()`);
    await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'Next on the phone did not advance the presentation',
      (value) => value.slide === 'BRAVO SLIDE',
    );
    const advanced = await eventually(
      async () => remote.evaluate<RemoteReading>(REMOTE_PROBE),
      'the phone did not follow the presentation',
      (value) => value.slide === 'Slide 2 / 3',
    );
    expect(advanced.notes).toBe(NOTES[1]);
    expect(advanced.next).toBe('CHARLIE SLIDE');

    // A swipe right goes back.
    await remote.evaluate(`(() => {
      const area = document.getElementById('stage-area');
      const at = (type, x) => area.dispatchEvent(new PointerEvent(type, {
        bubbles: true, isPrimary: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: 100,
      }));
      at('pointerdown', 40);
      at('pointerup', 260);
    })()`);
    await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'a swipe on the phone did not go back',
      (value) => value.slide === 'ALPHA SLIDE',
    );

    // Blank from the phone blanks the audience and shows on the phone.
    await remote.evaluate(`document.getElementById('blank').click()`);
    await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'Blank on the phone did not blank the audience',
      (value) => value.stageOpacity === '0',
    );
    await eventually(
      async () => remote.evaluate<RemoteReading>(REMOTE_PROBE),
      'the phone did not show that the audience is blank',
      (value) => value.blank,
    );

    // Disconnect phones (the panel comes back with P) unpairs the phone.
    await audience.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))`);
    await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'P did not bring the pairing panel back',
      (value) => value.dialog && value.status.includes('Phone connected'),
    );
    await audience.evaluate(`document.querySelector('.pair-phone-disconnect').click()`);
    const dropped = await eventually(
      async () => remote.evaluate<RemoteReading>(REMOTE_PROBE),
      'Disconnect phones left the phone connected',
      (value) => value.overlay !== null,
    );
    expect(dropped.connection).toBe('done');
    // And the panel puts a fresh code up in place of the revoked one.
    const fresh = await eventually(
      async () => audience.evaluate<AudienceReading>(AUDIENCE_PROBE),
      'no fresh code after disconnecting phones',
      (value) => value.link.includes('/remote.html#') && value.link !== remoteUrl,
    );
    expect(fresh.status).toMatch(/Waiting for a phone/);
  }, 180_000);
});

describe.skipIf(electronBinary)('phone remote (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
