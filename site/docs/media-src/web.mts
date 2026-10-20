// Screenshots of a browser collaboration session for the docs: two people in
// one deck, the chat, the File menu and the phone view.
// Run it from the root of a DeckWerk checkout:
//
//   node_modules/.bin/vite-node --config vitest.config.ts \
//     <path>/site/docs/media-src/web.mts <deck-dir> [ids...]
//
// The session hosts a few slides of the docs deck on a local server.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = process.cwd();
const [deckArg, ...only] = process.argv.slice(2);
if (!deckArg) throw new Error('usage: web.mts <deck-dir> [ids...]');
const out = join(here, '..', 'media');
const wanted = (id: string) => only.length === 0 || only.includes(id);

const { launchWebEditor } = await import(join(checkout, 'test/support/webEditorSession.ts'));
const { wait } = await import(join(checkout, 'test/support/browserSession.ts'));

const deckDir = resolve(deckArg);
const deck = JSON.parse(readFileSync(join(deckDir, 'deck.json'), 'utf8'));
deck.slides = deck.slides.filter((slide: { name: string }) => ['roles', 'shapes', 'chart', 'flip'].includes(slide.name));
const session = await launchWebEditor([{
  id: 'talk',
  deck,
  themeCss: readFileSync(join(deckDir, 'theme.css'), 'utf8'),
}], { userName: 'Sam' });
const { cdp } = session;
const W = 1680;
const H = 1000;
await cdp.call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await wait(1500);

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (page: typeof cdp, selector: string) => page.evaluate(`(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.getClientRects().length);
  if (!nodes.length) return null;
  const rects = nodes.map((n) => n.getBoundingClientRect());
  const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
  return { x, y, w: Math.max(...rects.map((r) => r.right)) - x, h: Math.max(...rects.map((r) => r.bottom)) - y };
})()`) as Promise<Box | null>;
const union = (...boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};
const manifestPath = join(out, 'manifest.json');
async function shot(page: typeof cdp, id: string, box: Box, pad = 0, size = { w: W, h: H }): Promise<void> {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const w = Math.min(size.w - x, Math.ceil(box.w + 2 * pad));
  const h = Math.min(size.h - y, Math.ceil(box.h + 2 * pad));
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 1 } });
  const png = join(session.decksRoot, `${id}.png`);
  writeFileSync(png, Buffer.from(data, 'base64'));
  execFileSync('cwebp', ['-quiet', '-metadata', 'none', '-q', '86', png, '-o', join(out, `${id}.webp`)]);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  manifest[id] = { kind: 'still', w, h };
  writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
  console.log(`web ${id} ${w}x${h}`);
}
const centreOf = async (page: typeof cdp, selector: string, index = 0) => page.evaluate(`(() => {
  const r = document.querySelectorAll(${JSON.stringify(selector)})[${index}].getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
})()`) as Promise<[number, number]>;

// A second person, in a second tab, with an object selected.
const other = await (async () => {
  const url = session.editorUrl().replace('name=Sam', 'name=Alex');
  await cdp.evaluate(`void window.open(${JSON.stringify(url)}, '_blank', 'width=1680,height=1000')`);
  const page = await session.connectTarget((t: { url: string }) => t.url.includes('name=Alex'));
  await page.call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await wait(2500);
  return page;
})();

try {
  if (wanted('presence')) {
    await cdp.clickAt(...await centreOf(cdp, '#rail .rail-item', 1));
    await other.clickAt(...await centreOf(other, '#rail .rail-item', 1));
    await wait(800);
    await other.clickAt(...await centreOf(other, '#canvas .slide-layer [data-element-id]', 2));
    await other.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 420, button: 'none', buttons: 0 });
    await wait(1200);
    const stage = (await boxOf(cdp, '#canvas .stage'))!;
    await shot(cdp, 'presence', { x: stage.x + stage.w * 0.06, y: stage.y + stage.h * 0.28, w: stage.w * 0.88, h: stage.h * 0.48 });
  }
  if (wanted('chat')) {
    await cdp.clickByText('#side-tabs button', 'Chat');
    await wait(500);
    await cdp.click('.chat-compose textarea, .chat-compose [contenteditable], .chat-compose input');
    await cdp.typeKeys('@agent make the chart on slide 3 use the deck colours');
    await cdp.key('Enter', 13);
    await wait(800);
    await shot(cdp, 'chat', { ...(await boxOf(cdp, '#side-panels'))!, h: 520 });
    await cdp.clickByText('#side-tabs button', 'Props');
  }
  if (wanted('download-deck')) {
    await cdp.clickByText('#toolbar button', 'File');
    await wait(600);
    const menu = (await boxOf(cdp, '.shape-menu'))!;
    const file = (await boxOf(cdp, '#toolbar .toolbar-compact-file-action'))!;
    await shot(cdp, 'download-deck', union(menu, file), 12);
    await cdp.key('Escape', 27);
  }
  if (wanted('phone-client')) {
    await other.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await other.call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await other.call('Page.navigate', { url: `${session.editorUrl().replace('name=Sam', 'name=Alex')}&mobile=1` });
    await wait(3500);
    await shot(other, 'phone-client', { x: 0, y: 0, w: 390, h: 844 }, 0, { w: 390, h: 844 });
  }
} finally {
  await session.close();
}
process.exit(0);
