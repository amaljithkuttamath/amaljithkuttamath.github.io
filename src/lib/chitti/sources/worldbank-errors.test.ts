import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldbank } from '../tools';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

const ok = (rows: unknown[] = []) =>
  ({ ok: true, status: 200, json: async () => [{ page: 1, pages: 1 }, rows] }) as unknown as Response;
const fail = (status: number, body = '') =>
  ({ ok: false, status, text: async () => body }) as unknown as Response;
const row = { countryiso3code: 'IND', country: { value: 'India' }, date: '2020', value: 1 };

// Any case that lets a retry happen MUST drive the clock rather than wait on it.
// Not only for speed: a test that times out mid-retry leaves its loop running,
// and once afterEach has restored the global fetch that orphan calls the NEXT
// test's spy — which is exactly how a stale assumption in this file produced a
// phantom extra call in an unrelated test.
async function withRetryElapsed<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const p = run();
  await vi.advanceTimersByTimeAsync(30_000);
  return p;
}

describe('World Bank error reporting', () => {
  it('names the URL and quotes the API on a failure', async () => {
    // 404 is deliberately not retryable, so this case exercises the message
    // alone. The hole it closes: a demo-generation run died on a bare
    // "HTTP 400" and the log could not say which request of a batched
    // every-country pull had been rejected, or why.
    globalThis.fetch = vi.fn(async () => fail(404, '{"message":"no such indicator"}')) as any;
    const err = await fetchWorldbank('SH.DYN.MORT', ['IND'], 2000, 2026).catch((e) => e);
    expect(err.message).toMatch(/HTTP 404/);
    expect(err.message).toMatch(/api\.worldbank\.org/);   // which request
    expect(err.message).toMatch(/SH\.DYN\.MORT/);         // for what
    expect(err.message).toMatch(/no such indicator/);     // and the reason
  });

  it('still names the URL once retries are exhausted', async () => {
    globalThis.fetch = vi.fn(async () => fail(400, 'rate limited')) as any;
    const err = await withRetryElapsed(() =>
      fetchWorldbank('SH.DYN.MORT', ['IND']).catch((e) => e)
    );
    expect(err.message).toMatch(/HTTP 400/);
    expect(err.message).toMatch(/api\.worldbank\.org/);
    expect(err.message).toMatch(/rate limited/);
  });

  it('survives an unreadable body rather than masking the status', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 404, text: async () => { throw new Error('stream closed'); },
    }) as unknown as Response) as any;
    const err = await fetchWorldbank('SH.DYN.MORT', ['IND']).catch((e) => e);
    expect(err.message).toMatch(/HTTP 404/);
    expect(err.message).toMatch(/api\.worldbank\.org/);
  });
});

