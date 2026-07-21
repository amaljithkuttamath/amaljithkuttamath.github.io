// tools.ts — the tools the deep-agent can call. Each is a plain async
// function; the agent loop dispatches to them by name. All network access
// is a direct browser fetch to the World Bank Open Data API (CORS: *).

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
// The VFS + its FileMeta provenance marker now live in ./vfs. Re-exported so
// every existing `import { VFS, type FileMeta } from './tools'` keeps working.
export { VFS, type FileMeta } from './vfs';

// ── Data sources: moved to ./sources ─────────────────────────────────────
// The per-source fetchers, curated catalogs, live-catalog search, error
// parsing, the source registry, and the cross-source search now live under
// ./sources (one adapter file per database + a generic ./sources/index).
// Re-exported here so every existing `import { ... } from './tools'` keeps
// working unchanged.
export * from './sources';
export {
  fetchWorldbank,
  fetchWorldbankAll,
  worldbankDateParam,
  parseWorldBankError,
  searchIndicators,
  type FetchWorldbankResult,
  type FetchWorldbankAllResult,
} from './sources/worldbank';
export { fetchOwid, parseOwidCatalog } from './sources/owid';
export { fetchImf, parseImfIndicators } from './sources/imf';
export { fetchWho, parseWhoIndicators } from './sources/who';

// ── Relevance scoring ────────────────────────────────────────────────────
// The one weighted scorer shared by every catalog now lives in ./scoring
// (SYNONYMS/STOPWORDS/explainMatch/scoreSeries). Re-exported so every existing
// `import { scoreSeries, explainMatch, type MatchExplanation } from './tools'`
// keeps working unchanged.
export { explainMatch, scoreSeries, type MatchExplanation } from './scoring';

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
// A STRUCTURED rejection from a data API: the request reached the API and it
// refused the given indicator/slug/code (a 200-with-error-body from the World
// Bank; a 404 from OWID/IMF/WHO). This is DISTINCT from a network/CORS failure
// (a plain Error), which never got an answer. The router (agent.ts routeFetch)
// translates an ApiRejection into a specific, model-recoverable steer ("call
// find_series"); a plain Error keeps its existing graceful-fallback wording, so
// genuine network failures are left alone and only structured rejections steer.
export class ApiRejection extends Error {
  readonly source: 'worldbank' | 'owid' | 'imf' | 'who';
  readonly indicatorId: string;
  readonly status?: number;
  // True when the id/parameter itself is what the API rejected (the World Bank
  // "provided parameter value is not valid" shape; an OWID/IMF/WHO not-found).
  readonly invalidParameter: boolean;
  constructor(
    source: ApiRejection['source'],
    indicatorId: string,
    opts: { message?: string; status?: number; invalidParameter?: boolean } = {}
  ) {
    super(opts.message || `${source} rejected "${indicatorId}"`);
    this.name = 'ApiRejection';
    this.source = source;
    this.indicatorId = indicatorId;
    this.status = opts.status;
    this.invalidParameter = opts.invalidParameter ?? true;
  }
}

// The CSV read/write helpers now live in ./csv. Imported for internal use by
// the OWID fetcher below, and re-exported (rowsToCSV) at the module's CSV
// section so `import { rowsToCSV } from './tools'` keeps working.

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

// The execute_js sandbox + its recursive-LM primitive type now live in
// ./execute-js. Re-exported so every existing `import { executeJs,
// type ExecuteJsResult, type LlmFn } from './tools'` keeps working.
export { executeJs, type ExecuteJsResult, type LlmFn } from './execute-js';

// rowsToCSV (+ its csvCell helper) now lives in ./csv. Re-exported so
// `import { rowsToCSV } from './tools'` keeps working.
export { rowsToCSV } from './csv';

