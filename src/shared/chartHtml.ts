import type { ChartEl } from './deck.js';
import { chartSvg } from './chartSvg.js';
import { parsePaletteText } from './chartPalettes.js';

/**
 * A chart in the HTML authoring format:
 *
 *   <figure data-element="chart" data-kind="bar" data-x="model"
 *           data-series="score,cost" data-palette="okabe-ito"
 *           data-title="…" style="width:1200px;height:640px">
 *     <script type="text/csv">
 *   model,score,cost
 *   Ours,0.91,12
 *   </script>
 *   </figure>
 *
 * Options are data attributes, the data is an inert `text/csv` script — the
 * one element whose content the HTML parser leaves exactly as written, commas,
 * quotes, `<` and all. The figure's CSS box is the chart's geometry like any
 * element's. An export also puts the drawn SVG in the figure (marked
 * `data-element="none"`) so the page looks like the slide in a browser; the
 * compile ignores it and redraws from the data.
 */

const KIND_ALIASES: Record<string, ChartEl['kind']> = {
  bar: 'bar', bars: 'bar', column: 'bar', grouped: 'bar', 'grouped-bar': 'bar', groupedbar: 'bar',
  stacked: 'stacked-bar', 'stacked-bar': 'stacked-bar', stackedbar: 'stacked-bar',
  line: 'line', lines: 'line', area: 'area', scatter: 'scatter', points: 'scatter',
};

const PALETTES = new Set(['deck', 'tableau10', 'okabe-ito', 'viridis', 'grayscale', 'custom']);
const PALETTE_ALIASES: Record<string, ChartEl['palette']> = {
  tableau: 'tableau10', 'tableau-10': 'tableau10', okabeito: 'okabe-ito', 'okabe_ito': 'okabe-ito',
  greyscale: 'grayscale', gray: 'grayscale', grey: 'grayscale', theme: 'deck',
};

/** A list attribute: comma-separated names, or a JSON array when names hold commas. */
function nameList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  if (value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* read as a plain list */ }
  }
  return value.split(',').map((name) => name.trim()).filter(Boolean);
}

function listAttr(names: string[]): string {
  return names.some((name) => name.includes(',')) ? JSON.stringify(names) : names.join(',');
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '' || value.trim() === 'auto') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The CSV out of a `text/csv` script's text. An export writes the data on its
 * own lines between the tags, so one leading line break and the trailing
 * line's indentation are the markup's, not the data's. Hand-written data
 * indented along with the page is dedented. `<\/script` is how a cell holding
 * a closing script tag is written; it is put back.
 */
export function csvFromScript(text: string): string {
  let csv = text.replace(/\r\n?/g, '\n').replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
  const lines = csv.split('\n');
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  if (common > 0) csv = lines.map((line) => line.slice(Math.min(common, /^[ \t]*/.exec(line)![0].length))).join('\n');
  return csv.replace(/<\\\/script/gi, '</script');
}

/** The CSV as script text: on its own lines, a closing tag inside it escaped. */
export function csvToScript(csv: string): string {
  return `<script type="text/csv">\n${csv.replace(/<\/script/gi, '<\\/script')}\n</script>`;
}

/**
 * The chart fields a figure's data attributes and script state. Everything
 * the attributes leave out takes its default, so a hand-written figure needs
 * only its data.
 */
