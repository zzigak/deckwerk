import { z } from 'zod';
import type { Deck } from './deck.js';
import type { PresentationCommand, PresentationState } from './ipc.js';

/**
 * Presenting from a phone: the wire between a running presentation, the
 * server relay, and the phone remote page.
 *
 * The presenter's two surfaces talk over a `BroadcastChannel`
 * (presentationBus.ts), which cannot leave the presenter's browser. A phone is
 * another device, so its commands have to travel through the server. The
 * relay is deliberately thin: the presenting page stays the only authority on
 * where the show is. It publishes state, the relay fans it out to paired
 * phones, and a phone's command is handed back to the presenting page, which
 * runs it exactly as if its own Next button had been pressed. Nothing here
 * ever reaches a collaborator — the relay is a separate socket, not a room.
 *
 * Pairing has two tiers:
 *
 * - The **pairing code** is what the QR carries. It is minted when the
 *   presenter opens the pairing panel, admits new phones for a few minutes,
 *   and dies when it is replaced, when phones are disconnected, or when the
 *   presentation ends. A code left on a projected screen therefore stops
 *   working on its own.
 * - Joining with it hands the phone a **device key** for the rest of the
 *   session. Every command carries that key, so a phone that lost its socket
 *   (screen lock, Wi-Fi to cellular) reconnects without rescanning, and
 *   "Disconnect phones" revokes every key at once.
 *
 * Everything in this file is pure: the server module owns sockets and clocks,
 * and the two pages own the DOM.
 */

/** The relay's WebSocket path, beside the collaboration socket's `/ws`. */
export const REMOTE_SOCKET_PATH = '/remote-ws';
/** The phone page in the collab client bundle. */
export const REMOTE_PAGE = 'remote.html';

/** How long a freshly shown pairing code admits new phones. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/**
 * A code shown again with less than this left is replaced first, so the QR a
 * presenter is about to scan never expires in their hand.
 */
export const PAIRING_CODE_REFRESH_MS = 2 * 60_000;
/**
 * How long a session outlives its presenter's socket. A laptop's Wi-Fi blip
 * mid-talk must not unpair the phone in the presenter's hand; a closed
 * presentation tab, which never comes back, ends it a minute later.
 */
export const PRESENTER_GRACE_MS = 60_000;
/** Backstop for a presentation tab left open and forgotten for days. */
export const SESSION_MAX_LIFETIME_MS = 16 * 60 * 60_000;

/** WebSocket close codes the phone page explains to its person. */
export const REMOTE_CLOSE = {
  /** The code or device key is unknown, expired, or was revoked. */
  unpaired: 4401,
  /** The presentation ended, or the presenter disconnected every phone. */
  ended: 4410,
  /** With access control: this tailnet login may not open the deck. */
  forbidden: 4403,
} as const;

/** The subset of presenter controls a phone may send. Ending the show and
 *  swapping displays stay on the laptop: neither belongs in a pocket. */
export type RemoteCommand =
  | { type: 'next' | 'prev' | 'toggleBlank' }
  | { type: 'goTo'; slide: number };

const RemoteCommandSchema = z.union([
  z.object({ type: z.enum(['next', 'prev', 'toggleBlank']) }).strict(),
  z.object({ type: z.literal('goTo'), slide: z.number().int().min(0).max(100_000) }).strict(),
]);

/** Where the show is, as the phone needs it. */
export interface RemoteState extends PresentationState {
  /** Whether the audience screen is blanked. */
  blank?: boolean;
}

const RemoteStateSchema = z.object({
  cursor: z.object({ slide: z.number().int().min(0), step: z.number().int().min(0) }),
  steps: z.number().int().min(1),
  startedAt: z.number(),
  slideStartedAt: z.number(),
  range: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
  blank: z.boolean().optional(),
});

const Secret = z.string().min(16).max(128);

/** Presenter → relay. */
export const PresenterMessageSchema = z.discriminatedUnion('kind', [
  /** First frame on every presenter socket: a new session, or the one this page already had. */
  z.object({ kind: z.literal('open'), resume: z.object({ session: z.string(), key: Secret }).optional() }),
  /** Show (and if need be mint) a pairing code. */
  z.object({ kind: z.literal('pair') }),
  /** `now` is the presenter's clock, so the relay can rebase the timers onto its own. */
  z.object({ kind: z.literal('state'), state: RemoteStateSchema, now: z.number() }),
  /** The deck changed under the presentation; phones should re-read it. */
  z.object({ kind: z.literal('deckChanged') }),
  /** "Disconnect phones": revoke every device key and the current code. */
  z.object({ kind: z.literal('revoke') }),
  /** The presentation ended on purpose; no grace period. */
  z.object({ kind: z.literal('end') }),
]);
export type PresenterMessage = z.infer<typeof PresenterMessageSchema>;

/** Phone → relay. */
export const PhoneMessageSchema = z.discriminatedUnion('kind', [
  /** Join with the code from the QR, or come back with the device key a join handed out. */
  z.object({ kind: z.literal('join'), token: Secret.optional(), device: Secret.optional() }),
  z.object({ kind: z.literal('command'), device: Secret, command: RemoteCommandSchema }),
]);
export type PhoneMessage = z.infer<typeof PhoneMessageSchema>;

