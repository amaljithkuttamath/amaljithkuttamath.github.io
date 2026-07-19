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
// Provenance marker for a VFS entry. Set when the file's content was produced
// by a recursive llm() call inside execute_js (semantic labelling/summarizing
// over data slices) rather than fetched from a data API. Identity-critical:
// model-derived content must be visibly labelled and must never be presented
// as fetched data (no citation, never in the evidence table).
export interface FileMeta {
  derived?: boolean; // true → content is model-derived, not fetched
  via?: string; // how it was derived, e.g. 'llm'
}

export class VFS {
  files: Record<string, string> = {};
  // Per-path provenance, parallel to `files`. Absent entry = ordinary
  // (non-derived) file. Kept separate so the string content contract of
  // `files` is unchanged for every existing reader.
  meta: Record<string, FileMeta> = {};
  private onChange?: (files: Record<string, string>) => void;

  constructor(onChange?: (files: Record<string, string>) => void) {
    this.onChange = onChange;
  }
  write(path: string, content: string, meta?: FileMeta): void {
    this.files[path] = content;
    if (meta && (meta.derived || meta.via)) this.meta[path] = { ...meta };
    else delete this.meta[path]; // a plain re-write clears any stale marker
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

// ── Relevance scoring ────────────────────────────────────────────────────
// One weighted scorer shared by every catalog. Plain substring term-counting
// missed real matches — "co2" never hits "CO-emissions…" because it isn't a
// literal substring — so we normalize punctuation to spaces and expand a small
// synonym map before scoring. No embeddings: this stays a browser-only static
// site, and a curated synonym list is both cheap and debuggable.
const SYNONYMS: Record<string, string[]> = {
  co2: ['carbon', 'emissions', 'greenhouse'],
  carbon: ['co2', 'emissions'],
  emissions: ['co2', 'carbon'],
  gdp: ['gross domestic product', 'economy', 'output'],
  economy: ['gdp', 'economic', 'output'],
  economic: ['gdp', 'economy', 'output'],
  output: ['gdp', 'economy'],
  gni: ['gross national income'],
  inflation: ['consumer prices', 'cpi'],
  unemployment: ['labor force', 'jobless', 'unemployed'],
  jobless: ['unemployment', 'unemployed'],
  unemployed: ['unemployment'],
  population: ['people', 'demographic', 'inhabitants'],
  people: ['population'],
  // "per person" is the colloquial "per capita"; the reverse is not added so
  // a plain "per capita" query doesn't drag in the one dataset named "person".
  person: ['capita'],
  pc: ['per capita'],
  mortality: ['death', 'deaths'],
  fertility: ['births', 'birth rate'],
  longevity: ['life expectancy'],
  lifespan: ['life expectancy'],
  // aging skews toward the "ages 65 and above" series, not a literal word.
  aging: ['ages', 'elderly', 'old', 'older'],
  ageing: ['ages', 'elderly', 'old', 'older'],
  doctors: ['physicians', 'medical'],
  physicians: ['doctors'],
  vaccination: ['immunization', 'vaccine'],
  vaccine: ['immunization', 'vaccination'],
  immunization: ['vaccination', 'vaccine'],
  spending: ['expenditure', 'expenses'],
  expenditure: ['spending'],
  // IMF is the forecast source — route "forecast/projection" phrasings there.
  forecast: ['projection', 'projected', 'forecasts', 'outlook'],
  forecasts: ['forecast', 'projection'],
  projection: ['forecast', 'forecasts', 'projected'],
  projected: ['forecast', 'projection'],
  internet: ['online', 'web', 'connectivity'],
  online: ['internet', 'web'],
  phone: ['mobile', 'cellular'],
  cellular: ['mobile', 'phone'],
  poverty: ['poor', 'income'],
  literacy: ['reading', 'education'],
  renewables: ['renewable', 'solar', 'wind', 'clean energy'],
  renewable: ['renewables', 'solar', 'wind', 'clean energy'],
  energy: ['electricity', 'power'],
  debt: ['borrowing', 'liabilities'],
  trade: ['exports', 'imports'],
  cover: ['area'],
  happiness: ['life satisfaction', 'wellbeing', 'cantril'],
  hdi: ['human development'],
};

// Function/units words that carry no topic signal. Dropped from per-term
// scoring so a short token can't win on an incidental substring hit — "in"
// (from "gdp in france") was matching "international", and "rate" (a units
// suffix on many indicator names) was outscoring the actual topic term. The
// full-phrase and name-prefix bonuses still use the raw query, so multi-word
// phrases like "gdp per capita" keep their exact-match weight.
const STOPWORDS = new Set([
  'in', 'of', 'the', 'a', 'an', 'to', 'for', 'and', 'or', 'how', 'many', 'much',
  'are', 'is', 'be', 'on', 'at', 'by', 'with', 'from', 'rate',
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The receipt for one scored series: not just the number, but WHICH query
// terms and synonym expansions actually landed. The UI surfaces this so the
// scorer's work ("matched 'gdp' → 'economy'") is visible instead of hidden.
export interface MatchExplanation {
  score: number;
  // Original query tokens that appeared verbatim in the id/name.
  matchedBase: string[];
  // Synonym expansions that fired: the original query term and the synonym
  // word that actually appeared in the haystack. e.g. gdp → economy.
  matchedSynonyms: { term: string; synonym: string }[];
}

// Weighted relevance of one series (id + name) to a query, PLUS which terms
// contributed. Pure and offline-testable. scoreSeries is the thin numeric
// wrapper, so the number and the explanation can never drift apart.
export function explainMatch(query: string, id: string, name: string): MatchExplanation {
  const q = normalize(query);
  if (!q) return { score: 0, matchedBase: [], matchedSynonyms: [] };
  const nName = normalize(name);
  const nId = normalize(id);
  const hay = nName + ' ' + nId;
  let score = 0;
  if (hay.includes(q)) score += 10; // exact phrase present
  if (nName.startsWith(q)) score += 6; // name leads with the query
  if (nId === q) score += 8; // id is exactly the query

  const base = new Set(q.split(' ').filter((w) => w && !STOPWORDS.has(w)));
  // Synonym word → the base term it expands from. First writer wins so a word
  // reachable from two base terms is attributed once (matches the old Set
  // dedup that kept scoring stable).
  const synOf = new Map<string, string>();
  for (const t of base)
    for (const syn of SYNONYMS[t] ?? [])
      for (const w of normalize(syn).split(' '))
        if (w && !base.has(w) && !synOf.has(w)) synOf.set(w, t);

  const matchedBase: string[] = [];
  const matchedSynonyms: { term: string; synonym: string }[] = [];
  for (const t of base) if (hay.includes(t)) { score += 2; matchedBase.push(t); } // originals weigh more
  for (const [w, t] of synOf) if (hay.includes(w)) { score += 1; matchedSynonyms.push({ term: t, synonym: w }); }
  return { score, matchedBase, matchedSynonyms };
}

// Weighted relevance of one series (id + name) to a query. 0 = no match.
export function scoreSeries(query: string, id: string, name: string): number {
  return explainMatch(query, id, name).score;
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
  return DATASETS.filter((d) => !allowSet || allowSet.has(d.source))
    .map((d) => ({ d, score: scoreSeries(query, d.id, d.name) }))
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
      `OWID fetch failed (${err?.message ?? err}). If this is a CORS block, fetch a World Bank series (a plain-code id) via fetch_series for this question instead.`
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
      `IMF fetch failed (${err?.message ?? err}). If this is a CORS block, fall back to a World Bank series (a plain-code id) via fetch_series (no forecasts, but similar historical macro data).`
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
//
// RLM primitive: the code may also `await llm(prompt, data?)` — a bounded
// recursive language-model call over a slice of the data (the Recursive
// Language Model pattern: the context lives as data in this REPL and the
// model's own code makes small, depth-1 LM calls over pieces of it, keeping
// the raw data out of the main context). Because of `llm`, the sandboxed
// function is an AsyncFunction, so the code may use `await`; a plain
// synchronous `return` still works exactly as before. The caps, receipts,
// and provenance live in the injected `llm` (see agent.ts); executeJs only
// wires it in and awaits the result.
export interface ExecuteJsResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// The recursive LM primitive handed to sandboxed code. Returns text only —
// no tool access — so it is depth-1 by construction.
export type LlmFn = (prompt: string, data?: unknown) => Promise<string>;

// The AsyncFunction constructor is not a global binding; reach it off an async
// function's prototype. Lets the sandboxed body use `await llm(...)`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
  new (...args: string[]): (...a: unknown[]) => Promise<unknown>;
};

// Default `llm` when execute_js is run without a session-provided one (e.g.
// direct unit tests): calling it is a clear, catchable error rather than a
// silent undefined.
const llmUnavailable: LlmFn = async () => {
  throw new Error('llm() is not available in this context');
};

export async function executeJs(
  code: string,
  rows: DataRow[],
  llm: LlmFn = llmUnavailable
): Promise<ExecuteJsResult> {
  try {
    const fn = new AsyncFunction('rows', 'llm', code);
    const result = await fn(rows, llm);
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
    name: 'find_series',
    description:
      'Search for a data series across ALL your active databases in one call. Returns matches as ' +
      '{id, name, source}. Pass the chosen id verbatim to fetch_series — it routes to the right ' +
      'source automatically (plain codes like SH.DYN.MORT, "owid:<slug>", and "imf:<code>" all go ' +
      'through the same fetch tool). This is the single entry point for finding what to fetch — you ' +
      'do not choose a database first, the results tell you which source has the series.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "child mortality", "co2 emissions", "inflation forecast"' },
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
    name: 'fetch_series',
    description:
      'Fetch time-series data for ONE series id from find_series — the single fetch tool. It ROUTES ' +
      'automatically by the id: plain World Bank codes (e.g. SH.DYN.MORT), "owid:<slug>", and ' +
      '"imf:<code>" each go to their own source. Returns rows of {country, iso3, year, value, ' +
      'indicator}. Give `countries` (ISO3 codes, or loose names like "UK"/"Korea" which are resolved ' +
      'for you; one aggregate like ["WLD"] works too) for named countries/regions, or OMIT countries ' +
      'for EVERY country — World Bank is batched internally, so never build the full country list ' +
      'yourself. IMF series include projection years beyond today — say "IMF projection" when you use ' +
      'them. Pass the id verbatim from find_series.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Series id from find_series, verbatim: a plain World Bank code (e.g. "SH.DYN.MORT"), ' +
            '"owid:<slug>", or "imf:<code>".',
        },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ISO3 codes or loose names, e.g. ["IND","CHN","BRA"] or ["UK"]; one aggregate like ' +
            '["WLD"] works too. Omit for every country (World Bank batches internally).',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write an intermediate artifact to the virtual filesystem (visible to the user). ' +
      'Set derived=true when the content is model-derived — anything produced by an llm() ' +
      'call inside execute_js (labels, classifications, summaries), not fetched from a data ' +
      'source. Derived files are labelled "model-derived" and must never be cited as data.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'e.g. plan.md, indicator_shortlist.json' },
        content: { type: 'string' },
        derived: {
          type: 'boolean',
          description:
            'true if this content was produced via llm() (model-derived, not fetched). ' +
            'Marks the file model-derived so it is never mistaken for fetched data.',
        },
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
  {
    name: 'delegate_source',
    description:
      'Delegate ONE database\'s part of the question to a focused sub-agent, and get back a short ' +
      'distilled summary (the sub-agent\'s fetched rows merge into your data automatically, with ' +
      'their citations intact — you never see the raw rows). Offered only when more than one ' +
      'database is active. Use it ONLY for questions that genuinely span multiple databases: ' +
      'delegate each source\'s slice, then combine the summaries. For anything one database ' +
      'answers on its own, use the direct fetch/compute tools — delegation spends extra model ' +
      'calls. Call it once per source (you may call it a few times, one source each).',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The database to delegate to — its name or id (e.g. "Our World in Data", "owid", "IMF", "World Bank").',
        },
        question: {
          type: 'string',
          description: 'The focused, single-source sub-question, e.g. "life expectancy for G7 countries since 1960".',
        },
      },
      required: ['source', 'question'],
    },
  },
];

