import { scaleBand, scaleLinear, scaleLog, scalePoint } from 'd3-scale';
import type { ChartEl } from './deck.js';
import { chartData, type ChartData } from './chartData.js';
import { chartSeriesColors } from './chartPalettes.js';

/**
 * A chart element as SVG markup: one pure function, the only one.
 *
 * The editor canvas, the presentation player, the web export, the PDF and the
 * HTML authoring page all draw a chart by calling this, so a chart cannot look
 * different on the projector than it did while authoring. It is a string
 * rather than DOM so it runs in Node too — the authoring export and the tests
 * have no document to build into.
 *
 * The drawing is laid out for the element's own box at 1:1 (`viewBox` is the
 * box in canvas pixels), so text sizes are real slide sizes and stay legible
 * from the back of the room. There is no text measurement without a browser,
 * so label widths are estimated generously from character counts; the cost of
 * over-estimating is a few pixels of margin, of under-estimating a clipped
 * label.
 *
 * Styling is the theme's, through CSS custom properties with fallbacks (see
 * chartPalettes.ts): titles in the heading face, everything else in the body
 * and caption faces, text in the slide's text colour, light gridlines in the
 * same colour at low opacity so they read on light and dark grounds alike.
 *
 * Every mark carries `data-series` (and bars, points and value labels
 * `data-category`), which is what builds reveal step by step
 * (shared/chartBuild.ts).
 */

/** Average advance of a glyph as a fraction of the font size; deliberately wide. */
const GLYPH_WIDTH = 0.62;

const textWidth = (text: string, size: number): number => text.length * size * GLYPH_WIDTH;

/** Short, deterministic coordinates: two decimals is far below a device pixel. */
const n = (value: number): string => String(Math.round(value * 100) / 100);

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A label cut to fit `width`, with an ellipsis, so one long category cannot eat the plot. */
function fitLabel(text: string, size: number, width: number): string {
  const max = Math.max(3, Math.floor(width / (size * GLYPH_WIDTH)));
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Tick and label numbers: thousands separated, no float noise. */
export function formatChartNumber(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  // Millions and billions read as such on an axis; beyond, and for the very
  // small, scientific notation is the only short form.
  if (abs >= 1e6 && abs < 1e12) {
    const [unit, suffix] = abs >= 1e9 ? [1e9, 'B'] : [1e6, 'M'];
    return `${formatChartNumber(value / unit)}${suffix}`;
  }
  if (abs >= 1e12 || abs < 1e-4) {
    return value.toExponential(1).replace(/\.0e/, 'e').replace('e+', 'e').replace(/^-/, '−');
  }
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: abs >= 10000 })
    .replace(/^-/, '−');
}

interface Domain { lo: number; hi: number }

/** The extent of finite values, or null when there are none. */
function extent(values: Array<number | null>): Domain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  return lo <= hi ? { lo, hi } : null;
}

/** The values the value axis must show, per kind: stacks sum, bars and areas start at zero. */
function valueExtent(el: ChartEl, data: ChartData, log: boolean): Domain | null {
  const all = data.series.flatMap((series) => series.values)
    .filter((value) => value !== null && (!log || value > 0));
  if (el.kind === 'stacked-bar') {
    const totals: number[] = [];
    data.categories.forEach((_, row) => {
      let up = 0;
      let down = 0;
      for (const series of data.series) {
        const value = series.values[row];
        if (value === null || (log && value <= 0)) continue;
        if (value >= 0) up += value;
        else down += value;
      }
      totals.push(up, down);
    });
    all.push(...totals.filter((value) => !log || value > 0));
  }
  const found = extent(all);
  if (!found) return null;
  if (!log && (el.kind === 'bar' || el.kind === 'stacked-bar' || el.kind === 'area')) {
    found.lo = Math.min(found.lo, 0);
    found.hi = Math.max(found.hi, 0);
  }
  return found;
}

type NumericScale = ((value: number) => number) & {
  ticks(count?: number): number[];
  domain(): number[];
};

/**
 * A value scale over `range`, with nice ends unless the author fixed them.
 * Log scales keep to powers of ten when d3 offers more ticks than fit.
 */
