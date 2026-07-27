// sources/mirror.ts — a same-origin snapshot of the World Bank series Chitti
// answers from without a key.
//
// WHY. Chitti's no-key promise ran through a live cross-origin call to
// api.worldbank.org, which meant the first thing a visitor with no API key
// experienced depended on a public API that rate-limits: the demo generator hit
// a 400 storm, and a probe caught the API serving five rapid requests and then
// refusing three in a row. A first run that sometimes fails is not a key-free
// first run. The 50 curated indicators are the fast path's entire vocabulary,
// so mirroring them turns that path into a same-origin static fetch — no CORS,
// no rate limit, no key, cacheable by the service worker, and it works offline.
//
// WHAT THIS IS NOT. It is not a replacement for the live API and it must never
// pretend to be one. Two rules hold it honest:
//
//   1. MISSING IS NEVER WRONG. An indicator absent from the manifest, a file
//      that 404s, a payload that fails its shape check — every one of these
//      returns null and the caller falls through to the live API. The mirror can
//      only ever make an answer faster, never different.
//   2. A MIRRORED ANSWER SAYS SO. The result carries `mirroredAt` and the
//      upstream request URL the numbers actually came from, and the citation
//      renders both. A snapshot presented as a live fetch would be precisely
//      the dishonesty this app exists to avoid — and a disclosed snapshot is
//      arguably better provenance than a live call, because it is reproducible.
//
// Values are stored to 6 significant figures. That is far beyond the precision
// World Bank indicators are actually measured to (it survives the round trip
// for every statistic the app computes) and it halves the file; the rounding is
// recorded in each file's `precision` field rather than left implicit.
import type { DataRow } from '../tools';
// The countries table is imported from the DATA FILE, not from ../tools, and
// that is deliberate. tools.ts re-exports ./sources, so a value import from it
// here would close the loop mirror → tools → sources/index → worldbank →
// mirror, and because the name lookup below is built at module scope the cycle
// resolves to an undefined adapter rather than to a lazy miss. This module sits
// in the data layer and reads the data file, exactly as tools.ts does.
import countriesData from '../../../data/worldbank/countries.json';
import { fetchWithTimeout, SEARCH_TIMEOUT_MS } from './net';
import type { FetchSeriesResult } from './types';
import manifestData from '../../../data/chitti/mirror-manifest.json';

// Where the per-indicator files are served from. They live in `public/`, NOT in
// the bundle: kb.json and demos.json are statically imported and so cost every
// page load, whereas a mirror file is fetched only when the indicator behind it
// is actually asked for — one ~32 KB request, not 4.6 MB.
export const MIRROR_BASE = '/apps/chitti/mirror/';

export interface MirrorManifestEntry {
  sourceUpdated?: string;
  yearStart: number;
  yearEnd: number;
}

export interface MirrorManifest {
  generated: string;
  indicators: Record<string, MirrorManifestEntry>;
}

const manifest = manifestData as unknown as MirrorManifest;

export function mirrorGeneratedAt(): string {
  return typeof manifest?.generated === 'string' ? manifest.generated : '';
}

export function mirroredIds(): string[] {
  const ind = manifest?.indicators;
  return ind && typeof ind === 'object' ? Object.keys(ind) : [];
}

// Case-insensitive, because ids reach us from model output and user text.
export function mirrorHas(id: string): boolean {
  const want = id.trim().toLowerCase();
  return mirroredIds().some((k) => k.toLowerCase() === want);
}

function mirrorKey(id: string): string | null {
  const want = id.trim().toLowerCase();
  return mirroredIds().find((k) => k.toLowerCase() === want) ?? null;
}

export interface MirrorFile {
  indicator: string;
  upstreamUrl: string;
  mirroredAt: string;
  sourceUpdated?: string;
  precision: number;
  yearStart: number;
  yearEnd: number;
  // ISO3 → one value per year from yearStart to yearEnd, nulls included so a
  // gap in the source stays a gap here. Country NAMES are not stored: they come
  // from the bundled countries table, which is the same table the live path
  // uses, so a mirrored row is indistinguishable from a fetched one.
  countries: Record<string, (number | null)[]>;
}