// The sub-agent's terminal tool — hands a distilled text summary back to the
// main agent and ends the sub-agent loop. Kept OUT of TOOL_SCHEMAS (and thus
// out of every main-loop schema set); it exists only inside a delegation.
export const RETURN_FINDINGS_SCHEMA: ToolSchema = {
  name: 'return_findings',
  description:
    'Finish this sub-agent and return a SHORT distilled summary (a few sentences: the key ' +
    'numbers and what they show) to the main agent. Your fetched rows are already merged back ' +
    'with their citations — do not paste raw rows here. Call this once you have what the ' +
    'sub-question needs.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The distilled text summary for the main agent.' },
    },
    required: ['summary'],
  },
};

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
  // Grouping axis for the picker — sources sharing a category render under one
  // header, so the list stays legible as the registry grows to many sources.
  category: string;
  blurb: string; // one line, shown next to the name in the picker
  // Extra source-specific tool names (from TOOL_SCHEMAS) this source owns, on
  // top of the always-on core. Fetching is NO LONGER listed here: it goes
  // through the source-agnostic core `fetch_series`, which routes by the id's
  // namespace (plain code → World Bank, "owid:" → OWID, "imf:" → IMF) and is
  // restricted to the active/sub-agent source at dispatch time. So this is
  // empty for today's sources; kept for a future source that needs its own tool.
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
  'find_series', 'fetch_series', 'list_countries', 'execute_js', 'growth_stats', 'correlate',
  'render_chart', 'finish', 'finish_explanation', 'write_file', 'read_file',
];

