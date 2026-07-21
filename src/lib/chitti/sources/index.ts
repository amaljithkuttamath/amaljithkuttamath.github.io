// sources/index.ts — the data-source registry and the generic cross-source
// operations built on the SourceAdapter interface. SOURCES is the ordered
// adapter list (World Bank first — the broad default). Everything here is
// GENERIC over that list: findSeriesWithReceipt, the id->source router helpers,
// the shared dataset catalog, and the schema/selection helpers all iterate the
// registry, so adding a fifth source is: write one adapter file + append it to
// SOURCES. No per-source branching lives here.
import type { ToolSchema } from '../providers';
import { TOOL_SCHEMAS, RETURN_FINDINGS_SCHEMA, CORE_TOOL_NAMES } from '../schemas';
import { explainMatch, scoreSeries } from '../scoring';
import type { SourceAdapter, SourceDef, Dataset, SeriesHit, SearchReceipt } from './types';
import { worldbankAdapter } from './worldbank';
import { owidAdapter } from './owid';
import { imfAdapter } from './imf';
import { whoAdapter } from './who';

export type { SourceAdapter, SourceDef, Dataset, SeriesHit, SearchReceipt, FetchSeriesResult, CatalogEntry } from './types';

// ── The registry ─────────────────────────────────────────────────────────
// The single source of truth for "which databases exist". One adapter per
// database feeds BOTH the UI picker (label + blurb) and the agent (fetch/search
// + prompt guidance + citation). Adding a database = write its adapter file and
// append it here; the picker, router, search, and citation code need no change.
export const SOURCES: SourceAdapter[] = [worldbankAdapter, owidAdapter, imfAdapter, whoAdapter];

// The shared dataset catalog: the curated entries of every catalog-style source
// (OWID/IMF/WHO), tagged with the source. Assembled from the adapters, in
// registry order, so a new catalog source joins it automatically.
export const DATASETS: Dataset[] = SOURCES
  .filter((s) => s.usesSharedCatalog)
  .flatMap((a) => a.curated.map((c): Dataset => ({ id: c.id, name: c.name, source: a.datasetSource! })));

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

// Normalize an incoming selection: keep only known ids; empty/unknown -> all.
export function resolveSources(ids?: string[]): SourceAdapter[] {
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

// ── id -> source routing (was fetchSourceOf in agent.ts) ──────────────────
// The adapter whose namespace owns this id, or undefined for an unrecognized
// namespace. Registry order + matchesId decides: "owid:"/"imf:"/"who:" match
// their prefix; World Bank matches any bare (colon-free) code. A namespaced id
// with an unknown prefix matches nothing -> undefined (surfaced as a routing
// error, never silently treated as a World Bank code).
export function adapterOfId(id: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.matchesId(id));
}
// The adapter registered under a source id ('worldbank' | 'owid' | ...).
export function adapterById(id: string): SourceAdapter | undefined {
  return SOURCES.find((s) => s.id === id);
}
// The source id an fetch id routes to, or 'unknown'. Mirrors the old
// fetchSourceOf exactly.
export function sourceOfId(id: string): 'worldbank' | 'owid' | 'imf' | 'who' | 'unknown' {
  return (adapterOfId(id)?.id as 'worldbank' | 'owid' | 'imf' | 'who' | undefined) ?? 'unknown';
}

// One search across every active database, so the model calls a single tool
// instead of choosing between per-source search tools and guessing which
// database holds the metric. Each source contributes hits from its own
// catalog; the returned id already carries the namespace the fetch tools
// route on, and `source` names the database for the model's benefit.
export async function findSeries(query: string, activeIds?: string[]): Promise<SeriesHit[]> {
  return (await findSeriesWithReceipt(query, activeIds)).hits;
}

// findSeries plus the UI receipt, GENERIC over the active adapters. The search
// runs in three registry-ordered phases, each driven by adapter metadata (no
// per-source if-chain): (1) each active source's PRIMARY search (World Bank's
// curated+live-API search); (2) the SHARED curated catalog for the active
// catalog sources (OWID/IMF/WHO), combined and capped together exactly as
// before; (3) each active source's live-catalog fallback, when it returned
// fewer than 3 hits. Then the same candidateCount / dedup / cross-source score
// re-rank / cap / receipt as the original.
export async function findSeriesWithReceipt(
  query: string,
  activeIds?: string[]
): Promise<{ hits: SeriesHit[]; receipt: SearchReceipt }> {
  const activeSources = resolveSources(activeIds);
  const hits: SeriesHit[] = [];

  // 1. Primary searches (World Bank), in registry order. searchIndicators also
  //    falls back to the live WB search API when the curated set is thin.
  for (const s of activeSources) {
    if (s.primarySearch) hits.push(...(await s.primarySearch(query)));
  }

  // 2. The shared curated dataset catalog (OWID/IMF/WHO), filtered to whichever
  //    catalog sources are active and searched together (one combined cap).
  const catalogSources = datasetSourcesFor(activeIds);
  if (catalogSources.length) {
    const ds = searchDatasets(query, catalogSources);
    hits.push(...ds.map((d) => ({ id: d.id, name: d.name, source: d.source })));
  }

  // 3. Live-catalog fallbacks, registry order: when a source is active and its
  //    curated hits are thin (<3), widen with its live catalog. Curated hits
  //    were pushed first, so dedup keeps their friendlier names. Any failure
  //    inside a source's liveCatalogSearch degrades to [] (curated hits stand).
  for (const s of activeSources) {
    if (s.liveCatalogSearch && hits.filter((h) => h.source === s.id).length < 3) {
      hits.push(...(await s.liveCatalogSearch(query)));
    }
  }

  // candidateCount is the scored (>0) series gathered across every searched
  // database, before dedup and the display cap.
  const candidateCount = hits.length;
  const seen = new Set<string>();
  const deduped = hits
    .filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)))
    // Rank across ALL sources by relevance, not by source order. Array.sort is
    // stable, so equal scores keep gather order (World Bank still wins ties,
    // curated still precede live-catalog hits).
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
