import type { ChartEl } from './deck.js';

/**
 * The data half of a chart: CSV in, columns of numbers out.
 *
 * A chart's data lives in the deck as the CSV text the author pasted or
 * dropped, never as a parsed table. Text diffs, survives the HTML round trip
 * byte for byte, and keeps whatever the author meant by a cell — "12.5%" stays
 * "12.5%" in the data and becomes 12.5 only on its way to a scale. Everything
 * here is pure, so the canvas, the player, the exports and the tests all read
 * the same numbers out of the same text.
 */

export type ChartKind = ChartEl['kind'];

export const CHART_KINDS: ChartKind[] = ['bar', 'stacked-bar', 'line', 'area', 'scatter'];

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: 'Bar',
  'stacked-bar': 'Stacked bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
};

/** A parsed CSV: the header row and the rows under it, every row as long as the header. */
export interface CsvTable {
  columns: string[];
  rows: string[][];
}

/**
 * The field separator a pasted table uses. Spreadsheets copy tab-separated
 * text and a good part of Europe writes semicolons, so the header line decides:
 * whichever of tab, semicolon and comma it has most of outside quotes.
 */
function detectDelimiter(text: string): string {
  const firstLine: string[] = [];
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    firstLine.push(quoted ? '' : ch);
  }
  const count = (d: string) => firstLine.filter((ch) => ch === d).length;
  const tabs = count('\t');
  const semis = count(';');
  const commas = count(',');
  if (tabs > 0 && tabs >= commas) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * RFC 4180 CSV: quoted fields may hold the separator, line breaks and doubled
 * quotes; CRLF and LF both end a record. Blank lines are skipped and short rows
 * padded, so a hand-typed table with a missing trailing cell still lines up.
 * Unquoted fields are trimmed (the spaces after a comma are layout); a quoted
 * field is kept exactly.
 */
export function parseCsv(text: string): CsvTable {
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldWasQuoted = false;
  const endField = () => {
    record.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (record.length > 1 || record[0] !== '') records.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      fieldWasQuoted = true;
      field = '';
    } else if (ch === delimiter) endField();
    else if (ch === '\n') endRecord();
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else field += ch;
  }
  if (field !== '' || fieldWasQuoted || record.length > 0) endRecord();

  const [header = [], ...body] = records;
  const columns = header.map((name, index) => name.trim() || `Column ${index + 1}`);
  const width = Math.max(columns.length, ...body.map((row) => row.length));
  while (columns.length < width) columns.push(`Column ${columns.length + 1}`);
  const rows = body.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  return { columns, rows };
}

/** One CSV field, quoted only when it has to be. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A table back to CSV text: comma-separated, LF line ends, quoting only where needed. */
export function serializeCsv(table: CsvTable): string {
  return [table.columns, ...table.rows].map((row) => row.map(csvField).join(',')).join('\n');
}

/**
 * A cell as a number, or null when it is empty or a missing-value marker.
 * Returns NaN for text that is not a number at all, so a column can tell
 * "has gaps" (still numeric) from "is labels" (not).
 *
 * Units are stripped rather than rejected: "12.5%", "$1,200", "3.2 ms",
 * "−0.4" (a typographic minus), "1.2e-3 s" and "45°" are what a results table
 * actually holds, and a chart of them should not need the table rewritten
 * first. What is left must still be one plain number: "12-15" or "v2" is text.
 */
export function parseChartNumber(cell: string): number | null {
  const raw = cell.trim();
  if (raw === '' || /^(?:n\/?a|nan|null|none|-|—|–|\?)$/i.test(raw)) return null;
  const normalised = raw.replace(/[−‒–]/g, '-').replace(/[\s  ]/g, ' ');
  const match = /^([-+]?)\s*[$€£¥]?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:e([-+]?\d+))?\s*(?:%|‰|°[CF]?|[a-zA-Zµμ][a-zA-Zµμ/²³]*)?$/i
    .exec(normalised);
  if (!match) return Number.NaN;
  const [, sign, digits, exponent] = match;
  const value = Number(`${sign}${digits.replace(/,/g, '')}${exponent !== undefined ? `e${exponent}` : ''}`);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** A column is numeric when every non-empty cell is a number (and at least one is). */