export const SOURCES: SourceDef[] = [
  {
    id: 'worldbank',
    label: 'World Bank',
    category: 'Economics & development',
    blurb: 'Development, economic, health & social indicators for every country.',
    toolNames: [],
    promptSnippet:
      'World Bank — the broad default: development, economic, health, and social indicators. Its find_series hits are plain codes (e.g. SH.DYN.MORT); fetch them with fetch_series — pass explicit countries (ISO3 codes, or one aggregate like WLD), or omit countries for "every country" questions (fetch_series batches World Bank internally — never build the full country list yourself).',
    cite: { name: 'World Bank Open Data', url: 'https://data.worldbank.org' },
  },
  {
    id: 'owid',
    label: 'Our World in Data',
    category: 'Society & environment',
    blurb: 'CO₂ & energy, happiness, HDI, literacy, extreme poverty.',
    toolNames: [],
    promptSnippet:
      'Our World in Data — topics World Bank lacks: CO2/energy, happiness, HDI, literacy, extreme poverty. Its find_series hits look like "owid:<slug>"; fetch them with fetch_series.',
    cite: { name: 'Our World in Data', url: 'https://ourworldindata.org' },
    datasetSource: 'owid',
  },
  {
    id: 'imf',
    label: 'IMF',
    category: 'Economics & development',
    blurb: 'Macro data with multi-year forecasts: GDP, inflation, debt.',
    toolNames: [],
    promptSnippet:
      'IMF DataMapper — the source for forecasts/projections several years ahead: GDP growth, inflation, unemployment, government debt. Its find_series hits look like "imf:<code>"; fetch them with fetch_series, and say "IMF projection" when you use projected years.',
    cite: { name: 'IMF DataMapper', url: 'https://www.imf.org/external/datamapper' },
    datasetSource: 'imf',
  },
];

