import '../player/player.css';
import '../player/type.css';
import '../appChrome.css';
import '../lightTheme.css';
import './remote.css';
import type { Deck } from '@shared/deck.js';
import {
  REMOTE_CLOSE,
  REMOTE_SOCKET_PATH,
  classifySwipe,
  nextShownSlide,
  rebaseState,
  stepNoteSize,
  tokenFromHash,
  type RelayToPhone,
  type RemoteCommand,
  type RemoteState,
} from '@shared/phoneRemote.js';
import { resolveState } from '@shared/timeline.js';
import { applyUiTheme } from '../uiTheme.js';
import { revealImagesWhenDecoded } from '../player/imageDecode.js';
import { freezePreviewVideos, releasePreviewVideos } from '../player/previewPoster.js';
import { applyStageScale, renderSlide, rewriteCssAssetUrls } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { formatElapsed, formatWallClock } from '../presenter/model.js';
import { pinMediaVariant, setMediaVariants } from './mediaVariants.js';

/**
 * The phone remote: a clicker with the presenter's notes, previews and clocks.
 *
 * Opened by scanning the QR code from "Pair phone". It never presents
 * anything itself — every press is a command to the presenting page, relayed
 * by the server (server/phoneRemote.ts), and everything shown here is the
 * state that page publishes back. So the laptop stays the one authority on
 * where the talk is, and a phone that drops off the network costs the talk
 * nothing but the phone.
 */

applyUiTheme();

const root = document.getElementById('remote')!;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusText = $('status-text');
const wallClock = $('wall-clock');
const currentPreview = $('current-preview');
const nextPreview = $('next-preview');
const nextLabel = $('next-label');
const blankBadge = $('blank-badge');
const slideLabel = $('slide-label');
const buildLabel = $('build-label');
const elapsed = $('elapsed');
const slideElapsed = $('slide-elapsed');
const notes = $('notes');
const prevButton = $<HTMLButtonElement>('prev');
const nextButton = $<HTMLButtonElement>('next');
const blankButton = $<HTMLButtonElement>('blank');
const overlay = $('overlay');

const token = tokenFromHash(location.hash);
const deviceStoreKey = token ? `deckwerk.remote.device:${token}` : null;
const NOTE_SIZE_KEY = 'deckwerk.remote.noteSize';

let deckId: string | null = null;
let deck: Deck | null = null;
let state: RemoteState | null = null;
let device: string | null = readStored(deviceStoreKey);
let presenterOnline = false;
let socket: WebSocket | null = null;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Set once the relay has said this phone is not (or no longer) paired. */
let finished = false;
const themeTag = document.createElement('style');
document.head.appendChild(themeTag);

function readStored(key: string | null): string | null {
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string | null, value: string): void {
  if (!key) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: a reload just rejoins with the code while it is valid.
  }
}

/* --- connection ------------------------------------------------------------ */

function setConnection(kind: 'connecting' | 'live' | 'presenter-away' | 'offline' | 'done', text: string): void {
  root.dataset.connection = kind;
  statusText.textContent = text;
  const usable = kind === 'live';
  for (const button of [prevButton, nextButton, blankButton]) button.disabled = !usable;
}

function showOverlay(title: string, text: string): void {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  overlay.hidden = false;
}

