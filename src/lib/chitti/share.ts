// ── Shareable answer permalink (backlog #15) ────────────────────────────────
// Encode a COMPLETED answer's state into a URL fragment so a recipient sees the
// same charted, cited answer without running the agent or holding a key. The
// permalink is the *answer*, not the run: question, final answer text, chart
// spec, the rows the chart uses, citations, and the verification verdict — never
// keys, never the trace/receipts, never the VFS.
//
// Pipeline: whitelist-encode → JSON → deflate-raw (native CompressionStream,
// feature-detected) → base64url, carried in `#share=` (a fragment, so it never
// reaches a server log). A one-char flag prefixes the payload: 'C' compressed,
// 'U' uncompressed (the fallback when CompressionStream is unavailable).
//
// Security posture is whitelist, not blacklist: buildSharePayload copies only
// the known-shape fields off whatever object it is handed, so a stray apiKey (or
// any unlisted field) on the input state is structurally incapable of reaching
// the serialized output. Decoding is defensive and inert — it returns plain data
// or null, never executes anything, and the UI renders every string through
// text-safe paths.

import type { ChartSpec, DataRow, Citation } from './tools';

// Bumped whenever the payload shape changes incompatibly. decodeShareState gates
// on it: an unknown version yields null (invalid link), never a guess.
export const SHARE_VERSION = 1 as const;

// URL practicality budget. Browsers and servers vary, but ~8KB keeps the link
// pasteable everywhere. Measured against the final fragment payload length
// (flag + base64url), the thing that actually lands in the URL.
export const MAX_SHARE_BYTES = 8000;

// The compact, versioned schema the fragment carries.
export interface ShareVerification {
  status: 'verified' | 'unverified' | 'unavailable';
  confidence: 'high' | 'medium' | 'low' | 'none';
  issues: string[];
}

export interface ShareStateV1 {
  v: typeof SHARE_VERSION;
  q: string; // question
  answer: string; // final answer text (finding)
  spec: ChartSpec | null; // chart spec (carries its own series data)
  rows: DataRow[]; // the rows the chart uses (evidence table)
  citations: Citation[]; // citation ledger entries
  verification: ShareVerification | null; // verdict at time of generation
  ts: string; // ISO timestamp: when this answer was generated
  // Set true only when the size budget forced dropping the evidence rows. The
  // shared view must disclose this ("showing charted data only") — never a
  // silent lossy link.
  lossy?: boolean;
}

// What a caller hands in. Deliberately loose (`unknown`-ish) so we can be handed
// the live TurnBlock-ish state directly and still strip it down safely — the
// whitelist copy below is what makes that safe.
export interface ShareInput {
  question: string;
  answer: string;
  spec: ChartSpec | null;
  rows: DataRow[];
  citations: Citation[];
  verification:
    | { status?: string; confidence?: string; issues?: string[] }
    | null
    | undefined;
  ts?: string;
}

export type EncodeResult =
  | { ok: true; payload: string; lossy: boolean; bytes: number }
  | { ok: false; reason: 'too-large' };

// ── Whitelist copying ───────────────────────────────────────────────────────
// Each of these rebuilds an object from named fields only. Anything not named —
// an apiKey, an internal handle, a __proto__ key — cannot survive the copy. This
// is the security boundary; do not replace it with a blacklist/delete approach.

const VERIFY_STATUS = new Set(['verified', 'unverified', 'unavailable']);
const VERIFY_CONFIDENCE = new Set(['high', 'medium', 'low', 'none']);
const SPEC_TYPES = new Set(['line', 'bar', 'scatter', 'grouped-bar']);

