// ── Fragment codec (shared transport for #share= and #dash= permalinks) ──────
// The low-level, payload-agnostic pipeline both the answer share (share.ts) and
// the dashboard share (dashboard-share.ts) ride on: a JSON string in, a URL-safe
// fragment string out, and back. Extracted so the two share modules share ONE
// implementation of base64url + deflate-raw + the compressed/uncompressed flag,
// rather than copy-pasting it (and drifting).
//
// Pipeline: JSON string → UTF-8 bytes → deflate-raw (native CompressionStream,
// feature-detected) → base64url, prefixed with a one-char flag: 'C' compressed,
// 'U' uncompressed (the fallback when CompressionStream is unavailable). The
// output carries no keys/JSON parsing/whitelisting of its own — it is pure
// transport; the caller owns the versioned schema, the whitelist rebuild, and
// the semantic gates. unpackJson is defensive and inert: any malformed input
// yields null, never a throw, and it never executes anything.

// ── base64url ───────────────────────────────────────────────────────────────
export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array {
  // atob throws on malformed input; the caller catches and returns null.
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── deflate-raw via native streams (feature-detected) ───────────────────────
export function hasCompression(): boolean {
  return (
    typeof (globalThis as any).CompressionStream === 'function' &&
    typeof (globalThis as any).DecompressionStream === 'function'
  );
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new (globalThis as any).CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  // Attach .catch to the write/close promises so that if the stream errors
  // (e.g. on malformed input to the decompress path), their rejections are
  // OBSERVED here rather than surfacing as an unhandled promise rejection. The
  // read side's rejection propagates to the caller (unpackJson catches it).
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(buf);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// Serialize a JSON string to the fragment payload (flag + base64url). The
// `compress` flag is resolved by the caller so tests can force either path.
export async function packJson(json: string, compress: boolean): Promise<string> {
  const raw = enc.encode(json);
  if (compress) {
    const packed = await deflateRaw(raw);
    return 'C' + bytesToB64url(packed);
  }
  return 'U' + bytesToB64url(raw);
}

// Decode a fragment payload back to its JSON string, defensively: any
// malformed / oversized / non-inflatable input yields null. Never throws, never
// runs anything — the returned value is a plain string the caller then parses
// and whitelist-rebuilds. `maxBytes` bounds the raw fragment length (rejected at
// 4× the budget) before any decode work is attempted.
export async function unpackJson(
  payload: string,
  opts: { maxBytes: number }
): Promise<string | null> {
  try {
    if (typeof payload !== 'string' || payload.length < 2) return null;
    // Reject absurdly large fragments before doing any work.
    if (payload.length > opts.maxBytes * 4) return null;
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
    return dec.decode(raw);
  } catch {
    return null;
  }
}