describe('World Bank retry policy', () => {
  it('DOES retry a 400 — this API throttles with 400 and reports bad parameters with 200', async () => {
    // Measured, not assumed. A live probe from a CI runner saw the exact
    // production-failing request succeed in 43ms, then three consecutive
    // requests time out — throttling, not a malformed request. And a genuine
    // parameter error arrives as HTTP 200 with an error envelope (that is why
    // parseWorldBankError exists), so a real 400 here is never "your request is
    // wrong". The first version of this retry excluded all 4xx on general
    // principle and so could never have fired on the failure it was written for.
    const spy = vi.fn().mockResolvedValueOnce(fail(400, 'throttled')).mockResolvedValueOnce(ok([row]));
    globalThis.fetch = spy as any;
    const r = await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.rows).toHaveLength(1);
  });

  it('retries a rate limit and a server error', async () => {
    for (const status of [429, 503]) {
      const spy = vi.fn().mockResolvedValueOnce(fail(status)).mockResolvedValueOnce(ok([row]));
      globalThis.fetch = spy as any;
      const r = await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']));
      expect(spy, `status ${status} should retry`).toHaveBeenCalledTimes(2);
      expect(r.rows).toHaveLength(1);
    }
  });

  it('does not retry a 404 — a real answer no repetition will change', async () => {
    const spy = vi.fn().mockResolvedValue(fail(404, 'not found'));
    globalThis.fetch = spy as any;
    await fetchWorldbank('SH.DYN.MORT', ['IND']).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts rather than looping', async () => {
    const spy = vi.fn().mockResolvedValue(fail(429));
    globalThis.fetch = spy as any;
    await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']).catch(() => {}));
    expect(spy).toHaveBeenCalledTimes(3); // initial + two backoffs
  });

  it('does not make a stopped user wait out a retry', async () => {
    const ctrl = new AbortController();
    const spy = vi.fn(async () => { ctrl.abort(); return fail(503); });
    globalThis.fetch = spy as any;
    await withRetryElapsed(() =>
      fetchWorldbank('SH.DYN.MORT', ['IND'], undefined, undefined, ctrl.signal).catch(() => {})
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('World Bank pagination', () => {
  // The API reports the page count in the response header and serves the rest
  // on later pages. Reading only page one silently truncated any pull over
  // PER_PAGE rows — and because rows arrive ordered by country, what went
  // missing was whole countries off the end of the alphabet, with nothing in
  // the result to show it. A 60-country batch across 1960–2024 is 3,900 rows.
  const page = (pages: number, rows: unknown[]) =>
    ({ ok: true, status: 200, json: async () => [{ page: 1, pages, lastupdated: '2024-12-16' }, rows] }) as unknown as Response;
  const rowFor = (iso3: string, year: number) =>
    ({ countryiso3code: iso3, country: { value: iso3 }, date: String(year), value: 1 });

  it('walks every page the header announces', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(page(3, [rowFor('AAA', 2000)]))
      .mockResolvedValueOnce(page(3, [rowFor('BBB', 2000)]))
      .mockResolvedValueOnce(page(3, [rowFor('CCC', 2000)]));
    globalThis.fetch = spy as any;
    const r = await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND'], 1960, 2024));
    expect(spy).toHaveBeenCalledTimes(3);
    expect(r.rows.map((x) => x.iso3)).toEqual(['AAA', 'BBB', 'CCC']);
  });

  it('asks for the later pages by number', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(page(2, [rowFor('AAA', 2000)]))
      .mockResolvedValueOnce(page(2, [rowFor('BBB', 2000)]));
    globalThis.fetch = spy as any;
    await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']));
    expect(String(spy.mock.calls[0][0])).not.toMatch(/[&?]page=/);
    expect(String(spy.mock.calls[1][0])).toMatch(/[&?]page=2\b/);
  });

  it('makes exactly one request when there is one page', async () => {
    const spy = vi.fn().mockResolvedValue(page(1, [rowFor('IND', 2000)]));
    globalThis.fetch = spy as any;
    const r = await fetchWorldbank('SH.DYN.MORT', ['IND']);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.rows).toHaveLength(1);
  });

  it('keeps the first page URL as the citation, not the last', async () => {
    // The citation must point at the pull, not at whichever page happened to
    // come last — a reader following it should get the whole thing.
    const spy = vi.fn()
      .mockResolvedValueOnce(page(2, [rowFor('AAA', 2000)]))
      .mockResolvedValueOnce(page(2, [rowFor('BBB', 2000)]));
    globalThis.fetch = spy as any;
    const r = await withRetryElapsed(() => fetchWorldbank('SH.DYN.MORT', ['IND']));
    expect(r.requestUrl).not.toMatch(/[&?]page=/);
    expect(r.sourceUpdated).toBe('2024-12-16');
  });

  it('stops rather than looping on a nonsense page count', async () => {
    const spy = vi.fn().mockResolvedValue(page(999999, [rowFor('IND', 2000)]));
    globalThis.fetch = spy as any;
    // 99 paced gaps at BATCH_PACING_MS, so the clock has to be driven past
    // ~35s — well beyond the retry helper's window.
    vi.useFakeTimers();
    const p = fetchWorldbank('SH.DYN.MORT', ['IND']);
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    expect(spy).toHaveBeenCalledTimes(100); // MAX_PAGES, not 999999
  });

  it('treats a missing or unusable page count as a single page', async () => {
    for (const pages of [undefined, 0, -1, 'lots']) {
      const spy = vi.fn().mockResolvedValue(
        { ok: true, status: 200, json: async () => [{ pages }, [rowFor('IND', 2000)]] } as unknown as Response
      );
      globalThis.fetch = spy as any;
      await fetchWorldbank('SH.DYN.MORT', ['IND']);
      expect(spy, `pages=${pages}`).toHaveBeenCalledTimes(1);
    }
  });

  it('does not make a stopped user wait out the remaining pages', async () => {
    const ctrl = new AbortController();
    const spy = vi.fn(async () => { ctrl.abort(); return page(5, [rowFor('IND', 2000)]); });
    globalThis.fetch = spy as any;
    await withRetryElapsed(() =>
      fetchWorldbank('SH.DYN.MORT', ['IND'], undefined, undefined, ctrl.signal).catch(() => {})
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
