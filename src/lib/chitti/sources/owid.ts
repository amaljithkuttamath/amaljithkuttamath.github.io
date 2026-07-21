// sources/owid.ts — the Our World in Data adapter. Holds the OWID curated
// grapher-slug catalog, the grapher-CSV fetcher, the live-catalog parser +
// fetch + search, all moved verbatim from tools.ts. Names/behavior unchanged.
import type { DataRow } from '../tools';
import { ApiRejection } from '../tools';
import { parseCsvLine } from '../csv';
import { scoreSeries } from '../scoring';
import type { SeriesHit, SourceAdapter, FetchSeriesResult } from './types';

// OWID grapher slugs — each serves CSV at ourworldindata.org/grapher/<slug>.csv,
// so every id here round-trips: a find_series hit fetches through the router's
// OWID branch unchanged. This is a hand-curated set of long-standing, canonical
// OWID grapher slugs (the "never fabricate" constraint outweighs raw count — an
// invented slug would 404 on fetch, breaking the round-trip). Names are worded
// to avoid stealing World-Bank-preferred queries (e.g. the Gini entry says
// "income inequality", not "Gini coefficient", so the WB Gini index still wins
// that phrasing). The live catalog fallback (owidCatalog) widens coverage past
// this list whenever the network is reachable.
const OWID_DATASETS: [string, string][] = [
  // Health & mortality
  ['life-expectancy', 'Life expectancy at birth (years)'],
  ['child-mortality', 'Child mortality rate (under-5, per 100 live births)'],
  ['maternal-mortality', 'Maternal mortality ratio (per 100,000 live births)'],
  ['prevalence-of-undernourishment', 'Prevalence of undernourishment (% of population)'],
  ['death-rates-from-air-pollution', 'Death rate from air pollution (per 100,000 persons)'],
  ['daily-per-capita-caloric-supply', 'Daily supply of calories per person (kcal)'],
  // Demographics & population
  ['population', 'Population'],
  // "persons" not "people": the bare word "people" false-matched colloquial
  // queries like "how many people are online" (a World Bank internet series).
  ['population-density', 'Population density (persons per km²)'],
  ['median-age', 'Median age of the population (years)'],
  ['children-per-woman', 'Children per woman (total fertility)'],
  // Economy, poverty & inequality
  ['gdp-per-capita-worldbank', 'GDP per capita (international-$, PPP)'],
  ['human-development-index', 'Human Development Index (HDI)'],
  ['share-of-population-in-extreme-poverty', 'Share of population in extreme poverty (%)'],
  // (Gini/income inequality intentionally omitted here: the World Bank Gini
  // index already covers it, and the OWID slug's id — "economic-inequality-…" —
  // false-matched the "economic output" → GDP query. Left out to keep ranking
  // clean; WB owns that metric.)
  // Environment & climate
  ['co-emissions-per-capita', 'CO2 emissions per capita (tonnes)'],
  ['annual-co2-emissions-per-country', 'Annual CO2 emissions (tonnes)'],
  ['cumulative-co2-emissions', 'Cumulative CO2 emissions (tonnes)'],
  ['consumption-co2-per-capita', 'Consumption-based CO2 emissions per capita (tonnes)'],
  ['temperature-anomaly', 'Global temperature anomaly (°C vs pre-industrial)'],
  ['plastic-waste-per-capita', 'Plastic waste generated per person (kg/day)'],
  // Energy
  ['share-electricity-renewables', 'Share of electricity from renewables (%)'],
  ['per-capita-energy-use', 'Energy use per person (kWh)'],
  // Technology
  ['share-of-individuals-using-the-internet', 'Share of population using the internet (%)'],
  // Society, education & governance
  ['cross-country-literacy-rates', 'Literacy rate (%)'],
  ['happiness-cantril-ladder', 'Self-reported life satisfaction (Cantril ladder, 0-10)'],
  ['homicide-rate-unodc', 'Homicide rate (per 100,000 people)'],
  ['political-regime', 'Political regime (democracy classification)'],
];

// fetch_owid: CSV from the OWID grapher. Columns: Entity, Code, Year,
// <metric...>. First metric column is the value. Aggregates like World use
// OWID_WRL codes; rows with no code (subregions) are dropped.
export async function fetchOwid(
  slug: string,
  countryIds?: string[],
  yearStart?: number,
  yearEnd?: number,
  signal?: AbortSignal
): Promise<{ rows: DataRow[]; metric: string; requestUrl: string }> {
  const clean = slug.replace(/^owid:/i, '');
  const url = `https://ourworldindata.org/grapher/${encodeURIComponent(clean)}.csv?csvType=full`;
  let resp: Response;
  try {
    resp = await fetch(url, signal ? { signal } : undefined);
  } catch (err: any) {
    // A user-cancel must keep its AbortError identity so the loop unwinds as a
    // stop — not get rewritten into a "CORS block, fall back to World Bank" steer
    // that sends the agent chasing a retry against an aborted signal.
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    throw new Error(
      `OWID fetch failed (${err?.message ?? err}). If this is a CORS block, fetch a World Bank series (a plain-code id) via fetch_series for this question instead.`
    );
  }
  // A 404 (or other non-OK) means the grapher has no such slug — a STRUCTURED
  // rejection the router steers to find_series (not a network failure).
  if (!resp.ok)
    throw new ApiRejection('owid', clean, {
      status: resp.status,
      message: `OWID API HTTP ${resp.status} for slug "${clean}" — the slug may be wrong.`,
    });
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
  // The grapher CSV carries no data-vintage field in its body, so no
  // sourceUpdated is emitted here (never invented — omitted honestly).
  return { rows, metric, requestUrl: url };
}

