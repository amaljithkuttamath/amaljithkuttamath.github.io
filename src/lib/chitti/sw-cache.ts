// Pure caching-policy predicate for Chitti's service worker.
//
// This module exists to make the service worker's single most safety-critical
// decision — "may this request touch the cache, and how?" — unit-testable in
// isolation. The service worker itself (public/apps/chitti/sw.js) is a plain,
// un-bundled browser file that cannot import TypeScript at runtime, so the
// logic below is *mirrored by hand* into sw.js. The two copies must stay in
// sync; the tests here are the contract that copy must honour. This is called
// out honestly in the PWA notes rather than pretending sw.js is built from
// this source.
//
// The overriding rule: LLM provider calls and live data-source APIs must NEVER
// be served from cache. A stale economic figure or a replayed model response
// would be a correctness bug far worse than a cache miss, so those requests
// always classify as 'bypass' (straight to the network, never stored).

export type CacheStrategy =
  | 'bypass' // never touch the cache — always hit the network, never store
  | 'network-first' // try network, fall back to cache (HTML / navigations)
  | 'stale-while-revalidate' // serve cache immediately, refresh in background
  | 'cache-first'; // serve cache if present, else fetch+store (immutable libs)

// Hosts whose responses must never be cached: LLM providers and the live data
// sources Chitti computes from. Matched on the registrable-domain suffix so
// api.worldbank.org, data.imf.org, etc. are all covered.
export const NEVER_CACHE_HOSTS: readonly string[] = [
  'openrouter.ai',
  'api.openai.com',
  'openai.com',
  'api.anthropic.com',
  'anthropic.com',
  'worldbank.org',
  'imf.org',
  'ourworldindata.org',
];

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return NEVER_CACHE_HOSTS.some((base) => h === base || h.endsWith('.' + base));
}

export interface ClassifyInput {
  url: string;
  method: string;
  /** The service worker's own origin (self.location.origin). */
  selfOrigin: string;
  /** The Request.mode; 'navigate' marks a top-level navigation. */
  mode?: string;
}

// Decide how a request should interact with the cache. Deliberately
// conservative: anything not positively recognised as a safe, immutable or
// same-origin static asset falls through to 'bypass'.
export function classifyRequest(input: ClassifyInput): CacheStrategy {
  const { url, selfOrigin, mode } = input;
  const method = (input.method || 'GET').toUpperCase();

  // Non-GET is never cacheable (POST to LLM/data APIs, etc.).
  if (method !== 'GET' && method !== 'HEAD') return 'bypass';

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'bypass';
  }

  // Only http(s). chrome-extension:, data:, etc. pass straight through.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bypass';

  // LLM providers + live data APIs: never cached, no exceptions.
  if (isBlockedHost(u.hostname)) return 'bypass';

  // The echarts library from jsDelivr is a versioned, immutable URL — safe to
  // cache-first so repeat visits (and offline) get the chart engine instantly.
  if (u.hostname === 'cdn.jsdelivr.net') return 'cache-first';

  const sameOrigin = u.origin === selfOrigin;
  if (sameOrigin) {
    // Top-level navigations and HTML documents: network-first, so a fresh
    // deploy is always picked up when online, with the cached shell as the
    // offline fallback.
    if (mode === 'navigate') return 'network-first';
    if (u.pathname.endsWith('.html') || u.pathname === '/apps/chitti/') {
      return 'network-first';
    }
    // Hashed build assets and other same-origin statics: stale-while-revalidate
    // — instant from cache, refreshed in the background.
    return 'stale-while-revalidate';
  }

  // Any other cross-origin request (a data API not in the blocklist, an
  // unforeseen third party): do not cache. Fail safe.
  return 'bypass';
}
