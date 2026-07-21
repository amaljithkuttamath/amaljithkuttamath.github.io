// sources/worldbank.ts — the World Bank Open Data adapter. Holds the World
// Bank fetchers (specific-country + every-country batched), the date-param
// builder, the 200-with-error-body rejection parser, and the primary indicator
// search (curated indicators.json + the live WB /indicator search API). All
// moved verbatim from tools.ts; only imports/exports were adjusted.
import type { DataRow, Indicator } from '../tools';
import { ApiRejection, INDICATORS, listCountries } from '../tools';
import { scoreSeries } from '../scoring';
import type { SeriesHit, SourceAdapter, FetchSeriesResult } from './types';

const WB = 'https://api.worldbank.org/v2';

// A bare World Bank indicator code: 1-4 letters, then one or more dot-segments
// (e.g. NY.GDP.PCAP.KD, SH.DYN.MORT, SP.POP.TOTL). Colon-prefixed ids
// (owid:/imf:/who:) don't match and belong to other adapters anyway.
const WB_CODE = /^[A-Za-z]{1,4}(?:\.[A-Za-z0-9]+)+$/;

// Resolve an exact indicator code via the WB `/indicator/{code}` endpoint.
// Returns undefined when offline/blocked or the code doesn't exist. Never throws.
async function resolveWbIndicatorCode(code: string): Promise<Indicator | undefined> {
  try {
    const url = `${WB}/indicator/${encodeURIComponent(code)}?format=json`;
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    const data = await resp.json();
    const row = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : undefined;
    if (row && row.id && row.name) return { id: row.id as string, name: row.name as string, topic: 'World Bank' };
  } catch {
    /* offline / blocked */
  }
  return undefined;
}

