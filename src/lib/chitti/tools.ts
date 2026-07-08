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
// per call, matching the API's practical multi-country limit.
export async function fetchWorldbank(
  indicatorId: string,
  countryIds: string[],
  yearStart: number,
  yearEnd: number
): Promise<DataRow[]> {
  const codes = countryIds
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 60)
    .join(';');
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
  return rows;
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
      'Fetch time-series data for one indicator across one or more countries (by ISO3 code). ' +
      'Returns rows of {country, iso3, year, value}. Use for actual data retrieval.',
    parameters: {
      type: 'object',
      properties: {
        indicator_id: { type: 'string', description: 'World Bank indicator id, e.g. SH.DYN.MORT' },
        country_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'ISO3 codes, e.g. ["IND","CHN","BRA"]. Use aggregate ids like "WLD" for world.',
        },
        year_start: { type: 'number' },
        year_end: { type: 'number' },
      },
      required: ['indicator_id', 'country_ids', 'year_start', 'year_end'],
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
