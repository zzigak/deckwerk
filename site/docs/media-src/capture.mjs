// Captures the docs pictures from the docs deck (build-deck.mts): stills
// rendered by slide-agent and cropped to their content, and short clips
// recorded from the real player in headless Chrome and encoded with ffmpeg.
//
//   node site/docs/media-src/capture.mjs <checkout> <deck-dir> <web-export-dir> [ids...]
//
// <web-export-dir> is the deck exported with the checkout's export script at
// original quality. Output goes to site/docs/media/<id>.webp, and for a clip
// <id>.mp4 beside its poster <id>.webp. Needs Google Chrome and ffmpeg.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [checkout, deckDir, webDir, ...only] = process.argv.slice(2).map((arg, index) => (index < 3 ? resolve(arg) : arg));
if (!webDir) throw new Error('usage: capture.mjs <checkout> <deck-dir> <web-export-dir> [ids...]');
const out = join(here, '..', 'media');
mkdirSync(out, { recursive: true });
const chromePath = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Still: a feature id and the slide (by name) that shows it. */
const STILLS = {
  'text-roles': 'roles', fonts: 'fonts', 'inline-styles': 'inline', 'text-colour': 'colour',
  alignment: 'align', spacing: 'spacing', lists: 'lists', 'bullet-styles': 'bullets', indent: 'indent',
  links: 'links', 'auto-fit': 'autofit', 'text-box-style': 'textbox', tables: 'table',
  'shape-kinds': 'shapes', arrowheads: 'arrowheads', 'curved-arrows': 'curved', braces: 'braces',
  'stroke-styles': 'strokes', shadows: 'shadows', gradients: 'gradients', 'flip-rotate': 'flip',
  'add-media': 'images', crop: 'crop', mask: 'mask', 'media-effects': 'effects', background: 'background',
  latex: 'latex', 'code-block': 'code', chart: 'chart', 'chart-style': 'chart-style', 'paper-card': 'paper',
  '3d-models': 'model', 'web-element': 'web', 'html-region': 'html-region',
};

/**
 * Clip: the slide it starts on and what happens while recording:
 * a number waits that many ms, "next" advances one step, "key:<k>" presses
 * a key, "move:x,y" moves the pointer and "drag:x1,y1,x2,y2,ms" drags,
 * in slide pixels.
 */
const CLIPS = {
  video: ['video', 3000],
  'synced-videos': ['synced', 3500],
  wipe: ['wipe', 500, 'drag:960,517,600,517,700', 'drag:600,517,1320,517,1000', 'drag:1320,517,960,517,500', 200],
  'hover-bar': ['video', 'move:960,500', 'move:980,520', 2600],
  'video-speed': ['video', 'move:960,500', 800, 'key:]', 700, 'key:]', 1500],
  'add-build': ['build-steps', 600, 'next', 700, 'next', 700, 'next', 1300],
  'dissolve-blur': ['dissolve-blur', 600, 'next', 2600],
  'line-draw': ['line-draw', 600, 'next', 3000],
  'pop-in': ['pop-in', 600, 'next', 2600],
  keyboard: ['keyboard', 600, 'next', 2400],
  'by-paragraph': ['by-paragraph', 600, 'next', 600, 'next', 600, 'next', 600, 'next', 1000],
  'play-pause': ['play', 600, 'next', 4800],
  emphasis: ['emphasis', 500, 'next', 1100, 'next', 1000, 'next', 1100],
  morph: ['morph-a', 600, 'next', 1900],
  'equation-morph': ['eq-morph-a', 600, 'next', 1700, 'next', 1900],
  'term-builds': ['term-build', 500, 'next', 700, 'next', 700, 'next', 1100],
  'term-colour': ['term-colour', 500, 'next', 900, 'next', 1300],
  'term-pulse': ['term-pulse', 500, 'next', 1700],
  'line-builds': ['code-lines', 500, 'next', 900, 'next', 900, 'next', 1400],
  'chart-builds': ['chart-build', 500, 'next', 1000, 'next', 1500],
};

/**
 * media/manifest.json: each picture's kind and its size on the page in CSS
 * pixels, half a slide pixel each, so every picture shows slides at one scale.
 */
const manifestPath = join(out, 'manifest.json');
const record = (id, kind, w, h) => {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  manifest[id] = { kind, w: Math.round(w), h: Math.round(h) };
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(manifestPath, `${JSON.stringify(sorted, null, 1)}\n`);
};