export const DEFAULT_SOURCE_IDS = SOURCES.map((s) => s.id);

// Sources grouped by category, preserving first-seen category order — the
// shape the picker renders (one header per category). Scales the UI as the
// registry grows without the picker code needing to know the categories.
export function sourcesByCategory(): { category: string; sources: SourceDef[] }[] {
  const order: string[] = [];
  const byCat = new Map<string, SourceDef[]>();
  for (const s of SOURCES) {
    if (!byCat.has(s.category)) { byCat.set(s.category, []); order.push(s.category); }
    byCat.get(s.category)!.push(s);
  }
  return order.map((category) => ({ category, sources: byCat.get(category)! }));
}

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
  const sources = resolveSources(ids);
  const allowed = new Set(CORE_TOOL_NAMES);
  for (const s of sources) for (const t of s.toolNames) allowed.add(t);
  // delegate_source is offered to the MAIN loop only when more than one source
  // is active — a single-source session has nothing to delegate across, so the
  // tool never even appears in its schema (the dispatch refuses it too).
  if (sources.length > 1) allowed.add('delegate_source');
  return TOOL_SCHEMAS.filter((sch) => allowed.has(sch.name));
}

// The tool schema set for a depth-1 per-source sub-agent (a delegation target).
// Scoped to ONE database: find_series (the caller restricts it to this source),
// fetch_series (the router refuses out-of-namespace ids for this sub-agent's
// source at dispatch time), execute_js (with the recursive llm() primitive),
// plus return_findings. delegate_source is structurally absent — a sub-agent can
// never itself delegate, so recursion is bounded to depth 1. `sourceId` names
// the source the dispatcher restricts fetch_series to; the schema itself is the
// same router tool for every source (routing/restriction happen at runtime).
export function subAgentSchemasFor(sourceId: string): ToolSchema[] {
  void sourceId; // runtime restriction lives in dispatch (sourceIds); see note above
  const names = new Set<string>(['find_series', 'fetch_series', 'execute_js']);
  const base = TOOL_SCHEMAS.filter((sch) => names.has(sch.name));
  return [...base, RETURN_FINDINGS_SCHEMA];
}

// The dataset-catalog sources (owid/imf) among a selection — pushed into
// searchDatasets so the shared catalog tool respects the hard filter.
export function datasetSourcesFor(ids?: string[]): Dataset['source'][] {
  return resolveSources(ids)
    .map((s) => s.datasetSource)
    .filter((x): x is Dataset['source'] => !!x);
}

export interface SeriesHit {
  id: string; // fetch id: plain WB code, "owid:<slug>", or "imf:<code>"
  name: string;
  source: string; // registry source id: 'worldbank' | 'owid' | 'imf' | …
}