// Parse an OWID grapher-catalog listing into namespaced series entries. OWID
// has no single documented, keyless, CORS-open JSON endpoint that lists every
// grapher slug, so this stays deliberately defensive about shape: a bare array
// of chart objects, or an { charts | items | results } wrapper around one, with
// the human title under any of title/name/chartName and the slug under slug/id.
// Anything it can't read is skipped rather than thrown. Pure + exported so the
// live-catalog path is unit-testable from a fixture without the network.
export function parseOwidCatalog(data: unknown): { id: string; name: string }[] {
  const root = data as Record<string, unknown> | unknown[];
  const arr: unknown[] = Array.isArray(root)
    ? root
    : Array.isArray((root as any)?.charts) ? (root as any).charts
    : Array.isArray((root as any)?.items) ? (root as any).items
    : Array.isArray((root as any)?.results) ? (root as any).results
    : [];
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const rec = e as Record<string, unknown>;
    const slug = String(rec.slug ?? rec.id ?? '').trim().replace(/^owid:/, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name = String(rec.title ?? rec.name ?? rec.chartName ?? slug).trim() || slug;
    out.push({ id: 'owid:' + slug, name });
  }
  return out;
}

// The live OWID grapher catalog, fetched once and cached for the session — the
// graceful widen past the curated OWID_DATASETS list (same idea as the World
// Bank search API and the live IMF DataMapper catalog). Same host Chitti already
// pulls OWID *data* from, so it shares that host's browser-open CORS policy.
// NOTE (offline-honest): OWID publishes no confirmed keyless JSON index of all
// grapher slugs, so this endpoint is a best-effort candidate. It is EXPECTED to
// fail for many sessions; when it does, searchOwidCatalog swallows the error and
// find_series simply returns the (expanded) curated hits. The parser above — not
// this URL — is the tested contract.
let owidCatalogCache: { id: string; name: string }[] | null = null;
async function owidCatalog(): Promise<{ id: string; name: string }[]> {
  if (owidCatalogCache) return owidCatalogCache;
  const resp = await fetch('https://ourworldindata.org/charts.json');
  if (!resp.ok) throw new Error('OWID charts HTTP ' + resp.status);
  owidCatalogCache = parseOwidCatalog(await resp.json());
  return owidCatalogCache;
}

// Search the live OWID catalog with the shared scorer. Any failure (offline,
// CORS, no such endpoint, shape change) degrades to an empty list — findSeries
// then just returns the curated OWID hits, never an error.
async function searchOwidCatalog(query: string): Promise<SeriesHit[]> {
  try {
    const cat = await owidCatalog();
    return cat
      .map((d) => ({ d, score: scoreSeries(query, d.id, d.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => ({ id: x.d.id, name: x.d.name, source: 'owid' }));
  } catch {
    return [];
  }
}

// Namespaced curated entries + a friendly-name lookup over them.
const OWID_CATALOG = OWID_DATASETS.map(([slug, name]) => ({ id: 'owid:' + slug, name }));
const curatedName = (nid: string): string | undefined => OWID_CATALOG.find((c) => c.id === nid)?.name;

// ── Adapter ────────────────────────────────────────────────────────────────
export const owidAdapter: SourceAdapter = {
    id: 'owid',
    label: 'Our World in Data',
    category: 'Society & environment',
    blurb: 'CO₂ & energy, happiness, HDI, literacy, extreme poverty.',
    toolNames: [],
    promptSnippet:
      'Our World in Data — topics World Bank lacks: CO2/energy, happiness, HDI, literacy, extreme poverty. Its find_series hits look like "owid:<slug>"; fetch them with fetch_series.',
    cite: { name: 'Our World in Data', url: 'https://ourworldindata.org' },
    datasetSource: 'owid',
  citationSource: 'owid',
  sourceLabel: 'Our World in Data',
  humanUrl: (id) => 'https://ourworldindata.org/grapher/' + encodeURIComponent(id.replace(/^owid:/i, '')),
  matchesId: (id) => id.trim().toLowerCase().startsWith('owid:'),
  normalizeId: (id) => 'owid:' + id.replace(/^owid:/i, ''),
  curated: OWID_CATALOG,
  usesSharedCatalog: true,
  liveCatalogSearch: (query) => searchOwidCatalog(query),
  openIdSpace: false,
  idLabel: 'OWID slug',
  hasCuratedId: (id) => OWID_CATALOG.some((c) => c.id === 'owid:' + id.replace(/^owid:/i, '')),
  reportsBatches: false,
  detailSuffix: () => ' · OWID',
  indicatorLabel: (nid, r) => curatedName(nid) ?? r.metric ?? nid,
  async fetchSeries(id, countries, ys, ye, signal): Promise<FetchSeriesResult> {
    const r = await fetchOwid(id, countries, ys, ye, signal);
    return { rows: r.rows, requestUrl: r.requestUrl, metric: r.metric };
  },
};
