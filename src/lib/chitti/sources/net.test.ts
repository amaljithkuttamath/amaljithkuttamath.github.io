import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout, isTimeout, TimeoutError, SEARCH_TIMEOUT_MS, SOURCE_TIMEOUT_MS } from './net';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

// Stand-in for a host that accepts the connection and then says nothing —
// the failure mode that made a `find_series` step run for 447 seconds with an
// unresponsive stop button.
function hangingFetch(): typeof globalThis.fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as typeof globalThis.fetch;
}

describe('fetchWithTimeout', () => {
  it('passes a normal response straight through', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as any;
    const resp = await fetchWithTimeout('https://example.test/x');
    expect(resp.status).toBe(200);
  });

  it('aborts as soon as the caller stops, without waiting for the network', async () => {
    globalThis.fetch = hangingFetch();
    const ctrl = new AbortController();
    const p = fetchWithTimeout('https://example.test/hangs', { signal: ctrl.signal, timeoutMs: 60_000 });
    ctrl.abort();
    // The point of the fix: this settles now, not in a minute.
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not open a connection at all when already stopped', async () => {
    const spy = vi.fn(async () => new Response('{}'));
    globalThis.fetch = spy as any;
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fetchWithTimeout('https://example.test/x', { signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('gives up on a hung host at the deadline, and says it timed out', async () => {
    globalThis.fetch = hangingFetch();
    const err = await fetchWithTimeout('https://example.test/hangs', { timeoutMs: 10 }).catch((e) => e);
    expect(isTimeout(err), `expected a timeout, got ${err?.name}`).toBe(true);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('reports a user stop as a stop, never as a timeout', async () => {
    globalThis.fetch = hangingFetch();
    const ctrl = new AbortController();
    const p = fetchWithTimeout('https://example.test/hangs', { signal: ctrl.signal, timeoutMs: 10_000 });
    ctrl.abort();
    const err = await p.catch((e) => e);
    // The distinction matters: a stop is not a failure and must not be
    // reported to the user as one.
    expect(isTimeout(err)).toBe(false);
    expect(err.name).toBe('AbortError');
  });

  it('clears its timer on success, so a slow later stop cannot fire it', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => new Response('{}')) as any;
    await fetchWithTimeout('https://example.test/x', { timeoutMs: 5 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds searches more tightly than data fetches', () => {
    // Search sits in front of the fetch the user actually wants and always
    // degrades to "no hits", so it should be abandoned sooner.
    expect(SEARCH_TIMEOUT_MS).toBeLessThan(SOURCE_TIMEOUT_MS);
  });
});
