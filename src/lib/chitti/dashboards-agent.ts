// dashboards-agent.ts — the agent-side dashboard glue: tile-reference
// resolution (resolveTileRef), the session-less "refresh data" pipeline
// (refreshDashboard / refreshTile / refetchCitation), the shared citation
// builder (buildCitation), and small helpers (indicatorName, defaultDashboardTitle).
// The refresh pipeline reuses the router's building blocks (the same country
// resolver + per-source fetchers + buildCitation) with NO LLM call and NO
// ChittiSession, driven straight off a tile's stored citations. Moved verbatim
// from agent.ts; only imports/exports adjusted.
import {
  loadDashboard,
  saveDashboard,
  touchTileData,
  markTileStale,
  type Dashboard,
  type Tile,
  type StorageLike as DashboardStorage,
} from './dashboard';
import { resolveCountryList } from './countries';
import {
  fetchWorldbank,
  fetchWorldbankAll,
  fetchOwid,
  fetchImf,
  fetchWho,
  adapterById,
  ApiRejection,
  INDICATORS,
  datasetName,
  type Citation,
  type DataRow,
} from './tools';
import { AbortedError } from './abort';

// A default dashboard title derived from the question when the model (or user)
// names none: the question itself, trimmed to a sane length. Pure + exported for
// its unit table.
// Resolve a tile reference (from edit_dashboard) to a concrete tile: EXACT title
// first, then case-insensitive title, then a 1-based index. Ambiguous (two tiles
// share a title) or unresolvable references fail with a message that LISTS the
// dashboard's tiles, so the model (or a user) can correct the reference. Pure +
// exported for the resolution unit table.
export function resolveTileRef(
  dash: Dashboard,
  ref: { title?: string; index?: number }
): { ok: true; tile: Tile } | { ok: false; error: string } {
  const list = dash.tiles.length
    ? dash.tiles.map((t, i) => `${i + 1}. "${t.title}"`).join(', ')
    : '(no tiles)';
  const fail = (lead: string) => ({ ok: false as const, error: `${lead} Tiles in "${dash.title}": ${list}.` });

  const title = String(ref.title ?? '').trim();
  if (title) {
    const exact = dash.tiles.filter((t) => t.title === title);
    if (exact.length === 1) return { ok: true, tile: exact[0] };
    if (exact.length > 1) return fail(`More than one tile is titled "${title}" — reference it by position (tile_index) instead.`);
    const ci = dash.tiles.filter((t) => t.title.toLowerCase() === title.toLowerCase());
    if (ci.length === 1) return { ok: true, tile: ci[0] };
    if (ci.length > 1) return fail(`More than one tile matches "${title}" (case-insensitive) — reference it by position (tile_index) instead.`);
    return fail(`No tile titled "${title}".`);
  }
  if (ref.index !== undefined && Number.isFinite(ref.index)) {
    const i = Math.trunc(ref.index) - 1; // 1-based
    if (i >= 0 && i < dash.tiles.length) return { ok: true, tile: dash.tiles[i] };
    return fail(`No tile at position ${ref.index}.`);
  }
  return fail('Name a tile by title (tile_title) or position (tile_index).');
}

// Orchestrate a whole-dashboard "refresh data" run: reload the dashboard fresh
// from the store, re-fetch each tile's series (refreshTile), apply the outcome
// through the PURE ops (touchTileData on success, markTileStale on failure), and
// PERSIST after every tile so completed tiles stick and the live refresh log can
// stream. Aborting stops the loop at the next tile boundary, leaving the
// remaining (unprocessed) tiles untouched. Reused by BOTH the agent tool and the
// dashboard-view refresh button — the single refresh code path. `onTile` fires
// after each tile is applied+saved, for the UI's per-tile receipt line.
export async function refreshDashboard(
  store: DashboardStorage,
  dashId: string,
  opts?: { signal?: AbortSignal; onTile?: (r: TileRefreshResult, dash: Dashboard) => void }
): Promise<{ dashboard: Dashboard | null; results: TileRefreshResult[]; aborted: boolean; saveError?: string }> {
  const signal = opts?.signal;
  let dash = loadDashboard(store, dashId);
  if (!dash) return { dashboard: null, results: [], aborted: false };
  const results: TileRefreshResult[] = [];
  // Iterate a snapshot of the ORIGINAL tile list (by id), so a per-tile save that
  // rewrites the document never changes what we iterate over.
  const tiles = [...dash.tiles];
  for (const tile of tiles) {
    if (signal?.aborted) return { dashboard: dash, results, aborted: true };
    let res: TileRefreshResult;
    try {
      res = await refreshTile(tile, signal);
    } catch (err: any) {
      if (err instanceof AbortedError || signal?.aborted || err?.name === 'AbortError') {
        return { dashboard: dash, results, aborted: true };
      }
      throw err;
    }
    dash = res.ok
      ? touchTileData(dash, res.tileId, res.rows!, res.citations!, res.refreshedAt!)
      : markTileStale(dash, res.tileId, res.reason!);
    const saved = saveDashboard(store, dash);
    if (!saved.ok) return { dashboard: dash, results, aborted: false, saveError: saved.error };
    results.push(res);
    opts?.onTile?.(res, dash);
  }
  return { dashboard: dash, results, aborted: false };
}