function numericScale(
  found: Domain | null,
  fixedLo: number | null | undefined,
  fixedHi: number | null | undefined,
  log: boolean,
  range: [number, number],
  tickCount: number,
): { scale: NumericScale; ticks: number[] } {
  let lo = fixedLo ?? found?.lo ?? (log ? 1 : 0);
  let hi = fixedHi ?? found?.hi ?? (log ? 10 : 1);
  if (log) {
    lo = lo > 0 ? lo : Math.min(1, hi > 0 ? hi / 10 : 1);
    hi = hi > lo ? hi : lo * 10;
    const scale = scaleLog().domain([lo, hi]).range(range);
    if (fixedLo == null || fixedHi == null) {
      scale.nice();
      const [niceLo, niceHi] = scale.domain();
      scale.domain([fixedLo ?? niceLo, fixedHi ?? niceHi]);
    }
    let ticks = scale.ticks();
    const decades = ticks.filter((tick) => Math.abs(Math.log10(tick) - Math.round(Math.log10(tick))) < 1e-9);
    if (ticks.length > tickCount + 2 && decades.length >= 2) ticks = decades;
    return { scale: scale as unknown as NumericScale, ticks };
  }
  if (lo === hi) {
    const spread = Math.abs(lo) * 0.1 || 1;
    if (fixedLo == null) lo -= spread;
    if (fixedHi == null) hi += spread;
  }
  if (lo > hi) [lo, hi] = [hi, lo];
  const scale = scaleLinear().domain([lo, hi]).range(range);
  if (fixedLo == null || fixedHi == null) {
    scale.nice(tickCount);
    const [niceLo, niceHi] = scale.domain();
    scale.domain([fixedLo ?? niceLo, fixedHi ?? niceHi]);
  }
  return { scale: scale as unknown as NumericScale, ticks: scale.ticks(tickCount) };
}

/** Relative luminance of a #rrggbb colour, or null for anything else (a CSS variable). */
function luminance(color: string): number | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Legend placement after `auto` is resolved: a single series needs no key. */
function legendPosition(el: ChartEl, seriesCount: number): 'top' | 'right' | 'bottom' | 'none' {
  if (el.legend === 'auto') return seriesCount > 1 ? 'top' : 'none';
  return seriesCount === 0 ? 'none' : el.legend;
}

/** The base text size: the author's, or one that scales with the box and stays readable. */
export function chartFontSize(el: Pick<ChartEl, 'w' | 'h' | 'fontSize'>): number {
  if (el.fontSize) return el.fontSize;
  return Math.round(Math.max(12, Math.min(40, Math.min(el.w, el.h * 1.6) * 0.028)));
}

