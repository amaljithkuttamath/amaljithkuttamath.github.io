// chart-format.ts — pure, offline-testable formatting + threshold helpers for
// the chart card. Kept out of chitti.astro (DOM surface) so the axis/tooltip
// number formatting and the "when do we add chrome" decisions can be
// unit-tested without a browser, an LLM, or the network.
//
// None of these touch buildOption's category/series construction — they only
// decide how numbers READ and when to show optional chrome (dataZoom, scroll
// legend). chart-link.ts's index math is therefore unaffected by this module.

import type { ChartSpec } from './tools';

// A y_axis label that denotes a percentage. The spec's unit lives in
// spec.y_axis (a free-text axis description, e.g. "% of GDP", "deaths per
// 1,000 live births"). We only special-case percent because it's the one unit
// that changes the number's rendered glyph (a trailing %); every other unit
// stays in the card header, never appended to axis ticks.
export function isPercentUnit(unit?: string | null): boolean {
  if (!unit) return false;
  const u = unit.toLowerCase();
  return u.includes('%') || /\bper ?cent(age|s)?\b/.test(u);
}

// parseFloat(toFixed) drops trailing zeros: 1.20 -> "1.2", 3.0 -> "3".
function trim(n: number, digits: number): string {
  return String(parseFloat(n.toFixed(digits)));
}

// A value in (0,1): keep ~2 significant figures so 0.5 -> "0.5", 0.05 ->
// "0.05", 0.0123 -> "0.012", without ever printing scientific notation.
function fmtSmall(abs: number): string {
  const s = abs.toPrecision(2);
  if (s.indexOf('e') >= 0) return String(parseFloat(abs.toFixed(6))); // absurdly tiny -> collapses toward 0
  return String(parseFloat(s));
}

const MAGNITUDES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
];

// Compact, human-readable rendering of an axis/tooltip value. Magnitude
// suffixes for large numbers (1.2M, 3.4B, 1T), a trailing % for percent units,
// sensible precision for small floats. Pure and total: non-finite input
// (NaN/±Infinity), and null/undefined, render as '' so a single-point or
// all-equal series can never make it throw — it never divides by a data range.
export function formatAxisValue(value: number | null | undefined, unit?: string | null): string {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return '';
  const suffix = isPercentUnit(unit) ? '%' : '';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);

  if (abs === 0) return '0' + suffix;

  for (const [threshold, mag] of MAGNITUDES) {
    if (abs >= threshold) return sign + trim(abs / threshold, 1) + mag + suffix;
  }

  // abs < 1000
  let body: string;
  if (Number.isInteger(abs)) body = String(abs);
  else if (abs >= 100) body = String(Math.round(abs));
  else if (abs >= 1) body = trim(abs, 1);
  else body = fmtSmall(abs);
  return sign + body + suffix;
}

// The count of distinct x-axis categories a spec plots — mirrors the union
// buildOption/chartCategories build, without the ordering (order is
// irrelevant to a count). Used only by the threshold helpers below.
function categoryCount(spec: ChartSpec): number {
  const seen = new Set<string | number>();
  for (const s of spec.series) for (const [x] of s.data) seen.add(x);
  return seen.size;
}

// Long line series get a dataZoom (inside wheel/pinch + a slim slider). The
// boundary is strict >40: 40 points get none, 41 get zoom. Only line charts —
// bars/scatter never zoom. Guards a null/empty spec.
export const DATAZOOM_THRESHOLD = 40;
export function needsDataZoom(spec: ChartSpec | null | undefined): boolean {
  if (!spec || spec.type !== 'line' || !Array.isArray(spec.series)) return false;
  return categoryCount(spec) > DATAZOOM_THRESHOLD;
}

// Legend rendering mode. Many series (>6) get a scrollable, paged legend so a
// tall legend never eats the plot; 6 or fewer render plainly. The boundary is
// strict >6: 6 -> 'plain', 7 -> 'scroll'. Single-series charts don't show a
// legend at all (decided in buildOption), but this still answers 'plain' for
// them harmlessly.
export const LEGEND_SCROLL_THRESHOLD = 6;
export function legendMode(spec: ChartSpec | null | undefined): 'scroll' | 'plain' {
  if (!spec || !Array.isArray(spec.series)) return 'plain';
  return spec.series.length > LEGEND_SCROLL_THRESHOLD ? 'scroll' : 'plain';
}

// A filesystem-safe slug of the chart title for the saveAsImage filename.
// Always non-empty ('chart' when the title has no usable characters).
export function titleSlug(title?: string | null): string {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'chart';
}