export interface RemoteDeckSnapshot {
  deckId: string;
  deck: Deck;
  themeCss: string;
  mediaVariants?: Record<string, string>;
}

/** Relay → presenter. */
export type RelayToPresenter =
  | { kind: 'session'; session: string; key: string; resumed: boolean; origins: string[] }
  | { kind: 'pairing'; token: string; expiresAt: number; now: number }
  | { kind: 'phones'; count: number }
  | { kind: 'command'; command: RemoteCommand };

/** Relay → phone. */
export type RelayToPhone =
  | { kind: 'joined'; device: string; presenter: boolean }
  | { kind: 'presenter'; connected: boolean }
  | ({ kind: 'deck' } & RemoteDeckSnapshot)
  | { kind: 'state'; state: RemoteState; now: number }
  | { kind: 'refused'; reason: string };

/** Narrow a presenter command to what a phone may send, or null. */
export function remoteCommand(command: PresentationCommand): RemoteCommand | null {
  const parsed = RemoteCommandSchema.safeParse(command);
  return parsed.success ? parsed.data : null;
}

/**
 * Move a state's timestamps from the clock of whoever sent it (`sentAt` on
 * their clock) onto ours (`receivedAt`). Phone, laptop and server clocks may
 * disagree by seconds or minutes; elapsed time is the only thing worth
 * carrying across, and it survives the move.
 */
export function rebaseState<T extends PresentationState>(state: T, sentAt: number, receivedAt: number): T {
  const shift = receivedAt - sentAt;
  return { ...state, startedAt: state.startedAt + shift, slideStartedAt: state.slideStartedAt + shift };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Tailscale hands out addresses from the CGNAT block 100.64.0.0/10. */
function isTailscaleAddress(hostname: string): boolean {
  const match = /^100\.(\d+)\.\d+\.\d+$/.exec(hostname);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function isPrivateLanAddress(hostname: string): boolean {
  return /^10\./.test(hostname) || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

/**
 * The origin a phone should open the remote on.
 *
 * The presenter's own address is the right one whenever it is not loopback:
 * the Tailscale hostname (or `tailscale serve` HTTPS name) the laptop reached
 * the server on is, by construction, a name the presenter's tailnet resolves,
 * and it carries the right scheme and port. Loopback is the one case where it
 * is useless — the desktop app hands its own collaboration window to
 * `127.0.0.1` — and then the best of the server's own addresses stands in:
 * Tailscale first (it works off the local network too), then the LAN.
 */
export function remoteOrigin(presenterOrigin: string, serverOrigins: readonly string[]): string {
  const own = new URL(presenterOrigin);
  if (!LOOPBACK_HOSTS.has(own.hostname)) return own.origin;
  const candidates = serverOrigins
    .map((origin) => { try { return new URL(origin); } catch { return null; } })
    .filter((url): url is URL => url !== null && !LOOPBACK_HOSTS.has(url.hostname));
  const pick = candidates.find((url) => isTailscaleAddress(url.hostname))
    ?? candidates.find((url) => isPrivateLanAddress(url.hostname))
    ?? candidates[0];
  return pick ? pick.origin : own.origin;
}

/**
 * The URL the QR code carries. The code rides in the fragment, which a
 * browser never sends to a server: it stays out of request logs, proxies and
 * `Referer` headers, and the page hands it to the relay itself.
 */
export function remoteUrl(pageUrl: string, origin: string, token: string): string {
  const url = new URL(REMOTE_PAGE, pageUrl);
  const target = new URL(url.pathname, origin);
  target.hash = token;
  return target.toString();
}

/** Read the pairing code back out of a remote URL's fragment. */
export function tokenFromHash(hash: string): string | null {
  const token = hash.replace(/^#/, '').trim();
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

export interface SwipeSample {
  dx: number;
  dy: number;
  ms: number;
}

/**
 * Whether a finished touch was a deliberate horizontal swipe. Left (content
 * moving left, as when turning a page) advances; right goes back. It has to
 * be clearly horizontal and reasonably quick, so scrolling the notes or a
 * slow drag never changes the slide under the presenter.
 */
export function classifySwipe({ dx, dy, ms }: SwipeSample): 'next' | 'prev' | null {
  if (ms > 700) return null;
  if (Math.abs(dx) < 48) return null;
  if (Math.abs(dx) < Math.abs(dy) * 1.6) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** Note text sizes the phone steps through with A− / A+. */
export const NOTE_SIZES = [14, 16, 18, 21, 24, 28, 33, 40] as const;

export function stepNoteSize(current: number, direction: 1 | -1): number {
  const index = NOTE_SIZES.findIndex((size) => size >= current);
  const from = index < 0 ? NOTE_SIZES.length - 1 : index;
  const next = Math.min(NOTE_SIZES.length - 1, Math.max(0, from + direction));
  return NOTE_SIZES[next];
}

/** The slide after `slide` that the audience will actually see, or -1. */
export function nextShownSlide(deck: Deck, state: PresentationState): number {
  const last = state.range?.end ?? deck.slides.length - 1;
  let next = state.cursor.slide + 1;
  while (next <= last && deck.slides[next]?.skipped) next += 1;
  return next <= last ? next : -1;
}
