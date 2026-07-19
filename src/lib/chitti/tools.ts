// tools.ts — the tools the deep-agent can call. Each is a plain async
// function; the agent loop dispatches to them by name. All network access
// is a direct browser fetch to the World Bank Open Data API (CORS: *).

import type { ToolSchema } from './providers';
import countriesData from '../../data/worldbank/countries.json';
import indicatorsData from '../../data/worldbank/indicators.json';

export interface Country {
  id: string; // ISO3
  iso2: string;
  name: string;
  region: string;
  income: string;
}

export interface Indicator {
  id: string;
  name: string;
  topic: string;
}

export interface DataRow {
  country: string; // display name
  iso3: string;
  year: number;
  value: number | null;
  // Which indicator/dataset this row belongs to. Plain World Bank id
  // (e.g. "SH.DYN.MORT"), or namespaced "owid:<slug>" / "imf:<id>".
  // Lets execute_js and the analysis helpers separate rows when the
  // session holds data from more than one fetch.
  indicator?: string;
}

// Chart spec the agent builds and the renderer consumes.
export interface ChartSpec {
  type: 'line' | 'bar' | 'scatter' | 'grouped-bar';
  title: string;
  x_axis?: string;
  y_axis?: string;
  series: { name: string; data: [number | string, number][] }[];
}

export const COUNTRIES = countriesData as Country[];

// Flatten the topic-keyed indicators file into a single searchable list.
export const INDICATORS: Indicator[] = (() => {
  const out: Indicator[] = [];
  const raw = indicatorsData as Record<string, [string, string][]>;
  for (const topic of Object.keys(raw)) {
    for (const [id, name] of raw[topic]) {
      out.push({ id, name, topic });
    }
  }
  return out;
})();

export const TOPICS = Object.keys(indicatorsData as Record<string, unknown>);

// ── Virtual filesystem ──────────────────────────────────────────────────
// An in-memory Record<string,string> the agent writes intermediate artifacts
// into. The UI mirrors this so the "deep agent" is visible as it works.
export class VFS {
  files: Record<string, string> = {};
  private onChange?: (files: Record<string, string>) => void;

  constructor(onChange?: (files: Record<string, string>) => void) {
    this.onChange = onChange;
  }
  write(path: string, content: string): void {
    this.files[path] = content;
    this.onChange?.({ ...this.files });
  }
  read(path: string): string {
    return this.files[path] ?? '';
  }
  list(): string[] {
    return Object.keys(this.files);
  }
}

// ── Tool implementations ─────────────────────────────────────────────────
const WB = 'https://api.worldbank.org/v2';

