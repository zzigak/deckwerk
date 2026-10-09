import type { ChartEl } from '@shared/deck.js';
import { chartSvg } from '@shared/chartSvg.js';

/**
 * A chart element's body: the shared SVG (shared/chartSvg.ts) in a box that
 * fills the element. The markup is remembered on the box, so the editor's
 * in-place patch can tell whether anything that draws actually changed.
 */
export function renderChartBody(el: ChartEl): HTMLElement {
  const box = document.createElement('div');
  box.className = 'chart-body';
  box.style.width = '100%';
  box.style.height = '100%';
  const markup = chartSvg(el);
  box.innerHTML = markup;
  chartMarkup.set(box, markup);
  return box;
}

const chartMarkup = new WeakMap<HTMLElement, string>();

/**
 * Bring an existing chart node up to date in place. The drawing is laid out
 * for the box at 1:1, so a resize — every frame of a drag — needs a new
 * drawing, as does any change to the data or options; the wrapper alone would
 * stretch the old one. Like a shape's SVG it holds no state worth keeping, so
 * it is simply drawn again, and only when the markup differs.
 */
export function syncChartBody(node: HTMLElement, el: ChartEl): void {
  const body = node.querySelector<HTMLElement>(':scope > .chart-body');
  if (!body) return;
  const markup = chartSvg(el);
  if (chartMarkup.get(body) === markup) return;
  body.innerHTML = markup;
  chartMarkup.set(body, markup);
}