// Validate a parsed payload before a single number is trusted. Same posture as
// every other external body in this codebase: never dereference without a shape
// guard, and degrade to null rather than throwing out of a fetch.
export function parseMirrorFile(body: unknown): MirrorFile | null {
  if (!body || typeof body !== 'object') return null;
  const f = body as Record<string, unknown>;
  const indicator = typeof f.indicator === 'string' ? f.indicator.trim() : '';
  const upstreamUrl = typeof f.upstreamUrl === 'string' ? f.upstreamUrl : '';
  const mirroredAt = typeof f.mirroredAt === 'string' ? f.mirroredAt : '';
  const yearStart = Number(f.yearStart);
  const yearEnd = Number(f.yearEnd);
  if (!indicator || !mirroredAt) return null;
  if (!Number.isFinite(yearStart) || !Number.isFinite(yearEnd) || yearEnd < yearStart) return null;
  const span = yearEnd - yearStart + 1;
  const raw = f.countries;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const countries: Record<string, (number | null)[]> = {};
  for (const [iso3, values] of Object.entries(raw as Record<string, unknown>)) {
    // A row of the wrong length would silently shift every year by one — the
    // worst possible failure for a time series, so it is dropped, not padded.
    if (!Array.isArray(values) || values.length !== span) continue;
    countries[iso3] = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  }
  if (!Object.keys(countries).length) return null;
  return {
    indicator,
    upstreamUrl,
    mirroredAt,
    sourceUpdated: typeof f.sourceUpdated === 'string' ? f.sourceUpdated : undefined,
    precision: Number.isFinite(Number(f.precision)) ? Number(f.precision) : 0,
    yearStart,
    yearEnd,
    countries,
  };
}

const NAME_OF = new Map(
  (countriesData as { id: string; name: string }[]).map((c) => [c.id, c.name])
);

// Expand a mirror payload into the same DataRow shape the live fetcher returns,
// honouring the caller's country and year filters.
export function rowsFromMirror(
  file: MirrorFile,
  id: string,
  countries: string[] | undefined,
  yearStart: number | undefined,
  yearEnd: number | undefined
): DataRow[] {
  const want = countries?.length
    ? new Set(countries.map((c) => c.trim().toUpperCase()).filter(Boolean))
    : null;
  const from = Number.isFinite(yearStart) ? Math.max(file.yearStart, yearStart as number) : file.yearStart;
  const to = Number.isFinite(yearEnd) ? Math.min(file.yearEnd, yearEnd as number) : file.yearEnd;
  const rows: DataRow[] = [];
  for (const [iso3, values] of Object.entries(file.countries)) {
    if (want && !want.has(iso3)) continue;
    for (let year = from; year <= to; year++) {
      rows.push({
        country: NAME_OF.get(iso3) ?? iso3,
        iso3,
        year,
        value: values[year - file.yearStart] ?? null,
        indicator: id,
      });
    }
  }
  rows.sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
  return rows;
}

// The one entry point. Returns null for every "not here" case so the caller
// falls through to the live API — the mirror is an accelerator, never a gate.
export async function fetchFromMirror(
  id: string,
  countries: string[] | undefined,
  yearStart: number | undefined,
  yearEnd: number | undefined,
  signal?: AbortSignal
): Promise<FetchSeriesResult | null> {
  const key = mirrorKey(id);
  if (!key) return null;
  const url = MIRROR_BASE + encodeURIComponent(key) + '.json';
  try {
    const resp = await fetchWithTimeout(url, { signal, timeoutMs: SEARCH_TIMEOUT_MS });
    if (!resp.ok) return null;
    const file = parseMirrorFile(await resp.json());
    if (!file) return null;
    const rows = rowsFromMirror(file, id, countries, yearStart, yearEnd);
    // An empty slice means the caller asked for a window this snapshot does not
    // cover. That is a real "not here", so it falls through to the live API
    // rather than answering "no data" from a partial mirror.
    if (!rows.length) return null;
    return {
      rows,
      // The URL the numbers actually came FROM. A reader following the citation
      // reaches the World Bank, not our copy of it.
      requestUrl: file.upstreamUrl,
      sourceUpdated: file.sourceUpdated,
      mirroredAt: file.mirroredAt,
      countryCount: countries?.length ? undefined : Object.keys(file.countries).length,
    };
  } catch {
    // Offline, blocked, aborted, malformed JSON — all the same answer: the
    // mirror has nothing to offer, so let the live path try.
    return null;
  }
}
