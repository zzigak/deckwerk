import './chartInspector.css';
import type { ChartEl, SlideElement } from '@shared/deck.js';
import { CHART_KINDS, CHART_KIND_LABELS, chartData, isNumericColumn, parseCsv } from '@shared/chartData.js';
import { CHART_PALETTES, CHART_PALETTE_LABELS, paletteSwatches, parsePaletteText } from '@shared/chartPalettes.js';
import type { EditorStore } from './store.js';

/**
 * The inspector's sections for a chart: what it is (kind, title), its data
 * (the CSV, which column is x, which columns are plotted), its axes and its
 * look (palette, legend, labels).
 *
 * The field builders are the inspector's own, handed in rather than copied,
 * so a chart's controls are the same components as every other object's.
 * Every control commits on `change`, one undoable step each, like the rest of
 * the inspector.
 */

type Section = { section: HTMLElement; content: HTMLElement; caption: HTMLElement };

export interface InspectorFields {
  typeSections: () => HTMLElement;
  optionSection: (title: string, contentClass: string, caption?: string) => Section;
  segmentedSelectField: (
    label: string,
    choices: Array<{ value: string; title: string; icon?: string; text?: string }>,
    value: string,
    onChange: (v: string) => void,
  ) => HTMLElement;
  textAreaField: (label: string, value: string, onChange: (v: string) => void) => HTMLElement;
  checkboxField: (label: string, value: boolean, onChange: (v: boolean) => void) => HTMLElement;
  numberField: (
    label: string,
    value: number | null,
    onChange: (v: number) => void,
    opts?: { step?: number; unit?: string; onClear?: () => void; placeholder?: string },
  ) => HTMLElement;
  hint: (text: string) => HTMLElement;
}

/** Kind glyphs on the inspector's 14×14 grid (see `.segment-button svg`). */
const KIND_GLYPHS: Record<ChartEl['kind'], string> = {
  bar: '<path d="M1.5 12.5h11M3 12.5V7M5.5 12.5V4.5M8.5 12.5V8M11 12.5V2.5"/>',
  'stacked-bar': '<path d="M1.5 12.5h11"/><rect x="3" y="6" width="3" height="6.5"/><rect x="8" y="3" width="3" height="9.5"/><path d="M3 9.5h3M8 7.5h3"/>',
  line: '<path d="M1.5 12.5h11M2 10l3-3.5 2.5 2 4.5-5.5"/>',
  area: '<path class="fill" d="M2 12V10l3-3.5 2.5 2L12 3v9z" opacity=".35"/><path d="M1.5 12.5h11M2 10l3-3.5 2.5 2L12 3"/>',
  scatter: '<path d="M1.5 12.5h11M1.5 1.5v11"/><circle class="fill" cx="4.5" cy="9" r="1"/><circle class="fill" cx="7" cy="6.5" r="1"/><circle class="fill" cx="10" cy="7.5" r="1"/><circle class="fill" cx="11" cy="3.5" r="1"/>',
};

/** A `.field` select whose options carry readable labels, built like the inspector's own. */
function labelledSelect(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');
  for (const option of options) {
    const opt = document.createElement('option');
    opt.value = option.value;
    opt.textContent = option.label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(span, select);
  return wrap;
}

/** A single-line `.field` text input that commits on change. */
function textInputField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  placeholder = '',
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.addEventListener('change', () => onChange(input.value));
  wrap.append(span, input);
  return wrap;
}

