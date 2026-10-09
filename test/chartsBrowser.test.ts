import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { THEMES, themeCss } from '../src/shared/themes.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { offlineWorkspace, type AgentWorkspace } from './support/agentWorkspace.js';

/**
 * Charts in a real browser: the player draws the chart in the theme's own
 * colours (CSS variables the theme block declares) and a series build reveals
 * one series per click; the browser editor offers the Chart menu, draws what
 * it inserts, and offers the series build in the Build panel.
 */
const DECK_ID = 'charts';
const CHART_ID = 'chart-1';
const CHART = `[data-element-id="${CHART_ID}"]`;
const THEME = THEMES[0];

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let page: Cdp | null = null;
let workspace: AgentWorkspace | null = null;

afterEach(async () => {
  await workspace?.close();
  workspace = null;
  page?.close();
  page = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

async function serve(path: string, withBuild: boolean): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'charts-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const deck = emptyDeck('Charts');
  deck.slides[0].elements.push({
    id: CHART_ID, type: 'chart', x: 160, y: 160, w: 1600, h: 800, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, kind: 'line', csv: 'step,Ours,Baseline,Oracle\n0,1,1,1\n10,0.6,0.8,0.4\n20,0.3,0.7,0.2',
    series: [], title: 'Error', xLabel: 'steps', yLabel: '', yScale: 'linear', xScale: 'linear',
    legend: 'auto', valueLabels: false, palette: 'deck',
  });
  if (withBuild) {
    deck.slides[0].timeline.push({
      id: 'build-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: CHART_ID, value: 'bySeries' },
    });
  }
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), themeCss(THEME), 'utf8');
  server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
  browser = await launchBrowser(`http://127.0.0.1:${server.port}${path}`, profileDir);
  const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
  page = await Cdp.connect(target.webSocketDebuggerUrl!);
}

/** Each series' computed visibility, in series order. */
const seriesVisibility = () => page!.evaluate<string[]>(`[...document.querySelectorAll('${CHART} .chart-series')]
  .map((group) => getComputedStyle(group).visibility)`);

