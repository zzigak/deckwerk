import type { ChartEl, ThemeStyle } from './deck.js';

/**
 * Series colours for charts, and the theme hook that lets a chart look like
 * its deck.
 *
 * The renderer has no deck in hand — it draws one element from one slide, the
 * same way on every surface — so the theme reaches a chart the way it reaches
 * everything else: through theme.css. The generated theme block declares a
 * few custom properties on `.slide` (`chartThemeCss`), and a chart's SVG paints
 * with `var(--chart-…, fallback)`. Changing the theme recolours and re-fonts
 * every chart with no edit to the charts themselves, and a deck whose
 * stylesheet predates these properties still draws with sensible fallbacks.
 */

export type ChartPalette = ChartEl['palette'];

export const CHART_PALETTES: ChartPalette[] = ['deck', 'tableau10', 'okabe-ito', 'viridis', 'grayscale', 'custom'];

export const CHART_PALETTE_LABELS: Record<ChartPalette, string> = {
  deck: 'Deck',
  tableau10: 'Tableau 10',
  'okabe-ito': 'Okabe-Ito (colour-blind safe)',
  viridis: 'Viridis',
  grayscale: 'Grayscale + accent',
  custom: 'Custom',
};

/** Tableau 10, the current (2016) ordering. */
export const TABLEAU_10 = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

/**
 * Okabe & Ito's colour-blind safe set. Yellow and black are moved to the end:
 * yellow nearly vanishes on a light slide and black on a dark one, so they are
 * only reached by a chart with seven or more series.
 */
export const OKABE_ITO = [
  '#e69f00', '#56b4e9', '#009e73', '#0072b2', '#d55e00', '#cc79a7', '#f0e442', '#000000',
];

/** Viridis at nine even stops, interpolated between for any series count. */
const VIRIDIS_STOPS = [
  '#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725',
];

/** Greys for the series a grayscale chart does not pick out; mid-tones read on light and dark slides. */
const GREYS = ['#8a8a8a', '#a8a8a8', '#6e6e6e', '#c2c2c2', '#565656'];

/**
 * The deck palette's fallbacks, used until theme.css declares `--chart-N`.
 * They are Tableau's first six, so an unthemed deck still gets distinct hues.
 */
const DECK_SLOTS = 6;

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex([r, g, b]: number[]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** Viridis at `t` in [0, 1]. */
export function viridis(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (VIRIDIS_STOPS.length - 1);
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(x));
  const a = hexRgb(VIRIDIS_STOPS[i]);
  const b = hexRgb(VIRIDIS_STOPS[i + 1]);
  const f = x - i;
  return rgbHex(a.map((v, k) => v + (b[k] - v) * f));
}

/**
 * One paint per series, in series order. Values are CSS colours, or for the
 * deck palette `var(--chart-N, fallback)` so the theme decides.
 *
 * Viridis spreads its samples across the map but stops short of both ends:
 * the last yellow is too light to read on a white slide, the first purple too
 * dark on a black one.
 */
export function chartSeriesColors(
  el: Pick<ChartEl, 'palette' | 'colors' | 'highlight'>,
  seriesNames: string[],
): string[] {
  const n = seriesNames.length;
  const cycle = (list: string[]) => seriesNames.map((_, i) => list[i % list.length]);
  switch (el.palette) {
    case 'tableau10': return cycle(TABLEAU_10);
    case 'okabe-ito': return cycle(OKABE_ITO);
    case 'viridis':
      return seriesNames.map((_, i) => viridis(n <= 1 ? 0.35 : 0.08 + (i / (n - 1)) * 0.8));
    case 'grayscale': {
      const picked = Math.max(0, el.highlight !== undefined ? seriesNames.indexOf(el.highlight) : 0);
      let grey = 0;
      return seriesNames.map((_, i) => (i === picked
        ? 'var(--chart-accent, #d55e00)'
        : GREYS[grey++ % GREYS.length]));
    }
    case 'custom': {
      const colors = (el.colors ?? []).filter(Boolean);
      if (colors.length > 0) return cycle(colors);
      return deckColors(n);
    }
    default: return deckColors(n);
  }
}