export function chartSvg(el: ChartEl): string {
  const W = el.w;
  const H = el.h;
  const data = chartData(el);
  const base = chartFontSize(el);
  const titleSize = base * 1.25;
  const tickSize = base * 0.82;
  const legendSize = base * 0.88;
  const axisSize = base * 0.88;
  const valueSize = base * 0.76;
  const pad = base * 0.4;
  const colors = chartSeriesColors(el, data.series.map((series) => series.name));
  const isBar = el.kind === 'bar' || el.kind === 'stacked-bar';
  const out: string[] = [];

  let top = pad;
  if (el.title) {
    out.push(`<text class="chart-title" x="${n(pad)}" y="${n(top + titleSize * 0.85)}" font-size="${n(titleSize)}"`
      + ` style="font-family:var(--chart-title-font, inherit);font-weight:var(--chart-title-weight, 600);fill:var(--chart-text, currentColor)">`
      + `${esc(fitLabel(el.title, titleSize, W - pad * 2))}</text>`);
    top += titleSize * 1.45;
  }

  const empty = data.series.length === 0 || data.categories.length === 0;
  if (empty) {
    out.push(`<text class="chart-empty" x="${n(W / 2)}" y="${n((top + H) / 2)}" text-anchor="middle" font-size="${n(axisSize)}"`
      + ` style="fill:var(--chart-muted, currentColor)">`
      + `${esc(fitLabel('No data: CSV needs a header row and a numeric column', axisSize, W - pad * 2))}</text>`);
    return wrap(el, W, H, out);
  }

  // --- legend ---------------------------------------------------------------
  const legend = legendPosition(el, data.series.length);
  const swatch = legendSize * 0.72;
  const itemGap = legendSize * 1.1;
  const labelOf = (name: string) => fitLabel(name, legendSize, W * 0.4);
  const itemWidth = (name: string) => swatch + legendSize * 0.4 + textWidth(labelOf(name), legendSize);
  let right = W - pad;
  let bottom = H - pad;
  const legendItems: Array<{ x: number; y: number; index: number }> = [];
  if (legend === 'top' || legend === 'bottom') {
    const rows: Array<Array<{ index: number; width: number }>> = [[]];
    let used = 0;
    data.series.forEach((series, index) => {
      const width = itemWidth(series.name);
      if (used > 0 && used + width > W - pad * 2) {
        rows.push([]);
        used = 0;
      }
      rows[rows.length - 1].push({ index, width });
      used += width + itemGap;
    });
    const rowHeight = legendSize * 1.5;
    const startY = legend === 'top' ? top : H - pad - rows.length * rowHeight;
    rows.forEach((row, r) => {
      let x = pad;
      for (const item of row) {
        legendItems.push({ x, y: startY + r * rowHeight + rowHeight / 2, index: item.index });
        x += item.width + itemGap;
      }
    });
    if (legend === 'top') top += rows.length * rowHeight + legendSize * 0.3;
    else bottom -= rows.length * rowHeight + legendSize * 0.3;
  } else if (legend === 'right') {
    const width = Math.max(...data.series.map((series) => itemWidth(series.name)));
    right -= width + pad;
    data.series.forEach((_, index) => {
      legendItems.push({ x: right + pad, y: top + legendSize * (0.75 + index * 1.5), index });
    });
  }

  // --- value axis -----------------------------------------------------------
  const yLog = el.yScale === 'log';
  const plotTop = top + tickSize * 0.6;
  const yLabelRoom = el.yLabel ? axisSize * 1.5 : 0;
  // Tick labels need the scale and the scale needs the plot's height; the
  // height barely depends on the labels, so estimate it once and settle.
  const roughBottom = bottom - tickSize * 1.8 - (el.xLabel ? axisSize * 1.5 : 0);
  const tickCount = Math.max(2, Math.min(10, Math.round((roughBottom - plotTop) / (tickSize * 3.4))));
  const yFound = valueExtent(el, data, yLog);
  const yProbe = numericScale(yFound, el.yMin, el.yMax, yLog, [roughBottom, plotTop], tickCount);
  const yTickLabels = yProbe.ticks.map(formatChartNumber);
  const yTickWidth = Math.max(...yTickLabels.map((label) => textWidth(label, tickSize)), tickSize);
  const plotLeft = pad + yLabelRoom + yTickWidth + tickSize * 0.6;

  // --- x axis ---------------------------------------------------------------
  const numericX = !isBar && data.xValues !== null;
  const xLog = numericX && el.xScale === 'log';
  const rightRoom = numericX ? tickSize * 1.2 : tickSize * 0.3;
  const plotRight = Math.max(plotLeft + 10, right - rightRoom);
  const plotWidth = plotRight - plotLeft;
  const rows = data.categories.length;
  const slot = plotWidth / Math.max(1, rows);
  const catLabels = data.categories.map((category) => fitLabel(category, tickSize, Math.max(slot * 2.4, H * 0.3)));
  const widest = Math.max(...catLabels.map((label) => textWidth(label, tickSize)));
  // Category names that would collide are turned to a slant rather than
  // thinned out: every bar keeps its name.
  const slanted = !numericX && widest > slot * 0.92;
  const SLANT = 35;
  const xLabelBand = slanted
    ? widest * Math.sin((SLANT * Math.PI) / 180) + tickSize * 1.4
    : tickSize * 1.7;
  const plotBottom = Math.max(plotTop + 10, bottom - xLabelBand - (el.xLabel ? axisSize * 1.5 : 0));
  const { scale: y, ticks: yTicks } = numericScale(yFound, el.yMin, el.yMax, yLog, [plotBottom, plotTop], tickCount);
  const [yLo, yHi] = y.domain();
  const clampY = (value: number) => y(Math.min(Math.max(value, Math.min(yLo, yHi)), Math.max(yLo, yHi)));
  const baseline = yLog ? plotBottom : clampY(0);

  // Gridlines and value ticks.
  const grid: string[] = [];
  const yLabels: string[] = [];
  const hairline = Math.max(1, base * 0.045);
  for (const tick of yTicks) {
    const py = y(tick);
    if (py < plotTop - 0.5 || py > plotBottom + 0.5) continue;
    grid.push(`<line x1="${n(plotLeft)}" x2="${n(plotRight)}" y1="${n(py)}" y2="${n(py)}"/>`);
    yLabels.push(`<text x="${n(plotLeft - tickSize * 0.6)}" y="${n(py)}" dy="0.35em" text-anchor="end">${esc(formatChartNumber(tick))}</text>`);
  }
  out.push(`<g class="chart-grid" stroke="currentColor" stroke-opacity="0.12" stroke-width="${n(hairline)}" fill="none">${grid.join('')}</g>`);

  // X positions.
  const indices = data.categories.map((_, i) => String(i));
  let xAt: (row: number) => number | null;
  let band = 0;
  const xLabelsMarkup: string[] = [];
  const tickGroupY = plotBottom + tickSize * 1.25;
  if (numericX) {
    const { scale: x, ticks: xTicks } = numericScale(
      extent(data.xValues!), el.xMin, el.xMax, xLog, [plotLeft, plotRight],
      Math.max(2, Math.min(10, Math.round(plotWidth / (tickSize * 6)))),
    );
    const [xLo, xHi] = x.domain();
    xAt = (row) => {
      const value = data.xValues![row];
      if (value === null || (xLog && value <= 0)) return null;
      if (value < Math.min(xLo, xHi) || value > Math.max(xLo, xHi)) return null;
      return x(value);
    };
    for (const tick of xTicks) {
      xLabelsMarkup.push(`<text x="${n(x(tick))}" y="${n(tickGroupY)}" text-anchor="middle">${esc(formatChartNumber(tick))}</text>`);
    }
  } else if (isBar) {
    const x = scaleBand<string>().domain(indices).range([plotLeft, plotRight])
      .paddingInner(0.24).paddingOuter(0.12);
    band = x.bandwidth();
    xAt = (row) => x(String(row))!;
  } else {
    const x = scalePoint<string>().domain(indices).range([plotLeft, plotRight]).padding(0.3);
    xAt = (row) => x(String(row))!;
  }
  if (!numericX) {
    data.categories.forEach((_, row) => {
      const cx = xAt(row)! + band / 2;
      const label = esc(catLabels[row]);
      xLabelsMarkup.push(slanted
        ? `<text x="${n(cx)}" y="${n(plotBottom + tickSize * 0.9)}" dy="0.35em" text-anchor="end"`
          + ` transform="rotate(-${SLANT} ${n(cx)} ${n(plotBottom + tickSize * 0.9)})">${label}</text>`
        : `<text x="${n(cx)}" y="${n(tickGroupY)}" text-anchor="middle">${label}</text>`);
    });
  }

  // --- marks ----------------------------------------------------------------
  const marks: string[] = [];
  const valueLabels: string[] = [];
  const valueLabel = (series: number, row: number, cx: number, cy: number, text: string, fill = '') =>
    valueLabels.push(`<text data-series="${series}" data-category="${row}" x="${n(cx)}" y="${n(cy)}" text-anchor="middle"${fill ? ` style="fill:${fill}"` : ''}>${esc(text.trim())}</text>`);
  const valid = (value: number | null): value is number => value !== null && Number.isFinite(value) && (!yLog || value > 0);

  if (el.kind === 'bar') {
    const inner = scaleBand<string>().domain(data.series.map((_, i) => String(i))).range([0, band])
      .paddingInner(data.series.length > 1 ? 0.08 : 0);
    const width = inner.bandwidth();
    data.series.forEach((series, s) => {
      const rects: string[] = [];
      series.values.forEach((value, row) => {
        if (!valid(value)) return;
        const x0 = xAt(row)! + inner(String(s))!;
        const py = clampY(value);
        const y0 = Math.min(py, baseline);
        rects.push(`<rect data-category="${row}" x="${n(x0)}" y="${n(y0)}" width="${n(width)}" height="${n(Math.abs(baseline - py))}"/>`);
        if (el.valueLabels) {
          const above = value >= 0 || yLog;
          valueLabel(s, row, x0 + width / 2, above ? py - valueSize * 0.4 : py + valueSize * 1.05, series.cells[row]);
        }
      });
      marks.push(`<g class="chart-series" data-series="${s}" style="fill:${colors[s]}">${rects.join('')}</g>`);
    });
  } else if (el.kind === 'stacked-bar') {
    const up = data.categories.map(() => (yLog ? yLo : 0));
    const down = data.categories.map(() => 0);
    data.series.forEach((series, s) => {
      const rects: string[] = [];
      const dark = luminance(colors[s]);
      const ink = dark !== null && dark > 0.45 ? '#1a1a1a' : '#ffffff';
      series.values.forEach((value, row) => {
        if (!valid(value)) return;
        const from = value >= 0 ? up[row] : down[row];
        const to = from + value;
        if (value >= 0) up[row] = to;
        else down[row] = to;
        const y0 = clampY(Math.max(from, to));
        const y1 = clampY(Math.min(from, to));
        const x0 = xAt(row)!;
        rects.push(`<rect data-category="${row}" x="${n(x0)}" y="${n(y0)}" width="${n(band)}" height="${n(Math.max(0, y1 - y0))}"/>`);
        if (el.valueLabels && y1 - y0 > valueSize * 1.3 && textWidth(series.cells[row].trim(), valueSize) < band) {
          valueLabel(s, row, x0 + band / 2, (y0 + y1) / 2 + valueSize * 0.35, series.cells[row], ink);
        }
      });
      marks.push(`<g class="chart-series" data-series="${s}" style="fill:${colors[s]}">${rects.join('')}</g>`);
    });
  } else {
    const stroke = Math.max(2, base * 0.12);
    const dot = el.kind === 'scatter' ? Math.max(3, base * 0.26) : Math.max(2.5, base * 0.17);
    const showDots = el.kind === 'scatter' || rows <= 24;
    data.series.forEach((series, s) => {
      const points: Array<{ row: number; x: number; y: number } | null> = series.values.map((value, row) => {
        const px = xAt(row);
        if (!valid(value) || px === null) return null;
        return { row, x: px, y: clampY(value) };
      });
      const parts: string[] = [];
      if (el.kind !== 'scatter') {
        // A gap in the data is a gap in the line, never a bridge across it.
        const runs: Array<Array<{ x: number; y: number }>> = [[]];
        for (const point of points) {
          if (point) runs[runs.length - 1].push(point);
          else if (runs[runs.length - 1].length > 0) runs.push([]);
        }
        for (const run of runs.filter((r) => r.length > 0)) {
          const d = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)} ${n(p.y)}`).join('');
          if (el.kind === 'area' && run.length > 1) {
            parts.push(`<path class="chart-area" d="${d}L${n(run[run.length - 1].x)} ${n(baseline)}L${n(run[0].x)} ${n(baseline)}Z"`
              + ` style="fill:${colors[s]}" fill-opacity="0.18" stroke="none"/>`);
          }
          parts.push(`<path class="chart-line" d="${d}" fill="none" style="stroke:${colors[s]}" stroke-width="${n(stroke)}"`
            + ` stroke-linejoin="round" stroke-linecap="round"/>`);
        }
      }
      if (showDots) {
        for (const point of points) {
          if (!point) continue;
          parts.push(`<circle data-category="${point.row}" cx="${n(point.x)}" cy="${n(point.y)}" r="${n(dot)}"`
            + ` style="fill:${colors[s]}"${el.kind === 'scatter' ? ' fill-opacity="0.85"' : ''}/>`);
        }
      }
      marks.push(`<g class="chart-series" data-series="${s}">${parts.join('')}</g>`);
    });
  }

  // The axis line goes over the bars' feet, under nothing else.
  const axisLine = `<line class="chart-baseline" x1="${n(plotLeft)}" x2="${n(plotRight)}" y1="${n(baseline)}" y2="${n(baseline)}"`
    + ` stroke="currentColor" stroke-opacity="0.45" stroke-width="${n(hairline * 1.4)}"/>`;

  out.push(`<g class="chart-marks">${marks.join('')}</g>`);
  out.push(axisLine);
  out.push(`<g class="chart-axis chart-axis-y" font-size="${n(tickSize)}" style="font-family:var(--chart-tick-font, inherit);fill:var(--chart-muted, currentColor)">${yLabels.join('')}</g>`);
  out.push(`<g class="chart-axis chart-axis-x" font-size="${n(tickSize)}" style="font-family:var(--chart-tick-font, inherit);fill:var(--chart-muted, currentColor)">${xLabelsMarkup.join('')}</g>`);
  if (valueLabels.length > 0) {
    out.push(`<g class="chart-value-labels" font-size="${n(valueSize)}" style="font-family:var(--chart-tick-font, inherit);fill:var(--chart-text, currentColor)">${valueLabels.join('')}</g>`);
  }

  if (el.yLabel) {
    const cx = pad + axisSize * 0.8;
    const cy = (plotTop + plotBottom) / 2;
    out.push(`<text class="chart-axis-label" x="${n(cx)}" y="${n(cy)}" text-anchor="middle" font-size="${n(axisSize)}"`
      + ` transform="rotate(-90 ${n(cx)} ${n(cy)})" style="fill:var(--chart-muted, currentColor)">`
      + `${esc(fitLabel(el.yLabel, axisSize, plotBottom - plotTop))}</text>`);
  }
  if (el.xLabel) {
    out.push(`<text class="chart-axis-label" x="${n((plotLeft + plotRight) / 2)}" y="${n(plotBottom + xLabelBand + axisSize * 1.1)}"`
      + ` text-anchor="middle" font-size="${n(axisSize)}" style="fill:var(--chart-muted, currentColor)">`
      + `${esc(fitLabel(el.xLabel, axisSize, plotWidth))}</text>`);
  }

  if (legendItems.length > 0) {
    const items = legendItems.map(({ x, y: cy, index }) => {
      const color = colors[index];
      const key = el.kind === 'line'
        ? `<line x1="${n(x)}" x2="${n(x + swatch)}" y1="${n(cy)}" y2="${n(cy)}" style="stroke:${color}" stroke-width="${n(Math.max(2, base * 0.12))}" stroke-linecap="round"/>`
        : el.kind === 'scatter'
          ? `<circle cx="${n(x + swatch / 2)}" cy="${n(cy)}" r="${n(swatch * 0.36)}" style="fill:${color}"/>`
          : `<rect x="${n(x)}" y="${n(cy - swatch / 2)}" width="${n(swatch)}" height="${n(swatch)}" rx="${n(swatch * 0.18)}" style="fill:${color}"/>`;
      return `<g class="chart-legend-item" data-series="${index}">${key}`
        + `<text x="${n(x + swatch + legendSize * 0.4)}" y="${n(cy)}" dy="0.35em">${esc(labelOf(data.series[index].name))}</text></g>`;
    });
    out.push(`<g class="chart-legend" font-size="${n(legendSize)}" style="fill:var(--chart-text, currentColor)">${items.join('')}</g>`);
  }

  return wrap(el, W, H, out);
}

function wrap(el: ChartEl, W: number, H: number, body: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="chart-svg" viewBox="0 0 ${n(W)} ${n(H)}" width="100%" height="100%"`
    + ` preserveAspectRatio="none" role="img" aria-label="${esc(el.title || `${el.kind} chart`)}"`
    + ` style="display:block;font-family:var(--chart-font, inherit);font-style:normal;font-weight:400;letter-spacing:normal;text-transform:none">`
    + `${body.join('')}</svg>`;
}
