// sources/types.ts — the data-source adapter interface: the single contract
// every institutional data source (World Bank, OWID, IMF, WHO) implements so
// the router (routeFetch), the cross-source search (findSeriesWithReceipt), and
// citation-building are GENERIC over sources. Adding a fifth source means
// writing one new adapter file that satisfies this interface and adding it to
// the SOURCES list in ./index — nothing in the router, search, or citation
// code changes. This module is at the BOTTOM of the source layer: it holds only
// types (plus the shared Dataset/SeriesHit/SearchReceipt/SourceDef shapes that
// used to live in tools.ts), so the adapter files and index can import from it
// without a cycle.
import type { DataRow } from '../tools';

export interface Dataset {
  id: string; // namespaced: "owid:<slug>", "imf:<code>", or "who:<IndicatorCode>"
  name: string;
  source: 'owid' | 'imf' | 'who';
  note?: string;
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

// The unified result an adapter's fetchSeries returns. rows/requestUrl are
// always present; the rest are per-source optionals the router reads when
// present (WB every-country batching sets countryCount/batchCount; a WB
// specific-country fetch over the 60-cap sets truncatedFrom; OWID sets the
// metric column name; a source with a data vintage sets sourceUpdated). The
// router assembles the model-facing body/detail from these + the adapter's
// small describe hooks, so no per-source switch survives in routeFetch.
export interface FetchSeriesResult {
  rows: DataRow[];
  requestUrl: string;
  sourceUpdated?: string;
  truncatedFrom?: number; // WB specific-country over-60-cap
  countryCount?: number;  // WB every-country
  batchCount?: number;    // WB every-country
  metric?: string;        // OWID metric column
}

export interface CatalogEntry {
  id: string;   // namespaced fetch id (plain WB code, "owid:<slug>", …)
  name: string;
}

// One data source, fully described: the picker/prompt metadata (the old
// SourceDef fields) PLUS everything the router/search/citation need to treat it
// generically. Extends SourceDef so a SourceAdapter[] is usable everywhere a
// SourceDef[] was.
export interface SourceAdapter extends SourceDef {
  // ── Citation identity ──
  // The stable source tag stored on citations (equals `id` for today's four).
  citationSource: 'worldbank' | 'owid' | 'imf' | 'who';
  // Friendly institution name for the citation ledger (e.g. "World Bank Open
  // Data") — distinct from `label` (the short picker name, e.g. "World Bank").
  sourceLabel: string;
  // The human-visitable canonical page a citation LINKS to, for a given id.
  humanUrl(indicatorId: string): string;

  // ── Id namespace ──
  // Does this source own the id's namespace? ("owid:"/"imf:"/"who:" prefixes;
  // World Bank owns bare, colon-free codes.) The first adapter to match wins.
  matchesId(id: string): boolean;
  // The normalized citation id (the "nid") for a fetch id — the form stored on
  // the citation ledger and in state.indicators.
  normalizeId(id: string): string;

  // ── Curated catalog + search ──
  curated: CatalogEntry[];      // hand-curated round-tripping entries
  // Does this source contribute to the SHARED dataset catalog (DATASETS +
  // searchDatasets)? True for the OWID/IMF/WHO catalog sources; false for World
  // Bank, which has its own primary search over the large indicators.json.
  usesSharedCatalog: boolean;
  // The source's PRIMARY search contribution (World Bank's curated+live-API
  // search). Run first, before the shared catalog block. Catalog sources omit it.
  primarySearch?(query: string): Promise<SeriesHit[]>;
  // The live-catalog fallback: widen past the curated list when this source is
  // active and returned fewer than 3 curated hits. Any failure degrades to [].
  liveCatalogSearch?(query: string): Promise<SeriesHit[]>;

  // ── Id-space guard (routeFetch) ──
  // World Bank's live id space dwarfs indicators.json, so an unknown WB id
  // PROCEEDS (marked "unverified id"); the curated-catalog sources have a CLOSED
  // id space, so an unknown id is refused with a find_series steer.
  openIdSpace: boolean;
  idLabel: string; // "World Bank indicator" | "OWID slug" | "IMF code" | …
  // Is this id in the source's own curated catalog? (Trusted by the guard.)
  hasCuratedId(id: string): boolean;

  // ── Fetch + describe (routeFetch) ──
  fetchSeries(
    id: string,
    countries: string[] | undefined,
    yearStart: number | undefined,
    yearEnd: number | undefined,
    signal?: AbortSignal
  ): Promise<FetchSeriesResult>;
  // Does an every-country (no-countries) fetch report batch/country counts?
  // (World Bank only — its every-country path batches internally.)
  reportsBatches: boolean;
  // The per-source receipt-detail suffix appended after "<n> rows" (WB adds a
  // truncation clause; OWID/IMF/WHO add a " · SOURCE" tag).
  detailSuffix(result: FetchSeriesResult): string;
  // The friendly label stored in state.indicators for a fetched nid.
  indicatorLabel(nid: string, result: FetchSeriesResult): string;
}
