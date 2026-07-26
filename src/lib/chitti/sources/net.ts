// net.ts — one place that decides how long a source request may take, and how
// it is cancelled.
//
// Two failures this fixes, both hit in the wild on one run:
//
//  1. STOP DIDN'T WORK. The turn's abort signal reached the *data* fetches
//     (`adapter.fetchSeries`) but never the *search* ones — `findSeries` took no
//     signal at all, and the live catalog/search endpoints were called with a
//     bare `fetch(url)`. A `find_series` step that ran for 447 seconds was
//     therefore uninterruptible: pressing stop set the flag, but nothing checked
//     it until the step finally returned, because ask() only tests the signal at
//     step boundaries. Every request in this module now carries the caller's
//     signal, so stop unwinds the turn wherever it is.
//
//  2. NOTHING BOUNDED A HUNG ENDPOINT. No source request had a timeout, so a
//     silently-stalled host blocked the turn indefinitely even with no stop
//     pressed. Every request now also races a deadline.
//
// The two are combined into a single signal so a request ends at whichever comes
// first — the user's stop or the deadline — and the caller can tell them apart
// (`isTimeout`).

// Default ceiling for one source request. Generous enough for the World Bank's
// batched every-country pulls (which legitimately take tens of seconds) while
// still bounded. Catalog/search calls pass something shorter.
export const SOURCE_TIMEOUT_MS = 45_000;
// Search and catalog lookups are latency-sensitive — they sit in front of the
// fetch the user actually wants, and a slow one is better abandoned than waited
// on, since every search path already degrades to "no hits" rather than failing.
export const SEARCH_TIMEOUT_MS = 12_000;

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`request exceeded ${Math.round(ms / 1000)}s`);
    this.name = 'TimeoutError';
  }
}

// True when this error is our deadline firing, as opposed to a user stop. Both
// surface as an AbortError from fetch(), so the distinction is carried on the
// controller we own, not read off the exception.
export function isTimeout(err: unknown): boolean {
  return err instanceof TimeoutError || (err as { name?: string })?.name === 'TimeoutError';
}

// Run one fetch with a deadline, cancelled early if the caller's signal fires.
//
// Deliberately built on a plain AbortController rather than
// `AbortSignal.any([...])` + `AbortSignal.timeout()`: `any` is recent enough
// (Safari 17.4, Firefox 124) that using it would silently break the stop button
// on browsers this app otherwise supports. This is a handful of lines and works
// everywhere fetch does.
export async function fetchWithTimeout(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const outer = opts.signal;
  // Already stopped before we started — don't open a connection at all.
  if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    // Our deadline, not the user's stop: report it as such so callers (and the
    // receipt) can say "timed out" instead of "aborted by user".
    if (timedOut && !outer?.aborted) throw new TimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}