// Structured metadata for the UI's search-receipt card: how much was searched,
// how many candidates were considered, and — for the top match — which query
// terms/synonyms actually fired. UI-only; the model still just gets SeriesHit[].
export interface SearchReceipt {
  query: string;
  sourcesSearched: string[]; // friendly labels of the databases searched
  candidateCount: number; // scored (>0) candidate series gathered, pre-dedup
  hitCount: number; // returned hits after dedup + cap
  topMatch?: {
    id: string;
    name: string;
    source: string; // registry source id
    sourceLabel: string; // friendly database name for the card
    matchedBase: string[];
    matchedSynonyms: { term: string; synonym: string }[];
  };
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

// One search across every active database, so the model calls a single tool
// instead of choosing between per-source search tools and guessing which
// database holds the metric. Each source contributes hits from its own
// catalog; the returned id already carries the namespace the fetch tools
// route on, and `source` names the database for the model's benefit.
export async function findSeries(query: string, activeIds?: string[]): Promise<SeriesHit[]> {
  return (await findSeriesWithReceipt(query, activeIds)).hits;
}

// findSeries plus the UI receipt: the same hits, alongside structured metadata
// (databases searched, candidates considered, and the top match's term/synonym
// provenance) that the trace renders as a search-receipt card. Kept separate so
// findSeries's SeriesHit[] contract — and everything that calls it — is unchanged.
export async function findSeriesWithReceipt(
  query: string,
  activeIds?: string[]
): Promise<{ hits: SeriesHit[]; receipt: SearchReceipt }> {
  const activeSources = resolveSources(activeIds);
  const active = new Set(activeSources.map((s) => s.id));
  const hits: SeriesHit[] = [];

  // World Bank first — it's the broad default, and searchIndicators also falls
  // back to the live WB search API when the curated set is thin.
  if (active.has('worldbank')) {
    const wb = await searchIndicators(query);
    hits.push(...wb.map((i) => ({ id: i.id, name: i.name, source: 'worldbank' })));
  }

  // OWID/IMF share one curated catalog; filter it to whichever is active.
  const catalogSources = datasetSourcesFor(activeIds);
  if (catalogSources.length) {
    const ds = searchDatasets(query, catalogSources);
    hits.push(...ds.map((d) => ({ id: d.id, name: d.name, source: d.source })));
  }

  // OWID live fallback: the curated OWID list, though expanded, still can't
  // cover OWID's full grapher catalog, so when OWID is active and few curated
  // hits came back, widen with the live grapher index. Curated hits are pushed
  // first, so dedup keeps their friendlier names. Any failure degrades to [] —
  // the curated hits still stand (OWID has no confirmed keyless catalog endpoint,
  // so this fallback is expected to be empty in many sessions).
  if (active.has('owid') && hits.filter((h) => h.source === 'owid').length < 3) {
    hits.push(...(await searchOwidCatalog(query)));
  }

  // IMF live fallback: the curated IMF list is tiny, so when IMF is active and
  // few curated hits came back, search the full DataMapper catalog. Curated
  // hits are pushed first, so dedup keeps their friendlier names.
  if (active.has('imf') && hits.filter((h) => h.source === 'imf').length < 3) {
    hits.push(...(await searchImfCatalog(query)));
  }

  // candidateCount is the scored (>0) series gathered across every searched
  // database, before dedup and the display cap — a faithful "how many the
  // scorer actually considered" for the receipt.
  const candidateCount = hits.length;
  const seen = new Set<string>();
  const deduped = hits
    .filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)))
    // Rank across ALL sources by relevance, not by source order. The hits are
    // gathered source-by-source (World Bank block, then the OWID/IMF catalog),
    // so without this a weak World Bank hit outranks a far stronger OWID/IMF
    // match purely because its source was searched first. Array.sort is stable,
    // so equal scores keep their gather order — World Bank still wins genuine
    // ties, and curated hits still precede the live-catalog ones.
    .sort((a, b) => scoreSeries(query, b.id, b.name) - scoreSeries(query, a.id, a.name))
    .slice(0, 12);

  const labelOf = (id: string) => activeSources.find((s) => s.id === id)?.label ?? id;
  const top = deduped[0];
  const receipt: SearchReceipt = {
    query,
    sourcesSearched: activeSources.map((s) => s.label),
    candidateCount,
    hitCount: deduped.length,
    topMatch: top
      ? { id: top.id, name: top.name, source: top.source, sourceLabel: labelOf(top.source), ...explainMatch(query, top.id, top.name) }
      : undefined,
  };
  return { hits: deduped, receipt };
}
