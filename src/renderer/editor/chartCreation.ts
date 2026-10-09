import type { ChartEl } from '@shared/deck.js';
import { makeId } from '@shared/geometry.js';
import {
  CHART_KINDS,
  CHART_KIND_LABELS,
  defaultChartKind,
  sampleChartCsv,
  type ChartKind,
} from '@shared/chartData.js';
import type { EditorStore } from './store.js';

/**
 * Making charts: the toolbar's Chart menu (sample data in the chosen kind, or
 * a CSV file picked from disk) and CSV files dropped on the canvas. The data
 * goes into the deck as text either way; nothing refers back to the file.
 */

/** Whether a dropped or picked file is tabular text a chart can be made from. */
export function isCsvFile(file: { name: string; type?: string }): boolean {
  return /\.(csv|tsv)$/i.test(file.name) || file.type === 'text/csv' || file.type === 'text/tab-separated-values';
}

/**
 * A chart element with every field at its default. Line ends are normalised
 * to LF, which is what the HTML round trip would turn them into anyway, so a
 * chart's data never changes merely by being exported and saved back.
 */
export function newChartElement(
  csv: string,
  box: { x: number; y: number; w: number; h: number },
  z: number,
  kind: ChartKind = defaultChartKind(csv),
): ChartEl {
  return {
    type: 'chart', id: makeId('chart'),
    ...box, rot: 0, z, opacity: 1, class: [], style: {},
    kind, csv: csv.replace(/\r\n?/g, '\n').replace(/\n+$/, ''), series: [],
    title: '', xLabel: '', yLabel: '',
    yScale: 'linear', xScale: 'linear', legend: 'auto', valueLabels: false, palette: 'deck',
  };
}

function nextZ(store: EditorStore): number {
  return (store.slide?.elements.reduce((max, el) => Math.max(max, el.z), 0) ?? 0) + 1;
}

/** A chart's starting box: a little over half the canvas wide, 16:9. */
function chartBox(store: EditorStore, centre?: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  const { canvas } = store.get().deck;
  const w = Math.round(Math.min(1200, canvas.w * 0.62));
  const h = Math.round(w * 9 / 16);
  const cx = centre?.x ?? canvas.w / 2;
  const cy = centre?.y ?? canvas.h / 2;
  return {
    x: Math.round(Math.min(Math.max(0, cx - w / 2), canvas.w - w)),
    y: Math.round(Math.min(Math.max(0, cy - h / 2), canvas.h - h)),
    w, h,
  };
}

/** Insert a chart of `kind` filled with sample data, and select it. */
export function insertChart(store: EditorStore, kind: ChartKind): ChartEl {
  const created = newChartElement(sampleChartCsv(kind), chartBox(store), nextZ(store), kind);
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(created), {
    label: `Insert ${CHART_KIND_LABELS[kind].toLowerCase()} chart`,
  });
  store.select([created.id]);
  return created;
}

/**
 * One chart per CSV file, centred on `point` (the drop) and cascading so
 * several files do not stack exactly. The kind is guessed from the data's
 * shape (`defaultChartKind`); the inspector changes it in one click.
 */
export async function insertChartsFromFiles(
  store: EditorStore,
  files: File[],
  point?: { x: number; y: number },
): Promise<ChartEl[]> {
  const texts = await Promise.all(files.map((file) => file.text()));
  const created = texts.map((text, i) => {
    const box = chartBox(store, point ? { x: point.x + i * 40, y: point.y + i * 40 } : undefined);
    return newChartElement(text, box, nextZ(store) + i);
  });
  if (created.length === 0) return created;
  store.commit((d) => d.slides[store.get().slideIndex].elements.push(...created), {
    label: files.length === 1 ? `Add chart from ${files[0].name}` : `Add ${files.length} charts`,
  });
  store.select(created.map((el) => el.id));
  return created;
}

function chartIcon(paths: string): string {
  return '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" '
    + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + `${paths}</svg>`;
}

const KIND_ICONS: Record<ChartKind, string> = {
  bar: chartIcon('<path d="M2 14h12M3.5 14V8M6 14V5M9.5 14V9M12 14V3"/>'),
  'stacked-bar': chartIcon('<path d="M2 14h12"/><rect x="3.5" y="7" width="3" height="7"/><rect x="9.5" y="4" width="3" height="10"/><path d="M3.5 10.5h3M9.5 9h3"/>'),
  line: chartIcon('<path d="M2 14h12M2.5 11l3.5-4 3 2.5 4.5-6"/>'),
  area: chartIcon('<path d="M2 14h12M2.5 13V11l3.5-4 3 2.5 4.5-6V13z"/>'),
  scatter: chartIcon('<path d="M2 14h12M2 2v12"/><circle cx="5" cy="10" r=".9"/><circle cx="8" cy="7.5" r=".9"/><circle cx="11" cy="8.5" r=".9"/><circle cx="12" cy="4.5" r=".9"/>'),
};

/**
 * The toolbar's Chart menu, built like the Shape menu beside it: a kind
 * starts from sample data; "From CSV file…" reads a file into one.
 */
export function createChartInsertPicker(store: EditorStore): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'shape-menu-wrap chart-menu-wrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'shape-menu-trigger chart-menu-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = KIND_ICONS.bar.replace('<svg ', '<svg class="bar-icon" ')
    + '<span>Chart</span>'
    + '<svg class="shape-menu-chevron" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">'
    + '<path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // The picker's file input is never shown; the menu item is its face.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.csv,.tsv,text/csv,text/tab-separated-values';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])].filter(isCsvFile);
    picker.value = '';
    if (files.length > 0) void insertChartsFromFiles(store, files);
  });

  let menu: HTMLDivElement | null = null;
  const close = (): void => {
    menu?.remove();
    menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (event: PointerEvent): void => {
    if (!wrap.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close();
  };
  const item = (label: string, icon: string, run: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shape-menu-item';
    button.setAttribute('role', 'menuitem');
    button.innerHTML = `${icon}<span>${label}</span>`;
    button.addEventListener('click', () => {
      close();
      // A focused control suppresses the editor's Delete shortcuts; the new
      // chart is the active context.
      button.blur();
      trigger.blur();
      run();
    });
    return button;
  };
  const open = (): void => {
    menu = document.createElement('div');
    menu.className = 'shape-menu chart-menu';
    menu.setAttribute('role', 'menu');
    for (const kind of CHART_KINDS) {
      menu.appendChild(item(CHART_KIND_LABELS[kind], KIND_ICONS[kind], () => insertChart(store, kind)));
    }
    menu.appendChild(item('From CSV file…', chartIcon('<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 9h4M6 11.5h4"/>'),
      () => picker.click()));
    wrap.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  };

  trigger.addEventListener('click', () => (menu ? close() : open()));
  wrap.append(trigger, picker);
  return wrap;
}