export function chartInspectorSections(el: ChartEl, store: EditorStore, f: InspectorFields): HTMLElement {
  const wrap = f.typeSections();
  const update = (label: string, fn: (chart: ChartEl) => void) =>
    store.updateSelected((e: SlideElement) => {
      if (e.type === 'chart') fn(e);
    }, { label });
  const data = chartData(el);
  const table = parseCsv(el.csv);
  const numericX = data.xValues !== null && el.kind !== 'bar' && el.kind !== 'stacked-bar';
  const isBar = el.kind === 'bar' || el.kind === 'stacked-bar';

  // --- chart ----------------------------------------------------------------
  // Not "Chart": the panel already names the selected object that.
  const chart = f.optionSection('Type', 'chart-options');
  const kind = f.segmentedSelectField(
    'Kind',
    CHART_KINDS.map((value) => ({ value, title: CHART_KIND_LABELS[value], icon: KIND_GLYPHS[value] })),
    el.kind,
    (v) => update('Change chart kind', (c) => { c.kind = v as ChartEl['kind']; }),
  );
  kind.classList.add('chart-kind-field');
  chart.content.append(
    kind,
    textInputField('Title', el.title, (v) => update('Change chart title', (c) => { c.title = v.trim(); })),
  );
  wrap.appendChild(chart.section);

  // --- data -----------------------------------------------------------------
  const rows = table.rows.length;
  const dataSection = f.optionSection('Data', 'chart-data-options',
    `${rows} ${rows === 1 ? 'row' : 'rows'} · ${data.series.length} plotted`);
  if (table.columns.length > 0) {
    dataSection.content.appendChild(labelledSelect(
      'X column',
      table.columns.map((name) => ({ value: name, label: name })),
      data.xName,
      (v) => update('Change chart x column', (c) => {
        c.xColumn = v;
        c.series = c.series.filter((name) => name !== v);
      }),
    ));
    // One checkbox per other column; numeric ones are offered, labels are not.
    const plotted = new Set(data.series.map((series) => series.name));
    const candidates = table.columns.filter((name, index) =>
      name !== data.xName && isNumericColumn(table.rows.map((row) => row[index] ?? '')));
    if (candidates.length > 0) {
      // A field whose control is the list of columns, labelled like any other.
      const list = document.createElement('div');
      list.className = 'field chart-series-list';
      const caption = document.createElement('span');
      caption.textContent = 'Series';
      list.appendChild(caption);
      for (const name of candidates) {
        list.appendChild(f.checkboxField(name, plotted.has(name), (on) =>
          update(on ? 'Plot chart series' : 'Hide chart series', (c) => {
            const current = chartData(c).series.map((series) => series.name);
            const next = on ? [...current, name] : current.filter((other) => other !== name);
            // Keep the CSV's column order, whatever order they were ticked in.
            c.series = candidates.filter((candidate) => next.includes(candidate));
          })));
      }
      dataSection.content.appendChild(list);
    }
  }
  const csv = f.textAreaField('CSV (header row first)', el.csv, (v) =>
    update('Edit chart data', (c) => { c.csv = v.replace(/\r\n?/g, '\n'); }));
  csv.classList.add('chart-csv-field');
  const area = csv.querySelector('textarea');
  if (area) {
    area.rows = Math.min(14, Math.max(5, el.csv.split('\n').length + 1));
    area.spellcheck = false;
    area.wrap = 'off';
  }
  dataSection.content.appendChild(csv);
  if (data.series.length === 0) {
    dataSection.content.appendChild(f.hint('Nothing to plot: give the data a numeric column besides the x column.'));
  }
  wrap.appendChild(dataSection.section);

  // --- axes -----------------------------------------------------------------
  const axes = f.optionSection('Axes', 'chart-axis-options');
  const pair = (...fields: HTMLElement[]) => {
    const grid = document.createElement('div');
    grid.className = 'field-grid field-grid-2';
    grid.append(...fields);
    return grid;
  };
  axes.content.append(
    pair(
      textInputField('X label', el.xLabel, (v) => update('Change chart x label', (c) => { c.xLabel = v.trim(); })),
      textInputField('Y label', el.yLabel, (v) => update('Change chart y label', (c) => { c.yLabel = v.trim(); })),
    ),
    pair(
      f.numberField('Y min', el.yMin ?? null, (v) => update('Fix chart y minimum', (c) => { c.yMin = v; }),
        { placeholder: 'auto', step: 0.1, onClear: () => update('Fit chart y minimum', (c) => { delete c.yMin; }) }),
      f.numberField('Y max', el.yMax ?? null, (v) => update('Fix chart y maximum', (c) => { c.yMax = v; }),
        { placeholder: 'auto', step: 0.1, onClear: () => update('Fit chart y maximum', (c) => { delete c.yMax; }) }),
    ),
  );
  const scaleChoices = [{ value: 'linear', title: 'Linear scale', text: 'Linear' }, { value: 'log', title: 'Logarithmic scale', text: 'Log' }];
  const yScale = f.segmentedSelectField('Y scale', scaleChoices, el.yScale,
    (v) => update('Change chart y scale', (c) => { c.yScale = v as ChartEl['yScale']; }));
  yScale.classList.add('chart-two-way');
  axes.content.appendChild(yScale);
  if (numericX) {
    axes.content.appendChild(pair(
      f.numberField('X min', el.xMin ?? null, (v) => update('Fix chart x minimum', (c) => { c.xMin = v; }),
        { placeholder: 'auto', step: 0.1, onClear: () => update('Fit chart x minimum', (c) => { delete c.xMin; }) }),
      f.numberField('X max', el.xMax ?? null, (v) => update('Fix chart x maximum', (c) => { c.xMax = v; }),
        { placeholder: 'auto', step: 0.1, onClear: () => update('Fit chart x maximum', (c) => { delete c.xMax; }) }),
    ));
    const xScale = f.segmentedSelectField('X scale', scaleChoices, el.xScale,
      (v) => update('Change chart x scale', (c) => { c.xScale = v as ChartEl['xScale']; }));
    xScale.classList.add('chart-two-way');
    axes.content.appendChild(xScale);
  }
  wrap.appendChild(axes.section);

  // --- style ----------------------------------------------------------------
  const look = f.optionSection('Style', 'chart-style-options');
  look.content.appendChild(labelledSelect(
    'Palette',
    CHART_PALETTES
      .filter((value) => value !== 'custom' || (el.colors?.length ?? 0) > 0)
      .map((value) => ({ value, label: CHART_PALETTE_LABELS[value] })),
    el.palette,
    (v) => update('Change chart palette', (c) => { c.palette = v as ChartEl['palette']; }),
  ));
  const swatches = document.createElement('div');
  swatches.className = 'chart-swatches';
  swatches.setAttribute('aria-hidden', 'true');
  // The deck palette is whatever the theme declares on the slide, so read it
  // off the slide the canvas is drawing rather than guessing from the deck.
  const slide = document.querySelector('#canvas .slide');
  const declared = slide ? getComputedStyle(slide) : null;
  const resolve = (name: string) => declared?.getPropertyValue(name).trim() || null;
  for (const color of paletteSwatches(el, Math.max(5, data.series.length), resolve)) {
    const chip = document.createElement('span');
    chip.className = 'chart-swatch';
    chip.style.background = color;
    swatches.appendChild(chip);
  }
  look.content.appendChild(swatches);
  const importField = textInputField('Import palette', '', (v) => {
    const colors = parsePaletteText(v);
    if (colors.length === 0) {
      importNote.textContent = 'No colours found. Paste hex codes (#264653, 2a9d8f …) or a coolors.co link.';
      importNote.hidden = false;
      return;
    }
    update('Import chart palette', (c) => {
      c.palette = 'custom';
      c.colors = colors;
    });
  }, 'Hex list or coolors.co link');
  importField.classList.add('chart-palette-import');
  const importNote = f.hint('');
  importNote.hidden = true;
  look.content.append(importField, importNote);
  if (el.palette === 'grayscale' && data.series.length > 1) {
    look.content.appendChild(labelledSelect(
      'Highlight',
      data.series.map((series) => ({ value: series.name, label: series.name })),
      el.highlight && data.series.some((series) => series.name === el.highlight) ? el.highlight : data.series[0].name,
      (v) => update('Change highlighted series', (c) => { c.highlight = v; }),
    ));
  }
  look.content.appendChild(labelledSelect(
    'Legend',
    [
      { value: 'auto', label: 'Auto (top, for several series)' },
      { value: 'top', label: 'Top' },
      { value: 'right', label: 'Right' },
      { value: 'bottom', label: 'Bottom' },
      { value: 'none', label: 'None' },
    ],
    el.legend,
    (v) => update('Change chart legend', (c) => { c.legend = v as ChartEl['legend']; }),
  ));
  if (isBar) {
    look.content.appendChild(f.checkboxField('Value labels on bars', el.valueLabels, (v) =>
      update(v ? 'Show chart value labels' : 'Hide chart value labels', (c) => { c.valueLabels = v; })));
  }
  look.content.appendChild(f.numberField('Text size', el.fontSize ?? null,
    (v) => update('Change chart text size', (c) => { if (v > 0) c.fontSize = v; }),
    { unit: 'px', placeholder: 'auto', onClear: () => update('Scale chart text with its box', (c) => { delete c.fontSize; }) }));
  wrap.appendChild(look.section);
  return wrap;
}