const deck = JSON.parse(readFileSync(join(deckDir, 'deck.json'), 'utf8'));
const numberOf = (name) => {
  const index = deck.slides.findIndex((slide) => slide.name === name);
  if (index < 0) throw new Error(`no slide named ${name}`);
  return index + 1;
};
const wanted = (id) => only.length === 0 || only.includes(id);
const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/**
 * The box around everything that is not white in `input` (a still, or every
 * fifth frame of a clip), padded and even, in pixels.
 */
function cropOf(input, width, height, pad = 56) {
  const gray = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', `${/\.png$/.test(input) ? '' : 'fps=6,'}scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-'],
  { maxBuffer: 1 << 30 });
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let at = 0; at + width * height <= gray.length; at += width * height) {
    for (let y = 0; y < height; y++) {
      const row = at + y * width;
      for (let x = 0; x < width; x++) {
        if (gray[row + x] < 236) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: width, h: height };
  const even = (n) => n - (n % 2);
  const left = even(Math.max(0, x0 - pad));
  const top = even(Math.max(0, y0 - pad));
  return {
    x: left, y: top,
    w: even(Math.min(width, x1 + 1 + pad) - left),
    h: even(Math.min(height, y1 + 1 + pad) - top),
  };
}

// ---- stills -------------------------------------------------------------
const stills = Object.entries(STILLS).filter(([id]) => wanted(id));
if (stills.length) {
  const renders = mkdtempSync(join(tmpdir(), 'docs-stills-'));
  for (const [id, name] of stills) {
    const reply = JSON.parse(execFileSync(join(checkout, 'bin/slide-agent'),
      ['render', deckDir, '--slide', String(numberOf(name)), '--built', '--output', renders],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    const png = reply.images[0].path;
    const box = name === 'background' ? { x: 0, y: 0, w: 1920, h: 1080 } : cropOf(png, 1920, 1080);
    const scale = box.w > 1480 ? ',scale=1480:-2' : '';
    const tmp = join(renders, `${id}.png`);
    ff('-i', png, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}${scale}`, tmp);
    execFileSync('cwebp', ['-quiet', '-metadata', 'none', '-q', '82', tmp, '-o', join(out, `${id}.webp`)]);
    record(id, 'still', box.w / 2, box.h / 2);
    console.log(`still ${id} ${box.w}x${box.h}`);
  }
  rmSync(renders, { recursive: true, force: true });
}

// The contact sheet `render --contact-sheet` makes, its first three rows.
if (wanted('contact-sheet')) {
  const renders = mkdtempSync(join(tmpdir(), 'docs-sheet-'));
  const reply = JSON.parse(execFileSync(join(checkout, 'bin/slide-agent'),
    ['render', deckDir, '--slide', '1,2,3,8,14,16,20,22,24,44,50,53', '--built', '--output', renders, '--contact-sheet'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const sheet = reply.contactSheet;
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', sheet],
    { encoding: 'utf8' }).trim().split(',').map(Number);
  const tmp = join(renders, 'sheet.png');
  // The page lays three columns out on the left of a wide window.
  const keepW = Math.round(w * 0.75) - (Math.round(w * 0.75) % 2);
  const keep = Math.min(h, Math.round(w * 0.462)) - (Math.min(h, Math.round(w * 0.462)) % 2);
  ff('-i', sheet, '-vf', `crop=${keepW}:${keep}:0:0`, tmp);
  execFileSync('cwebp', ['-quiet', '-metadata', 'none', '-q', '82', tmp, '-o', join(out, 'contact-sheet.webp')]);
  record('contact-sheet', 'still', keepW / 2, keep / 2);
  console.log(`still contact-sheet ${w}x${keep}`);
  rmSync(renders, { recursive: true, force: true });
}

// ---- clips ----------------------------------------------------------------
const clips = Object.entries(CLIPS).filter(([id]) => wanted(id));
if (clips.length) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const server = createServer((req, res) => {
    const path = join(webDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(path) || statSync(path).isDirectory()) { res.writeHead(404); res.end(); return; }
    const data = readFileSync(path);
    const type = types[extname(path)] ?? 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : data.length - 1;
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': data.length });
    res.end(data);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(join(tmpdir(), 'docs-chrome-'));
  const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((done) => {
    let text = '';
    chrome.stderr.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) done(match[1]);
    });
  });
  const browser = new WebSocket(wsUrl);
  await new Promise((done) => browser.addEventListener('open', done));
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  browser.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    for (const listen of listeners) listen(msg);
  });
  let sessionId;
  const send = (method, params = {}) => new Promise((done) => {
    const id = ++nextId;
    pending.set(id, done);
    browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  ({ result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable');
  // The stage is 1600 wide; the player fits the 1920 slide to it.
  const W = 1600, H = 900, S = W / 1920;
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  const key = async (k, code, keyCode, text) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode });
  };
  const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', {
    type, x: x * S, y: y * S, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: 1,
  });

  for (const [id, [slide, ...steps]] of clips) {
    await send('Page.navigate', { url: `${origin}/index.html#${numberOf(slide)}` });
    await sleep(2500);
    // Out of the way of what is recorded.
    await mouse('mouseMoved', 1919, 1079);
    await sleep(400);
    const frames = [];
    const onFrame = (msg) => {
      if (msg.method !== 'Page.screencastFrame' || msg.sessionId !== sessionId) return;
      frames.push({ data: msg.params.data, t: msg.params.metadata.timestamp });
      void send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
    };
    listeners.add(onFrame);
    await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(150);
    for (const step of steps) {
      if (typeof step === 'number') await sleep(step);
      else if (step === 'next') await key('ArrowRight', 'ArrowRight', 39);
      else if (step.startsWith('key:')) { const k = step.slice(4); await key(k, 'BracketRight', 221, k); }
      else if (step.startsWith('move:')) { const [x, y] = step.slice(5).split(',').map(Number); await mouse('mouseMoved', x, y); }
      else if (step.startsWith('drag:')) {
        const [x1, y1, x2, y2, ms] = step.slice(5).split(',').map(Number);
        await mouse('mouseMoved', x1, y1);
        await mouse('mousePressed', x1, y1, 1);
        const n = Math.max(2, Math.round(ms / 33));
        for (let i = 1; i <= n; i++) {
          await mouse('mouseMoved', x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n, 1);
          await sleep(ms / n);
        }
        await mouse('mouseReleased', x2, y2);
      }
    }
    await send('Page.stopScreencast');
    listeners.delete(onFrame);

    // Frames, each held until the next one came, at 30 fps.
    const work = mkdtempSync(join(tmpdir(), `docs-clip-${id}-`));
    const list = [];
    frames.forEach((frame, index) => {
      const file = join(work, `f${String(index).padStart(4, '0')}.png`);
      writeFileSync(file, Buffer.from(frame.data, 'base64'));
      const next = frames[index + 1]?.t ?? frame.t + 0.5;
      list.push(`file '${file}'`, `duration ${Math.max(0.001, next - frame.t).toFixed(4)}`);
    });
    list.push(`file '${join(work, `f${String(frames.length - 1).padStart(4, '0')}.png`)}'`);
    writeFileSync(join(work, 'frames.txt'), list.join('\n'));
    const raw = join(work, 'raw.mp4');
    ff('-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'), '-vf', 'fps=30,format=yuv420p',
      '-c:v', 'libx264', '-crf', '12', raw);
    const box = cropOf(raw, W, H, 40);
    const width = Math.min(800, box.w - (box.w % 2));
    const filter = `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${width}:-2:flags=lanczos`;
    ff('-i', raw, '-vf', `${filter},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '27',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
      '-movflags', '+faststart', '-an', join(out, `${id}.mp4`));
    const poster = join(work, 'poster.png');
    ff('-sseof', '-0.1', '-i', raw, '-frames:v', '1', '-vf', filter, poster);
    execFileSync('cwebp', ['-quiet', '-metadata', 'none', '-q', '80', poster, '-o', join(out, `${id}.webp`)]);
    // The stage drew the slide at W/1920 of its size.
    record(id, 'clip', (box.w / S) / 2, (box.h / S) / 2);
    const size = statSync(join(out, `${id}.mp4`)).size;
    console.log(`clip ${id} ${frames.length} frames, ${box.w}x${box.h}, ${(size / 1024).toFixed(0)} KB`);
    rmSync(work, { recursive: true, force: true });
  }
  browser.close();
  const exited = new Promise((done) => chrome.once('exit', done));
  chrome.kill();
  await exited;
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