export function chartFieldsFromHtml(
  dataset: Record<string, string | undefined>,
  scriptText: string,
): Omit<ChartEl, 'id' | 'x' | 'y' | 'w' | 'h' | 'rot' | 'z' | 'opacity' | 'class' | 'style' | 'morphId' | 'lineageId' | 'layoutMasterId' | 'comments'> {
  const kind = KIND_ALIASES[(dataset.kind ?? 'bar').trim().toLowerCase()] ?? 'bar';
  const rawPalette = (dataset.palette ?? 'deck').trim();
  const paletteKey = rawPalette.toLowerCase();
  let palette: ChartEl['palette'] = PALETTES.has(paletteKey)
    ? paletteKey as ChartEl['palette']
    : PALETTE_ALIASES[paletteKey] ?? 'deck';
  let colors = dataset.colors ? parsePaletteText(dataset.colors) : [];
  // `data-palette="#264653,#2a9d8f"` or a coolors link: an imported palette.
  if (!PALETTES.has(paletteKey) && !PALETTE_ALIASES[paletteKey]) {
    const pasted = parsePaletteText(rawPalette);
    if (pasted.length > 0) {
      palette = 'custom';
      colors = pasted;
    }
  }
  const legend = (dataset.legend ?? 'auto').trim().toLowerCase();
  const fields = {
    type: 'chart' as const,
    kind,
    csv: csvFromScript(scriptText),
    series: nameList(dataset.series),
    title: dataset.title ?? '',
    xLabel: dataset.xLabel ?? '',
    yLabel: dataset.yLabel ?? '',
    yScale: dataset.yScale === 'log' ? 'log' as const : 'linear' as const,
    xScale: dataset.xScale === 'log' ? 'log' as const : 'linear' as const,
    legend: (['auto', 'top', 'right', 'bottom', 'none'].includes(legend) ? legend : legend === 'false' ? 'none' : 'auto') as ChartEl['legend'],
    valueLabels: dataset.valueLabels === 'true' || dataset.valueLabels === '',
    palette,
  };
  const yMin = optionalNumber(dataset.yMin);
  const yMax = optionalNumber(dataset.yMax);
  const xMin = optionalNumber(dataset.xMin);
  const xMax = optionalNumber(dataset.xMax);
  const fontSize = optionalNumber(dataset.fontSize);
  return {
    ...fields,
    ...(dataset.x ? { xColumn: dataset.x } : {}),
    ...(yMin !== undefined ? { yMin } : {}),
    ...(yMax !== undefined ? { yMax } : {}),
    ...(xMin !== undefined ? { xMin } : {}),
    ...(xMax !== undefined ? { xMax } : {}),
    ...(colors.length > 0 ? { colors } : {}),
    ...(dataset.highlight ? { highlight: dataset.highlight } : {}),
    ...(fontSize !== undefined && fontSize > 0 ? { fontSize } : {}),
  };
}

function attr(name: string, value: string): string {
  return ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
}

/**
 * A chart element as authoring markup. `attrs` is the identity and build
 * attributes every element carries, `style` its box; only what differs from
 * a default is written, so the figure reads like one an agent would write.
 */
export function chartToHtml(el: ChartEl, attrs: string, style: string): string {
  const options = [
    attr('data-kind', el.kind),
    el.xColumn !== undefined ? attr('data-x', el.xColumn) : '',
    el.series.length > 0 ? attr('data-series', listAttr(el.series)) : '',
    el.title ? attr('data-title', el.title) : '',
    el.xLabel ? attr('data-x-label', el.xLabel) : '',
    el.yLabel ? attr('data-y-label', el.yLabel) : '',
    el.yMin != null ? attr('data-y-min', String(el.yMin)) : '',
    el.yMax != null ? attr('data-y-max', String(el.yMax)) : '',
    el.xMin != null ? attr('data-x-min', String(el.xMin)) : '',
    el.xMax != null ? attr('data-x-max', String(el.xMax)) : '',
    el.yScale !== 'linear' ? attr('data-y-scale', el.yScale) : '',
    el.xScale !== 'linear' ? attr('data-x-scale', el.xScale) : '',
    el.legend !== 'auto' ? attr('data-legend', el.legend) : '',
    el.valueLabels ? attr('data-value-labels', 'true') : '',
    attr('data-palette', el.palette),
    el.colors && el.colors.length > 0 ? attr('data-colors', el.colors.join(',')) : '',
    el.highlight !== undefined ? attr('data-highlight', el.highlight) : '',
    el.fontSize !== undefined ? attr('data-font-size', String(el.fontSize)) : '',
  ].join('');
  const drawing = chartSvg(el).replace(/^<svg /, '<svg data-element="none" ');
  return `  <figure ${attrs} data-element="chart"${options} ${style}>${drawing}\n${csvToScript(el.csv)}</figure>`;
}