// ── Citation ledger ──────────────────────────────────────────────────────
// A structured, first-class provenance record for one live fetch. Written at
// the fetch choke point (routeFetch), stored in session state keyed by the
// fetch-cache key, mirrored into the VFS as citations.json (via:'fetch'), and
// rendered by the UI's evidence section. Every field is captured verbatim from
// the fetch — nothing is reconstructed after the fact, so what the receipt (and
// the verifier) shows is exactly what happened. Model-derived (llm()) artifacts
// never produce a Citation: only fetched data gets one.
export interface Citation {
  // Stable id = the session fetch-cache key (id + resolved countries + range),
  // so a repeat/cached use maps to the SAME entry rather than a duplicate.
  id: string;
  source: 'worldbank' | 'owid' | 'imf' | 'who';
  sourceLabel: string; // friendly institution name, e.g. "World Bank Open Data"
  indicatorId: string; // the (normalized) series id
  indicatorName: string; // friendly indicator name when known, else the id
  // The human-visitable canonical page — this is what the citation LINKS to.
  url: string;
  // The exact API URL the data actually came from, only when it differs from
  // the human URL (they always do here). Kept for full traceability.
  requestUrl?: string;
  countries: string[]; // resolved ISO3 / aggregate codes ([] = every country)
  yearRange: { start?: number; end?: number } | null;
  fetchedAt: string; // ISO timestamp — when CHITTI fetched (not the vintage)
  // Data vintage from the source's own response (WB `lastupdated`), when the
  // source provides one. Omitted otherwise — never invented.
  sourceUpdated?: string;
  rowCount: number;
  // Whether the record's underlying fetch was a real network call. Always false
  // on the stored ledger entry (it IS the real fetch); a later cache hit reuses
  // this same entry and discloses "cached" only on that use's receipt.
  cached: boolean;
}

const CITATION_SOURCE_LABEL: Record<Citation['source'], string> = {
  worldbank: 'World Bank Open Data',
  owid: 'Our World in Data',
  imf: 'IMF DataMapper',
  who: 'WHO Global Health Observatory',
};

export function citationSourceLabel(source: Citation['source']): string {
  return CITATION_SOURCE_LABEL[source];
}

// The human-visitable page for a series id — the URL a citation links to.
// Mirrors the per-source institution pages (distinct from the API request URL).
export function citationHumanUrl(source: Citation['source'], id: string): string {
  if (source === 'owid') return 'https://ourworldindata.org/grapher/' + encodeURIComponent(id.replace(/^owid:/, ''));
  if (source === 'imf') return 'https://www.imf.org/external/datamapper/' + encodeURIComponent(id.replace(/^imf:/i, ''));
  // WHO GHO: the per-indicator "pretty" page (…/indicator-details/GHO/<url-name>)
  // is keyed by a human URL-name slug that differs from the IndicatorCode and
  // can't be reliably derived from it — a guessed one would 404. So the citation
  // LINKS to the stable GHO data portal (which always resolves) and the exact
  // per-indicator OData endpoint rides along as requestUrl for full traceability.
  if (source === 'who') return 'https://www.who.int/data/gho';
  return 'https://data.worldbank.org/indicator/' + encodeURIComponent(id);
}

// Compact one-line-per-source provenance header for CSV export. Emitted as
// `#`-prefixed comment lines so it rides along at the top of the file without
// breaking spreadsheet import (Excel/Sheets/pandas all skip or isolate a
// leading comment block). A blank comment separates the block from the header.
export function citationsToCsvComments(citations: Citation[]): string {
  if (!citations.length) return '';
  const lines = citations.map((c) => {
    const range = c.yearRange
      ? ` — ${c.yearRange.start ?? ''}–${c.yearRange.end ?? ''}`
      : '';
    const where = c.countries.length ? ` — countries: ${c.countries.join(', ')}` : ' — all countries';
    const vintage = c.sourceUpdated ? ` — source updated ${c.sourceUpdated}` : '';
    return `# Source: ${c.sourceLabel} — ${c.indicatorName} (${c.indicatorId}) — ${c.url}${where}${range} — fetched ${c.fetchedAt}${vintage}`;
  });
  return ['# Chitti — data provenance (every number fetched live and cited):', ...lines, '#'].join('\n') + '\n';
}

// The tool schemas (TOOL_SCHEMAS) and the sub-agent terminal tool schema
// (RETURN_FINDINGS_SCHEMA) now live in ./schemas. Imported for internal use
// by schemasForSources()/subAgentSchemasFor() below and re-exported so
// existing `import { TOOL_SCHEMAS, RETURN_FINDINGS_SCHEMA } from './tools'`
// keeps working.
export { TOOL_SCHEMAS, RETURN_FINDINGS_SCHEMA } from './schemas';

// The always-on core tool-name set now lives in ./schemas. Re-exported so
// `import { CORE_TOOL_NAMES } from './tools'` keeps working.
export { CORE_TOOL_NAMES } from './schemas';

