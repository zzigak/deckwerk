// Screenshots of the real desktop editor for the docs, through the test
// harness (test/support/desktopApp.ts), with the docs deck open in the light
// UI theme. Run it from the root of a DeckWerk checkout:
//
//   node_modules/.bin/vite-node --config vitest.config.ts \
//     <path>/site/docs/media-src/ui.mts <deck-dir> [ids...]
//
// The app works on a copy of the deck. Each picture is cropped to the panel
// it is about and written to site/docs/media/<id>.webp at twice CSS size.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = process.cwd();
const [deckArg, ...only] = process.argv.slice(2);
if (!deckArg) throw new Error('usage: ui.mts <deck-dir> [ids...]');
const out = join(here, '..', 'media');

type Cdp = {
  call: (method: string, params?: object) => Promise<any>;
  evaluate: <T>(expression: string) => Promise<T>;
  click: (selector: string) => Promise<void>;
  clickByText: (selector: string, text: string) => Promise<void>;
  clickAt: (x: number, y: number) => Promise<void>;
  rightClick: (selector: string) => Promise<void>;
  rightClickAt: (x: number, y: number) => Promise<void>;
  doubleClickAt: (x: number, y: number) => Promise<void>;
  key: (key: string, code: number) => Promise<void>;
  chord: (key: string, code: string, keyCode: number, modifiers: number) => Promise<void>;
  typeKeys: (value: string) => Promise<void>;
  close: () => void;
};
const { Cdp: CdpClass, findTarget, wait } = await import(join(checkout, 'test/support/browserSession.ts'));
const { isEditorTarget, launchDesktopApp, materializeDesktopApp } = await import(join(checkout, 'test/support/desktopApp.ts'));

const work = await mkdtemp(join(tmpdir(), 'docs-ui-'));
await mkdir(join(work, 'app'), { recursive: true });
await cp(resolve(deckArg), join(work, 'deck'), { recursive: true });
await materializeDesktopApp(join(work, 'app'), 'deckwerk-docs-ui');
const app = await launchDesktopApp(join(work, 'app'), [join(work, 'deck')], { profileDir: join(work, 'profile') });
const target = await findTarget(app.debugPort, isEditorTarget, app.log, 60_000);
const cdp: Cdp = await CdpClass.connect(target.webSocketDebuggerUrl);
const W = 1680;
const H = 1000;
await cdp.call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await cdp.call('Page.bringToFront');
await wait(1500);

const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;
const deck = JSON.parse(readFileSync(join(work, 'deck', 'deck.json'), 'utf8'));
const numberOf = (name: string) => deck.slides.findIndex((slide: { name: string }) => slide.name === name);

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (selector: string) => cdp.evaluate<Box | null>(`(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.getClientRects().length);
  if (!nodes.length) return null;
  const rects = nodes.map((n) => n.getBoundingClientRect());
  const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
  return { x, y, w: Math.max(...rects.map((r) => r.right)) - x, h: Math.max(...rects.map((r) => r.bottom)) - y };
})()`);
const union = (...boxes: Array<Box | null>): Box => {
  const real = boxes.filter((b): b is Box => Boolean(b));
  const x = Math.min(...real.map((b) => b.x)), y = Math.min(...real.map((b) => b.y));
  return { x, y, w: Math.max(...real.map((b) => b.x + b.w)) - x, h: Math.max(...real.map((b) => b.y + b.h)) - y };
};