describe.skipIf(!electronBinary)('charts', () => {
  it('draws in the theme\'s colours and builds one series per click when presenting', { timeout: 120_000 }, async () => {
    await serve(`/present.html?deck=${DECK_ID}&slide=1`, true);
    await eventually(async () => page!.evaluate<number>(`document.querySelectorAll('${CHART} .chart-series').length`),
      'the chart never rendered in the player', (count) => count === 3);
    // Keys sent before the player has painted its first state are lost.
    await eventually(async () => page!.evaluate<boolean>(`Boolean(document.querySelector('[data-player-ready="true"]'))`),
      'the player never became ready');
    await wait(500);

    // The deck palette is the theme's: the first series is the accent hue.
    const stroke = await page!.evaluate<string>(`getComputedStyle(document.querySelector('${CHART} .chart-series .chart-line')).stroke`);
    const hex = THEME.palette[2];
    const rgb = `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(stroke).toBe(rgb);
    const font = await page!.evaluate<string>(`getComputedStyle(document.querySelector('${CHART} .chart-title')).fontFamily`);
    expect(font).toContain(THEME.fonts.heading.family.split(',')[0].trim());

    // Step 0: the chart waits for its first click.
    expect(await page!.evaluate<string>(`getComputedStyle(document.querySelector('${CHART}')).visibility`)).toBe('hidden');
    await page!.key('ArrowRight', 39);
    await eventually(seriesVisibility, 'the first series never appeared',
      (shown) => shown.join() === 'visible,hidden,hidden');
    await page!.key('ArrowRight', 39);
    await eventually(seriesVisibility, 'the second series never appeared',
      (shown) => shown.join() === 'visible,visible,hidden');
    await page!.key('ArrowRight', 39);
    await eventually(seriesVisibility, 'the third series never appeared',
      (shown) => shown.join() === 'visible,visible,visible');
    // Back one step hides the last series again.
    await page!.key('ArrowLeft', 37);
    await eventually(seriesVisibility, 'stepping back did not hide the third series',
      (shown) => shown.join() === 'visible,visible,hidden');
  });

  it('inserts a chart from the toolbar and offers a series build in the editor', { timeout: 120_000 }, async () => {
    await serve(`/?deck=${DECK_ID}&name=Charts`, false);
    await eventually(async () => page!.evaluate<boolean>(`Boolean(document.querySelector('#canvas ${CHART} .chart-svg'))`),
      'the chart never rendered on the canvas');

    // Chart menu → Bar: a new chart of sample data, drawn and selected.
    await page!.click('.chart-menu-trigger', 'the Chart menu');
    await page!.clickByText('.chart-menu .shape-menu-item', 'Bar', 'Bar');
    await eventually(async () => page!.evaluate<number>(`document.querySelectorAll('#canvas .element-chart .chart-svg').length`),
      'the inserted chart never appeared', (count) => count === 2);
    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements.filter((el) => el.type === 'chart');
    };
    await eventually(saved, 'the inserted chart never reached the saved deck', (charts) => charts.length === 2);
    // The inspector shows the chart's own controls.
    await eventually(async () => page!.evaluate<boolean>(`Boolean(document.querySelector('.chart-csv-field textarea'))`),
      'the chart inspector never appeared');

    // A data edit redraws the chart in place.
    await page!.evaluate(`(() => {
      const area = document.querySelector('.chart-csv-field textarea');
      area.value = 'method,Accuracy\\nA,1\\nB,2\\nC,3\\nD,4';
      area.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await eventually(async () => page!.evaluate<number>(`Math.max(...[...document.querySelectorAll('#canvas .element-chart')]
      .map((node) => node.querySelectorAll('.chart-series rect').length))`), 'the edited data was never drawn', (bars) => bars === 4);

    // Build panel: the original chart builds by series.
    await page!.evaluate(`document.querySelector('#side-tabs button[data-panel="timeline"]')?.click()`);
    await page!.click(`.build-element-row[data-element-id="${CHART_ID}"]`, 'the chart in the Build list');
    await page!.clickByText('button', 'Add animation', 'Add animation');
    const options = await page!.evaluate<string[]>(
      `[...document.querySelectorAll('.timeline-row select.build-action option')].map((o) => o.textContent)`);
    expect(options).toContain('appear by series');
    await page!.choose('.timeline-row select.build-action', 'appear:bySeries', 'the action menu');
    await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].timeline[0]?.action;
    }, 'the series build never reached the saved deck', (action) => action?.value === 'bySeries');
  });

  it('compiles a hand-written chart slide, and re-saves its export as no change', { timeout: 180_000 }, async () => {
    // The slide an agent writes: two figures in a flex row, CSV indented
    // along with the page, a series build on the second chart.
    workspace = await offlineWorkspace();
    const before = (await workspace.deck()).slides.length;
    const fresh = await workspace.run('new', '.', '--count', '1');
    expect(fresh.code, fresh.stderr).toBe(0);
    await workspace.write('add.html', fresh.stdout.replace(/<section class="slide" data-placeholder="true">[\s\S]*?<\/section>/, () => DEMO_SLIDE));
    const added = await workspace.run('apply', '.', '--html', 'edit/add.html');
    expect(added.code, `${added.stdout}\n${added.stderr}`).toBe(0);

    const deck = await workspace.deck();
    expect(deck.slides).toHaveLength(before + 1);
    const slide = deck.slides[deck.slides.length - 1];
    const charts = slide.elements.filter((el) => el.type === 'chart');
    expect(charts).toHaveLength(2);
    const [bar, line] = charts;
    expect(bar).toMatchObject({ kind: 'bar', palette: 'okabe-ito', yMin: 0, yMax: 1, series: ['Agent A', 'Agent B', 'Agent C'] });
    expect(bar.type === 'chart' && bar.csv.split('\n')).toEqual([
      'family,Agent A,Agent B,Agent C', 'Metal,0.91,0.84,0.77', 'Glass,0.62,0.71,0.55',
      'Fabric,0.78,0.69,0.81', 'Wood,0.88,0.80,0.74', 'Plastic,0.83,0.86,0.70',
    ]);
    expect(line).toMatchObject({ kind: 'line', palette: 'deck', xScale: 'log', yScale: 'log', xColumn: 'simulation steps' });
    // Laid out by the browser: side by side, each the height it was given.
    expect(bar.h).toBe(720);
    expect(line.x).toBeGreaterThan(bar.x + bar.w);
    expect(slide.timeline.map((entry) => [entry.action.target, entry.action.value]))
      .toEqual([[line.id, 'bySeries']]);

    // Export that slide and save it straight back: nothing changes.
    const exported = await workspace.run('inspect', '.', '--html', '--slide', slide.id);
    expect(exported.code, exported.stderr).toBe(0);
    expect(exported.stdout).toContain('<script type="text/csv">');
    await workspace.write('work.html', exported.stdout);
    const resaved = await workspace.run('apply', '.', '--html', 'edit/work.html');
    expect(resaved.code, `${resaved.stdout}\n${resaved.stderr}`).toBe(0);
    const after = (await workspace.deck()).slides.find((candidate) => candidate.id === slide.id);
    expect(after).toEqual(slide);
  });
});

const DEMO_SLIDE = `<section class="slide" style="padding:90px 120px; display:flex; flex-direction:column; gap:48px;">
  <h1 class="role-title">Agent A leads on most materials and converges fastest</h1>
  <div style="display:flex; gap:64px;">
    <figure data-element="chart" data-kind="bar" data-x="family"
            data-series="Agent A,Agent B,Agent C" data-palette="okabe-ito"
            data-title="Reconstruction score by material family" data-y-label="Score (higher is better)"
            data-y-min="0" data-y-max="1" data-font-size="26"
            style="flex:1; height:720px;">
      <script type="text/csv">
      family,Agent A,Agent B,Agent C
      Metal,0.91,0.84,0.77
      Glass,0.62,0.71,0.55
      Fabric,0.78,0.69,0.81
      Wood,0.88,0.80,0.74
      Plastic,0.83,0.86,0.70
      </script>
    </figure>
    <figure data-element="chart" data-kind="line" data-x="simulation steps" data-palette="deck"
            data-title="Error vs. simulation steps" data-x-label="Simulation steps" data-y-label="Relative L2 error"
            data-x-scale="log" data-y-scale="log" data-legend="top" data-font-size="26"
            data-build="click" data-build-effect="bySeries"
            style="flex:1; height:720px;">
      <script type="text/csv">
      simulation steps,Agent A,Agent B,Agent C
      100,0.42,0.61,0.55
      1000,0.18,0.39,0.31
      10000,0.071,0.22,0.15
      100000,0.024,0.13,0.08
      1000000,0.009,0.09,0.05
      </script>
    </figure>
  </div>
</section>`;
