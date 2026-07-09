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
  const header = 'country,iso3,year,value';
  const body = rows
    .map((r) => `${csvCell(r.country)},${r.iso3},${r.year},${r.value ?? ''}`)
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
      'receives one argument, `rows`, an array of {country, iso3, year, value} objects (the ' +
      'combined result of every fetch_worldbank/fetch_worldbank_all call so far). Whatever your ' +
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
      'Signal completion with a single, tight one-line finding — the top-line takeaway only. ' +
      'No methodology, no caveats.',
    parameters: {
      type: 'object',
      properties: {
        one_line_finding: { type: 'string', description: 'One sentence, the finding.' },
      },
      required: ['one_line_finding'],
    },
  },
];
