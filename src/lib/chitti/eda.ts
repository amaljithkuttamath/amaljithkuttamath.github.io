// eda.ts — exploratory verbs over the rows already fetched from a connected
// database. Pure, deterministic, and unit-tested; no model call anywhere in
// here, so nothing in an EDA answer can be invented.
//
// WHY: Chitti could fetch a series and chart it, but it could not tell you what
// you were looking AT — how complete the data is, how it is distributed, who
// the outliers are, or how the picture changes when you group countries rather
// than list them. Those are the questions that turn a chart into an
// understanding, and every one of them is arithmetic over rows we already have.
//
// The `breakdown` verb is the reason this module earns its place. Every row
// carries an iso3, and the bundled countries table tags all 217 real countries
// with a World Bank REGION and INCOME GROUP — metadata that shipped with the app
// from the start and that nothing ever used. Grouping by it answers questions a
// single-series chart cannot ("is the gap between income groups closing?") and
// that a chart site cannot answer at all, because it requires joining the
// series to the country metadata and aggregating.
import { COUNTRIES, type DataRow } from './tools';

// Aggregates are World Bank pseudo-countries (WLD, EUU, income aggregates…).
// They are legitimate rows to fetch and chart, but including them in a
// distribution or a group breakdown double-counts — an aggregate IS a summary
// of the countries beside it. Every verb here works over real countries only,
// and says how many rows it set aside.
const META = new Map(COUNTRIES.map((c) => [c.id, c]));
export function isRealCountry(iso3: string): boolean {
  const c = META.get(iso3);
  return !!c && c.region !== 'Aggregates' && c.region !== '';
}

export interface Distribution {
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  mean: number;
  sd: number;
}

// Quantile by linear interpolation on a sorted array (the "R type 7" default,
// and what a reader who checks in a spreadsheet will get).
export function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function describe(values: number[]): Distribution | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  // Sample standard deviation (n-1); 0 for a single point rather than NaN.
  const sd =
    v.length > 1
      ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1))
      : 0;
  return {
    n: v.length,
    min: v[0],
    q1: quantile(v, 0.25),
    median: quantile(v, 0.5),
    q3: quantile(v, 0.75),
    max: v[v.length - 1],
    mean,
    sd,
  };
}

export interface SeriesProfile {
  indicator: string;
  rowCount: number;
  countryCount: number;
  aggregatesExcluded: number;
  yearStart: number | null;
  yearEnd: number | null;
  // Share of (country × year) cells in the covered rectangle that have no
  // value — the honest measure of how patchy a series is, and the thing a
  // reader most often does not realise about institutional data.
  missingPct: number;
  // The most recent year with at least 60% of the series' countries reporting.
  // "Latest year" is a trap otherwise: the final year of a World Bank pull is
  // usually near-empty, and a ranking built on it is a ranking of who reports
  // early, not who leads.
  latestUsableYear: number | null;
  latest: Distribution | null;
  outliers: { iso3: string; country: string; value: number; side: 'high' | 'low' }[];
}

