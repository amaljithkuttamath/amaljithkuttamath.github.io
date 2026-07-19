/*
 * Chitti service worker — scope /apps/chitti/.
 *
 * Goals, in priority order:
 *   1. NEVER cache LLM provider calls (openrouter/openai/anthropic) or live
 *      data-source APIs (World Bank, IMF, Our World in Data), and never cache
 *      any non-GET request. Stale numbers or replayed model output would be a
 *      correctness bug, so those always pass straight through to the network.
 *   2. Network-first for the app shell / HTML so a fresh deploy is picked up
 *      the moment the user is online, with the cached shell as offline fallback.
 *   3. Stale-while-revalidate for same-origin hashed build assets (/_astro/…).
 *   4. Cache-first for the versioned, immutable echarts lib on jsDelivr.
 *
 * The classify() function below is a hand-mirrored copy of the pure predicate
 * in src/lib/chitti/sw-cache.ts, which is unit-tested (sw-cache.test.ts). This
 * file is a plain, un-bundled public asset and cannot import TypeScript at
 * runtime, so the two copies must be kept in sync by hand; the tests are the
 * contract. Keep them identical.
 */

// Bump this string to invalidate the whole cache on the next deploy.
const CACHE_VERSION = 'chitti-v1';
const CACHE_NAME = CACHE_VERSION;

// The shell URL to pre-cache so offline navigation has something to serve.
const SHELL_URL = '/apps/chitti/';

const NEVER_CACHE_HOSTS = [
  'openrouter.ai',
  'api.openai.com',
  'openai.com',
  'api.anthropic.com',
  'anthropic.com',
  'worldbank.org',
  'imf.org',
  'ourworldindata.org',
];

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  return NEVER_CACHE_HOSTS.some((base) => h === base || h.endsWith('.' + base));
}

// Mirror of classifyRequest() in src/lib/chitti/sw-cache.ts.
function classify(input) {
  const method = (input.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return 'bypass';

  let u;
  try {
    u = new URL(input.url);
  } catch (e) {
    return 'bypass';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'bypass';
  if (isBlockedHost(u.hostname)) return 'bypass';
  if (u.hostname === 'cdn.jsdelivr.net') return 'cache-first';

  const sameOrigin = u.origin === input.selfOrigin;
  if (sameOrigin) {
    if (input.mode === 'navigate') return 'network-first';
    if (u.pathname.endsWith('.html') || u.pathname === '/apps/chitti/') {
      return 'network-first';
    }
    return 'stale-while-revalidate';
  }
  return 'bypass';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Pre-cache the shell. Best-effort: a failure here must not abort install.
      try {
        await cache.add(new Request(SHELL_URL, { cache: 'reload' }));
      } catch (e) {
        /* offline at install time, or shell unreachable — fine */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any cache whose name isn't the current version.
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

async function networkFirst(request, cache) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // Navigation offline fallback: serve the cached shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match(SHELL_URL);
      if (shell) return shell;
    }
    throw e;
  }
}

async function staleWhileRevalidate(request, cache) {
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => undefined);
  return cached || (await network) || fetch(request);
}

async function cacheFirst(request, cache) {
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const strategy = classify({
    url: request.url,
    method: request.method,
    selfOrigin: self.location.origin,
    mode: request.mode,
  });

  // 'bypass' means: do not intercept at all. Let the request go to the network
  // exactly as it would without a service worker — nothing stored, nothing read.
  if (strategy === 'bypass') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      if (strategy === 'network-first') return networkFirst(request, cache);
      if (strategy === 'cache-first') return cacheFirst(request, cache);
      return staleWhileRevalidate(request, cache);
    })()
  );
});