export function defaultDashboardTitle(question: string): string {
  const q = String(question ?? '').trim().replace(/\s+/g, ' ');
  if (!q) return 'My dashboard';
  return q.length > 60 ? q.slice(0, 57).trimEnd() + '…' : q;
}

export function indicatorName(id: string): string {
  // Enrich the raw indicator id with its friendly curated name when we have
  // one — checking the World Bank list first, then the OWID/IMF catalogs.
  const hit = INDICATORS.find((i) => i.id === id);
  return hit ? hit.name : (datasetName(id) ?? id);
}

// Build one citation record from a completed fetch's provenance. Pure and
// module-level so BOTH the live routeFetch (via recordCitation) and the
// session-less refresh path (refreshTileData below) construct citations
// identically — same fields, same fetchedAt-vs-sourceUpdated discipline. `id` is
// the ledger/cache key; it is a derived key, never user input, so it carries no
// secret. requestUrl is kept only when it genuinely differs from the human page.
export function buildCitation(
  id: string,
  source: 'worldbank' | 'owid' | 'imf' | 'who',
  nid: string,
  codes: string[],
  ys: number | undefined,
  ye: number | undefined,
  rowCount: number,
  requestUrl: string,
  sourceUpdated: string | undefined
): Citation {
  // Citation identity is now GENERIC over the source adapter (same strings the
  // legacy citationHumanUrl/citationSourceLabel produced, sourced from the one
  // registry). source is always one of the four known sources, so adapterById
  // never misses.
  const adapter = adapterById(source)!;
  const humanUrl = adapter.humanUrl(nid);
  return {
    id,
    source,
    sourceLabel: adapter.sourceLabel,
    indicatorId: nid,
    indicatorName: indicatorName(nid),
    url: humanUrl,
    ...(requestUrl && requestUrl !== humanUrl ? { requestUrl } : {}),
    countries: codes,
    yearRange: ys !== undefined || ye !== undefined ? { start: ys, end: ye } : null,
    fetchedAt: new Date().toISOString(),
    ...(sourceUpdated ? { sourceUpdated } : {}),
    rowCount,
    cached: false,
  };
}

// ── The refresh pipeline (increment 2) ───────────────────────────────────────
// "Refresh data" re-pulls a saved tile's series straight from the source APIs,
// with NO LLM call and NO ChittiSession. It is a session-less pipeline that
// reuses the router's own building blocks — the same country resolver
// (resolveCountryList), the same per-source fetchers (fetchWorldbank/…/fetchWho),
// and the same buildCitation the live ledger uses — driven directly off a tile's
// stored citations, which already carry everything a refetch needs (source,
// indicatorId, resolved country codes, year range). We deliberately do NOT reuse
// the session fetch cache: refresh's whole purpose is to bypass a stale cached
// answer and re-pull from source. This design was chosen over spinning up a
// "lightweight internal session" because a session drags in the whole tool loop
// and a required provider `complete()` call for work the tile can already
// describe itself — while still guaranteeing cache/citation/country behaviour
// identical to a live run, because it goes through the very same code paths.

