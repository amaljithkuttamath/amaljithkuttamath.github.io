import { describe, it, expect } from 'vitest';
import { classifyRequest, isBlockedHost, NEVER_CACHE_HOSTS } from './sw-cache';

const ORIGIN = 'https://amaljithkuttamath.github.io';

const classify = (url: string, method = 'GET', mode?: string) =>
  classifyRequest({ url, method, selfOrigin: ORIGIN, mode });

describe('isBlockedHost', () => {
  it('blocks exact provider/data hosts', () => {
    expect(isBlockedHost('openrouter.ai')).toBe(true);
    expect(isBlockedHost('api.openai.com')).toBe(true);
    expect(isBlockedHost('api.anthropic.com')).toBe(true);
    expect(isBlockedHost('imf.org')).toBe(true);
    expect(isBlockedHost('ourworldindata.org')).toBe(true);
  });

  it('blocks subdomains of blocked registrable domains', () => {
    expect(isBlockedHost('api.worldbank.org')).toBe(true);
    expect(isBlockedHost('data.imf.org')).toBe(true);
    expect(isBlockedHost('CDN.OURWORLDINDATA.ORG')).toBe(true);
  });

  it('does not block unrelated or look-alike hosts', () => {
    expect(isBlockedHost('cdn.jsdelivr.net')).toBe(false);
    expect(isBlockedHost('amaljithkuttamath.github.io')).toBe(false);
    // A suffix that is not a dot-boundary match must not be blocked.
    expect(isBlockedHost('notopenrouter.ai')).toBe(false);
    expect(isBlockedHost('evil-imf.org.attacker.com')).toBe(false);
  });

  it('every declared host is actually blocked', () => {
    for (const h of NEVER_CACHE_HOSTS) expect(isBlockedHost(h)).toBe(true);
  });
});

describe('classifyRequest — never-cache safety', () => {
  it('bypasses all LLM provider endpoints', () => {
    expect(classify('https://openrouter.ai/api/v1/chat/completions', 'POST')).toBe('bypass');
    expect(classify('https://api.openai.com/v1/chat/completions', 'POST')).toBe('bypass');
    expect(classify('https://api.anthropic.com/v1/messages', 'POST')).toBe('bypass');
    // Even a GET to a provider (e.g. /models) must not be cached.
    expect(classify('https://openrouter.ai/api/v1/models', 'GET')).toBe('bypass');
  });

  it('bypasses all live data-source APIs', () => {
    expect(classify('https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL')).toBe('bypass');
    expect(classify('https://www.imf.org/external/datamapper/api/v1/NGDPD')).toBe('bypass');
    expect(classify('https://ourworldindata.org/grapher/life-expectancy.csv')).toBe('bypass');
  });

  it('bypasses any non-GET request regardless of host', () => {
    expect(classify(`${ORIGIN}/apps/chitti/`, 'POST')).toBe('bypass');
    expect(classify(`${ORIGIN}/_astro/x.js`, 'DELETE')).toBe('bypass');
    expect(classify('https://cdn.jsdelivr.net/npm/echarts@5.5.1/x.js', 'POST')).toBe('bypass');
  });

  it('bypasses non-http(s) schemes and malformed URLs', () => {
    expect(classify('data:text/plain,hello')).toBe('bypass');
    expect(classify('chrome-extension://abc/def.js')).toBe('bypass');
    expect(classify('not a url')).toBe('bypass');
  });
});

describe('classifyRequest — cacheable classes', () => {
  it('cache-first for the immutable echarts lib on jsDelivr', () => {
    expect(classify('https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.esm.min.js')).toBe(
      'cache-first'
    );
  });

  it('network-first for navigations and HTML', () => {
    expect(classify(`${ORIGIN}/apps/chitti/`, 'GET', 'navigate')).toBe('network-first');
    expect(classify(`${ORIGIN}/apps/chitti/`, 'GET')).toBe('network-first');
    expect(classify(`${ORIGIN}/apps/chitti/index.html`, 'GET')).toBe('network-first');
  });

  it('stale-while-revalidate for hashed same-origin build assets', () => {
    expect(classify(`${ORIGIN}/_astro/chitti.abc123.js`)).toBe('stale-while-revalidate');
    expect(classify(`${ORIGIN}/_astro/chitti.def456.css`)).toBe('stale-while-revalidate');
    expect(classify(`${ORIGIN}/apps/chitti/icon-192.png`)).toBe('stale-while-revalidate');
  });

  it('bypasses unrecognised cross-origin GETs (fail safe)', () => {
    expect(classify('https://example.com/some.js')).toBe('bypass');
  });
});