// search_indicators: filter the curated list; if <3 hits, hit the WB search API.
export async function searchIndicators(query: string, topic?: string): Promise<Indicator[]> {
  const q = (query || '').toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  let pool = INDICATORS;
  if (topic) {
    const t = topic.toLowerCase();
    pool = pool.filter((i) => i.topic.toLowerCase().includes(t));
  }
  const scored = pool
    .map((i) => {
      const hay = (i.name + ' ' + i.id).toLowerCase();
      const score = terms.reduce((s, term) => s + (hay.includes(term) ? 1 : 0), 0);
      return { i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);

  if (scored.length >= 3) return scored.slice(0, 12);

  // Fall back to the live World Bank indicator search API for breadth.
  try {
    const url =
      `${WB}/indicator?format=json&per_page=25&source=2&search=` +
      encodeURIComponent(q);
    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const rows: any[] = Array.isArray(data) && data.length > 1 && Array.isArray(data[1]) ? data[1] : [];
      const live: Indicator[] = rows
        .map((r) => ({ id: r.id as string, name: (r.name as string) || '', topic: 'World Bank' }))
        .filter((r) => r.id && r.name);
      const merged = [...scored, ...live];
      const seen = new Set<string>();
      const dedup = merged.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
      return dedup.slice(0, 12);
    }
  } catch {
    /* offline / blocked — return what we have */
  }
  return scored.slice(0, 12);
}

export type CountryFilter = 'all' | 'oecd' | string;

// A small OECD membership list (ISO3), enough for common comparisons.
const OECD = new Set([
  'AUS','AUT','BEL','CAN','CHL','COL','CRI','CZE','DNK','EST','FIN','FRA','DEU','GRC','HUN','ISL',
  'IRL','ISR','ITA','JPN','KOR','LVA','LTU','LUX','MEX','NLD','NZL','NOR','POL','PRT','SVK','SVN',
  'ESP','SWE','CHE','TUR','GBR','USA',
]);

export function listCountries(filter?: CountryFilter): Country[] {
  if (!filter || filter === 'all') {
    // Exclude aggregates by default so "list countries" means real countries.
    return COUNTRIES.filter((c) => c.region !== 'Aggregates');
  }
  if (filter === 'oecd') return COUNTRIES.filter((c) => OECD.has(c.id));
  const f = filter.toLowerCase();
  // Match against region name (real countries) or aggregate name.
  return COUNTRIES.filter(
    (c) => c.region.toLowerCase().includes(f) || c.name.toLowerCase().includes(f)
  );
}

// fetch_worldbank: the actual API call. Multi-country uses ';' separator
// (the WB API rejects comma-separated ISO3 lists). Cap at ~60 countries
// per call, matching the API's practical multi-country limit. Truncation
// is reported back (`truncatedFrom`) rather than silently dropped — the
// model has no other way to know its country_ids list was cut, and would
// otherwise report findings over an incomplete country set with no signal
// anything was missing.
export interface FetchWorldbankResult {
  rows: DataRow[];
  // Original requested country count, only set when it exceeded the 60-per-
  // call cap and was truncated. Undefined when no truncation occurred.
  truncatedFrom?: number;
}

export async function fetchWorldbank(
  indicatorId: string,
  countryIds: string[],
  yearStart: number,
  yearEnd: number
): Promise<FetchWorldbankResult> {
  const cleanIds = countryIds.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const truncatedFrom = cleanIds.length > 60 ? cleanIds.length : undefined;
  const codes = cleanIds.slice(0, 60).join(';');
  // Semicolons must stay literal in the path segment; only the indicator id
  // needs escaping (WB ids are dot-delimited alnum, so this is a no-op in
  // practice, but keeps us safe).
  const url =
    `${WB}/country/${codes}/indicator/${encodeURIComponent(indicatorId)}` +
    `?format=json&date=${yearStart}:${yearEnd}&per_page=2000`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('World Bank API HTTP ' + resp.status);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) {
    const msg = Array.isArray(data) && data[0]?.message?.[0]?.value;
    throw new Error('World Bank API: ' + (msg || 'no data returned'));
  }
  const rows: DataRow[] = (data[1] as any[]).map((r) => ({
    country: r.country?.value ?? r.countryiso3code,
    iso3: r.countryiso3code,
    year: parseInt(r.date, 10),
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    indicator: indicatorId,
  }));
  // Sort by country then year ascending for stable downstream use.
  rows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows, truncatedFrom };
}

// fetch_worldbank_all: every real country for one indicator, batched and
// merged internally — no LLM reasoning about country counts, batch math, or
// "did I already fetch this" required. Exists specifically because letting
// the model own list_countries + manual 60-per-call batching burned a huge
// reasoning turn re-deriving batch counts and re-verifying its own country
// list mid-run (observed directly: an 18k+ token turn spent second-guessing
// whether it had already fetched all ~195 countries). This tool answers
// "give me every country for this indicator" as one deterministic call.
export interface FetchWorldbankAllResult {
  rows: DataRow[];
  countryCount: number;
  batchCount: number;
}

export async function fetchWorldbankAll(
  indicatorId: string,
  yearStart: number,
  yearEnd: number
): Promise<FetchWorldbankAllResult> {
  const countries = listCountries('all');
  const ids = countries.map((c) => c.id);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 60) batches.push(ids.slice(i, i + 60));

  // Sequential, not parallel — a burst of ~4 simultaneous requests to the
  // World Bank's public API is an unnecessary way to invite rate-limiting
  // for a request that isn't latency-critical (this whole call already
  // replaces what used to be several separate LLM-driven round-trips).
  const allRows: DataRow[] = [];
  for (const batch of batches) {
    const { rows } = await fetchWorldbank(indicatorId, batch, yearStart, yearEnd);
    allRows.push(...rows);
  }
  allRows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows: allRows, countryCount: ids.length, batchCount: batches.length };
}

// ── Additional sources: Our World in Data + IMF DataMapper ──────────────
// Both are free, keyless, browser-fetchable APIs. Curated catalogs (like
// the World Bank indicators.json) rather than live search: the model
// searches a known-good list, so it can't invent slugs that 404.