function deckColors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const slot = i % DECK_SLOTS;
    return `var(--chart-${slot + 1}, ${TABLEAU_10[slot]})`;
  });
}

/**
 * The swatches a palette shows in the inspector, as plain colours. Theme
 * variables are resolved with `resolve` (the value a slide declares) when it
 * knows them, and otherwise show their fallback.
 */
export function paletteSwatches(
  el: Pick<ChartEl, 'palette' | 'colors' | 'highlight'>,
  count: number,
  resolve: (name: string) => string | null = () => null,
): string[] {
  const names = Array.from({ length: count }, (_, i) => `s${i}`);
  return chartSeriesColors({ ...el, highlight: el.palette === 'grayscale' ? 's0' : el.highlight }, names)
    .map((paint) => {
      const variable = /^var\((--chart-[a-z0-9-]+), (#[0-9a-f]+)\)$/i.exec(paint);
      return variable ? resolve(variable[1]) ?? variable[2] : paint;
    });
}

/**
 * The theme's swatch row reordered for data. A preset's palette runs text,
 * muted, accent, three more hues, then two grounds; data wants the hues first,
 * the accent leading, and the text colours only after them. Grounds are never
 * used — a bar the colour of the slide is invisible.
 */
export function deckChartColors(style: Pick<ThemeStyle, 'palette' | 'colors'>): string[] {
  const p = style.palette;
  const slots = p.length >= 6
    ? [p[2], p[3], p[4], p[5], p[1], p[0]]
    : [style.colors.accent, ...p.filter((color) => color !== style.colors.background)];
  return slots.filter((color, i) => Boolean(color) && slots.indexOf(color) === i).slice(0, DECK_SLOTS);
}

/**
 * The custom properties a theme block declares for charts. Appended to the
 * generated theme.css by `themeStyleCss`, on `.slide` so every surface that
 * draws a slide (canvas, player, exports, PDF, the authoring page) has them.
 */
export function chartThemeCss(style: ThemeStyle): string {
  const colors = deckChartColors(style);
  return [
    `.slide {`,
    ...colors.map((color, i) => `  --chart-${i + 1}: ${color};`),
    `  --chart-accent: ${style.colors.accent};`,
    `  --chart-text: ${style.colors.text};`,
    `  --chart-muted: ${style.colors.muted};`,
    `  --chart-title-font: ${style.fonts.heading.family};`,
    `  --chart-title-weight: ${style.fonts.heading.weight};`,
    `  --chart-font: ${style.fonts.body.family};`,
    `  --chart-tick-font: ${style.fonts.caption.family};`,
    `}`,
    ``,
  ].join('\n');
}

/**
 * Colours out of whatever a person pastes as a palette: a list of hex codes
 * (with or without `#`, separated by anything), a coolors.co link
 * (`https://coolors.co/264653-2a9d8f-e9c46a`), a JSON array, or `rgb()` /
 * `hsl()` values. Bare hex is only taken as six digits — three bare digits
 * are as likely a number as a colour. Duplicates are dropped, order kept.
 */
export function parsePaletteText(text: string): string[] {
  const found: string[] = [];
  const pattern = /(rgba?|hsla?)\([^)]*\)|#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])|(?<![0-9a-z#])([0-9a-f]{6})(?![0-9a-z])/gi;
  for (const match of text.matchAll(pattern)) {
    let color: string;
    if (match[1]) color = match[0].replace(/\s+/g, ' ');
    else {
      let hex = (match[2] ?? match[3]).toLowerCase();
      if (hex.length === 3) hex = [...hex].map((ch) => ch + ch).join('');
      color = `#${hex}`;
    }
    if (!found.includes(color)) found.push(color);
  }
  return found;
}