function connect(): void {
  if (finished || !token) return;
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  setConnection(attempt === 0 ? 'connecting' : 'offline', attempt === 0 ? 'Connecting…' : 'Reconnecting…');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${REMOTE_SOCKET_PATH}?role=phone`);
  socket = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ kind: 'join', token, ...(device ? { device } : {}) }));
  });
  ws.addEventListener('message', (event) => {
    let message: RelayToPhone;
    try {
      message = JSON.parse(String(event.data)) as RelayToPhone;
    } catch {
      return;
    }
    onRelayMessage(message);
  });
  ws.addEventListener('close', (event) => {
    if (socket !== ws) return;
    socket = null;
    if (event.code === REMOTE_CLOSE.unpaired || event.code === REMOTE_CLOSE.forbidden) {
      finish('Not paired', `${event.reason || 'This phone is not paired.'} Choose Pair phone in Speaker View and scan the new code.`);
      return;
    }
    if (event.code === REMOTE_CLOSE.ended) {
      finish('Presentation ended', `${event.reason || 'The presentation ended.'} Pair again from Speaker View to keep going.`);
      return;
    }
    // Phones drop sockets constantly — a locked screen, a Wi-Fi handover.
    // Keep trying; the device key brings this phone straight back.
    setConnection('offline', 'Reconnecting…');
    const delay = [400, 1000, 2000, 4000][Math.min(attempt, 3)];
    attempt += 1;
    retryTimer = setTimeout(connect, delay);
  });
}

function finish(title: string, text: string): void {
  finished = true;
  setConnection('done', title);
  showOverlay(title, text);
}

function onRelayMessage(message: RelayToPhone): void {
  switch (message.kind) {
    case 'joined':
      attempt = 0;
      device = message.device;
      writeStored(deviceStoreKey, message.device);
      setPresenter(message.presenter);
      keepAwake();
      return;
    case 'presenter':
      setPresenter(message.connected);
      return;
    case 'deck': {
      const first = deck === null;
      deckId = message.deckId;
      deck = message.deck;
      setMediaVariants(message.mediaVariants, true);
      themeTag.textContent = rewriteCssAssetUrls(message.themeCss, resolveSrc);
      document.title = `Remote — ${deck.title}`;
      render(first);
      return;
    }
    case 'state':
      // The relay's clock, moved onto this phone's: elapsed time is what matters.
      state = rebaseState(message.state, message.now, Date.now());
      render(false);
      tick();
      return;
    case 'refused':
      // The close frame that follows carries the code that decides what to say.
      return;
  }
}

function setPresenter(online: boolean): void {
  presenterOnline = online;
  if (online) setConnection('live', 'Connected');
  else setConnection('presenter-away', 'Presenter offline');
}

function send(command: RemoteCommand): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !device || !presenterOnline) return;
  socket.send(JSON.stringify({ kind: 'command', device, command }));
  navigator.vibrate?.(8);
}

/* --- rendering ------------------------------------------------------------- */

function resolveSrc(src: string): string {
  return pinMediaVariant(src, `/decks/${(deckId ?? '').split('/').map(encodeURIComponent).join('/')}/`
    + src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'));
}

/** The same still preview Speaker View draws, sized to its box. */
function preview(target: HTMLElement, slideIndex: number, step: number): void {
  releasePreviewVideos(target);
  target.replaceChildren();
  const slide = deck?.slides[slideIndex];
  if (!deck || !slide) return;
  const stage = document.createElement('div');
  stage.className = 'stage';
  stage.appendChild(renderSlide(slide, { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true }));
  target.appendChild(stage);
  applyStaticSlideState(stage, slide, resolveState(slide, step));
  const bounds = target.getBoundingClientRect();
  applyStageScale(stage, deck, { w: bounds.width, h: bounds.height });
  for (const video of stage.querySelectorAll('video')) video.pause();
  revealImagesWhenDecoded(stage);
  freezePreviewVideos(stage);
}

/** What was last drawn, so a state that only moved the clocks redraws nothing. */
let drawn = '';

function render(force: boolean): void {
  if (!deck) return;
  const cursor = state?.cursor ?? { slide: 0, step: 0 };
  const steps = state?.steps ?? 1;
  const key = `${cursor.slide}:${cursor.step}:${steps}`;
  blankBadge.hidden = !state?.blank;
  blankButton.setAttribute('aria-pressed', String(Boolean(state?.blank)));
  blankButton.classList.toggle('active', Boolean(state?.blank));
  if (!force && key === drawn) return;
  drawn = key;

  const total = deck.slides.length;
  slideLabel.textContent = `Slide ${cursor.slide + 1} / ${total}`;
  buildLabel.textContent = steps > 1 ? `Build ${cursor.step + 1} of ${steps}` : '';
  preview(currentPreview, cursor.slide, cursor.step);

  // As a clicker, "next" is whatever the next press shows: the slide's own
  // next build while it has one, then the next slide the audience will see.
  if (cursor.step + 1 < steps) {
    nextLabel.textContent = 'Next build';
    preview(nextPreview, cursor.slide, cursor.step + 1);
  } else {
    const following = state ? nextShownSlide(deck, state) : (total > 1 ? 1 : -1);
    nextLabel.textContent = following >= 0 ? `Next · slide ${following + 1}` : 'End of presentation';
    preview(nextPreview, following, 0);
  }
  const text = deck.slides[cursor.slide]?.notes ?? '';
  notes.textContent = text;
  notes.classList.toggle('empty', text.trim() === '');
  if (text.trim() === '') notes.textContent = 'No notes for this slide.';
  notes.scrollTop = 0;
}

function tick(): void {
  const now = Date.now();
  wallClock.textContent = formatWallClock(new Date(now));
  if (!state) return;
  elapsed.textContent = formatElapsed(now, state.startedAt);
  slideElapsed.textContent = formatElapsed(now, state.slideStartedAt);
}

/* --- controls -------------------------------------------------------------- */

prevButton.addEventListener('click', () => send({ type: 'prev' }));
nextButton.addEventListener('click', () => send({ type: 'next' }));
blankButton.addEventListener('click', () => send({ type: 'toggleBlank' }));

// Swipe across the slides or the notes: left for next, right for previous,
// like turning a page. Vertical drags stay the notes' scroll.
for (const area of [$('stage-area'), notes]) {
  let start: { x: number; y: number; t: number; id: number } | null = null;
  area.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    start = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId };
  });
  area.addEventListener('pointerup', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const swipe = classifySwipe({ dx: event.clientX - start.x, dy: event.clientY - start.y, ms: event.timeStamp - start.t });
    start = null;
    if (swipe) send({ type: swipe });
  });
  area.addEventListener('pointercancel', () => { start = null; });
}

let noteSize = Number(readStored(NOTE_SIZE_KEY)) || 18;
function applyNoteSize(): void {
  notes.style.fontSize = `${noteSize}px`;
}
function changeNoteSize(direction: 1 | -1): void {
  noteSize = stepNoteSize(noteSize, direction);
  writeStored(NOTE_SIZE_KEY, String(noteSize));
  applyNoteSize();
}
$('notes-smaller').addEventListener('click', () => changeNoteSize(-1));
$('notes-larger').addEventListener('click', () => changeNoteSize(1));
applyNoteSize();

// A hardware keyboard or a Bluetooth clicker paired with the phone works too.
window.addEventListener('keydown', (event) => {
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) send({ type: 'next' });
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) send({ type: 'prev' });
  else if (event.key === 'b' || event.key === 'B') send({ type: 'toggleBlank' });
  else return;
  event.preventDefault();
});

/* --- screen ---------------------------------------------------------------- */

/**
 * Keep the phone awake for the length of the talk. The Wake Lock API needs a
 * secure context (HTTPS, as `tailscale serve` provides) and a visible page;
 * the browser drops the lock whenever the page is hidden, so it is taken
 * again on every return. Without it the phone sleeps on its own timer.
 */
let wakeLock: { release(): Promise<void> } | null = null;
function keepAwake(): void {
  const api = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(type: 'release', cb: () => void): void }> };
  }).wakeLock;
  if (!api) {
    document.documentElement.dataset.wakeLock = 'unavailable';
    return;
  }
  if (wakeLock || document.visibilityState !== 'visible') return;
  api.request('screen').then((sentinel) => {
    wakeLock = sentinel;
    document.documentElement.dataset.wakeLock = 'held';
    sentinel.addEventListener('release', () => {
      wakeLock = null;
      document.documentElement.dataset.wakeLock = 'released';
    });
  }, () => {
    document.documentElement.dataset.wakeLock = 'refused';
  });
}
// Some browsers grant the lock only from a gesture; the first press asks again.
window.addEventListener('pointerdown', () => keepAwake(), { capture: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  // A phone that slept has usually lost its socket; do not wait out a backoff.
  attempt = Math.min(attempt, 1);
  connect();
});

let resizeFrame = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => render(true));
});

setInterval(tick, 500);
tick();

if (!token) {
  finish('Scan to pair', 'Open this page by scanning the code from Pair phone in Speaker View.');
} else {
  connect();
}
