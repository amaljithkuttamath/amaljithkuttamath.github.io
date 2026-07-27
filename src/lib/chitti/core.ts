// core.ts — the bottom of Chitti's data layer: the bundled reference tables,
// the core row/spec types, and the structured API-rejection error.
//
// WHY THIS FILE EXISTS. These lived in tools.ts, which is the FACADE: it
// re-exports ./sources so callers get one import. Every source adapter also
// needed COUNTRIES / INDICATORS / listCountries / ApiRejection, and imported
// them from that facade — closing the loop
//   sources/<adapter> -> tools -> sources/index -> sources/<adapter>
// sources/index builds the SOURCES array at module scope, so whichever module
// the loop is entered through determines whether that array sees a fully
// initialised adapter or `undefined`. Entering through tools.ts happened to
// work; entering through an adapter file did not, and failed with
// "Cannot read properties of undefined (reading \'usesSharedCatalog\')".
//
// That is not a theoretical hazard: it broke the mirror test, and then broke
// the snapshot workflow on the runner, because the generator loaded
// sources/worldbank.ts as its entry point. Moving these to a module that
// imports nothing from the app removes the loop rather than ordering around it,
// so any file can be an entry point. tools.ts re-exports everything here, so
// `import { COUNTRIES } from \'./tools\'` keeps working everywhere.
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

export type CountryFilter = 'all' | 'oecd' | string;

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
