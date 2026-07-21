// ── Dashboards as artifacts (increment 1) ────────────────────────────────────
// A Dashboard is a versioned, client-persisted document of chart tiles, each
// carrying full provenance (the chart spec, the charted rows, and the citation
// ledger for those series). Users PIN a chart from any answer into a dashboard;
// later increments add conversational editing/refresh (increment 2) and sharing
// (increment 3), so the model is deliberately a plain, whitelist-rebuildable
// value type with no behavior baked in.
//
// Security posture mirrors share.ts: serialize/parse go through a whitelist
// rebuild, so a stray apiKey (or any unlisted field) planted on the input — at
// the dashboard, tile, spec, row, or citation level — is structurally incapable
// of surviving into the stored/parsed object. Parsing is defensive and inert:
// malformed input or an unknown version yields null, never a throw, never a
// half-built object.

import type { ChartSpec, DataRow, Citation } from './tools';
import { citationSourceLabel } from './tools';

// Bumped whenever the document shape changes incompatibly. parseDashboard gates
// on it: an unknown version yields null (a document we refuse to guess at).
export const DASHBOARD_VERSION = 1 as const;

// Soft byte cap per dashboard, for localStorage sanity — a single browser origin
// has a few MB total, and a dashboard is a working document, not an archive.
// addTile refuses to grow a dashboard past this, with a clear error.
export const DASHBOARD_SOFT_CAP_BYTES = 200_000;

// localStorage key namespace. One dashboard per key: `chitti:dash:<id>`.
export const DASHBOARD_NS = 'chitti:dash:';

// ── Types ────────────────────────────────────────────────────────────────────
export interface Tile {
  id: string;
  title: string;
  spec: ChartSpec; // the chart to re-render (carries its own series data)
  rows: DataRow[]; // the charted rows — fetched evidence only, never derived
  citations: Citation[]; // the citation ledger for this tile's series
  pinnedAt: string; // ISO timestamp: when this tile was pinned
  // A short human label for the tile's provenance line (e.g. "World Bank Open
  // Data · source updated 2024-12-16"). Derived from citations at pin time when
  // not supplied; kept on the tile so the view never has to recompute it.
  sourceNote?: string;
  // ── Refresh provenance (increment 2) ────────────────────────────────────
  // Set by touchTileData when a "refresh data" run successfully re-fetched this
  // tile's series from source: the moment Chitti last re-pulled it. Distinct
  // from pinnedAt (when the tile was first saved — refresh never changes it) and
  // from a citation's own fetchedAt.
  refreshedAt?: string;
  // Set by markTileStale when a refresh FAILED for this tile. The tile keeps its
  // last-good rows/citations (never blanked, never fabricated); this marker lets
  // the view show "refresh failed <date> — showing data from <original date>" in
  // muted styling. Cleared on the next successful refresh (touchTileData).
  stale?: { failedAt: string; reason: string };
}

export interface Dashboard {
  v: typeof DASHBOARD_VERSION;
  id: string;
  title: string;
  created: string; // ISO timestamp
  updated: string; // ISO timestamp, bumped by every mutating op
  tiles: Tile[];
}

// A compact listing shape (no rows/spec) for the dashboards index view.
export interface DashboardSummary {
  id: string;
  title: string;
  updated: string;
  tileCount: number;
}

// ── Id + clock ─────────────────────────────────────────────────────────────
// crypto.randomUUID is a global in both the browser and Node 20+ (the CI/runtime
// targets), so no Math.random and no dependency. A short prefix keeps ids
// self-describing in storage/debug.
function newId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : // Extremely defensive fallback for a stripped environment; never the
        // primary path. Still id-shaped, still collision-resistant enough here.
        `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `${prefix}_${uuid}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Whitelist cleaning (the security boundary) ───────────────────────────────
// Each rebuilds an object from named fields only. Anything not named — an
// apiKey, an internal handle, a __proto__ key — cannot survive the copy. Do not
// replace with a blacklist/delete approach. Mirrors share.ts's discipline.

const SPEC_TYPES = new Set(['line', 'bar', 'scatter', 'grouped-bar']);
const CITE_SOURCES = new Set(['worldbank', 'owid', 'imf', 'who']);