function str(x: unknown): string {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

function cleanSpec(spec: unknown): ChartSpec | null {
  if (!spec || typeof spec !== 'object') return null;
  const s = spec as Record<string, unknown>;
  const type = SPEC_TYPES.has(s.type as string) ? (s.type as ChartSpec['type']) : 'line';
  const seriesIn = Array.isArray(s.series) ? s.series : [];
  const series = seriesIn.map((ser) => {
    const so = (ser && typeof ser === 'object' ? ser : {}) as Record<string, unknown>;
    const dataIn = Array.isArray(so.data) ? so.data : [];
    const data = dataIn
      .filter((pt) => Array.isArray(pt) && pt.length >= 2)
      .map((pt) => [(pt as unknown[])[0] as number | string, Number((pt as unknown[])[1])] as [number | string, number]);
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

function cleanCitations(citations: unknown): Citation[] {
  if (!Array.isArray(citations)) return [];
  return citations.map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const cit: Citation = {
      id: str(o.id),
      source: (['worldbank', 'owid', 'imf', 'who'].includes(o.source as string)
        ? (o.source as Citation['source'])
        : 'worldbank'),
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

function cleanYearRange(r: unknown): Citation['yearRange'] {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const out: { start?: number; end?: number } = {};
  if (o.start != null && Number.isFinite(Number(o.start))) out.start = Number(o.start);
  if (o.end != null && Number.isFinite(Number(o.end))) out.end = Number(o.end);
  return out.start === undefined && out.end === undefined ? null : out;
}

function cleanVerification(v: unknown): ShareVerification | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!VERIFY_STATUS.has(o.status as string)) return null;
  return {
    status: o.status as ShareVerification['status'],
    confidence: VERIFY_CONFIDENCE.has(o.confidence as string)
      ? (o.confidence as ShareVerification['confidence'])
      : 'none',
    issues: Array.isArray(o.issues) ? o.issues.map(str) : [],
  };
}

// Build the versioned payload object from arbitrary input, copying ONLY the
// whitelisted fields. Exported so a test can assert a stray key never survives.
export function buildSharePayload(input: ShareInput): ShareStateV1 {
  return {
    v: SHARE_VERSION,
    q: str(input.question),
    answer: str(input.answer),
    spec: cleanSpec(input.spec),
    rows: cleanRows(input.rows),
    citations: cleanCitations(input.citations),
    verification: cleanVerification(input.verification),
    ts: input.ts && !Number.isNaN(Date.parse(input.ts)) ? input.ts : new Date().toISOString(),
  };
}

// ── base64url ───────────────────────────────────────────────────────────────
function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  // atob throws on malformed input; the caller catches and returns null.
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── deflate-raw via native streams (feature-detected) ───────────────────────
function hasCompression(): boolean {
  return (
    typeof (globalThis as any).CompressionStream === 'function' &&
    typeof (globalThis as any).DecompressionStream === 'function'
  );
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Serialize one payload object to the fragment string (flag + base64url). The
// `compress` flag is resolved here so tests can force the uncompressed path.
async function serialize(state: ShareStateV1, compress: boolean): Promise<string> {
  const json = JSON.stringify(state);
  const raw = enc.encode(json);
  if (compress) {
    const packed = await deflateRaw(raw);
    return 'C' + bytesToB64url(packed);
  }
  return 'U' + bytesToB64url(raw);
}

// ── Public encode ───────────────────────────────────────────────────────────
// Encodes input into a fragment payload, enforcing the size budget by dropping
// evidence rows first (marking the result lossy), then refusing outright. The
// answer text is NEVER truncated.
export async function encodeShareState(
  input: ShareInput,
  opts?: { maxBytes?: number; compress?: boolean }
): Promise<EncodeResult> {
  const maxBytes = opts?.maxBytes ?? MAX_SHARE_BYTES;
  const compress = opts?.compress ?? hasCompression();

  const full = buildSharePayload(input);
  let payload = await serialize(full, compress);
  if (payload.length <= maxBytes) {
    return { ok: true, payload, lossy: false, bytes: payload.length };
  }

  // Over budget: drop the evidence rows. The chart still renders from spec
  // (which carries its own series data), so the shared view stays charted —
  // it just discloses "showing charted data only".
  const dropped: ShareStateV1 = { ...full, rows: [], lossy: true };
  payload = await serialize(dropped, compress);
  if (payload.length <= maxBytes) {
    return { ok: true, payload, lossy: true, bytes: payload.length };
  }

  // Still too large even without rows — refuse rather than emit a broken or
  // answer-truncated link.
  return { ok: false, reason: 'too-large' };
}

// ── Public decode ───────────────────────────────────────────────────────────
// Decodes a fragment payload back to a ShareStateV1, defensively: any
// malformed/oversized/unknown-version input yields null. Never throws, never
// executes anything — the returned object is inert data whose strings the UI
// renders through text-safe paths. A second whitelist pass on decode guarantees
// the object handed to the renderer has exactly the known shape, even if the
// payload was hand-crafted.
export async function decodeShareState(payload: string): Promise<ShareStateV1 | null> {
  try {
    if (typeof payload !== 'string' || payload.length < 2) return null;
    // Reject absurdly large fragments before doing any work.
    if (payload.length > MAX_SHARE_BYTES * 4) return null;
    const flag = payload[0];
    const body = payload.slice(1);
    if (flag !== 'C' && flag !== 'U') return null;

    const packed = b64urlToBytes(body);
    let raw: Uint8Array;
    if (flag === 'C') {
      if (!hasCompression()) return null; // can't inflate without the API
      raw = await inflateRaw(packed);
    } else {
      raw = packed;
    }
    const json = dec.decode(raw);
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    if (obj.v !== SHARE_VERSION) return null; // version gate

    // Re-whitelist on the way out: never trust the payload's shape.
    const state: ShareStateV1 = {
      v: SHARE_VERSION,
      q: str(obj.q),
      answer: str(obj.answer),
      spec: cleanSpec(obj.spec),
      rows: cleanRows(obj.rows),
      citations: cleanCitations(obj.citations),
      verification: cleanVerification(obj.verification),
      ts: str(obj.ts),
    };
    if (obj.lossy === true) state.lossy = true;
    return state;
  } catch {
    return null;
  }
}