export function isNumericColumn(cells: string[]): boolean {
  let seen = false;
  for (const cell of cells) {
    const value = parseChartNumber(cell);
    if (value === null) continue;
    if (Number.isNaN(value)) return false;
    seen = true;
  }
  return seen;
}

export interface ChartSeries {
  name: string;
  /** One value per row; null where the cell is empty or not a number. */
  values: Array<number | null>;
  /** The cells as written, for value labels: "12.5%" reads better than 12.5. */
  cells: string[];
}

/** What a chart plots, resolved from its CSV and column mapping. */
export interface ChartData {
  xName: string;
  /** The x cell of each row, as written. */
  categories: string[];
  /** The x column as numbers, when every cell is one; otherwise null (categorical x). */
  xValues: Array<number | null> | null;
  series: ChartSeries[];
  columns: string[];
}

/**
 * Resolve an element's CSV and column mapping into plottable series.
 *
 * Unknown names in `series` are dropped rather than failing the whole chart:
 * a column renamed in the data should cost one series, not the slide. With no
 * series named (or none left), every numeric column other than x is plotted.
 */
export function chartData(el: Pick<ChartEl, 'csv' | 'xColumn' | 'series'>): ChartData {
  const table = parseCsv(el.csv);
  const xIndex = Math.max(0, el.xColumn !== undefined ? table.columns.indexOf(el.xColumn) : 0);
  const xName = table.columns[xIndex] ?? '';
  const column = (index: number) => table.rows.map((row) => row[index] ?? '');
  const categories = column(xIndex);
  const xValues = isNumericColumn(categories)
    ? categories.map((cell) => {
      const value = parseChartNumber(cell);
      return value === null || Number.isNaN(value) ? null : value;
    })
    : null;
  const named = el.series
    .map((name) => table.columns.indexOf(name))
    .filter((index) => index >= 0 && index !== xIndex);
  const indices = named.length > 0
    ? named
    : table.columns.map((_, index) => index).filter((index) => index !== xIndex && isNumericColumn(column(index)));
  const series = indices.map((index) => ({
    name: table.columns[index],
    cells: column(index),
    values: column(index).map((cell) => {
      const value = parseChartNumber(cell);
      return value === null || Number.isNaN(value) ? null : value;
    }),
  }));
  return { xName, categories, xValues, series, columns: table.columns };
}

/**
 * The kind a fresh table most likely wants, from its shape alone: a numeric x
 * that only rises is a sweep (a line); a numeric x in any order is a cloud of
 * points (a scatter); labels on x are categories, compared as bars.
 */
export function defaultChartKind(csv: string): ChartKind {
  const data = chartData({ csv, series: [] });
  if (data.xValues) {
    const xs = data.xValues.filter((value): value is number => value !== null);
    const rising = xs.every((value, i) => i === 0 || value > xs[i - 1]);
    return rising && xs.length >= 3 ? 'line' : 'scatter';
  }
  return 'bar';
}

/** Sample data a chart inserted from the toolbar starts with, per kind. */
export function sampleChartCsv(kind: ChartKind): string {
  switch (kind) {
    case 'line':
    case 'area':
      return 'step,Ours,Baseline\n0,1.00,1.00\n10,0.62,0.81\n20,0.41,0.70\n40,0.24,0.58\n80,0.13,0.49\n160,0.08,0.43';
    case 'scatter':
      return 'params (M),Ours,Baseline\n12,71.2,68.0\n25,74.8,70.9\n48,77.1,72.4\n86,78.9,74.6\n150,80.3,75.1\n300,81.0,75.8';
    default:
      return 'method,Accuracy,Recall\nBaseline,0.72,0.64\nAblation,0.78,0.71\nOurs,0.86,0.83';
  }
}