function str(x: unknown): string {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

function cleanSpec(spec: unknown): ChartSpec {
  const s = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
  const type = SPEC_TYPES.has(s.type as string) ? (s.type as ChartSpec['type']) : 'line';
  const seriesIn = Array.isArray(s.series) ? s.series : [];
  const series = seriesIn.map((ser) => {
    const so = (ser && typeof ser === 'object' ? ser : {}) as Record<string, unknown>;
    const dataIn = Array.isArray(so.data) ? so.data : [];
    const data = dataIn
      .filter((pt) => Array.isArray(pt) && pt.length >= 2)
      .map(
        (pt) =>
          [(pt as unknown[])[0] as number | string, Number((pt as unknown[])[1])] as [
            number | string,
            number,
          ]
      );
    return { name: str(so.name), data };
  });
  const out: ChartSpec = { type, title: str(s.title), series };
  if (s.x_axis != null) out.x_axis = str(s.x_axis);
  if (s.y_axis != null) out.y_axis = str(s.y_axis);
  return out;
}

function cleanRows(rows: unknown): DataRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const row: DataRow = {
      country: str(o.country),
      iso3: str(o.iso3),
      year: Number(o.year),
      value: o.value == null ? null : Number(o.value),
    };
    if (o.indicator != null) row.indicator = str(o.indicator);
    return row;
  });
}

function cleanYearRange(r: unknown): Citation['yearRange'] {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const out: { start?: number; end?: number } = {};
  if (o.start != null && Number.isFinite(Number(o.start))) out.start = Number(o.start);
  if (o.end != null && Number.isFinite(Number(o.end))) out.end = Number(o.end);
  return out.start === undefined && out.end === undefined ? null : out;
}

function cleanCitations(citations: unknown): Citation[] {
  if (!Array.isArray(citations)) return [];
  return citations.map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const cit: Citation = {
      id: str(o.id),
      source: (CITE_SOURCES.has(o.source as string) ? o.source : 'worldbank') as Citation['source'],
      sourceLabel: str(o.sourceLabel),
      indicatorId: str(o.indicatorId),
      indicatorName: str(o.indicatorName),
      url: str(o.url),
      countries: Array.isArray(o.countries) ? o.countries.map(str) : [],
      yearRange: cleanYearRange(o.yearRange),
      fetchedAt: str(o.fetchedAt),
      rowCount: Number(o.rowCount) || 0,
      cached: Boolean(o.cached),
    };
    if (o.requestUrl != null) cit.requestUrl = str(o.requestUrl);
    if (o.sourceUpdated != null) cit.sourceUpdated = str(o.sourceUpdated);
    return cit;
  });
}

// Rebuild a tile's stale marker from named fields only (increment 2). A marker
// with neither a failedAt nor a reason is dropped entirely — a tile is stale
// only when it genuinely records why.
function cleanStale(s: unknown): { failedAt: string; reason: string } | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const o = s as Record<string, unknown>;
  const failedAt = str(o.failedAt);
  const reason = str(o.reason);
  if (!failedAt && !reason) return undefined;
  return { failedAt, reason };
}

function cleanTile(tile: unknown): Tile {
  const o = (tile && typeof tile === 'object' ? tile : {}) as Record<string, unknown>;
  const t: Tile = {
    id: str(o.id) || newId('tile'),
    title: str(o.title),
    spec: cleanSpec(o.spec),
    rows: cleanRows(o.rows),
    citations: cleanCitations(o.citations),
    pinnedAt: str(o.pinnedAt) || nowIso(),
  };
  if (o.sourceNote != null) t.sourceNote = str(o.sourceNote);
  if (o.refreshedAt != null) t.refreshedAt = str(o.refreshedAt);
  const stale = cleanStale(o.stale);
  if (stale) t.stale = stale;
  return t;
}

