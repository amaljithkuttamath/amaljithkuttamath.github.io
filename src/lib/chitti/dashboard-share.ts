// ── Share & export dashboards (increment 3) ──────────────────────────────────
// Two ways to move a dashboard off this browser, both whitelist-versioned so a
// stray key (an apiKey, an internal handle, a __proto__) is structurally
// incapable of travelling with it:
//
//   1. A #dash= fragment PERMALINK — the dashboard's tiles compressed into a URL
//      the recipient opens read-only (no key, no run). Rides the SHARED codec
//      (codec.ts) the answer permalink uses, under the same ~8KB budget. When a
//      dashboard is too big, rows are dropped per tile largest-first (each such
//      tile flagged lossy; its chart still renders from the spec's own series
//      data) — and only if a row-less payload still overflows do we refuse, so a
//      link is never silently truncated at a title or citation.
//
//   2. A JSON EXPORT/IMPORT — the full Dashboard document as a downloadable
//      file, re-imported through the SAME versioned whitelist (parseDashboard)
//      as a NEW local dashboard. Import never overwrites: a fresh id always, and
//      a colliding title gets an "(imported)" suffix.
//
// Nothing here parses HTML or executes anything: decode/import return inert data
// (or null) which the UI renders through text-safe paths only.

import type { ChartSpec, DataRow, Citation } from './tools';
import { packJson, unpackJson, hasCompression } from './codec';
import {
  type Dashboard,
  type Tile,
  DASHBOARD_VERSION,
  DASHBOARD_SOFT_CAP_BYTES,
  cleanDashboard,
  cleanTile,
  parseDashboard,
} from './dashboard';

// Bumped whenever the fragment payload shape changes incompatibly. decodeDashShare
// gates on it: an unknown version yields null (a link we refuse to guess at).
export const DASH_SHARE_VERSION = 1 as const;

// Same URL practicality budget as the answer permalink (~8KB keeps the link
// pasteable everywhere). Measured against the final fragment payload length.
export const MAX_DASH_SHARE_BYTES = 8000;

// ── Fragment payload schema ──────────────────────────────────────────────────
// A compact, id-less projection of a dashboard's tiles. Deliberately omits the
// document id/created/updated (a shared view is a snapshot, not the original
// document) and each tile's storage id (regenerated on import). Carries enough
// provenance for honest "as fetched then" framing: pinnedAt/refreshedAt vintages,
// the sourceNote, and any stale marker — all preserved, never invented.
export interface DashShareTileV1 {
  title: string;
  spec: ChartSpec; // the chart to re-render (carries its own series data)
  rows: DataRow[]; // the charted rows; [] when dropped for size (see `lossy`)
  citations: Citation[];
  sourceNote?: string;
  pinnedAt?: string;
  refreshedAt?: string;
  stale?: { failedAt: string; reason: string };
  // Set true only when the size budget forced dropping THIS tile's rows. The
  // shared view discloses it ("showing charted data only") — never silent.
  lossy?: boolean;
}

export interface DashShareV1 {
  v: typeof DASH_SHARE_VERSION;
  title: string;
  tiles: DashShareTileV1[];
}

export type EncodeDashResult =
  | { ok: true; payload: string; lossy: boolean; bytes: number }
  | { ok: false; reason: 'too-large' };

