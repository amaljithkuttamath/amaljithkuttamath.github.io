// sources/imf.ts — the IMF DataMapper adapter. Holds the curated IMF code
// catalog, the DataMapper JSON fetcher, and the live-catalog parser + fetch +
// search, moved verbatim from tools.ts. Names/behavior unchanged.
import type { DataRow } from '../tools';
import { ApiRejection, COUNTRIES } from '../tools';
import { scoreSeries } from '../scoring';
import type { SeriesHit, SourceAdapter, FetchSeriesResult } from './types';

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

// fetch_imf: IMF DataMapper JSON. Shape:
// { values: { <code>: { <ISO3>: { "<year>": value } } } }
// Includes projection years beyond today — that's the point of this source.
export async function fetchImf(
  code: string,
  countryIds?: string[],
  yearStart?: number,
  yearEnd?: number,
  signal?: AbortSignal
): Promise<{ rows: DataRow[]; requestUrl: string }> {
  const clean = code.replace(/^imf:/, '').toUpperCase();
  const path = countryIds?.length
    ? `${clean}/${countryIds.map((c) => c.trim().toUpperCase()).join('/')}`
    : clean;
  const url = `https://www.imf.org/external/datamapper/api/v1/${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, signal ? { signal } : undefined);
  } catch (err: any) {
    throw new Error(
      `IMF fetch failed (${err?.message ?? err}). If this is a CORS block, fall back to a World Bank series (a plain-code id) via fetch_series (no forecasts, but similar historical macro data).`
    );
  }
  // A non-OK from DataMapper means the code is unknown — a STRUCTURED rejection.
  if (!resp.ok)
    throw new ApiRejection('imf', clean, {
      status: resp.status,
      message: `IMF API HTTP ${resp.status} for code "${clean}".`,
    });
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
  // DataMapper JSON carries no per-series vintage, so no sourceUpdated (omitted,
  // never invented). requestUrl is the exact endpoint we hit.
  return { rows, requestUrl: url };
}

// Parse the IMF DataMapper /indicators payload into series entries. Shape:
// { indicators: { <CODE>: { label, description, ... } } }. Pure + exported so
// it's unit-testable without the network.
export function parseImfIndicators(data: unknown): { id: string; name: string }[] {
  const inds = (data as { indicators?: Record<string, { label?: string }> })?.indicators;
  if (!inds || typeof inds !== 'object') return [];
  return Object.keys(inds).map((code) => ({
    id: 'imf:' + code,
    name: inds[code]?.label || code,
  }));
}

// The full IMF DataMapper indicator catalog (~50+ series), fetched once and
// cached for the session. The curated IMF_DATASETS list is tiny; this is the
// live-fallback equivalent of World Bank's search API. Same host Chitti already
// fetches IMF *data* from, so it shares that host's (browser-open) CORS policy.
let imfCatalogCache: { id: string; name: string }[] | null = null;
async function imfCatalog(): Promise<{ id: string; name: string }[]> {
  if (imfCatalogCache) return imfCatalogCache;
  const resp = await fetch('https://www.imf.org/external/datamapper/api/v1/indicators');
  if (!resp.ok) throw new Error('IMF indicators HTTP ' + resp.status);
  imfCatalogCache = parseImfIndicators(await resp.json());
  return imfCatalogCache;
}

// Search the live IMF catalog with the shared scorer. Any failure (offline,
// CORS, shape change) degrades to an empty list — findSeries then just returns
// the curated hits, never an error.
async function searchImfCatalog(query: string): Promise<SeriesHit[]> {
  try {
    const cat = await imfCatalog();
    return cat
      .map((d) => ({ d, score: scoreSeries(query, d.id, d.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => ({ id: x.d.id, name: x.d.name, source: 'imf' }));
  } catch {
    return [];
  }
}

const IMF_CATALOG = IMF_DATASETS.map(([code, name]) => ({ id: 'imf:' + code, name }));
const curatedName = (nid: string): string | undefined => IMF_CATALOG.find((c) => c.id === nid)?.name;

// ── Adapter ────────────────────────────────────────────────────────────────
export const imfAdapter: SourceAdapter = {
    id: 'imf',
    label: 'IMF',
    category: 'Economics & development',
    blurb: 'Macro data with multi-year forecasts: GDP, inflation, debt.',
    toolNames: [],
    promptSnippet:
      'IMF DataMapper — the source for forecasts/projections several years ahead: GDP growth, inflation, unemployment, government debt. Its find_series hits look like "imf:<code>"; fetch them with fetch_series, and say "IMF projection" when you use projected years.',
    cite: { name: 'IMF DataMapper', url: 'https://www.imf.org/external/datamapper' },
    datasetSource: 'imf',
  citationSource: 'imf',
  sourceLabel: 'IMF DataMapper',
  humanUrl: (id) => 'https://www.imf.org/external/datamapper/' + encodeURIComponent(id.replace(/^imf:/i, '')),
  matchesId: (id) => id.trim().toLowerCase().startsWith('imf:'),
  normalizeId: (id) => 'imf:' + id.replace(/^imf:/, '').toUpperCase(),
  curated: IMF_CATALOG,
  usesSharedCatalog: true,
  liveCatalogSearch: (query) => searchImfCatalog(query),
  openIdSpace: false,
  idLabel: 'IMF code',
  hasCuratedId: (id) => IMF_CATALOG.some((c) => c.id === 'imf:' + id.replace(/^imf:/i, '').toUpperCase()),
  reportsBatches: false,
  detailSuffix: () => ' · IMF (incl. forecasts)',
  indicatorLabel: (nid) => curatedName(nid) ?? nid,
  async fetchSeries(id, countries, ys, ye, signal): Promise<FetchSeriesResult> {
    const r = await fetchImf(id, countries, ys, ye, signal);
    return { rows: r.rows, requestUrl: r.requestUrl };
  },
};