export interface Dataset {
  id: string; // namespaced: "owid:<slug>" or "imf:<code>"
  name: string;
  source: 'owid' | 'imf';
  note?: string;
}

// OWID grapher slugs — each serves CSV at ourworldindata.org/grapher/<slug>.csv
const OWID_DATASETS: [string, string][] = [
  ['life-expectancy', 'Life expectancy at birth (years)'],
  ['child-mortality', 'Child mortality rate (under-5, per 100 live births)'],
  ['population', 'Population'],
  ['gdp-per-capita-worldbank', 'GDP per capita (international-$, PPP)'],
  ['human-development-index', 'Human Development Index (HDI)'],
  ['happiness-cantril-ladder', 'Self-reported life satisfaction (Cantril ladder, 0-10)'],
  ['co-emissions-per-capita', 'CO2 emissions per capita (tonnes)'],
  ['annual-co2-emissions-per-country', 'Annual CO2 emissions (tonnes)'],
  ['share-electricity-renewables', 'Share of electricity from renewables (%)'],
  ['share-of-individuals-using-the-internet', 'Share of population using the internet (%)'],
  ['cross-country-literacy-rates', 'Literacy rate (%)'],
  ['homicide-rate-unodc', 'Homicide rate (per 100,000 people)'],
  ['share-of-population-in-extreme-poverty', 'Share of population in extreme poverty (%)'],
  ['daily-per-capita-caloric-supply', 'Daily supply of calories per person (kcal)'],
];

// IMF DataMapper codes — JSON at imf.org/external/datamapper/api/v1/<code>.
// Distinctive value: includes IMF FORECASTS several years ahead.
const IMF_DATASETS: [string, string][] = [
  ['NGDP_RPCH', 'Real GDP growth (annual %, incl. IMF forecasts)'],
  ['NGDPDPC', 'GDP per capita, current prices (US$, incl. forecasts)'],
  ['PCPIPCH', 'Inflation rate, average consumer prices (annual %, incl. forecasts)'],
  ['LUR', 'Unemployment rate (% of labor force, incl. forecasts)'],
  ['GGXWDG_NGDP', 'General government gross debt (% of GDP, incl. forecasts)'],
  ['BCA_NGDPD', 'Current account balance (% of GDP, incl. forecasts)'],
];

export const DATASETS: Dataset[] = [
  ...OWID_DATASETS.map(([slug, name]): Dataset => ({ id: 'owid:' + slug, name, source: 'owid' })),
  ...IMF_DATASETS.map(([code, name]): Dataset => ({ id: 'imf:' + code, name, source: 'imf' })),
];

// `allow` restricts results to a subset of catalog sources — used when the
// user has hard-filtered the active databases, so an OWID-only session never
// sees IMF datasets (and vice-versa) even though both share this one tool.
export function searchDatasets(query: string, allow?: Dataset['source'][]): Dataset[] {
  const allowSet = allow && allow.length ? new Set(allow) : null;
  const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return DATASETS.filter((d) => !allowSet || allowSet.has(d.source))
    .map((d) => {
      const hay = (d.name + ' ' + d.id).toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d)
    .slice(0, 10);
}

// Friendly name for any indicator id, across all three sources.
export function datasetName(id: string): string | undefined {
  return DATASETS.find((d) => d.id === id)?.name;
}

// Minimal CSV parser: handles quoted cells (OWID entity names contain
// commas, e.g. "Korea, Rep."). Good enough for machine-generated CSV.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// fetch_owid: CSV from the OWID grapher. Columns: Entity, Code, Year,
// <metric...>. First metric column is the value. Aggregates like World use
// OWID_WRL codes; rows with no code (subregions) are dropped.
export async function fetchOwid(
  slug: string,
  countryIds?: string[],
  yearStart?: number,
  yearEnd?: number
): Promise<{ rows: DataRow[]; metric: string }> {
  const clean = slug.replace(/^owid:/, '');
  const url = `https://ourworldindata.org/grapher/${encodeURIComponent(clean)}.csv?csvType=full`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err: any) {
    throw new Error(
      `OWID fetch failed (${err?.message ?? err}). If this is a CORS block, use fetch_worldbank for this question instead.`
    );
  }
  if (!resp.ok) throw new Error(`OWID API HTTP ${resp.status} for slug "${clean}" — the slug may be wrong; use search_datasets results verbatim.`);
  const text = await resp.text();
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) throw new Error('OWID: empty dataset');
  const header = parseCsvLine(lines[0]);
  const metric = header[3] || clean;
  const want = countryIds?.length
    ? new Set(countryIds.map((c) => c.trim().toUpperCase()))
    : null;
  const rows: DataRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const code = (cells[1] || '').toUpperCase();
    if (!code) continue; // regions without ISO codes
    if (want && !want.has(code)) continue;
    const year = parseInt(cells[2], 10);
    if (Number.isNaN(year)) continue;
    if (yearStart !== undefined && year < yearStart) continue;
    if (yearEnd !== undefined && year > yearEnd) continue;
    const v = cells[3];
    rows.push({
      country: cells[0],
      iso3: code,
      year,
      value: v === '' || v === undefined ? null : Number(v),
      indicator: 'owid:' + clean,
    });
  }
  rows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows, metric };
}