function str(x: unknown): string {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

// Project a whitelist-clean Tile down to the compact share tile. Named-field
// copy only; nothing beyond the schema above can ride along.
function tileToShare(t: Tile): DashShareTileV1 {
  const out: DashShareTileV1 = {
    title: t.title,
    spec: t.spec,
    rows: t.rows,
    citations: t.citations,
  };
  if (t.sourceNote) out.sourceNote = t.sourceNote;
  if (t.pinnedAt) out.pinnedAt = t.pinnedAt;
  if (t.refreshedAt) out.refreshedAt = t.refreshedAt;
  if (t.stale) out.stale = t.stale;
  return out;
}

// Build the versioned fragment payload from a dashboard, copying ONLY whitelisted
// fields (each tile is rebuilt through dashboard.ts's cleanTile first, so the
// same key-proof discipline as storage applies). Exported so a test can assert a
// stray key never survives.
export function buildDashSharePayload(dash: Dashboard): DashShareV1 {
  const tiles = Array.isArray(dash?.tiles) ? dash.tiles : [];
  return {
    v: DASH_SHARE_VERSION,
    title: str(dash?.title),
    tiles: tiles.map((t) => tileToShare(cleanTile(t))),
  };
}

// ── Encode (size ladder) ─────────────────────────────────────────────────────
// full → drop rows per tile largest-first (each dropped tile flagged lossy;
// chart still renders from spec) → refuse. Titles and citations are NEVER
// dropped or truncated.
export async function encodeDashShare(
  dash: Dashboard,
  opts?: { maxBytes?: number; compress?: boolean }
): Promise<EncodeDashResult> {
  const maxBytes = opts?.maxBytes ?? MAX_DASH_SHARE_BYTES;
  const compress = opts?.compress ?? hasCompression();

  const full = buildDashSharePayload(dash);
  let payload = await packJson(JSON.stringify(full), compress);
  if (payload.length <= maxBytes) {
    return { ok: true, payload, lossy: false, bytes: payload.length };
  }

  // Over budget: drop rows tile-by-tile, largest row-payload first, re-measuring
  // after each drop so we shed no more evidence than necessary.
  const tiles = full.tiles.map((t) => ({ ...t }));
  const order = tiles
    .map((t, i) => ({ i, size: JSON.stringify(t.rows || []).length }))
    .filter((x) => x.size > 2) // "[]" is 2 chars — nothing to drop
    .sort((a, b) => b.size - a.size)
    .map((x) => x.i);

  for (const i of order) {
    tiles[i] = { ...tiles[i], rows: [], lossy: true };
    payload = await packJson(JSON.stringify({ ...full, tiles }), compress);
    if (payload.length <= maxBytes) {
      return { ok: true, payload, lossy: true, bytes: payload.length };
    }
  }

  // Every tile's rows dropped and still over budget — refuse rather than emit a
  // link truncated at a title or citation.
  return { ok: false, reason: 'too-large' };
}

// ── Decode ───────────────────────────────────────────────────────────────────
// Any malformed / oversized / unknown-version input yields null. Never throws,
// never executes anything. A second whitelist pass (cleanTile) guarantees the
// object handed to the renderer has exactly the known shape, even if the payload
// was hand-crafted.
export async function decodeDashShare(payload: string): Promise<DashShareV1 | null> {
  const json = await unpackJson(payload, { maxBytes: MAX_DASH_SHARE_BYTES });
  if (json == null) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.v !== DASH_SHARE_VERSION) return null; // version gate
    const rawTiles = Array.isArray(obj.tiles) ? obj.tiles : [];
    const tiles = rawTiles.map((rt) => {
      const share = tileToShare(cleanTile(rt));
      // The lossy flag is a share-only signal, not a tile field — read it here.
      if (rt && typeof rt === 'object' && (rt as Record<string, unknown>).lossy === true) {
        share.lossy = true;
        share.rows = [];
      }
      return share;
    });
    return { v: DASH_SHARE_VERSION, title: str(obj.title), tiles };
  } catch {
    return null;
  }
}

// ── Materialize a shared payload into a local, editable dashboard ─────────────
// The read-only shared view's "import to edit or refresh" action: rebuild a
// fresh local Dashboard (new id/created/updated) from the decoded snapshot.
// Tiles go through cleanDashboard → cleanTile (fresh tile ids), so the result is
// a normal editable/refreshable document.
export function materializeSharedDashboard(state: DashShareV1): Dashboard {
  const now = new Date().toISOString();
  return cleanDashboard({
    v: DASHBOARD_VERSION,
    // no id → cleanDashboard mints a fresh one
    title: str(state?.title),
    created: now,
    updated: now,
    tiles: Array.isArray(state?.tiles)
      ? state.tiles.map((t) => ({
          title: t.title,
          spec: t.spec,
          rows: t.rows,
          citations: t.citations,
          sourceNote: t.sourceNote,
          pinnedAt: t.pinnedAt,
          refreshedAt: t.refreshedAt,
          stale: t.stale,
        }))
      : [],
  });
}

// ── JSON export / import ──────────────────────────────────────────────────────
// Export is just serializeDashboard (in dashboard.ts) — the full document JSON.
// Import parses it back through the SAME versioned whitelist and lands it as a
// NEW local dashboard.

// Parse an imported file's text through the versioned whitelist. Oversized input
// (beyond 4× the per-dashboard soft cap) or anything malformed → null, never a
// throw. The returned Dashboard still has its ORIGINAL id/title; callers pass it
// through prepareImportedDashboard before saving so an import never overwrites.
export function parseImportedDashboard(raw: string): Dashboard | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > DASHBOARD_SOFT_CAP_BYTES * 4) return null; // reject absurd input
  return parseDashboard(raw);
}

// Pick a non-colliding title for an import. If `title` collides (case-insensitive)
// with an existing dashboard, append " (imported)"; if that also collides,
// " (imported 2)", " (imported 3)", … Never returns an existing title.
export function importTitle(existingTitles: string[], title: string): string {
  const base = str(title).trim() || 'Imported dashboard';
  const taken = new Set(existingTitles.map((t) => str(t).trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let cand = `${base} (imported)`;
  let n = 2;
  while (taken.has(cand.toLowerCase())) {
    cand = `${base} (imported ${n})`;
    n++;
  }
  return cand;
}

// Turn a parsed (imported) Dashboard into one safe to save WITHOUT overwriting:
// a fresh id (new storage key), a de-duplicated title, and fresh created/updated
// stamps. Runs cleanDashboard again so the whole document is re-whitelisted.
export function prepareImportedDashboard(parsed: Dashboard, existingTitles: string[]): Dashboard {
  const now = new Date().toISOString();
  const tiles = Array.isArray(parsed?.tiles) ? parsed.tiles : [];
  return cleanDashboard({
    ...parsed,
    id: '', // empty → cleanDashboard mints a fresh id, so no existing key is hit
    title: importTitle(existingTitles, parsed?.title),
    created: now,
    updated: now,
    // Strip tile ids too, so an imported copy is fully decoupled from the
    // original (fresh tile ids minted by cleanTile) — re-importing the same file
    // never produces two documents that share tile ids.
    tiles: tiles.map((t) => ({ ...t, id: '' })),
  });
}
