import type { ChartEl, Slide, TimelineEntry } from './deck.js';
import { chartData } from './chartData.js';
import type { SlideState } from './timeline.js';

/**
 * Charts that build: an `appear` whose value is `"bySeries"` reveals a chart
 * one series at a time, `"byCategory"` one category (a group of bars) at a
 * time. They ride on the timeline's existing part machinery — the same fan-out
 * that reveals text a paragraph at a time — so the card, the step count, the
 * cascade for non-click triggers and jumping back all behave identically.
 * Axes, gridlines and titles are on screen from the first part; only the
 * marks wait.
 */

export type ChartBuildMode = 'bySeries' | 'byCategory';

export function isChartBuildValue(value: unknown): value is ChartBuildMode {
  return value === 'bySeries' || value === 'byCategory';
}

/** The chart an entry builds part by part, or null when it is not a chart build. */
export function chartBuildTarget(entry: TimelineEntry, slide: Slide): ChartEl | null {
  if (entry.action.type !== 'appear' || !isChartBuildValue(entry.action.value)) return null;
  const el = slide.elements.find((candidate) => candidate.id === entry.action.target);
  return el?.type === 'chart' ? el : null;
}

/** How many parts a chart build reveals: its series, or its categories. */
export function chartBuildParts(el: ChartEl, mode: ChartBuildMode): number {
  const data = chartData(el);
  return Math.max(1, mode === 'byCategory' ? data.categories.length : data.series.length);
}

/**
 * Reconcile part visibility on rendered charts with a resolved slide state:
 * marks whose series (or category) index is at or past the revealed count are
 * hidden. Visibility, not removal, so nothing re-lays out as the chart builds.
 * The player, presenter preview and PDF all apply state through here.
 */
export function applyChartBuildVisibility(stage: ParentNode, slide: Slide, state: SlideState): void {
  for (const [id, revealed] of state.parts) {
    const entry = slide.timeline.find((candidate) =>
      candidate.action.target === id && chartBuildTarget(candidate, slide) !== null);
    if (!entry) continue;
    const attribute = entry.action.value === 'byCategory' ? 'data-category' : 'data-series';
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/[\\"]/g, '\\$&');
    const svg = stage.querySelector(`[data-element-id="${escaped}"] .chart-svg`);
    if (!svg) continue;
    for (const mark of svg.querySelectorAll<SVGElement>(`[${attribute}]`)) {
      // Category builds leave the legend alone: every series is already there.
      if (attribute === 'data-category' && mark.closest('.chart-legend')) continue;
      mark.style.visibility = Number(mark.getAttribute(attribute)) < revealed ? '' : 'hidden';
    }
  }
}
