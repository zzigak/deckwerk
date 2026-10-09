// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type ChartEl, type Slide } from '../src/shared/deck.js';
import {
  chartData, defaultChartKind, isNumericColumn, parseChartNumber, parseCsv, serializeCsv,
} from '../src/shared/chartData.js';
import {
  OKABE_ITO, TABLEAU_10, chartSeriesColors, chartThemeCss, deckChartColors, parsePaletteText, viridis,
} from '../src/shared/chartPalettes.js';
import { chartSvg, formatChartNumber } from '../src/shared/chartSvg.js';
import { chartFieldsFromHtml, csvFromScript } from '../src/shared/chartHtml.js';
import { applyChartBuildVisibility } from '../src/shared/chartBuild.js';
import { buildFromNode, elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { sanitizeAuthoredHtml } from '../src/shared/htmlSafety.js';
import { expandTimeline, resolveState, stepCount } from '../src/shared/timeline.js';
import { THEMES, themeCss } from '../src/shared/themes.js';

/**
 * Charts from data: the CSV reader, number parsing, palettes, the one SVG
 * renderer every surface shares, the HTML round trip and series builds. The
 * browser side (the player stepping a build) is in chartsBrowser.test.ts.
 */

function chart(over: Partial<ChartEl> = {}): ChartEl {
  return parseDeck({ version: 1, slides: [{ id: 's', elements: [{
    id: 'c1', type: 'chart', x: 100, y: 100, w: 1200, h: 675, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, csv: 'model,score,cost\nOurs,0.91,12\nBaseline,0.74,9\nAblation,0.80,10',
    ...over,
  }] }] }).slides[0].elements[0] as ChartEl;
}

function svgOf(el: ChartEl): SVGSVGElement {
  const doc = new DOMParser().parseFromString(chartSvg(el), 'image/svg+xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  return doc.documentElement as unknown as SVGSVGElement;
}

const texts = (root: Element, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((node) => node.textContent ?? '');

describe('CSV', () => {
  it('reads quoted fields: separators, doubled quotes and line breaks inside quotes', () => {
    const table = parseCsv('name,"note, with comma",value\r\n"Smith, J.","said ""hi""",1\n"multi\nline",x,2\n');
    expect(table.columns).toEqual(['name', 'note, with comma', 'value']);
    expect(table.rows).toEqual([
      ['Smith, J.', 'said "hi"', '1'],
      ['multi\nline', 'x', '2'],
    ]);
  });

  it('detects tab and semicolon separators, skips blank lines and pads short rows', () => {
    expect(parseCsv('a\tb\n1\t2').rows).toEqual([['1', '2']]);
    expect(parseCsv('a;b;c\n1;2\n\n3;4;5').rows).toEqual([['1', '2', ''], ['3', '4', '5']]);
  });

  it('names empty headers and keeps quoted spaces exactly', () => {
    const table = parseCsv(',b\n" x ", y ');
    expect(table.columns).toEqual(['Column 1', 'b']);
    expect(table.rows[0]).toEqual([' x ', 'y']);
  });

  it('serializes back to text that parses to the same table', () => {
    const table = parseCsv('a,b\n"x, y","he said ""no"""\n1,2');
    expect(parseCsv(serializeCsv(table))).toEqual(table);
  });
});

describe('numbers in cells', () => {
  it('strips units, currency, grouping and typographic minus signs', () => {
    expect(parseChartNumber('12.5%')).toBe(12.5);
    expect(parseChartNumber('$1,200')).toBe(1200);
    expect(parseChartNumber('3.2 ms')).toBe(3.2);
    expect(parseChartNumber('−0.4')).toBe(-0.4);
    expect(parseChartNumber('1.2e-3 s')).toBe(0.0012);
    expect(parseChartNumber('45°')).toBe(45);
    expect(parseChartNumber('.5')).toBe(0.5);
    expect(parseChartNumber('-€3')).toBe(-3);
  });

  it('reads empty and missing-value markers as gaps', () => {
    for (const cell of ['', '  ', 'n/a', 'NA', 'NaN', '-', '—']) expect(parseChartNumber(cell)).toBeNull();
  });

  it('rejects text that is not one plain number', () => {
    for (const cell of ['12-15', 'v2', 'abc', '1,2', '3 4']) expect(parseChartNumber(cell)).toBeNaN();
    expect(isNumericColumn(['1', '', 'n/a', '3%'])).toBe(true);
    expect(isNumericColumn(['1', 'two'])).toBe(false);
    expect(isNumericColumn(['', 'n/a'])).toBe(false);
  });

  it('resolves series: every numeric column by default, named ones in order, unknown names dropped', () => {
    const csv = 'model,score,notes,cost\nA,1,good,3\nB,2,bad,n/a';
    const all = chartData({ csv, series: [] });
    expect(all.series.map((s) => s.name)).toEqual(['score', 'cost']);
    expect(all.series[1].values).toEqual([3, null]);
    expect(all.xValues).toBeNull();
    expect(chartData({ csv, series: ['cost', 'gone', 'score'] }).series.map((s) => s.name)).toEqual(['cost', 'score']);
    const byX = chartData({ csv, xColumn: 'cost', series: [] });
    expect(byX.xName).toBe('cost');
    expect(byX.series.map((s) => s.name)).toEqual(['score']);
  });

  it('picks a kind from the shape of the data', () => {
    expect(defaultChartKind('model,score\nA,1\nB,2')).toBe('bar');
    expect(defaultChartKind('step,err\n0,1\n10,0.5\n20,0.3')).toBe('line');
    expect(defaultChartKind('x,y\n3,1\n1,2\n2,5')).toBe('scatter');
  });
});

describe('palettes', () => {
  const names = ['a', 'b', 'c'];
  it('gives each named palette its colours, cycling past its end', () => {
    expect(chartSeriesColors({ palette: 'tableau10' }, names)).toEqual(TABLEAU_10.slice(0, 3));
    expect(chartSeriesColors({ palette: 'okabe-ito' }, names)).toEqual(OKABE_ITO.slice(0, 3));
    expect(chartSeriesColors({ palette: 'custom', colors: ['#111111', '#222222'] }, names))
      .toEqual(['#111111', '#222222', '#111111']);
    const v = chartSeriesColors({ palette: 'viridis' }, names);
    expect(v[0]).toBe(viridis(0.08));
    expect(new Set(v).size).toBe(3);
  });

  it('follows the theme through CSS variables for the deck palette', () => {
    expect(chartSeriesColors({ palette: 'deck' }, names)[0]).toBe('var(--chart-1, #4e79a7)');
    const grey = chartSeriesColors({ palette: 'grayscale', highlight: 'b' }, names);
    expect(grey[1]).toMatch(/^var\(--chart-accent/);
    expect(grey[0]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('declares the chart variables in the generated theme block, data hues first', () => {
    const research = THEMES[0];
    expect(deckChartColors(research)[0]).toBe(research.palette[2]);
    expect(deckChartColors(research)).not.toContain(research.colors.background);
    const css = themeCss(research);
    expect(css).toContain(`--chart-1: ${research.palette[2]};`);
    expect(css).toContain(`--chart-title-font: ${research.fonts.heading.family};`);
    expect(chartThemeCss(research)).toContain(`--chart-muted: ${research.colors.muted};`);
  });

  it('imports a palette from a hex list, a coolors link, JSON or rgb()', () => {
    expect(parsePaletteText('https://coolors.co/264653-2a9d8f-e9c46a-f4a261-e76f51'))
      .toEqual(['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51']);
    expect(parsePaletteText('#FFF, #000000\n#abc')).toEqual(['#ffffff', '#000000', '#aabbcc']);
    expect(parsePaletteText('["#112233", "#445566", "#112233"]')).toEqual(['#112233', '#445566']);
    expect(parsePaletteText('rgb(10, 20, 30) 123 hello')).toEqual(['rgb(10, 20, 30)']);
  });
});

describe('the SVG', () => {
  it('is sized to the box at 1:1 and themed through variables', () => {
    const svg = svgOf(chart());
    expect(svg.getAttribute('viewBox')).toBe('0 0 1200 675');
    expect(svg.getAttribute('style')).toContain('var(--chart-font');
  });

  it('draws grouped bars: one group per series, one bar per category, legend for several series', () => {
    const svg = svgOf(chart({ kind: 'bar' }));
    const groups = svg.querySelectorAll('.chart-series');
    expect(groups).toHaveLength(2);
    expect(groups[0].querySelectorAll('rect')).toHaveLength(3);
    expect([...groups[0].querySelectorAll('rect')].map((r) => r.getAttribute('data-category'))).toEqual(['0', '1', '2']);
    expect(texts(svg, '.chart-legend text')).toEqual(['score', 'cost']);
    expect(texts(svg, '.chart-axis-x text')).toEqual(['Ours', 'Baseline', 'Ablation']);
  });

  it('uses nice ticks starting at zero for bars', () => {
    const svg = svgOf(chart({ series: ['score'] }));
    const ticks = texts(svg, '.chart-axis-y text').map((t) => Number(t));
    expect(ticks[0]).toBe(0);
    const steps = ticks.slice(1).map((t, i) => Math.round((t - ticks[i]) * 1000));
    expect(new Set(steps).size).toBe(1);
    expect(svg.querySelector('.chart-legend')).toBeNull();
  });

  it('stacks bars and labels values with the cells as written', () => {
    const el = chart({ kind: 'stacked-bar', csv: 'q,a,b\nQ1,40%,60%\nQ2,55%,45%', valueLabels: true });
    const svg = svgOf(el);
    const [a, b] = [...svg.querySelectorAll('.chart-series')].map((g) => [...g.querySelectorAll('rect')]);
    // b sits on top of a: its bottom edge is a's top edge.
    const top = Number(a[0].getAttribute('y'));
    expect(Number(b[0].getAttribute('y')) + Number(b[0].getAttribute('height'))).toBeCloseTo(top, 1);
    expect(texts(svg, '.chart-value-labels text')).toContain('40%');
  });

  it('draws lines with dots, areas with fills, scatter as points against a numeric x', () => {
    const csv = 'step,Ours,Baseline\n0,1,1\n10,0.6,0.8\n20,,0.7\n40,0.2,0.6';
    const line = svgOf(chart({ kind: 'line', csv }));
    // The gap in Ours breaks its line in two.
    expect(line.querySelectorAll('[data-series="0"] .chart-line')).toHaveLength(2);
    expect(line.querySelectorAll('[data-series="1"] .chart-line')).toHaveLength(1);
    expect(line.querySelectorAll('[data-series="1"] circle')).toHaveLength(4);
    expect(texts(line, '.chart-axis-x text')).toContain('40');
    const area = svgOf(chart({ kind: 'area', csv }));
    expect(area.querySelectorAll('.chart-area').length).toBeGreaterThanOrEqual(2);
    const scatter = svgOf(chart({ kind: 'scatter', csv }));
    expect(scatter.querySelectorAll('.chart-line')).toHaveLength(0);
    expect(scatter.querySelectorAll('circle')).toHaveLength(7 + 2);
  });

  it('shows titles and axis labels, and honours legend position and fixed ranges', () => {
    const svg = svgOf(chart({ title: 'Scores', xLabel: 'Model', yLabel: 'Score', legend: 'right', yMin: 0, yMax: 2 }));
    expect(texts(svg, '.chart-title')).toEqual(['Scores']);
    expect(texts(svg, '.chart-axis-label')).toEqual(['Score', 'Model']);
    const ticks = texts(svg, '.chart-axis-y text');
    expect(ticks[0]).toBe('0');
    expect(ticks[ticks.length - 1]).toBe('2');
    const legendX = Number(svg.querySelector('.chart-legend rect')!.getAttribute('x'));
    expect(legendX).toBeGreaterThan(900);
  });

  it('keeps a log axis to powers of ten', () => {
    const svg = svgOf(chart({ kind: 'line', yScale: 'log', csv: 'n,err\n1,0.001\n2,0.03\n3,0.5\n4,20\n5,900' }));
    const ticks = texts(svg, '.chart-axis-y text');
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) {
      const value = Number(tick.replace('−', '-'));
      expect(Math.abs(Math.log10(value) - Math.round(Math.log10(value)))).toBeLessThan(1e-9);
    }
  });

  it('says so when there is nothing to plot', () => {
    const svg = svgOf(chart({ csv: 'name,notes\na,b' }));
    expect(svg.querySelector('.chart-empty')).not.toBeNull();
  });

  it('formats tick numbers without float noise', () => {
    expect(formatChartNumber(0.30000000000000004)).toBe('0.3');
    expect(formatChartNumber(12000)).toBe('12,000');
    expect(formatChartNumber(-2.5)).toBe('−2.5');
    expect(formatChartNumber(1e-6)).toBe('1e-6');
    expect(formatChartNumber(1e6)).toBe('1M');
    expect(formatChartNumber(2500000000)).toBe('2.5B');
  });
});

describe('the HTML round trip', () => {
  function measured(markup: string): MeasuredNode {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const figure = doc.querySelector<HTMLElement>('[data-element="chart"]')!;
    return {
      tag: figure.tagName.toLowerCase(), elementId: figure.dataset.elementId ?? null, classes: [],
      dataset: { ...figure.dataset } as Record<string, string>,
      rect: { x: 100, y: 100, w: 1200, h: 675 }, rotation: 0, opacity: 1, style: {},
      html: figure.querySelector(':scope > script[type="text/csv"]')?.textContent ?? '', attrs: {},
    };
  }

  it('exports a figure with the data in a text/csv script and reads it back unchanged', () => {
    const csv = 'material,"Agent A, v2",Agent B\nMetal,0.91,0.77\n"Glass\nclear",0.62,"0.70"\nodd </script> cell,1,2\n';
    const original = chart({
      csv, kind: 'stacked-bar', xColumn: 'material', series: ['Agent A, v2', 'Agent B'], title: 'Scores',
      xLabel: 'Family', yLabel: 'Score', yMin: 0, yMax: 1, yScale: 'linear', legend: 'bottom',
      valueLabels: true, palette: 'custom', colors: ['#264653', '#2a9d8f'], highlight: 'Agent B', fontSize: 26,
    });
    const deck = emptyDeck();
    deck.slides[0].elements = [original];
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('<figure');
    expect(html).toContain('data-element="chart"');
    expect(html).toContain('<script type="text/csv">');
    expect(html).toContain('<svg data-element="none"');
    const back = elementFromNode(measured(html), 'c1', 1) as ChartEl;
    const { x, y, w, h, z, ...rest } = original;
    expect(back).toMatchObject(rest);
    expect(back.csv).toBe(csv);
  });

  it('reads a figure an agent writes by hand, indented, with aliases and defaults', () => {
    const node = measured(`<section class="slide">
      <figure data-element="chart" data-kind="grouped-bar" data-x="model" data-series="score"
              data-palette="okabe-ito" data-y-min="auto" data-build="click" data-build-effect="bySeries">
        <script type="text/csv">
          model,score,cost
          Ours,0.91,12
          Baseline,0.74,9
        </script>
      </figure></section>`);
    const el = elementFromNode(node, 'c9', 1) as ChartEl;
    expect(el).toMatchObject({ type: 'chart', kind: 'bar', xColumn: 'model', series: ['score'], palette: 'okabe-ito', legend: 'auto' });
    expect(el.csv).toBe('model,score,cost\nOurs,0.91,12\nBaseline,0.74,9');
    expect(el.yMin).toBeUndefined();
    expect(buildFromNode(node, 'c9', 0)?.action.value).toBe('bySeries');
    expect(parseDeck({ version: 1, slides: [{ id: 's', elements: [el] }] }).slides[0].elements[0]).toEqual(el);
  });

  it('takes a pasted palette straight from data-palette', () => {
    const fields = chartFieldsFromHtml({ palette: 'https://coolors.co/264653-2a9d8f' }, 'a,b\nx,1');
    expect(fields.palette).toBe('custom');
    expect(fields.colors).toEqual(['#264653', '#2a9d8f']);
  });

  it('keeps an exported series build', () => {
    const el = chart();
    const deck = emptyDeck();
    deck.slides[0].elements = [el];
    deck.slides[0].timeline = [{ id: 't', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'c1', value: 'bySeries' } }];
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-build-effect="bySeries"');
    expect(buildFromNode(measured(html), 'c1', 0)?.action.value).toBe('bySeries');
  });

  it('strips one framing line and dedents, and nothing else', () => {
    expect(csvFromScript('\na,b\n1,2\n')).toBe('a,b\n1,2');
    expect(csvFromScript('\na,b\n1,2\n\n')).toBe('a,b\n1,2\n');
    expect(csvFromScript('a,b')).toBe('a,b');
  });

  it('survives the sanitizer, which still removes runnable scripts', () => {
    const { html, report } = sanitizeAuthoredHtml(`<!doctype html><html><body><section class="slide">
      <figure data-element="chart"><script type="text/csv">a,b
1,2</script></figure><script>alert(1)</script><script type="text/csv">loose</script></section></body></html>`);
    expect(html).toContain('<script type="text/csv">a,b\n1,2</script>');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('loose');
    expect(report.removedScripts).toBe(2);
  });
});

describe('series builds', () => {
  function slideWith(value: string, on: 'click' | 'afterPrev' = 'click'): Slide {
    const deck = emptyDeck();
    const slide = deck.slides[0];
    slide.elements = [chart()];
    slide.timeline = [{ id: 't', trigger: { on, ref: null, delay: 0 }, action: { type: 'appear', target: 'c1', value } }];
    return slide;
  }

  it('fans out one step per series, or per category', () => {
    expect(stepCount(slideWith('bySeries'))).toBe(3);
    expect(stepCount(slideWith('byCategory'))).toBe(4);
    expect(stepCount(slideWith('bySeries', 'afterPrev'))).toBe(1);
    expect(expandTimeline(slideWith('bySeries')).map((unit) => unit.part)).toEqual([0, 1]);
    expect(resolveState(slideWith('bySeries'), 1).parts.get('c1')).toBe(1);
    expect(resolveState(slideWith('bySeries'), 0).visible.has('c1')).toBe(false);
  });

  it('hides marks past the revealed count, legend and value labels included', () => {
    const slide = slideWith('bySeries');
    const stage = document.createElement('div');
    stage.innerHTML = `<div data-element-id="c1">${chartSvg(slide.elements[0] as ChartEl)}</div>`;
    applyChartBuildVisibility(stage, slide, resolveState(slide, 1));
    const hidden = (selector: string) => (stage.querySelector(selector) as SVGElement).style.visibility;
    expect(hidden('.chart-series[data-series="0"]')).toBe('');
    expect(hidden('.chart-series[data-series="1"]')).toBe('hidden');
    expect(hidden('.chart-legend-item[data-series="1"]')).toBe('hidden');
    applyChartBuildVisibility(stage, slide, resolveState(slide, 2));
    expect(hidden('.chart-series[data-series="1"]')).toBe('');

    const byCategory = slideWith('byCategory');
    applyChartBuildVisibility(stage, byCategory, resolveState(byCategory, 2));
    expect((stage.querySelector('rect[data-category="1"]') as SVGElement).style.visibility).toBe('');
    expect((stage.querySelector('rect[data-category="2"]') as SVGElement).style.visibility).toBe('hidden');
  });
});

describe('the measuring walk', () => {
  it('hands over a chart figure whole, its CSV exactly as written', async () => {
    const { authoringPageHtml, measureSlides } = await import('../src/shared/htmlMeasure.js');
    const html = authoringPageHtml({
      authored: `<section class="slide" data-slide-id="a">
        <figure data-element="chart" data-kind="line" style="width:800px;height:450px"><script type="text/csv">
step,  err
0,"1,0"
10,0.5
</script></figure></section>`,
      typeCss: '', theme: '', canvas: emptyDeck().canvas, base: 'deck://asset/',
    });
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(sanitizeAuthoredHtml(html).html);
    doc.close();
    const [slide] = measureSlides(doc);
    const nodes = slide.nodes.filter((node) => node.dataset.element === 'chart');
    expect(nodes).toHaveLength(1);
    expect(slide.nodes).toHaveLength(1);
    expect(csvFromScript(nodes[0].html)).toBe('step,  err\n0,"1,0"\n10,0.5');
  });
});