const manifestPath = join(out, 'manifest.json');
/** Screenshot `box` (CSS pixels, padded and clamped to the window) as media/<id>.webp. */
async function shot(id: string, box: Box, pad = 0, page: Cdp = cdp, size = { w: W, h: H }): Promise<void> {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const w = Math.min(size.w - x, Math.ceil(box.w + 2 * pad));
  const h = Math.min(size.h - y, Math.ceil(box.h + 2 * pad));
  const { data } = await page.call('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 1 } });
  const png = join(work, `${id}.png`);
  writeFileSync(png, Buffer.from(data, 'base64'));
  execFileSync('cwebp', ['-quiet', '-metadata', 'none', '-q', '86', png, '-o', join(out, `${id}.webp`)]);
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  manifest[id] = { kind: 'still', w, h };
  writeFileSync(manifestPath, `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
  console.log(`ui ${id} ${w}x${h}`);
}

// ---- moves a person makes ------------------------------------------------
const escape = async (times = 2) => { for (let i = 0; i < times; i++) { await cdp.key('Escape', 27); await wait(120); } };
async function goTo(name: string): Promise<void> {
  const index = numberOf(name);
  await cdp.evaluate(`document.querySelectorAll('#rail .rail-item')[${index}].scrollIntoView({ block: 'center' })`);
  await wait(250);
  await cdp.evaluate(`(() => { const r = document.querySelectorAll('#rail .rail-item')[${index}].getBoundingClientRect(); window.__railAt = [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const [x, y] = await cdp.evaluate<[number, number]>('window.__railAt');
  await cdp.clickAt(x, y);
  await wait(500);
}
const tab = async (label: string) => { await cdp.clickByText('#side-tabs button', label); await wait(400); };
/** The centre of the n-th object on the canvas, in paint order of the slide's elements. */
const elementCentre = (n: number) => cdp.evaluate<[number, number]>(`(() => {
  const r = document.querySelectorAll('#canvas .slide-layer [data-element-id]')[${n}].getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
})()`);
async function selectElement(n: number, modifiers = 0): Promise<void> {
  const [x, y] = await elementCentre(n);
  if (!modifiers) { await cdp.clickAt(x, y); await wait(300); return; }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers });
  }
  await wait(300);
}
const clickText = async (selector: string, text: string) => { await cdp.clickByText(selector, text); await wait(400); };
const scrollInto = (selector: string) => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`);
/** The panel section under the heading `title`: from it to the next heading. */
const sectionBox = (title: string, pad = 10) => cdp.evaluate<Box | null>(`(() => {
  const root = document.querySelector('#side-panels');
  const heads = [...root.querySelectorAll('.insp-subtitle, .insp-title')].filter((n) => n.getClientRects().length);
  const at = heads.findIndex((n) => n.textContent.trim().toLowerCase() === ${JSON.stringify(title.toLowerCase())});
  if (at < 0) return null;
  heads[at].scrollIntoView({ block: 'start' });
  const panel = root.getBoundingClientRect();
  const top = heads[at].getBoundingClientRect().top - ${pad};
  const next = heads.slice(at + 1).find((n) => n.getBoundingClientRect().top > top + 20);
  const bottom = next ? next.getBoundingClientRect().top - 6 : Math.min(panel.bottom, top + 700);
  return { x: panel.left, y: Math.max(panel.top, top), w: panel.width, h: bottom - Math.max(panel.top, top) };
})()`);
/** Remember what is on screen, so `newLayer` can find the menu or dialog an action opens. */
const mark = () => cdp.evaluate(`(() => { for (const n of document.querySelectorAll('*')) n.__seen = true; })()`);
const newLayer = () => cdp.evaluate<Box | null>(`(() => {
  const fresh = [...document.querySelectorAll('body *')].filter((n) => {
    if (n.__seen || !n.getClientRects().length) return false;
    const r = n.getBoundingClientRect();
    if (r.width * r.height < 1500) return false;
    const style = getComputedStyle(n);
    return style.position === 'fixed' || style.position === 'absolute' || n.getAttribute('role') === 'dialog' || n.tagName === 'DIALOG';
  });
  const top = fresh.filter((n) => !fresh.some((other) => other !== n && other.contains(n)));
  if (!top.length) return null;
  const rects = top.map((n) => n.getBoundingClientRect());
  const x = Math.min(...rects.map((r) => r.left)), y = Math.min(...rects.map((r) => r.top));
  return { x, y, w: Math.max(...rects.map((r) => r.right)) - x, h: Math.max(...rects.map((r) => r.bottom)) - y };
})()`);
/** The visible boxes matching `selector`, as one box. */
const layer = (selector: string) => boxOf(selector);
const buttonBox = (selector: string, text: string) => cdp.evaluate<Box | null>(`(() => {
  const n = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.getClientRects().length && (b.textContent.trim() === ${JSON.stringify(text)} || b.title === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}));
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
})()`);
const centre = (box: Box): [number, number] => [box.x + box.w / 2, box.y + box.h / 2];
const stageBox = () => boxOf('#canvas .stage');
async function rightClickElement(n: number): Promise<void> {
  const [x, y] = await elementCentre(n);
  await cdp.rightClickAt(x, y);
  await wait(400);
}
async function openFileMenu(): Promise<void> {
  const file = await buttonBox('#toolbar button', 'File');
  await cdp.clickAt(...centre(file!));
  await wait(400);
}
async function drag(from: [number, number], to: [number, number], steps = 12, release = true): Promise<void> {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1], button: 'none', buttons: 0 });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps, y = from[1] + ((to[1] - from[1]) * i) / steps;
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await wait(16);
  }
  if (release) await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1 });
}
const undo = () => cdp.chord('z', 'KeyZ', 90, MOD);

const scenes: Record<string, () => Promise<void>> = {
  'slide-rail': async () => {
    await goTo('roles');
    await shot('slide-rail', { x: 0, y: 44, w: 220, h: 340 });
  },
  'hide-slide': async () => {
    await goTo('inline');
    await clickText('#rail .rail-actions button', 'Hide');
    await goTo('roles');
    await shot('hide-slide', { x: 0, y: 44, w: 220, h: 440 });
    await undo();
  },
  layouts: async () => {
    await goTo('roles');
    await tab('Props');
    await shot('layouts', (await sectionBox('Layout'))!);
  },
  'layout-masters': async () => {
    await tab('Design');
    await clickText('#side-panels button', 'Edit layouts…');
    await wait(800);
    await shot('layout-masters', { x: 0, y: 0, w: W, h: H });
    await clickText('button', 'Cancel');
    await tab('Props');
  },
  themes: async () => {
    await tab('Design');
    await mark();
    const card = await cdp.evaluate<Box>(`(() => {
      const button = [...document.querySelectorAll('#side-panels button')].find((n) => n.getClientRects().length);
      const r = button.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    await cdp.clickAt(...centre(card));
    await wait(900);
    await shot('themes', (await layer('.theme-gallery'))!, 4);
    await escape();
    await tab('Props');
  },
  'edit-theme': async () => {
    await tab('Design');
    await clickText('#side-panels button', 'Edit…');
    await wait(500);
    await shot('edit-theme', { ...(await boxOf('#side-panels'))!, h: 600 });
    await clickText('#side-panels button', 'Cancel');
    await tab('Props');
  },
  'apply-theme': async () => {
    await tab('Design');
    await shot('apply-theme', (await sectionBox('Apply theme'))!);
    await tab('Props');
  },
  guides: async () => {
    await goTo('shapes');
    await selectElement(1);
    const [x, y] = await elementCentre(1);
    await drag([x, y], [x + 6, y - 61], 14, false);
    await wait(300);
    const stage = (await stageBox())!;
    await shot('guides', { x: stage.x, y: stage.y + stage.h * 0.12, w: stage.w, h: stage.h * 0.76 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 6, y: y - 61, button: 'left', buttons: 0, clickCount: 1 });
    await undo();
  },
  rulers: async () => {
    await goTo('shapes');
    await selectElement(0);
    await cdp.chord('r', 'KeyR', 82, MOD);
    await wait(500);
    const canvas = (await boxOf('#canvas'))!;
    await shot('rulers', { x: canvas.x, y: canvas.y, w: canvas.w * 0.62, h: canvas.h * 0.55 });
    await cdp.chord('r', 'KeyR', 82, MOD);
  },
  zoom: async () => {
    await shot('zoom', (await boxOf('#canvas .zoom-controls'))!, 14);
  },
  'object-list': async () => {
    await goTo('shapes');
    const rows = (await boxOf('#objects .object-list-header, #objects .object-list-row'))!;
    await shot('object-list', { ...rows, h: rows.h + 12 });
  },
  align: async () => {
    await goTo('shapes');
    await tab('Props');
    await selectElement(0);
    await selectElement(1, SHIFT);
    await selectElement(2, SHIFT);
    await shot('align', (await sectionBox('Align'))!);
  },
  arrange: async () => {
    await goTo('shapes');
    await mark();
    await rightClickElement(2);
    await shot('arrange', (await layer('#ctx-menu'))!, 10);
  },
  'speaker-notes': async () => {
    await goTo('roles');
    await cdp.click('#canvas .notes-toggle');
    await wait(500);
    await cdp.click('#canvas .notes-drawer-text');
    await cdp.typeKeys('Start with the result, then the method.');
    await wait(300);
    const drawer = (await boxOf('#canvas .notes-drawer'))!;
    await shot('speaker-notes', drawer, 8);
    await escape();
  },
  'text-box': async () => {
    await goTo('roles');
    const [x, y] = await elementCentre(0);
    await cdp.doubleClickAt(x, y);
    await wait(500);
    const stage = (await stageBox())!;
    await shot('text-box', { x: stage.x + stage.w * 0.08, y: stage.y + stage.h * 0.18, w: stage.w * 0.7, h: stage.h * 0.62 });
    await escape(3);
  },
  pen: async () => {
    await mark();
    await cdp.click('#toolbar .pen-tool-menu');
    await wait(400);
    const menu = (await layer('.shape-menu'))!;
    const pen = (await boxOf('#toolbar .pen-tool-control'))!;
    await shot('pen', union(menu, pen), 12);
    await escape();
  },
  'edit-points': async () => {
    await goTo('strokes');
    const [x, y] = await elementCentre(1);
    await cdp.doubleClickAt(x, y);
    await wait(600);
    const stage = (await stageBox())!;
    await shot('edit-points', { x: stage.x + stage.w * 0.2, y: stage.y + stage.h * 0.3, w: stage.w * 0.42, h: stage.h * 0.42 });
    await escape(3);
  },
  geometry: async () => {
    await goTo('flip');
    await tab('Props');
    await selectElement(1);
    await shot('geometry', (await sectionBox('Geometry'))!);
  },
  'colour-picker': async () => {
    await goTo('shapes');
    await tab('Props');
    await selectElement(0);
    await sectionBox('Style');
    await mark();
    const swatch = await cdp.evaluate<Box>(`(() => {
      const label = [...document.querySelectorAll('#side-panels *')].find((n) => n.children.length === 0 && n.textContent.trim().toLowerCase() === 'fill' && n.getClientRects().length);
      const row = label.closest('.insp-row, .row, label, div');
      const button = row.querySelector('button, .color-swatch, [class*=swatch]');
      const r = button.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    await cdp.clickAt(...centre(swatch));
    await wait(500);
    await shot('colour-picker', (await newLayer())!, 8);
    await escape();
  },
  trim: async () => {
    await goTo('video');
    await tab('Props');
    await selectElement(0);
    await shot('trim', (await sectionBox('Trim'))!);
  },
  'media-advanced': async () => {
    await goTo('video');
    await tab('Props');
    await selectElement(0);
    await shot('media-advanced', (await sectionBox('Advanced'))!);
  },
  'media-tab': async () => {
    await tab('Media');
    await shot('media-tab', { ...(await boxOf('#side-panels'))!, h: 500 });
    await tab('Props');
  },
  history: async () => {
    await tab('History');
    await shot('history', { ...(await boxOf('#side-panels'))!, h: 400 });
    await tab('Props');
  },
  'build-order': async () => {
    await goTo('build-steps');
    await tab('Build');
    const stage = (await stageBox())!;
    const side = (await boxOf('#side'))!;
    await shot('build-order', { x: stage.x + stage.w * 0.08, y: side.y, w: side.x + side.w - (stage.x + stage.w * 0.08), h: 700 });
  },
  'build-preview': async () => {
    await goTo('line-draw');
    await tab('Build');
    await shot('build-preview', { ...(await boxOf('#side-panels'))!, h: 360 });
    await tab('Props');
  },
  'morph-editor': async () => {
    await goTo('morph-a');
    await tab('Props');
    await clickText('#side-panels button', 'Enable and Auto-Pair');
    await mark();
    await clickText('#side-panels button', 'Open Morph editor…');
    await wait(900);
    await shot('morph-editor', (await layer('.morph-modal'))!, 4);
    await clickText('button', 'Done');
    await undo();
  },
  'morph-many': async () => {
    await goTo('morph-a');
    const index = numberOf('morph-b');
    const r = await cdp.evaluate<Box>(`(() => { const r = document.querySelectorAll('#rail .rail-item')[${index}].getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.call('Input.dispatchMouseEvent', { type, x: r.x + r.w / 2, y: r.y + r.h / 2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers: SHIFT });
    }
    await wait(500);
    await tab('Props');
    await shot('morph-many', { ...(await boxOf('#side-panels'))!, h: 420 });
    await goTo('roles');
  },
  present: async () => {
    await mark();
    await cdp.click('#toolbar .toolbar-split-menu');
    await wait(900);
    const menu = (await layer('.shape-menu'))!;
    const split = (await boxOf('#toolbar .toolbar-split-button'))!;
    await shot('present', union(menu, split), 12);
    await escape();
  },
  comments: async () => {
    await goTo('shapes');
    await rightClickElement(0);
    await clickText('button, [role=menuitem]', 'Comment…');
    await wait(400);
    await cdp.typeKeys('Make this one the same blue as the others.');
    await mark();
    await clickText('button', 'Comment');
    await wait(600);
    const pop = (await layer('#comments-popover'))!;
    const [ex, ey] = await elementCentre(0);
    await shot('comments', union(pop, { x: ex - 80, y: ey - 60, w: 160, h: 120 }), 16);
    await escape();
  },
  'agent-desktop': async () => {
    await mark();
    await clickText('#toolbar button', 'Agent…');
    await wait(1200);
    // The panel names the deck folder, here a temporary one on this machine;
    // the picture shows a made-up one instead.
    await cdp.evaluate(`(() => {
      const deck = ${JSON.stringify(join(work, 'deck'))};
      for (const node of document.querySelectorAll('.agent-chat-panel *')) {
        if (node.children.length === 0 && node.textContent.includes(deck)) node.textContent = '~/Talks/results-talk';
        if ('value' in node && typeof node.value === 'string' && node.value.includes(deck)) node.value = '~/Talks/results-talk';
      }
    })()`);
    await wait(200);
    await shot('agent-desktop', (await layer('.agent-chat-panel'))!, 6);
    await clickText('#toolbar button', 'Agent…');
  },
  'file-menu': async () => {
    await mark();
    await openFileMenu();
    const menu = (await layer('.shape-menu'))!;
    const file = (await buttonBox('#toolbar button', 'File'))!;
    await shot('file-menu', union(menu, file), 12);
    await escape();
  },
  'export-pdf': async () => {
    await openFileMenu();
    await mark();
    await clickText('button, [role=menuitem]', 'Export PDF…');
    await wait(700);
    await shot('export-pdf', (await layer('.workflow-dialog'))!, 4);
    await clickText('button', 'Cancel');
  },
  'export-web': async () => {
    await openFileMenu();
    await mark();
    await clickText('button, [role=menuitem]', 'Export Web…');
    await wait(700);
    await shot('export-web', (await layer('.workflow-dialog'))!, 4);
    await clickText('button', 'Cancel');
  },
  'open-settings': async () => {
    await mark();
    await cdp.chord(',', 'Comma', 188, MOD);
    await wait(700);
    await shot('open-settings', (await layer('.workflow-dialog'))!, 4);
    await clickText('button', 'Done');
  },
  appearance: async () => {
    await goTo('chart');
    await cdp.chord(',', 'Comma', 188, MOD);
    await wait(600);
    await clickText('button', 'Dark');
    await clickText('button', 'Done');
    await wait(600);
    await shot('appearance', { x: 0, y: 0, w: W, h: H });
    await cdp.chord(',', 'Comma', 188, MOD);
    await wait(600);
    await clickText('button', 'Light');
    await clickText('button', 'Done');
  },
  'presenter-display': async () => {
    await goTo('roles');
    await cdp.click('#toolbar .toolbar-split-menu');
    await wait(700);
    await clickText('.shape-menu button, .shape-menu [role=menuitem]', 'Present in Speaker View');
    const found = await findTarget(app.debugPort, (t: { title: string }) => t.title === 'Speaker View', app.log, 30_000);
    const speaker: Cdp = await CdpClass.connect(found.webSocketDebuggerUrl);
    await speaker.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 2, mobile: false });
    await wait(2500);
    await shot('presenter-display', { x: 0, y: 0, w: 1600, h: 900 }, 0, speaker, { w: 1600, h: 900 });
    await speaker.key('Escape', 27).catch(() => {});
    speaker.close();
    await wait(1000);
  },
  // The comparison chip under two selected videos (the wipe-length branch).
  'wipe-button': async () => {
    await goTo('synced');
    await selectElement(0);
    await selectElement(1, SHIFT);
    await wait(400);
    const stage = (await stageBox())!;
    const chip = (await layer('.compare-chip'))!;
    await shot('wipe-button', union({ x: stage.x + stage.w * 0.04, y: stage.y + stage.h * 0.25, w: stage.w * 0.92, h: stage.h * 0.4 }, chip), 12);
  },
  'wipe-length': async () => {
    await goTo('wipe');
    const [x, y] = await elementCentre(0);
    await cdp.clickAt(x, y);
    await cdp.chord('a', 'KeyA', 65, MOD);
    await wait(500);
    const stage = (await stageBox())!;
    const chip = (await layer('.compare-chip'))!;
    await shot('wipe-length', union({ x: stage.x + stage.w * 0.18, y: stage.y + stage.h * 0.16, w: stage.w * 0.64, h: stage.h * 0.62 }, chip), 12);
  },
};

const BRANCH_ONLY = ['wipe-button', 'wipe-length'];
const ids = only.length ? only : Object.keys(scenes).filter((id) => !BRANCH_ONLY.includes(id));
for (const id of ids) {
  try {
    await scenes[id]();
  } catch (error) {
    console.error(`ui ${id} failed:`, error);
  }
  await escape();
}
cdp.close();
app.process.kill();
await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
process.exit(0);