// fetch_imf: IMF DataMapper JSON. Shape:
// { values: { <code>: { <ISO3>: { "<year>": value } } } }
// Includes projection years beyond today — that's the point of this source.
export async function fetchImf(
  code: string,
  countryIds?: string[],
  yearStart?: number,
  yearEnd?: number
): Promise<{ rows: DataRow[] }> {
  const clean = code.replace(/^imf:/, '').toUpperCase();
  const path = countryIds?.length
    ? `${clean}/${countryIds.map((c) => c.trim().toUpperCase()).join('/')}`
    : clean;
  const url = `https://www.imf.org/external/datamapper/api/v1/${path}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err: any) {
    throw new Error(
      `IMF fetch failed (${err?.message ?? err}). If this is a CORS block, fall back to fetch_worldbank (no forecasts, but similar historical macro data).`
    );
  }
  if (!resp.ok) throw new Error(`IMF API HTTP ${resp.status} for code "${clean}"`);
  const data = await resp.json();
  const byCountry: Record<string, Record<string, number>> = data?.values?.[clean] ?? {};
  const nameOf = (iso3: string) => COUNTRIES.find((c) => c.id === iso3)?.name ?? iso3;
  const rows: DataRow[] = [];
  for (const iso3 of Object.keys(byCountry)) {
    // DataMapper mixes countries with regional aggregates (3-letter but not
    // ISO); keep everything — aggregates are useful and clearly named.
    for (const [yearStr, value] of Object.entries(byCountry[iso3])) {
      const year = parseInt(yearStr, 10);
      if (Number.isNaN(year)) continue;
      if (yearStart !== undefined && year < yearStart) continue;
      if (yearEnd !== undefined && year > yearEnd) continue;
      rows.push({
        country: nameOf(iso3),
        iso3,
        year,
        value: value === null || value === undefined ? null : Number(value),
        indicator: 'imf:' + clean,
      });
    }
  }
  rows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows };
}

// ── Analysis helpers ─────────────────────────────────────────────────────
// Deterministic implementations of the two computations behind most
// "insight" sentences, so the model gets them in one cheap call instead of
// writing (and possibly fumbling) the JS itself. execute_js remains for
// everything bespoke.

export interface GrowthStat {
  iso3: string;
  country: string;
  firstYear: number;
  firstValue: number;
  lastYear: number;
  lastValue: number;
  absChange: number;
  pctChange: number | null; // null when firstValue is 0
  cagr: number | null; // % per year; null when not computable
}

export function growthStats(rows: DataRow[], indicator?: string): GrowthStat[] {
  const pool = indicator ? rows.filter((r) => r.indicator === indicator) : rows;
  const byCountry: Record<string, DataRow[]> = {};
  for (const r of pool) if (r.value !== null) (byCountry[r.iso3] ??= []).push(r);
  const out: GrowthStat[] = [];
  for (const iso3 of Object.keys(byCountry)) {
    const rs = byCountry[iso3].sort((a, b) => a.year - b.year);
    if (rs.length < 2) continue;
    const first = rs[0];
    const last = rs[rs.length - 1];
    const years = last.year - first.year;
    const fv = first.value as number;
    const lv = last.value as number;
    out.push({
      iso3,
      country: first.country,
      firstYear: first.year,
      firstValue: fv,
      lastYear: last.year,
      lastValue: lv,
      absChange: lv - fv,
      pctChange: fv === 0 ? null : ((lv - fv) / Math.abs(fv)) * 100,
      cagr: fv > 0 && lv > 0 && years > 0 ? (Math.pow(lv / fv, 1 / years) - 1) * 100 : null,
    });
  }
  return out.sort((a, b) => b.absChange - a.absChange);
}

export interface CorrelationResult {
  r: number | null;
  n: number;
  year: number | null;
  note?: string;
}

// Pearson correlation across countries between two indicators, matched by
// ISO3 at one year (given, or the latest year both indicators share).
export function correlate(
  rows: DataRow[],
  indicatorA: string,
  indicatorB: string,
  year?: number
): CorrelationResult {
  const a = rows.filter((r) => r.indicator === indicatorA && r.value !== null);
  const b = rows.filter((r) => r.indicator === indicatorB && r.value !== null);
  if (!a.length || !b.length) {
    return { r: null, n: 0, year: null, note: 'one or both indicators have no fetched rows — fetch them first' };
  }
  let y = year;
  if (y === undefined) {
    const yearsA = new Set(a.map((r) => r.year));
    const shared = [...new Set(b.map((r) => r.year))].filter((yy) => yearsA.has(yy));
    if (!shared.length) return { r: null, n: 0, year: null, note: 'no overlapping years between the two indicators' };
    y = Math.max(...shared);
  }
  const mapA = new Map(a.filter((r) => r.year === y).map((r) => [r.iso3, r.value as number]));
  const pairs: [number, number][] = [];
  for (const r of b) {
    if (r.year === y && mapA.has(r.iso3)) pairs.push([mapA.get(r.iso3) as number, r.value as number]);
  }
  const n = pairs.length;
  if (n < 3) return { r: null, n, year: y, note: 'fewer than 3 matched countries at this year' };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (const [x, yv] of pairs) {
    num += (x - mx) * (yv - my);
    dx += (x - mx) ** 2;
    dy += (yv - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return { r: denom === 0 ? null : num / denom, n, year: y };
}

// execute_js: the model writes real JS to rank/diff/filter/aggregate the
// fetched rows, instead of doing that arithmetic by reasoning through
// numbers in natural language turns (observed directly: manually comparing
// ~190 countries' reduction values in reasoning text is slow, expensive, and
// error-prone). No fixed menu of operations — the model expresses whatever
// computation the question actually needs as code.
//
// Sandboxing note: this uses `new Function`, not a real VM (no
// quickjs-emscripten/WASM) — deliberately, to avoid a ~1.3MB dependency in a
// browser-only static site. The executed code's only argument is `rows`; it
// has no reference to anything else in this module's scope (Function bodies
// close over nothing but their own global scope, not the enclosing
// function's locals), so it cannot reach the VFS, the API key, or other
// module state. It CAN reach `window`/`fetch`/etc. like any other page
// script, so this is not a security boundary against malicious code — it's
// proportionate here because the executed code is written by the same
// model the user is already trusting to answer their question, operating on
// public World Bank data it just fetched, in the user's own tab. There is
// no execution timeout: a synchronous `new Function` call cannot be
// interrupted from the same thread. An infinite loop would hang this run
// the same way a broken tool-calling loop already could; a hard timeout
// would require moving execution to a Worker, which is more machinery than
// this risk currently justifies.
export interface ExecuteJsResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function executeJs(code: string, rows: DataRow[]): ExecuteJsResult {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('rows', code);
    const result = fn(rows);
    // Force through JSON so the result is always plain, serializable data —
    // matches every other tool's result shape and guards against the code
    // accidentally returning something (a DOM node, a class instance) that
    // can't be shown back to the model as a string.
    return { ok: true, result: JSON.parse(JSON.stringify(result ?? null)) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// Build CSV from data rows for the download button.
export function rowsToCSV(rows: DataRow[]): string {
  const multi = new Set(rows.map((r) => r.indicator ?? '')).size > 1;
  const header = multi ? 'indicator,country,iso3,year,value' : 'country,iso3,year,value';
  const body = rows
    .map((r) =>
      (multi ? `${csvCell(r.indicator ?? '')},` : '') +
      `${csvCell(r.country)},${r.iso3},${r.year},${r.value ?? ''}`
    )
    .join('\n');
  return header + '\n' + body;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ── Tool schemas exposed to the model ────────────────────────────────────
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'search_indicators',
    description:
      'Search World Bank indicators by keyword. Returns matching indicator ids and names. ' +
      'Prefer the curated set; falls back to a live World Bank search when few curated matches exist.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "child mortality" or "GDP per capita"' },
        topic: { type: 'string', description: 'Optional topic filter, e.g. "Health", "Economy"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_countries',
    description:
      'List countries/aggregates. filter="all" for real countries, "oecd" for OECD members, ' +
      'or a region name substring (e.g. "Sub-Saharan Africa", "Europe"). Returns ISO3 ids and names.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'all | oecd | region name substring' },
      },
    },
  },
  {
    name: 'fetch_worldbank',
    description:
      'Fetch time-series data for one indicator across specific countries (by ISO3 code) or one ' +
      'aggregate (e.g. "WLD" for world, a region aggregate id). Returns rows of ' +
      '{country, iso3, year, value}. country_ids MUST be an explicit, non-empty list — there is ' +
      'no wildcard, an empty array returns no data. Max 60 country_ids per call. ' +
      'Do NOT use this for "every country" questions — call fetch_worldbank_all instead, which ' +
      'handles the full country list and batching internally in one call.',
    parameters: {
      type: 'object',
      properties: {
        indicator_id: { type: 'string', description: 'World Bank indicator id, e.g. SH.DYN.MORT' },
        country_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Non-empty array of specific ISO3 codes, e.g. ["IND","CHN","BRA"], or one aggregate ' +
            'id like ["WLD"] for world. Max 60 per call. For "all countries", use ' +
            'fetch_worldbank_all instead of building this list yourself.',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['indicator_id', 'country_ids', 'year_start', 'year_end'],
    },
  },
  {
    name: 'fetch_worldbank_all',
    description:
      'Fetch time-series data for one indicator across EVERY real country in one call. Use this ' +
      'instead of list_countries + fetch_worldbank whenever the question is about "all countries", ' +
      '"which countries...", "every country", or similar — it resolves the full country list and ' +
      'batches the underlying requests internally, so you never need to reason about country ' +
      'counts, batch sizes, or merging results yourself. Returns rows of ' +
      '{country, iso3, year, value} for every country with data.',
    parameters: {
      type: 'object',
      properties: {
        indicator_id: { type: 'string', description: 'World Bank indicator id, e.g. SH.DYN.MORT' },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['indicator_id', 'year_start', 'year_end'],
    },
  },
  {
    name: 'write_file',
    description: 'Write an intermediate artifact to the virtual filesystem (visible to the user).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. plan.md, indicator_shortlist.json' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a previously written artifact from the virtual filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'execute_js',
    description:
      'Run JavaScript against the data you already fetched, to compute a ranking/reduction/' +
      'comparison/aggregate — instead of reasoning through the numbers by hand. Your code ' +
      'receives one argument, `rows`, an array of {country, iso3, year, value, indicator} objects ' +
      '(the combined result of every fetch call so far, across all sources; filter by the ' +
      '`indicator` field when you have data from more than one). Whatever your ' +
      'code returns is sent back to you as the result — return the exact ranked/computed array ' +
      'or object you need for the chart or the finding, not intermediate steps. Use this for ' +
      'anything that requires comparing across many rows: top-N by change, percentage change, ' +
      'filtering to the latest year per country, grouping by region, etc. Do not manually rank ' +
      'or diff more than a couple of countries in your own reasoning — write code instead.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'A JS function body (no wrapping function declaration) that uses `rows` and ends ' +
            'with a return statement, e.g. "const byCountry = {}; for (const r of rows) {...}; ' +
            'return Object.values(byCountry).sort(...).slice(0, 15);"',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'search_datasets',
    description:
      'Search the non-World-Bank catalogs: Our World in Data (health, CO2/energy, happiness, HDI, ' +
      'poverty, literacy) and IMF DataMapper (macro data INCLUDING FORECASTS several years ahead — ' +
      'GDP growth, inflation, unemployment, government debt). Returns dataset ids ("owid:<slug>" ' +
      'or "imf:<code>") and names. Use the returned id verbatim with fetch_owid / fetch_imf. ' +
      'Prefer World Bank (search_indicators) for standard development indicators; come here for ' +
      'topics it lacks or when the question needs projections/forecasts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "co2 emissions", "inflation forecast", "happiness"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_owid',
    description:
      'Fetch an Our World in Data dataset (id from search_datasets, "owid:<slug>"). Returns rows ' +
      'of {country, iso3, year, value, indicator}. Omit country_ids for every country. Use ' +
      '"OWID_WRL" as a country id for the world aggregate.',
    parameters: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'e.g. "owid:life-expectancy" (verbatim from search_datasets)' },
        country_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional ISO3 codes to filter to; omit for all countries.',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['dataset_id'],
    },
  },
  {
    name: 'fetch_imf',
    description:
      'Fetch an IMF DataMapper series (id from search_datasets, "imf:<code>"). THE source for ' +
      'forecasts: series extend several years beyond today as IMF projections — say so in the ' +
      'finding when you use projected years. Returns rows of {country, iso3, year, value, ' +
      'indicator}. Omit country_ids for all countries.',
    parameters: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'e.g. "imf:NGDP_RPCH" (verbatim from search_datasets)' },
        country_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional ISO3 codes; omit for all countries.',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['dataset_id'],
    },
  },
  {
    name: 'growth_stats',
    description:
      'Compute per-country change statistics over the data you already fetched: first/last value, ' +
      'absolute change, percent change, and CAGR, sorted by absolute change. One cheap call that ' +
      'replaces hand-written ranking code for "which countries grew/fell the most" questions and ' +
      'is a fast way to FIND the insight (outliers, surprising risers/fallers) before finishing.',
    parameters: {
      type: 'object',
      properties: {
        indicator_id: {
          type: 'string',
          description: 'Restrict to one indicator id (recommended when multiple were fetched).',
        },
      },
    },
  },
  {
    name: 'correlate',
    description:
      'Pearson correlation across countries between two already-fetched indicators, matched by ' +
      'country at one year (given, or the latest year both share). Use for "is X related to Y" ' +
      'questions and to strengthen findings with a relationship the chart alone does not show. ' +
      'Returns {r, n, year}. Both indicators must be fetched first.',
    parameters: {
      type: 'object',
      properties: {
        indicator_a: { type: 'string', description: 'First indicator id (as stored on rows, e.g. "SP.DYN.LE00.IN" or "owid:life-expectancy")' },
        indicator_b: { type: 'string', description: 'Second indicator id' },
        year: { type: 'number', description: 'Optional; defaults to latest shared year.' },
      },
      required: ['indicator_a', 'indicator_b'],
    },
  },
  {
    name: 'render_chart',
    description:
      'Render the final chart. Provide a spec with a chart type, title, axis labels, and series. ' +
      'Each series has a name and an array of [x, y] pairs (x = year for line/scatter, or category label for bar). ' +
      'Returns "rendered".',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['line', 'bar', 'scatter', 'grouped-bar'] },
        title: { type: 'string' },
        x_axis: { type: 'string' },
        y_axis: { type: 'string' },
        series: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              data: {
                type: 'array',
                items: { type: 'array', items: {} },
                description: 'Array of [x, y] pairs',
              },
            },
            required: ['name', 'data'],
          },
        },
      },
      required: ['type', 'title', 'series'],
    },
  },
  {
    name: 'finish',
    description:
      'Signal completion with the insight: the top-line result (with its concrete number) plus, ' +
      'when the data supports it, one sentence on what is genuinely notable — the outlier, the ' +
      'trend break, or what it implies. Max two sentences. No methodology, no caveats.',
    parameters: {
      type: 'object',
      properties: {
        one_line_finding: {
          type: 'string',
          description: 'The insight: 1-2 tight sentences with a concrete number, not a chart caption.',
        },
      },
      required: ['one_line_finding'],
    },
  },
  {
    name: 'finish_explanation',
    description:
      'End this turn with a prose explanation only, no chart. Use this when the user asked you ' +
      'to explain, describe, interpret, or summarize data you already have in words, rather than ' +
      'asking for a new or different chart. Do not call render_chart in a turn that ends with ' +
      'this tool.',
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'The prose answer to the user\'s question.' },
      },
      required: ['explanation'],
    },
  },
];

// ── Source registry ──────────────────────────────────────────────────────
// The single source of truth for "which databases exist". One entry per
// database feeds BOTH the UI picker (label + blurb) and the agent (which
// tools + prompt guidance + citation the model gets). Adding a database =
// add its fetch fn + tool schema above, then one entry here — it then shows
// up as a user-selectable chip and becomes available to the agent, nothing
// else to wire.

export interface SourceDef {
  id: string;
  label: string;
  blurb: string; // one line, shown under the chip in the picker
  // Tool names (from TOOL_SCHEMAS) this source owns. A tool may be shared by
  // more than one source (search_datasets serves both OWID and IMF); it is
  // offered whenever any owning source is selected.
  toolNames: string[];
  // How the model should use this source — spliced into the system prompt's
  // "pick a source" step only when this source is active.
  promptSnippet: string;
  cite: { name: string; url: string };
  // OWID/IMF share search_datasets; this maps the source to its catalog tag
  // so an active-source filter can be pushed into searchDatasets(). Omit for
  // sources (like World Bank) that don't use the shared dataset catalog.
  datasetSource?: Dataset['source'];
}

// Source-agnostic tools: control flow, computation over already-fetched rows,
// and country lookup. Always available regardless of which databases are on.
export const CORE_TOOL_NAMES = [
  'list_countries', 'execute_js', 'growth_stats', 'correlate',
  'render_chart', 'finish', 'finish_explanation', 'write_file', 'read_file',
];

export const SOURCES: SourceDef[] = [
  {
    id: 'worldbank',
    label: 'World Bank',
    blurb: 'Development, economic, health & social indicators for every country.',
    toolNames: ['search_indicators', 'fetch_worldbank', 'fetch_worldbank_all'],
    promptSnippet:
      'World Bank (search_indicators → fetch_worldbank / fetch_worldbank_all): the broad default — development, economic, health, and social indicators. Use fetch_worldbank with explicit ISO3 codes (or one aggregate like WLD); use fetch_worldbank_all for "every country" questions (it batches internally — never build the full country list yourself).',
    cite: { name: 'World Bank Open Data', url: 'https://data.worldbank.org' },
  },
  {
    id: 'owid',
    label: 'Our World in Data',
    blurb: 'CO₂ & energy, happiness, HDI, literacy, extreme poverty.',
    toolNames: ['search_datasets', 'fetch_owid'],
    promptSnippet:
      'Our World in Data (search_datasets → fetch_owid): topics World Bank lacks — CO2/energy, happiness, HDI, literacy, extreme poverty.',
    cite: { name: 'Our World in Data', url: 'https://ourworldindata.org' },
    datasetSource: 'owid',
  },
  {
    id: 'imf',
    label: 'IMF',
    blurb: 'Macro data with multi-year forecasts: GDP, inflation, debt.',
    toolNames: ['search_datasets', 'fetch_imf'],
    promptSnippet:
      'IMF DataMapper (search_datasets → fetch_imf): the source for forecasts/projections several years ahead — GDP growth, inflation, unemployment, government debt. Say "IMF projection" when you use projected years.',
    cite: { name: 'IMF DataMapper', url: 'https://www.imf.org/external/datamapper' },
    datasetSource: 'imf',
  },
];

export const DEFAULT_SOURCE_IDS = SOURCES.map((s) => s.id);

// Normalize an incoming selection: keep only known ids; empty/unknown → all.
export function resolveSources(ids?: string[]): SourceDef[] {
  const known = new Set(DEFAULT_SOURCE_IDS);
  const picked = (ids ?? []).filter((id) => known.has(id));
  const chosen = picked.length ? picked : DEFAULT_SOURCE_IDS;
  return SOURCES.filter((s) => chosen.includes(s.id));
}

// The tool schemas the model should see for a given source selection: the
// always-on core plus every selected source's own tools, in original order.
export function schemasForSources(ids?: string[]): ToolSchema[] {
  const allowed = new Set(CORE_TOOL_NAMES);
  for (const s of resolveSources(ids)) for (const t of s.toolNames) allowed.add(t);
  return TOOL_SCHEMAS.filter((sch) => allowed.has(sch.name));
}

// The dataset-catalog sources (owid/imf) among a selection — pushed into
// searchDatasets so the shared catalog tool respects the hard filter.
export function datasetSourcesFor(ids?: string[]): Dataset['source'][] {
  return resolveSources(ids)
    .map((s) => s.datasetSource)
    .filter((x): x is Dataset['source'] => !!x);
}