// Re-fetch ONE of a tile's citations (one series). Returns fresh rows and a
// freshly-built citation (new fetchedAt, refreshed sourceUpdated when the source
// carries one). Country codes are routed through the SAME resolver a live fetch
// uses; a tile's stored codes are already canonical, so this is a fixpoint that
// keeps refresh's country handling identical to routeFetch. `signal` lets a
// refresh run abort mid-flight (reuses the fetchers' AbortSignal support).
async function refetchCitation(
  cit: Citation,
  signal?: AbortSignal
): Promise<{ rows: DataRow[]; citation: Citation }> {
  const source = cit.source;
  const id = cit.indicatorId; // the namespaced nid — the fetchers strip prefixes
  const ys = cit.yearRange?.start;
  const ye = cit.yearRange?.end;
  const resolved = cit.countries.length ? resolveCountryList(cit.countries) : undefined;
  const codes = resolved?.codes ?? [];
  const has = codes.length > 0;

  let rows: DataRow[] = [];
  let requestUrl = '';
  let sourceUpdated: string | undefined;

  switch (source) {
    case 'worldbank': {
      if (has) {
        const r = await fetchWorldbank(id, codes, ys, ye, signal);
        rows = r.rows; requestUrl = r.requestUrl; sourceUpdated = r.sourceUpdated;
      } else {
        const r = await fetchWorldbankAll(id, ys, ye, signal);
        rows = r.rows; requestUrl = r.requestUrl; sourceUpdated = r.sourceUpdated;
      }
      break;
    }
    case 'owid': {
      const r = await fetchOwid(id, has ? codes : undefined, ys, ye, signal);
      rows = r.rows; requestUrl = r.requestUrl;
      break;
    }
    case 'imf': {
      const r = await fetchImf(id, has ? codes : undefined, ys, ye, signal);
      rows = r.rows; requestUrl = r.requestUrl;
      break;
    }
    case 'who': {
      const r = await fetchWho(id, has ? codes : undefined, ys, ye, signal);
      rows = r.rows; requestUrl = r.requestUrl;
      break;
    }
  }

  const citation = buildCitation(cit.id, source, id, codes, ys, ye, rows.length, requestUrl, sourceUpdated);
  return { rows, citation };
}

// The outcome of refreshing ONE tile — surfaced to the UI/agent as a receipt
// line and used to decide touchTileData (ok) vs markTileStale (failed).
export interface TileRefreshResult {
  tileId: string;
  title: string;
  ok: boolean;
  // On success: fresh rows + citations + the refresh timestamp (feed straight to
  // touchTileData). On failure: a short reason (feed to markTileStale).
  rows?: DataRow[];
  citations?: Citation[];
  refreshedAt?: string;
  reason?: string;
  // A compact receipt detail, receipt-style, for the refresh log:
  //   "234 rows · WB · source updated 2024-12-16" | "network error, kept previous data"
  detail: string;
}

// Short source tag for the refresh-log receipt line.
function refreshSourceTag(source: Citation['source']): string {
  return source === 'worldbank' ? 'WB' : source === 'owid' ? 'OWID' : source === 'imf' ? 'IMF' : 'WHO';
}

// Refresh a SINGLE tile: re-fetch every one of its series (citations), merge the
// rows, and collect the fresh citations. A tile with no citations cannot be
// refreshed (there is nothing to re-pull) — reported as a clean, honest failure
// rather than a blanked tile. An abort throws AbortedError so the caller can
// stop the whole run and leave the remaining tiles untouched. Any fetch failure
// (network, structured rejection, empty) is caught and turned into a stale
// outcome: the tile keeps its previous data.
export async function refreshTile(tile: Tile, signal?: AbortSignal): Promise<TileRefreshResult> {
  if (signal?.aborted) throw new AbortedError();
  if (!tile.citations.length) {
    return {
      tileId: tile.id,
      title: tile.title,
      ok: false,
      reason: 'no source to refresh',
      detail: 'no citations to refresh from, kept previous data',
    };
  }
  const allRows: DataRow[] = [];
  const freshCites: Citation[] = [];
  const sources = new Set<string>();
  const vintages: string[] = [];
  try {
    for (const cit of tile.citations) {
      if (signal?.aborted) throw new AbortedError();
      const { rows, citation } = await refetchCitation(cit, signal);
      allRows.push(...rows);
      freshCites.push(citation);
      sources.add(refreshSourceTag(citation.source));
      if (citation.sourceUpdated) vintages.push(citation.sourceUpdated);
    }
  } catch (err: any) {
    if (err instanceof AbortedError || signal?.aborted || err?.name === 'AbortError') {
      throw new AbortedError();
    }
    const reason = refreshFailureReason(err);
    return {
      tileId: tile.id,
      title: tile.title,
      ok: false,
      reason,
      detail: `${reason}, kept previous data`,
    };
  }
  const refreshedAt = new Date().toISOString();
  const vintage = vintages.sort();
  const latest = vintage.length ? vintage[vintage.length - 1] : '';
  const detail =
    `${allRows.length} row${allRows.length === 1 ? '' : 's'} · ${[...sources].join('/')}` +
    (latest ? ` · source updated ${latest}` : '');
  return { tileId: tile.id, title: tile.title, ok: true, rows: allRows, citations: freshCites, refreshedAt, detail };
}

// Map a caught fetch error to a short, honest refresh-log reason. Structured API
// rejections and HTTP/network/CORS failures each get plain wording — never
// invented, never blank.
function refreshFailureReason(err: any): string {
  if (err instanceof ApiRejection) return 'source rejected the series';
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (msg.includes('no data')) return 'no data returned';
  if (msg.includes('http')) return 'source API error';
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('cors')) return 'network error';
  return 'refresh failed';
}