// Rebuild a Dashboard from arbitrary input, copying ONLY whitelisted fields.
// Exported so a test can assert a stray key never survives. Does NOT gate on
// version (callers already have a live object); parseDashboard is the gate.
export function cleanDashboard(input: unknown): Dashboard {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const created = str(o.created) || nowIso();
  return {
    v: DASHBOARD_VERSION,
    id: str(o.id) || newId('dash'),
    title: str(o.title),
    created,
    updated: str(o.updated) || created,
    tiles: Array.isArray(o.tiles) ? o.tiles.map(cleanTile) : [],
  };
}

// ── Serialize / parse ────────────────────────────────────────────────────────
// serialize goes through the whitelist rebuild so a stray field can never reach
// storage. parse is defensive: bad JSON / non-object / unknown version → null.
export function serializeDashboard(dash: Dashboard): string {
  return JSON.stringify(cleanDashboard(dash));
}

export function parseDashboard(raw: string): Dashboard | null {
  try {
    if (typeof raw !== 'string' || !raw) return null;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.v !== DASHBOARD_VERSION) return null; // version gate
    return cleanDashboard(obj);
  } catch {
    return null;
  }
}

// ── Size guard ───────────────────────────────────────────────────────────────
// UTF-8 byte length of the serialized document — the figure that matters for a
// localStorage budget. Uses TextEncoder (a global in browser + Node).
export function dashboardBytes(dash: Dashboard): number {
  return new TextEncoder().encode(serializeDashboard(dash)).length;
}

// Thrown by addTile when accepting the tile would push the dashboard past the
// soft cap. Distinct type so the UI/agent can present a specific message.
export class DashboardCapError extends Error {
  readonly bytes: number;
  readonly cap: number;
  constructor(bytes: number, cap: number) {
    super(
      `Dashboard is full: adding this tile would make it ${Math.round(bytes / 1000)}KB, ` +
        `over the ${Math.round(cap / 1000)}KB per-dashboard limit. Remove a tile or start a new dashboard.`
    );
    this.name = 'DashboardCapError';
    this.bytes = bytes;
    this.cap = cap;
  }
}

// ── Tile construction ────────────────────────────────────────────────────────
// Centralized so both the UI pin action and the agent tool build tiles the same
// way (id + pinnedAt stamped here, sourceNote derived from citations when absent).
export function makeTile(input: {
  title: string;
  spec: ChartSpec;
  rows: DataRow[];
  citations: Citation[];
  sourceNote?: string;
}): Tile {
  const citations = cleanCitations(input.citations);
  return {
    id: newId('tile'),
    title: str(input.title).trim() || str(input.spec?.title).trim() || 'Untitled chart',
    spec: cleanSpec(input.spec),
    rows: cleanRows(input.rows),
    citations,
    pinnedAt: nowIso(),
    sourceNote: str(input.sourceNote).trim() || deriveSourceNote(citations),
  };
}

// A one-line provenance label from a tile's citations: the distinct source
// institutions, plus the most recent source vintage when any citation carries
// one. Empty string when there are no citations (shown as nothing by the view).
export function deriveSourceNote(citations: Citation[]): string {
  if (!citations.length) return '';
  const labels: string[] = [];
  for (const c of citations) {
    const label = c.sourceLabel || (c.source ? citationSourceLabel(c.source) : '');
    if (label && !labels.includes(label)) labels.push(label);
  }
  const vintages = citations
    .map((c) => c.sourceUpdated)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .sort();
  const latest = vintages.length ? vintages[vintages.length - 1] : '';
  const head = labels.join(' · ');
  return latest ? `${head} · source updated ${latest}` : head;
}

// ── Pure document ops (all return NEW objects; input is never mutated) ─────────
export function createDashboard(title: string): Dashboard {
  const now = nowIso();
  return {
    v: DASHBOARD_VERSION,
    id: newId('dash'),
    title: str(title).trim() || 'Untitled dashboard',
    created: now,
    updated: now,
    tiles: [],
  };
}

// Append a tile, refusing (DashboardCapError) if the result would exceed the
// soft byte cap. Returns a new dashboard with `updated` bumped.
export function addTile(dash: Dashboard, tile: Tile): Dashboard {
  const next: Dashboard = { ...dash, tiles: [...dash.tiles, tile], updated: nowIso() };
  const bytes = dashboardBytes(next);
  if (bytes > DASHBOARD_SOFT_CAP_BYTES) throw new DashboardCapError(bytes, DASHBOARD_SOFT_CAP_BYTES);
  return next;
}