// search_indicators: filter the curated list; if <3 hits, hit the WB search API.
export async function searchIndicators(query: string, topic?: string): Promise<Indicator[]> {
  const q = (query || '').toLowerCase().trim();
  let pool = INDICATORS;
  if (topic) {
    const t = topic.toLowerCase();
    pool = pool.filter((i) => i.topic.toLowerCase().includes(t));
  }
  const scored = pool
    .map((i) => ({ i, score: scoreSeries(query, i.id, i.name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);

  const dedup = (list: Indicator[]): Indicator[] => {
    const seen = new Set<string>();
    return list.filter((x) => x.id && !seen.has(x.id.toLowerCase()) && (seen.add(x.id.toLowerCase()), true));
  };

  // When the query IS an exact indicator code, resolve that code authoritatively
  // and include it — otherwise a code like NY.GDP.PCAP.KD short-circuits on ≥3
  // fuzzy token matches (ny/gdp/kd) and never surfaces the very series asked for,
  // returning e.g. "GDP growth (annual %)" instead. The caller re-ranks by
  // scoreSeries, which scores the exact code far above any token match.
  const code = query.trim();
  if (!topic && WB_CODE.test(code)) {
    const curated = INDICATORS.find((i) => i.id.toLowerCase() === code.toLowerCase());
    const exact = curated ?? (await resolveWbIndicatorCode(code));
    if (exact) return dedup([exact, ...scored]).slice(0, 12);
  }

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

// Parse a World Bank JSON error body into a structured result, DEFENSIVELY. The
// WB API returns HTTP 200 with a body shaped like
//   [{ message: [{ id: "120", key: "Invalid value",
//                  value: "The provided parameter value is not valid" }] }]
// for a bad indicator id or country code. Returns { message, invalidParameter }
// or null when the body is not a recognizable WB error envelope (e.g. a valid
// indicator that merely returned no rows). Never throws. Exported for its unit
// table (the reported "provided parameter value is not valid" shape included).
export function parseWorldBankError(
  body: unknown
): { message: string; invalidParameter: boolean } | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const head = body[0] as { message?: unknown };
  const msgs = head?.message;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const first = (msgs[0] ?? {}) as { key?: unknown; value?: unknown };
  const value = typeof first.value === 'string' ? first.value : '';
  const key = typeof first.key === 'string' ? first.key : '';
  if (!value && !key) return null;
  const invalidParameter =
    /provided parameter value is not valid/i.test(value) || /invalid value/i.test(key);
  return { message: value || key, invalidParameter };
}

export interface FetchWorldbankResult {
  rows: DataRow[];
  // Original requested country count, only set when it exceeded the 60-per-
  // call cap and was truncated. Undefined when no truncation occurred.
  truncatedFrom?: number;
  // The exact API URL this call hit — recorded verbatim for the citation
  // ledger (the request URL, distinct from the human-visitable data.worldbank
  // page). Never reconstructed after the fact; it is the string we fetched.
  requestUrl: string;
  // Data vintage straight from the World Bank JSON header (`data[0].lastupdated`,
  // e.g. "2024-12-16"). This is when the World Bank last refreshed the series —
  // NOT when we fetched it. Undefined when the header omits it (never invented).
  sourceUpdated?: string;
}

// Build the World Bank `&date=…` query fragment for an OPEN or closed year
// range, defensively. The bug this replaces: passing `Number(undefined)` (NaN)
// as a bound emitted `date=1990:NaN`, which the World Bank rejects with "The
// provided parameter value is not valid". The rule set:
//   both bounds       → date=YS:YE
//   only a start      → date=YS:<current year>   (WB wants a CLOSED range, so an
//                                                  open end is pinned to now)
//   only an end       → date=1960:YE             (1960 is WB's earliest year)
//   neither / invalid → omit the date param       (WB returns its full range)
// A bound that is not a finite number (NaN, undefined) is treated as ABSENT, so
// the strings "NaN"/"undefined" can never reach the URL.
export function worldbankDateParam(yearStart?: number, yearEnd?: number): string {
  const ys = Number.isFinite(yearStart) ? (yearStart as number) : undefined;
  const ye = Number.isFinite(yearEnd) ? (yearEnd as number) : undefined;
  if (ys !== undefined && ye !== undefined) return `&date=${ys}:${ye}`;
  if (ys !== undefined) return `&date=${ys}:${new Date().getFullYear()}`;
  if (ye !== undefined) return `&date=1960:${ye}`;
  return '';
}

export async function fetchWorldbank(
  indicatorId: string,
  countryIds: string[],
  yearStart?: number,
  yearEnd?: number,
  signal?: AbortSignal
): Promise<FetchWorldbankResult> {
  const cleanIds = countryIds.map((c) => c.trim().toUpperCase()).filter(Boolean);
  const truncatedFrom = cleanIds.length > 60 ? cleanIds.length : undefined;
  const codes = cleanIds.slice(0, 60).join(';');
  // Semicolons must stay literal in the path segment; only the indicator id
  // needs escaping (WB ids are dot-delimited alnum, so this is a no-op in
  // practice, but keeps us safe). The date fragment is built defensively so an
  // open range ("since 1990") never leaks NaN/undefined into the URL.
  const url =
    `${WB}/country/${codes}/indicator/${encodeURIComponent(indicatorId)}` +
    `?format=json${worldbankDateParam(yearStart, yearEnd)}&per_page=2000`;
  const resp = await fetch(url, signal ? { signal } : undefined);
  if (!resp.ok) throw new Error('World Bank API HTTP ' + resp.status);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) {
    // A World Bank error envelope (HTTP 200 + [{message:[…]}]) is a STRUCTURED
    // rejection of the indicator/country parameter — surface it as an
    // ApiRejection the router turns into a find_series steer. A shape that is
    // NOT an error envelope (a valid indicator that simply returned no rows)
    // stays a plain Error: empty data, not a rejection.
    const wbErr = parseWorldBankError(data);
    if (wbErr) {
      throw new ApiRejection('worldbank', indicatorId, {
        message: 'World Bank API: ' + wbErr.message,
        invalidParameter: wbErr.invalidParameter,
      });
    }
    throw new Error('World Bank API: no data returned');
  }
  // data[0] is the WB response header; it carries `lastupdated` — the series'
  // real data vintage. Capture it when present (string, e.g. "2024-12-16");
  // omit otherwise. This is disclosed as `sourceUpdated`, never as fetchedAt.
  const lastupdated = (data[0] && typeof data[0].lastupdated === 'string')
    ? (data[0].lastupdated as string)
    : undefined;
  const rows: DataRow[] = (data[1] as any[]).map((r) => ({
    country: r.country?.value ?? r.countryiso3code,
    iso3: r.countryiso3code,
    year: parseInt(r.date, 10),
    value: r.value === null || r.value === undefined ? null : Number(r.value),
    indicator: indicatorId,
  }));
  // Sort by country then year ascending for stable downstream use.
  rows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows, truncatedFrom, requestUrl: url, sourceUpdated: lastupdated };
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
  // Representative request URL (the first batch's) + the series vintage from
  // that batch's WB header — for the citation ledger of an every-country fetch.
  requestUrl: string;
  sourceUpdated?: string;
}

export async function fetchWorldbankAll(
  indicatorId: string,
  yearStart?: number,
  yearEnd?: number,
  signal?: AbortSignal
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
  let requestUrl = '';
  let sourceUpdated: string | undefined;
  for (const batch of batches) {
    const r = await fetchWorldbank(indicatorId, batch, yearStart, yearEnd, signal);
    allRows.push(...r.rows);
    // The batches share one indicator/vintage; keep the first batch's URL and
    // lastupdated as the representative citation for the whole every-country set.
    if (!requestUrl) requestUrl = r.requestUrl;
    if (sourceUpdated === undefined) sourceUpdated = r.sourceUpdated;
  }
  allRows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return { rows: allRows, countryCount: ids.length, batchCount: batches.length, requestUrl, sourceUpdated };
}

// ── Adapter ────────────────────────────────────────────────────────────────
export const worldbankAdapter: SourceAdapter = {
    id: 'worldbank',
    label: 'World Bank',
    category: 'Economics & development',
    blurb: 'Development, economic, health & social indicators for every country.',
    toolNames: [],
    promptSnippet:
      'World Bank — the broad default: development, economic, health, and social indicators. Its find_series hits are plain codes (e.g. SH.DYN.MORT); fetch them with fetch_series — pass explicit countries (ISO3 codes, or one aggregate like WLD), or omit countries for "every country" questions (fetch_series batches World Bank internally — never build the full country list yourself).',
    cite: { name: 'World Bank Open Data', url: 'https://data.worldbank.org' },
  citationSource: 'worldbank',
  sourceLabel: 'World Bank Open Data',
  humanUrl: (id) => 'https://data.worldbank.org/indicator/' + encodeURIComponent(id),
  matchesId: (id) => !id.trim().toLowerCase().includes(':'),
  normalizeId: (id) => id,
  curated: [],
  usesSharedCatalog: false,
  primarySearch: async (query) =>
    (await searchIndicators(query)).map((i) => ({ id: i.id, name: i.name, source: 'worldbank' })),
  openIdSpace: true,
  idLabel: 'World Bank indicator',
  hasCuratedId: (id) => INDICATORS.some((i) => i.id.toLowerCase() === id.trim().toLowerCase()),
  reportsBatches: true,
  detailSuffix: (r) => (r.truncatedFrom ? ` (truncated from ${r.truncatedFrom})` : ''),
  indicatorLabel: (nid) => nid,
  async fetchSeries(id, countries, ys, ye, signal): Promise<FetchSeriesResult> {
    // An empty array means "every country", same as `undefined` — matching
    // OWID/IMF/WHO. Routing `[]` down the specific-country path built a
    // malformed `/country//indicator/<id>` URL (double slash) that the WB API
    // does not read as "all", so the same input failed only for World Bank.
    if (countries && countries.length) {
      const r = await fetchWorldbank(id, countries, ys, ye, signal);
      return { rows: r.rows, requestUrl: r.requestUrl, sourceUpdated: r.sourceUpdated, truncatedFrom: r.truncatedFrom };
    }
    const r = await fetchWorldbankAll(id, ys, ye, signal);
    return { rows: r.rows, requestUrl: r.requestUrl, sourceUpdated: r.sourceUpdated, countryCount: r.countryCount, batchCount: r.batchCount };
  },
};
