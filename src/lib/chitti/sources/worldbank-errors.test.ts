import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldbank } from '../tools';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

// The retry pauses before its second attempt. Fake timers keep that pause out
// of the suite's wall clock — this file cost ~5s of real waiting otherwise, on
// a suite whose speed is part of the contract.
async function withRetryElapsed<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const p = run();
  await vi.advanceTimersByTimeAsync(2000);
  return p;
}

const ok = (rows: unknown[] = []) =>
  ({ ok: true, status: 200, json: async () => [{ page: 1, pages: 1 }, rows] }) as unknown as Response;
const fail = (status: number, body = '') =>
  ({ ok: false, status, text: async () => body }) as unknown as Response;

describe('World Bank error reporting', () => {
  it('names the URL and quotes the API on a failure', async () => {
    // The hole this closes: a demo-generation run died on a bare "HTTP 400"
    // and the log could not say which request of a batched every-country pull
    // had been rejected, or why.
    globalThis.fetch = vi.fn(async () => fail(400, '{"message":"Invalid date range"}')) as any;
    const err = await fetchWorldbank('SH.DYN.MORT', ['IND'], 2000, 2026).catch((e) => e);
    expect(err.message).toMatch(/HTTP 400/);
    expect(err.message).toMatch(/api\.worldbank\.org/);       // which request
    expect(err.message).toMatch(/SH\.DYN\.MORT/);             // for what
    expect(err.message).toMatch(/Invalid date range/);        // and the reason
  });

  it('survives an unreadable body rather than masking the status', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 502, text: async () => { throw new Error('stream closed'); },
    }) as unknown as Response) as any;
    const err = await fetchWorldbank('SH.DYN.MORT', ['IND']).catch((e) => e);
    expect(err.message).toMatch(/HTTP 502/);
    expect(err.message).toMatch(/api\.worldbank\.org/);
  });
});

describe('World Bank retry policy', () => {
  it('retries once on a rate limit and succeeds', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(ok([{ countryiso3code: 'IND', country: { value: 'India' }, date: '2020', value: 1 }]));
    globalThis.fetch = spy as any;
    const r = await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.rows).toHaveLength(1);
  });

  it('retries a server error', async () => {
    const spy = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
    globalThis.fetch = spy as any;
    await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']).catch(() => {}));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx — the request itself is wrong, repeating it wastes a call', async () => {
    const spy = vi.fn().mockResolvedValue(fail(400, 'bad request'));
    globalThis.fetch = spy as any;
    await fetchWorldbank('SH.DYN.MORT', ['IND']).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not make a stopped user wait out a retry', async () => {
    const ctrl = new AbortController();
    const spy = vi.fn(async () => { ctrl.abort(); return fail(503); });
    globalThis.fetch = spy as any;
    await fetchWorldbank('SH.DYN.MORT', ['IND'], undefined, undefined, ctrl.signal).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
