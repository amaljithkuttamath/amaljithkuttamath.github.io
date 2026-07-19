// chart-link.ts — pure, offline-testable mapping between an ECharts data
// point and the evidence DataRow that backs it, in both directions. Kept out
// of tools.ts (agent surface) and out of chitti.astro (DOM surface) so the
// index math can be unit-tested against buildOption's exact layout without a
// browser or a network.
//
// The single source of truth for "which category sits at which dataIndex" is
// chartCategories(), which MUST mirror buildOption() in chitti.astro:
//   - bar / grouped-bar: union of x values across series, in first-seen order
//     (no sort).
//   - line: same union, then sorted numerically (year axis).
//   - scatter: x is a value, not a category/year — a point maps to a
//     coordinate pair, not to a single {country, year} row, so linking is
//     skipped (both functions return null / empty).
// If buildOption's category construction ever changes, change it here too.

import type { ChartSpec, DataRow } from './tools';

export interface PointRef {
  seriesIndex: number;
  dataIndex: number;
}

// Tolerant scalar comparisons — chart x values arrive as number OR string
// (normalizeSpec keeps numeric years as numbers, category labels as strings),
// while rows always carry year:number / country:string. Match across that gap.
function eqNum(a: unknown, b: unknown): boolean {
  const na = Number(a);
  const nb = Number(b);
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}
function eqStr(a: unknown, b: unknown): boolean {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function eqVal(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Number(a) === Number(b);
}

// The plotted category axis for a spec, index-for-index identical to what
// buildOption feeds ECharts as xAxis.data. Empty for scatter (value axis).
export function chartCategories(spec: ChartSpec): (string | number)[] {
  if (!spec || spec.type === 'scatter') return [];
  const cats: (string | number)[] = [];
  for (const s of spec.series) for (const [x] of s.data) if (!cats.includes(x)) cats.push(x);
  if (spec.type === 'line') cats.sort((a, b) => Number(a) - Number(b));
  return cats;
}

// The y value a series plots at a given category, or undefined if that series
// has no point there (a null/absent bar in a grouped chart). Mirrors the
// `new Map(s.data).get(cat)` lookup buildOption uses.
function seriesValueAt(series: ChartSpec['series'][number], cat: string | number): number | undefined {
  const m = new Map(series.data.map(([x, y]) => [x, y]));
  return m.get(cat);
}

// point → row. Given a clicked series/data index, find the single evidence row
// that backs that number. Returns null when the point can't be mapped cleanly
// (scatter), the indices are out of range, the series plots nothing there, or
// no row matches.
export function matchPointToRow(
  spec: ChartSpec | null,
  seriesIndex: number,
  dataIndex: number,
  rows: DataRow[]
): DataRow | null {
  if (!spec || spec.type === 'scatter') return null;
  const series = spec.series?.[seriesIndex];
  if (!series) return null;
  const cats = chartCategories(spec);
  if (dataIndex < 0 || dataIndex >= cats.length) return null;
  const cat = cats[dataIndex];
  const y = seriesValueAt(series, cat);
  if (y === undefined || y === null) return null; // null/absent point — nothing to link
  const name = series.name;

  // A) series is a country, category is the year (line, grouped-by-country).
  //    Anchor on country+year, then prefer the exact value if several share
  //    that key (shouldn't happen, but keeps the pick deterministic).
  let r =
    rows.find((rw) => eqStr(rw.country, name) && eqNum(rw.year, cat) && eqVal(rw.value, y)) ||
    rows.find((rw) => eqStr(rw.country, name) && eqNum(rw.year, cat));
  if (r) return r;

  // B) category is the country (ranking bar); series name is the metric.
  r =
    rows.find((rw) => eqStr(rw.country, cat) && eqVal(rw.value, y)) ||
    rows.find((rw) => eqStr(rw.country, cat));
  if (r) return r;

  // C) fallback: category is a year but the series name isn't a row country —
  //    match on year + value.
  r = rows.find((rw) => eqNum(rw.year, cat) && eqVal(rw.value, y));
  return r ?? null;
}

// row → point. Given an evidence row, find the series/data index of the chart
// point that shows it, so a table hover can highlight it. Returns null when
// the spec can't map (scatter) or the row isn't plotted (e.g. a series hidden
// by legend has no matching visible point).
export function matchRowToPoint(spec: ChartSpec | null, row: DataRow): PointRef | null {
  if (!spec || spec.type === 'scatter' || !row) return null;
  const cats = chartCategories(spec);

  // A) a series named after the row's country; its point sits at the year.
  for (let si = 0; si < spec.series.length; si++) {
    const s = spec.series[si];
    if (!eqStr(s.name, row.country)) continue;
    const di = cats.findIndex((c) => eqNum(c, row.year));
    if (di >= 0 && seriesValueAt(s, cats[di]) != null) return { seriesIndex: si, dataIndex: di };
  }

  // B) the category axis is countries (ranking): find the category cell for
  //    this row's country, then the series that plots a matching value there
  //    (disambiguates grouped bars); fall back to the first series with a
  //    visible point in that cell.
  const diC = cats.findIndex((c) => eqStr(c, row.country));
  if (diC >= 0) {
    let fallback = -1;
    for (let si = 0; si < spec.series.length; si++) {
      const v = seriesValueAt(spec.series[si], cats[diC]);
      if (v === undefined || v === null) continue;
      if (eqVal(v, row.value)) return { seriesIndex: si, dataIndex: diC };
      if (fallback < 0) fallback = si;
    }
    if (fallback >= 0) return { seriesIndex: fallback, dataIndex: diC };
  }

  // C) fallback: the category axis is years — match year cell + value.
  const diY = cats.findIndex((c) => eqNum(c, row.year));
  if (diY >= 0) {
    for (let si = 0; si < spec.series.length; si++) {
      const v = seriesValueAt(spec.series[si], cats[diY]);
      if (v != null && eqVal(v, row.value)) return { seriesIndex: si, dataIndex: diY };
    }
  }

  return null;
}