// Profile one indicator's rows: coverage, missingness, distribution at the
// latest usable year, and the countries sitting outside the whiskers.
export function profileSeries(rows: DataRow[], indicator?: string): SeriesProfile | null {
  const pool = indicator ? rows.filter((r) => r.indicator === indicator) : rows;
  if (!pool.length) return null;
  const real = pool.filter((r) => isRealCountry(r.iso3));
  const aggregatesExcluded = pool.length - real.length;
  if (!real.length) return null;

  const years = real.map((r) => r.year).filter(Number.isFinite);
  const yearStart = years.length ? Math.min(...years) : null;
  const yearEnd = years.length ? Math.max(...years) : null;
  const countries = new Set(real.map((r) => r.iso3));

  // Missingness across the covered rectangle, counting a cell absent from the
  // rows as missing too — a series that simply omits a country-year is exactly
  // as unusable as one that returns null for it.
  const span = yearStart !== null && yearEnd !== null ? yearEnd - yearStart + 1 : 0;
  const cells = countries.size * span;
  const present = real.filter((r) => r.value !== null).length;
  const missingPct = cells > 0 ? Math.max(0, ((cells - present) / cells) * 100) : 0;

  // Reporting count per year, to find the latest year that is actually usable.
  const byYear = new Map<number, DataRow[]>();
  for (const r of real) {
    if (r.value === null) continue;
    const list = byYear.get(r.year) || [];
    list.push(r);
    byYear.set(r.year, list);
  }
  const threshold = countries.size * 0.6;
  const usableYears = [...byYear.entries()]
    .filter(([, list]) => list.length >= threshold)
    .map(([y]) => y)
    .sort((a, b) => a - b);
  const latestUsableYear = usableYears.length ? usableYears[usableYears.length - 1] : null;

  const latestRows = latestUsableYear !== null ? byYear.get(latestUsableYear) ?? [] : [];
  const latest = describe(latestRows.map((r) => r.value as number));

  // Tukey fences on the latest usable year. Outliers are NAMED, because "which
  // countries are unusual" is the interesting half of a distribution.
  const outliers: SeriesProfile['outliers'] = [];
  if (latest) {
    const iqr = latest.q3 - latest.q1;
    const hi = latest.q3 + 1.5 * iqr;
    const lo = latest.q1 - 1.5 * iqr;
    for (const r of latestRows) {
      const v = r.value as number;
      if (v > hi) outliers.push({ iso3: r.iso3, country: r.country, value: v, side: 'high' });
      else if (v < lo) outliers.push({ iso3: r.iso3, country: r.country, value: v, side: 'low' });
    }
    // Most extreme first, and capped — a list of 40 names is not a finding.
    outliers.sort((a, b) => Math.abs(b.value - latest.median) - Math.abs(a.value - latest.median));
    outliers.splice(8);
  }

  return {
    indicator: indicator ?? (pool[0].indicator || 'series'),
    rowCount: real.length,
    countryCount: countries.size,
    aggregatesExcluded,
    yearStart,
    yearEnd,
    missingPct,
    latestUsableYear,
    latest,
    outliers,
  };
}

export type BreakdownDimension = 'region' | 'income';

export interface BreakdownGroup {
  group: string;
  countryCount: number;
  stats: Distribution;
  // The extremes within the group — what makes a breakdown explorable rather
  // than just a bar chart.
  top: { country: string; value: number };
  bottom: { country: string; value: number };
}

export interface BreakdownResult {
  dimension: BreakdownDimension;
  indicator: string;
  year: number;
  groups: BreakdownGroup[];
  countriesUsed: number;
  aggregatesExcluded: number;
  unclassified: number;
}

// Group countries by World Bank region or income group at one year and describe
// each group. `year` defaults to the latest usable year from profileSeries, so
// a breakdown is never accidentally computed on a near-empty final year.
export function breakdown(
  rows: DataRow[],
  dimension: BreakdownDimension,
  opts: { indicator?: string; year?: number } = {}
): BreakdownResult | null {
  const pool = opts.indicator ? rows.filter((r) => r.indicator === opts.indicator) : rows;
  if (!pool.length) return null;

  let year = opts.year;
  if (year === undefined) {
    const prof = profileSeries(pool, opts.indicator);
    if (!prof || prof.latestUsableYear === null) return null;
    year = prof.latestUsableYear;
  }

  const atYear = pool.filter((r) => r.year === year && r.value !== null);
  const real = atYear.filter((r) => isRealCountry(r.iso3));
  const aggregatesExcluded = atYear.length - real.length;

  const buckets = new Map<string, { country: string; value: number }[]>();
  let unclassified = 0;
  for (const r of real) {
    const meta = META.get(r.iso3);
    const key = dimension === 'region' ? meta?.region : meta?.income;
    if (!key) { unclassified++; continue; }
    const list = buckets.get(key) || [];
    list.push({ country: r.country, value: r.value as number });
    buckets.set(key, list);
  }
  if (!buckets.size) return null;

  const groups: BreakdownGroup[] = [];
  for (const [group, list] of buckets) {
    const stats = describe(list.map((x) => x.value));
    if (!stats) continue;
    const sorted = [...list].sort((a, b) => b.value - a.value);
    groups.push({
      group,
      countryCount: list.length,
      stats,
      top: sorted[0],
      bottom: sorted[sorted.length - 1],
    });
  }
  // Ranked by median: the ordering a reader wants, and the ordering that makes
  // the gap between groups legible.
  groups.sort((a, b) => b.stats.median - a.stats.median);

  return {
    dimension,
    indicator: opts.indicator ?? (pool[0].indicator || 'series'),
    year,
    groups,
    countriesUsed: real.length - unclassified,
    aggregatesExcluded,
    unclassified,
  };
}