export function removeTile(dash: Dashboard, tileId: string): Dashboard {
  if (!dash.tiles.some((t) => t.id === tileId)) return dash; // no-op: unchanged
  return { ...dash, tiles: dash.tiles.filter((t) => t.id !== tileId), updated: nowIso() };
}

export function renameTile(dash: Dashboard, tileId: string, title: string): Dashboard {
  const clean = str(title).trim();
  if (!dash.tiles.some((t) => t.id === tileId)) return dash;
  return {
    ...dash,
    tiles: dash.tiles.map((t) => (t.id === tileId ? { ...t, title: clean || t.title } : t)),
    updated: nowIso(),
  };
}

export function renameDashboard(dash: Dashboard, title: string): Dashboard {
  const clean = str(title).trim();
  if (!clean || clean === dash.title) return dash;
  return { ...dash, title: clean, updated: nowIso() };
}

// Move a tile one slot up or down. A move at the boundary (first up / last down)
// or of an unknown tile is a no-op that returns the SAME object unchanged (no
// spurious `updated` bump).
export function moveTile(dash: Dashboard, tileId: string, dir: 'up' | 'down'): Dashboard {
  const i = dash.tiles.findIndex((t) => t.id === tileId);
  if (i === -1) return dash;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= dash.tiles.length) return dash; // at a boundary: unchanged
  const tiles = [...dash.tiles];
  [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  return { ...dash, tiles, updated: nowIso() };
}

// Replace the tile at `tileId`'s POSITION with a new tile, keeping its slot in
// the grid (increment 2 — the pin picker's "replace existing tile…"). Same
// addTile/removeTile semantics conceptually, but the new tile inherits the old
// one's index rather than landing at the end. Unknown tileId → same object
// unchanged. Runs the SAME soft-cap guard addTile does (a swap can grow the
// document) and bumps `updated`.
export function replaceTile(dash: Dashboard, tileId: string, newTile: Tile): Dashboard {
  const i = dash.tiles.findIndex((t) => t.id === tileId);
  if (i === -1) return dash;
  const tiles = [...dash.tiles];
  tiles[i] = newTile;
  const next: Dashboard = { ...dash, tiles, updated: nowIso() };
  const bytes = dashboardBytes(next);
  if (bytes > DASHBOARD_SOFT_CAP_BYTES) throw new DashboardCapError(bytes, DASHBOARD_SOFT_CAP_BYTES);
  return next;
}

// ── Refresh ops (increment 2) ────────────────────────────────────────────────
// Replace a tile's fetched evidence (rows) and citation ledger after a
// SUCCESSFUL "refresh data" run, keeping the tile's id/title/spec/pinnedAt and
// its grid position. Re-derives sourceNote from the new citations so the
// provenance line shows the refreshed vintage, stamps refreshedAt, and CLEARS
// any prior stale marker. Rows/citations are whitelist-cleaned on the way in
// (same discipline as makeTile), so a refresh can never smuggle an unlisted
// field onto a stored tile. Note: the chart spec is preserved as-is — the tile
// re-renders the chart it was pinned with; the refreshed rows + citations + new
// vintage are the evidence this op replaces. Unknown tileId → unchanged.
export function touchTileData(
  dash: Dashboard,
  tileId: string,
  rows: DataRow[],
  citations: Citation[],
  refreshedAt: string
): Dashboard {
  if (!dash.tiles.some((t) => t.id === tileId)) return dash;
  const cleanCites = cleanCitations(citations);
  const cleanedRows = cleanRows(rows);
  return {
    ...dash,
    tiles: dash.tiles.map((t) => {
      if (t.id !== tileId) return t;
      const next: Tile = {
        ...t,
        rows: cleanedRows,
        citations: cleanCites,
        sourceNote: deriveSourceNote(cleanCites) || t.sourceNote,
        refreshedAt: str(refreshedAt) || nowIso(),
      };
      delete next.stale; // a successful refresh clears any prior failure marker
      return next;
    }),
    updated: nowIso(),
  };
}

