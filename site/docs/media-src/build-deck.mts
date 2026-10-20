// Builds the docs deck: the media from assets.sh, the "Docs blue" theme and
// the slides in slides.html, in a new deck folder. Run it from the root of a
// DeckWerk checkout (it uses that checkout's slide-agent and editor code):
//
//   node_modules/.bin/vite-node --config vitest.config.ts \
//     <path>/site/docs/media-src/build-deck.mts <deck-dir>
//
// Builds that authoring HTML cannot state (a by-paragraph reveal, a video
// started by a click) are added to deck.json afterwards.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checkout = process.cwd();
const deckDir = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('usage: build-deck.mts <deck-dir>');

const { emptyDeck } = await import(join(checkout, 'src/shared/deck.ts'));
const { saveDeck, loadDeck } = await import(join(checkout, 'src/main/deckStore.ts'));
const { importMeshPage } = await import(join(checkout, 'src/main/meshPage.ts'));

const agent = (...args: string[]): string => execFileSync(join(checkout, 'bin/slide-agent'), args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 << 20,
});

rmSync(deckDir, { recursive: true, force: true });
mkdirSync(deckDir, { recursive: true });
await saveDeck(deckDir, emptyDeck('DeckWerk docs'));
agent('theme', 'create', deckDir, '--spec', join(here, 'theme.json'));
agent('theme', 'choose', deckDir, '--id', 'docs-blue');

// Media, under the names slides.html uses.
const media = join(deckDir, '.media');
execFileSync('sh', [join(here, 'assets.sh'), media], { stdio: 'inherit' });
const files = readdirSync(media).filter((name) => !name.endsWith('.obj')).map((name) => join(media, name));
const imported = JSON.parse(agent('asset', 'import', deckDir, ...files)) as { assets: Array<{ src: string }> };
const names: Record<string, string> = {};
for (const [index, file] of files.entries()) names[basename(file)] = imported.assets[index].src;

const mesh = await importMeshPage(deckDir, [{ name: 'torus.obj', bytes: readFileSync(join(media, 'torus.obj')) }]);
names['mesh.src'] = mesh.src;
names['mesh.poster'] = mesh.poster ?? '';
const web = JSON.parse(agent('web', 'add', deckDir, join(here, 'wave.html'), '--size', '1400x700', '--title', 'Wave'));
names['web.src'] = web.src;
names['web.poster'] = web.poster ?? '';
rmSync(media, { recursive: true, force: true });

// The slides.
const page = readFileSync(join(here, 'slides.html'), 'utf8').replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
  if (!(key in names)) throw new Error(`slides.html names unknown media {{${key}}}`);
  return names[key];
});
mkdirSync(join(deckDir, 'edit'), { recursive: true });
writeFileSync(join(deckDir, 'edit', 'docs.html'), page);
agent('apply', deckDir, '--html', join(deckDir, 'edit', 'docs.html'));
rmSync(join(deckDir, 'edit', 'docs.html'));

// Drop the empty first slide, and add the builds HTML has no words for.
const deck = await loadDeck(deckDir);
deck.slides = deck.slides.filter((slide: { id: string }) => slide.id !== 'slide-1');
const slideNamed = (name: string) => {
  const slide = deck.slides.find((s: { name?: string }) => s.name === name);
  if (!slide) throw new Error(`no slide named ${name}`);
  return slide;
};
const byParagraph = slideNamed('by-paragraph');
const list = byParagraph.elements.find((e: { type: string }) => e.type === 'text');
byParagraph.timeline = [{
  id: 'docs-by-paragraph', trigger: { on: 'click', ref: null, delay: 0 },
  action: { type: 'appear', target: list.id, value: 'byParagraph' },
}];
const play = slideNamed('play');
const video = play.elements.find((e: { type: string }) => e.type === 'video');
const caption = play.elements.find((e: { type: string }) => e.type === 'text');
video.autoplay = false;
video.loop = false;
play.timeline = [
  { id: 'docs-play', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'play', target: video.id, value: null } },
  { id: 'docs-ended', trigger: { on: 'mediaEnd', ref: video.id, delay: 0 }, action: { type: 'appear', target: caption.id, value: 'dissolve' } },
];
slideNamed('roles').notes = 'Start with the result, then the method.';
await saveDeck(deckDir, deck);
console.log(`${deck.slides.length} slides in ${deckDir}`);