// ── Model-facing rendering ───────────────────────────────────────────────────
// The tools hand the model compact text rather than raw JSON: it is what the
// model reads best, it keeps the context small, and it lets the wording carry
// the caveats (excluded aggregates, patchy coverage) that a bare number would
// drop. Pure and tested, so the caveats can't silently disappear.

const n1 = (x: number): string =>
  !Number.isFinite(x) ? '—'
  : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US')
  : Math.abs(x) >= 10 ? x.toFixed(1)
  : x.toFixed(2);

export function formatProfile(p: SeriesProfile): string {
  const lines: string[] = [];
  lines.push(
    `PROFILE of ${p.indicator}: ${p.rowCount} rows, ${p.countryCount} countries, ${p.yearStart}–${p.yearEnd}.`
  );
  if (p.aggregatesExcluded > 0) {
    lines.push(`${p.aggregatesExcluded} aggregate rows (WLD, income/region aggregates) excluded from all statistics.`);
  }
  lines.push(`Missing: ${p.missingPct.toFixed(0)}% of country-year cells in that range have no value.`);
  if (p.latestUsableYear === null || !p.latest) {
    lines.push('No year has enough reporting countries to describe a distribution.');
    return lines.join('\n');
  }
  const d = p.latest;
  lines.push(
    `Latest well-reported year is ${p.latestUsableYear} (${d.n} countries). Distribution: ` +
      `min ${n1(d.min)}, Q1 ${n1(d.q1)}, median ${n1(d.median)}, Q3 ${n1(d.q3)}, max ${n1(d.max)}; ` +
      `mean ${n1(d.mean)}, sd ${n1(d.sd)}.`
  );
  if (p.latestUsableYear !== p.yearEnd) {
    lines.push(
      `NOTE: the data runs to ${p.yearEnd}, but ${p.latestUsableYear} is the last year with broad reporting — ` +
        `rank or compare on ${p.latestUsableYear}, not ${p.yearEnd}.`
    );
  }
  if (p.outliers.length) {
    lines.push(
      'Outliers (beyond 1.5×IQR): ' +
        p.outliers.map((o) => `${o.country} ${n1(o.value)} (${o.side})`).join(', ') + '.'
    );
  } else {
    lines.push('No countries fall outside 1.5×IQR — the spread is unremarkable.');
  }
  return lines.join('\n');
}

export function formatBreakdown(b: BreakdownResult): string {
  const label = b.dimension === 'region' ? 'World Bank region' : 'World Bank income group';
  const lines: string[] = [];
  lines.push(`${b.indicator} by ${label}, ${b.year} (${b.countriesUsed} countries, ranked by median):`);
  for (const g of b.groups) {
    lines.push(
      `- ${g.group}: median ${n1(g.stats.median)} (n=${g.countryCount}, ` +
        `range ${n1(g.stats.min)}–${n1(g.stats.max)}); highest ${g.top.country} ${n1(g.top.value)}, ` +
        `lowest ${g.bottom.country} ${n1(g.bottom.value)}`
    );
  }
  if (b.groups.length > 1) {
    const hi = b.groups[0];
    const lo = b.groups[b.groups.length - 1];
    const ratio = lo.stats.median !== 0 ? hi.stats.median / lo.stats.median : NaN;
    lines.push(
      `Gap: ${hi.group} median is ${Number.isFinite(ratio) ? n1(ratio) + '×' : 'not comparable'} ` +
        `${lo.group} (${n1(hi.stats.median)} vs ${n1(lo.stats.median)}).`
    );
  }
  const notes: string[] = [];
  if (b.aggregatesExcluded > 0) notes.push(`${b.aggregatesExcluded} aggregate rows excluded`);
  if (b.unclassified > 0) notes.push(`${b.unclassified} countries had no ${b.dimension} classification`);
  if (notes.length) lines.push('(' + notes.join('; ') + '.)');
  return lines.join('\n');
}

// A breakdown is naturally a bar chart: one bar per group, median on the y
// axis. Returned as chart-spec series data so the caller can render it without
// the model having to retype the numbers it was just given.
export function breakdownChartData(b: BreakdownResult): [string, number][] {
  return b.groups.map((g) => [g.group, Number(g.stats.median.toFixed(4))]);
}