// Mark a tile stale after its refresh FAILED. The tile's rows/citations/spec are
// left UNTOUCHED (never blanked, never fabricated) — only a stale marker is
// added, recording when and why, so the view can show the honest "showing data
// from <original date>" line. Unknown tileId → unchanged. Bumps `updated` (the
// document's stale-state genuinely changed).
export function markTileStale(
  dash: Dashboard,
  tileId: string,
  reason: string,
  failedAt?: string
): Dashboard {
  if (!dash.tiles.some((t) => t.id === tileId)) return dash;
  const stale = { failedAt: str(failedAt) || nowIso(), reason: str(reason).trim() || 'refresh failed' };
  return {
    ...dash,
    tiles: dash.tiles.map((t) => (t.id === tileId ? { ...t, stale } : t)),
    updated: nowIso(),
  };
}

// ── Storage wrapper ──────────────────────────────────────────────────────────
// Thin persistence over a Web Storage-like object (real localStorage in the app;
// a Map-backed fake in tests). Every write is try/caught so a quota/serialization
// failure surfaces as a clear result, never a thrown crash into the caller.
// Reads skip malformed/foreign entries rather than failing the whole list.

// The subset of the Web Storage API this module uses. `localStorage` satisfies
// it directly; tests pass a small fake implementing the same shape.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

function dashboardKey(id: string): string {
  return DASHBOARD_NS + id;
}

// All namespaced keys currently in the store (order as the store reports them).
function namespacedKeys(store: StorageLike): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(DASHBOARD_NS)) out.push(k);
  }
  return out;
}

// Load and parse one dashboard by id; null if absent or malformed.
export function loadDashboard(store: StorageLike, id: string): Dashboard | null {
  try {
    const raw = store.getItem(dashboardKey(id));
    return raw ? parseDashboard(raw) : null;
  } catch {
    return null;
  }
}

// Every stored dashboard, parsed, malformed entries skipped, newest-updated
// first. Returns full documents (increment 1 dashboards are small).
export function listDashboards(store: StorageLike): Dashboard[] {
  const out: Dashboard[] = [];
  let keys: string[];
  try {
    keys = namespacedKeys(store);
  } catch {
    return [];
  }
  for (const k of keys) {
    try {
      const raw = store.getItem(k);
      const dash = raw ? parseDashboard(raw) : null;
      if (dash) out.push(dash);
    } catch {
      /* skip a single unreadable entry */
    }
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}

// Compact summaries for the index view (no rows/spec held in memory).
export function listDashboardSummaries(store: StorageLike): DashboardSummary[] {
  return listDashboards(store).map((d) => ({
    id: d.id,
    title: d.title,
    updated: d.updated,
    tileCount: d.tiles.length,
  }));
}

// Persist a dashboard (whitelist-serialized). A quota/serialization failure is
// caught and returned as { ok:false, error } — the caller decides how to surface
// it; this never throws.
export function saveDashboard(store: StorageLike, dash: Dashboard): SaveResult {
  try {
    store.setItem(dashboardKey(dash.id), serializeDashboard(dash));
    return { ok: true };
  } catch (err: any) {
    const quota =
      err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      error: quota
        ? 'Out of browser storage — delete a dashboard (or some tiles) and try again.'
        : 'Could not save the dashboard: ' + (err?.message ?? String(err)),
    };
  }
}

export function deleteDashboard(store: StorageLike, id: string): void {
  try {
    store.removeItem(dashboardKey(id));
  } catch {
    /* deleting a missing/locked key is not an error worth surfacing */
  }
}

// Find an existing dashboard by title (case-insensitive), else null. Used by the
// agent tool and the pin picker to reuse a dashboard the user named rather than
// spawning duplicates.
export function findDashboardByTitle(store: StorageLike, title: string): Dashboard | null {
  const want = str(title).trim().toLowerCase();
  if (!want) return null;
  return listDashboards(store).find((d) => d.title.toLowerCase() === want) ?? null;
}
