import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFreeModel,
  pricePerMillion,
  formatPricePerM,
  parseOpenRouterCatalog,
  fetchModels,
  classifyProviderError,
  parseRetryAfter,
  ClassifiedError,
  complete,
  type ProviderErrorClass,
  type ProviderId,
  type ProviderConfig,
  type CompleteDeps,
} from './providers';

// A realistic slice of openrouter.ai/api/v1/models. Pricing is USD *per token*
// as strings, exactly as OpenRouter returns it.
const CATALOG = {
  data: [
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      name: 'NVIDIA: Nemotron 3 Ultra 550B (free)',
      context_length: 131072,
      supported_parameters: ['tools', 'reasoning'],
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      name: 'DeepSeek: V4 Flash',
      context_length: 163840,
      supported_parameters: ['tools', 'reasoning', 'logprobs'],
      pricing: { prompt: '0.00000009', completion: '0.00000018' },
    },
    {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      context_length: 400000,
      supported_parameters: ['tools'],
      pricing: { prompt: '0.000002', completion: '0.000008' },
    },
    // No tools → excluded from a deep-agent picker.
    {
      id: 'some/embedding-only',
      name: 'Embedding Only',
      context_length: 8192,
      supported_parameters: [],
      pricing: { prompt: '0.0000001', completion: '0' },
    },
    // Preview/deprecated slug (~ prefix) → excluded.
    {
      id: '~preview/old-model',
      name: 'Old Preview',
      supported_parameters: ['tools'],
      pricing: { prompt: '0', completion: '0' },
    },
  ],
};

describe('pricePerMillion — per-token string → per-1M number', () => {
  it('converts a per-token price string to USD per 1M tokens', () => {
    expect(pricePerMillion('0.00000009')).toBeCloseTo(0.09, 6);
    expect(pricePerMillion('0.000002')).toBeCloseTo(2, 6);
    expect(pricePerMillion(0)).toBe(0);
  });

  it('returns undefined for missing/blank/unparseable input (never guesses)', () => {
    expect(pricePerMillion(undefined)).toBeUndefined();
    expect(pricePerMillion(null)).toBeUndefined();
    expect(pricePerMillion('')).toBeUndefined();
    expect(pricePerMillion('not-a-number')).toBeUndefined();
  });
});

describe('formatPricePerM — compact USD/1M display', () => {
  it('formats sub-dollar prices with two decimals', () => {
    expect(formatPricePerM(0.09)).toBe('$0.09');
    expect(formatPricePerM(0.15)).toBe('$0.15');
  });

  it('trims trailing zeros on whole-ish prices', () => {
    expect(formatPricePerM(2)).toBe('$2');
    expect(formatPricePerM(15)).toBe('$15');
  });

  it('shows $0 for free and omits (undefined) when the figure is absent', () => {
    expect(formatPricePerM(0)).toBe('$0');
    expect(formatPricePerM(undefined)).toBeUndefined();
  });
});

describe('isFreeModel — free detection', () => {
  it('treats a :free id as free regardless of pricing', () => {
    expect(isFreeModel({ id: 'x/y:free', pricing: { prompt: '99', completion: '99' } })).toBe(true);
  });

  it('treats zero prompt AND completion pricing as free', () => {
    expect(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0' } })).toBe(true);
  });

  it('does not call a model free when completion still charges', () => {
    expect(isFreeModel({ id: 'x/y', pricing: { prompt: '0', completion: '0.0000002' } })).toBe(false);
  });

  it('does not call a model free when pricing is missing (no guessing)', () => {
    expect(isFreeModel({ id: 'x/y' })).toBe(false);
  });
});

describe('parseOpenRouterCatalog — pure catalog parse', () => {
  it('keeps only tool-capable, non-preview models', () => {
    const opts = parseOpenRouterCatalog(CATALOG);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(ids).toContain('deepseek/deepseek-v4-flash');
    expect(ids).toContain('openai/gpt-5');
    expect(ids).not.toContain('some/embedding-only'); // no tools
    expect(ids).not.toContain('~preview/old-model'); // preview slug
  });

  it('sorts free models first, then alphabetical', () => {
    const opts = parseOpenRouterCatalog(CATALOG);
    expect(opts[0].free).toBe(true);
    expect(opts[0].id).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
  });

  it('carries name, ctx, reasoning, and per-1M pricing from the catalog', () => {
    const opts = parseOpenRouterCatalog(CATALOG);
    const dsk = opts.find((o) => o.id === 'deepseek/deepseek-v4-flash')!;
    expect(dsk.name).toBe('DeepSeek: V4 Flash');
    expect(dsk.ctx).toBe(163840);
    expect(dsk.reasoning).toBe(true);
    expect(dsk.free).toBe(false);
    expect(dsk.promptPricePerM).toBeCloseTo(0.09, 6);
    expect(dsk.completionPricePerM).toBeCloseTo(0.18, 6);
  });

  it('zeroes pricing for free models even if catalog figures stray', () => {
    const opts = parseOpenRouterCatalog(CATALOG);
    const free = opts.find((o) => o.free)!;
    expect(free.promptPricePerM).toBe(0);
    expect(free.completionPricePerM).toBe(0);
  });

  it('does not fabricate pricing when the catalog omits it', () => {
    const opts = parseOpenRouterCatalog({
      data: [{ id: 'x/y', supported_parameters: ['tools'] }],
    });
    expect(opts).toHaveLength(1);
    expect(opts[0].promptPricePerM).toBeUndefined();
    expect(opts[0].completionPricePerM).toBeUndefined();
  });

  it('returns [] for a malformed payload instead of throwing', () => {
    expect(parseOpenRouterCatalog(null)).toEqual([]);
    expect(parseOpenRouterCatalog({})).toEqual([]);
    expect(parseOpenRouterCatalog({ data: 'nope' })).toEqual([]);
  });
});

describe('fetchModels — live fetch with graceful fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the real fetch/parse path when the catalog is reachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => CATALOG })
    );
    const models = await fetchModels('openrouter');
    // Distinct cache key so this test never reads another test's cache.
    const ids = models.map((m) => m.id);
    expect(ids).toContain('deepseek/deepseek-v4-flash');
    expect(models[0].free).toBe(true);
  });

  it('falls back to the curated list when the fetch fails (offline sandbox)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // A key the previous test did not populate, so we exercise the fallback.
    const models = await fetchModels('openai', 'sk-offline-fallback-key');
    expect(models.length).toBeGreaterThan(0);
    // Curated OpenAI fallback slugs.
    expect(models.some((m) => m.id === 'gpt-5-mini')).toBe(true);
  });
});

// ── Provider error classification (backlog #17) ────────────────────────────
// The three providers' error bodies DIFFER, so the classifier is table-driven
// across all classes × all three shapes. The stubbed shapes ARE the contract:
// egress is blocked in the sandbox, so real provider errors can't be reproduced.
//   OpenRouter/OpenAI : { error: { message, code, type } }
//   Anthropic         : { type: 'error', error: { type, message } }
describe('classifyProviderError — taxonomy × 3 provider shapes', () => {
  // Build a provider-shaped error body for a given semantic message.
  const orBody = (message: string, code: number | string = 400) => ({ error: { message, code } });
  const oaBody = (message: string, type: string, code?: string) => ({ error: { message, type, ...(code ? { code } : {}) } });
  const anBody = (message: string, type: string) => ({ type: 'error', error: { type, message } });

  interface Row {
    name: string;
    provider: ProviderId;
    input: unknown;
    cls: ProviderErrorClass;
  }

  const rows: Row[] = [
    // bad_key — 401/403 on every provider, plus explicit invalid-key bodies.
    { name: 'openrouter 401', provider: 'openrouter', input: { status: 401, body: orBody('No auth credentials found', 401) }, cls: 'bad_key' },
    { name: 'openai 401 invalid_api_key', provider: 'openai', input: { status: 401, body: oaBody('Incorrect API key provided', 'invalid_request_error', 'invalid_api_key') }, cls: 'bad_key' },
    { name: 'anthropic 401 authentication_error', provider: 'anthropic', input: { status: 401, body: anBody('invalid x-api-key', 'authentication_error') }, cls: 'bad_key' },
    { name: 'openai 403 forbidden', provider: 'openai', input: { status: 403, body: oaBody('forbidden', 'permission_error') }, cls: 'bad_key' },

    // rate_limit — 429 without a credits shape.
    { name: 'openrouter 429', provider: 'openrouter', input: { status: 429, body: orBody('Rate limit exceeded', 429) }, cls: 'rate_limit' },
    { name: 'openai 429 rate_limit_exceeded', provider: 'openai', input: { status: 429, body: oaBody('Rate limit reached', 'rate_limit_exceeded') }, cls: 'rate_limit' },
    { name: 'anthropic 429 rate_limit_error', provider: 'anthropic', input: { status: 429, body: anBody('Number of requests has exceeded your rate limit', 'rate_limit_error') }, cls: 'rate_limit' },

    // insufficient_credits — 402 and the provider-specific 429/400 credit shapes.
    { name: 'openrouter 402', provider: 'openrouter', input: { status: 402, body: orBody('Insufficient credits', 402) }, cls: 'insufficient_credits' },
    { name: 'openai 429 insufficient_quota', provider: 'openai', input: { status: 429, body: oaBody('You exceeded your current quota', 'insufficient_quota', 'insufficient_quota') }, cls: 'insufficient_credits' },
    { name: 'anthropic 400 low balance', provider: 'anthropic', input: { status: 400, body: anBody('Your credit balance is too low to access the Claude API', 'invalid_request_error') }, cls: 'insufficient_credits' },

    // context_length — 400 with a provider-specific over-context message.
    { name: 'openai context_length_exceeded', provider: 'openai', input: { status: 400, body: oaBody("This model's maximum context length is 8192 tokens, however you requested 9000", 'invalid_request_error', 'context_length_exceeded') }, cls: 'context_length' },
    { name: 'anthropic prompt too long', provider: 'anthropic', input: { status: 400, body: anBody('prompt is too long: 250000 tokens > 200000 maximum', 'invalid_request_error') }, cls: 'context_length' },
    { name: 'openrouter context window', provider: 'openrouter', input: { status: 400, body: orBody('input length and max_tokens exceed context window', 400) }, cls: 'context_length' },

    // model_unavailable — 404 on every provider, plus a 400 "no endpoints" body.
    { name: 'openrouter 404', provider: 'openrouter', input: { status: 404, body: orBody('No endpoints found for foo/bar', 404) }, cls: 'model_unavailable' },
    { name: 'openai 404 model_not_found', provider: 'openai', input: { status: 404, body: oaBody('The model `gpt-nope` does not exist', 'invalid_request_error', 'model_not_found') }, cls: 'model_unavailable' },
    { name: 'anthropic 404 not_found_error', provider: 'anthropic', input: { status: 404, body: anBody('model: claude-nope', 'not_found_error') }, cls: 'model_unavailable' },
    { name: 'openrouter 400 no endpoints', provider: 'openrouter', input: { status: 400, body: orBody('model_not_found: no endpoints found matching your data policy', 400) }, cls: 'model_unavailable' },

    // server — 5xx on every provider, plus OpenRouter's 400 "Provider returned error".
    { name: 'openrouter 500', provider: 'openrouter', input: { status: 500, body: orBody('internal error', 500) }, cls: 'server' },
    { name: 'openai 503', provider: 'openai', input: { status: 503, body: oaBody('The server is overloaded', 'server_error') }, cls: 'server' },
    { name: 'anthropic 529 overloaded', provider: 'anthropic', input: { status: 529, body: anBody('Overloaded', 'overloaded_error') }, cls: 'server' },
    { name: 'openrouter 400 provider returned error', provider: 'openrouter', input: { status: 400, body: orBody('Provider returned error', 400) }, cls: 'server' },

    // timeout — HTTP 408.
    { name: 'openai 408', provider: 'openai', input: { status: 408, body: oaBody('Request timeout', 'timeout') }, cls: 'timeout' },

    // unknown — an unmapped 4xx with an unrecognized body.
    { name: 'openrouter 418 teapot', provider: 'openrouter', input: { status: 418, body: orBody("I'm a teapot", 418) }, cls: 'unknown' },
  ];

  for (const r of rows) {
    it(`${r.name} → ${r.cls}`, () => {
      const info = classifyProviderError(r.input, r.provider);
      expect(info.errorClass).toBe(r.cls);
      expect(info.provider).toBe(r.provider);
      expect(info.message.length).toBeGreaterThan(0);
    });
  }

  it('exception shapes: AbortError → timeout, fetch TypeError → network', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(classifyProviderError(abort, 'openrouter').errorClass).toBe('timeout');
    const netErr = new TypeError('Failed to fetch');
    expect(classifyProviderError(netErr, 'anthropic').errorClass).toBe('network');
    // A CORS-flavoured message still reads as network even without a TypeError.
    expect(classifyProviderError(new Error('NetworkError when attempting to fetch resource'), 'openai').errorClass).toBe('network');
  });

  it('assigns retryable/fallbackEligible flags correctly per class', () => {
    const flags = (input: unknown, p: ProviderId = 'openrouter') => {
      const i = classifyProviderError(input, p);
      return { retryable: i.retryable, fallbackEligible: i.fallbackEligible };
    };
    // Transient transport classes retry; only model_unavailable/rate_limit/
    // insufficient_credits are fallback-eligible; bad_key/context_length neither.
    expect(flags({ status: 429, body: {} })).toEqual({ retryable: true, fallbackEligible: true }); // rate_limit
    expect(flags({ status: 500, body: {} })).toEqual({ retryable: true, fallbackEligible: false }); // server
    expect(flags({ status: 404, body: {} })).toEqual({ retryable: false, fallbackEligible: true }); // model_unavailable
    expect(flags({ status: 402, body: {} })).toEqual({ retryable: false, fallbackEligible: true }); // insufficient_credits
    expect(flags({ status: 401, body: {} })).toEqual({ retryable: false, fallbackEligible: false }); // bad_key
    expect(flags(new TypeError('Failed to fetch'))).toEqual({ retryable: true, fallbackEligible: false }); // network
  });

  it('never throws on garbage input (returns unknown)', () => {
    for (const junk of [null, undefined, 42, 'string', [], { status: 'nope' }, { status: 400, body: '{{{not json' }, { status: 400, body: { weird: true } }]) {
      const info = classifyProviderError(junk, 'openrouter');
      expect(info.errorClass).toBeDefined();
      expect(typeof info.message).toBe('string');
    }
  });

  it('bad_key message names the provider and points at settings; never suggests a fallback', () => {
    const info = classifyProviderError({ status: 401, body: {} }, 'openrouter');
    expect(info.message).toMatch(/OpenRouter/);
    expect(info.message).toMatch(/key/i);
    expect(info.fallbackEligible).toBe(false);
  });
});

describe('parseRetryAfter — header parsing (capping is applied at wait time)', () => {
  it('parses integer seconds → milliseconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('600')).toBe(600000);
  });
  it('parses an HTTP-date relative to now (never negative)', () => {
    const now = 1_000_000_000_000;
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBeGreaterThanOrEqual(0);
    // A past date clamps to 0, not a negative wait.
    expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  });
  it('returns undefined for missing/blank/unparseable input', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
  it('captures Retry-After through the classifier for a 429', () => {
    const info = classifyProviderError({ status: 429, body: {}, headers: { 'retry-after': '3' } }, 'openai');
    expect(info.errorClass).toBe('rate_limit');
    expect(info.retryAfterMs).toBe(3000);
  });
});

// ── complete() orchestration: timeout, retry, and fallback gating ──────────
// A fake fetch returns provider-shaped Response-likes; injected sleep/random/
// buildFreeFallbackChain make timing deterministic with no real sleeps.
describe('complete — transport hardening (retry / fallback / timeout / malformed)', () => {
  const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
    provider: 'openai',
    model: 'gpt-5-mini',
    apiKey: 'k',
    ...over,
  });

  // A Response-like for the fake fetch.
  const httpErr = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: false,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  });
  // A successful chat completion. complete() reads the body via text() (so it
  // can tell a blank body apart from garbage before parsing), so the fake must
  // serialize the JSON there — not only expose json().
  const okBody = (model = 'served-model', over: Record<string, unknown> = {}) => ({
    choices: [{ message: { content: 'hello', tool_calls: [] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    model,
    ...over,
  });
  const okChat = (model = 'served-model') => {
    const body = okBody(model);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: { get: () => null },
    };
  };
  // A 200 whose body is exactly `raw` (string) — for empty-body / garbage cases.
  const okRaw = (raw: string) => ({
    ok: true,
    status: 200,
    text: async () => raw,
    json: async () => JSON.parse(raw),
    headers: { get: () => null },
  });

  const deps = (fetchImpl: any, over: Partial<CompleteDeps> = {}): CompleteDeps => ({
    fetch: fetchImpl,
    sleep: async () => {},
    random: () => 0,
    ...over,
  });

  it('runs every provider fetch under an AbortController (timeout wiring)', async () => {
    let sawSignal = false;
    const f = vi.fn(async (_url: string, init: any) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return okChat();
    });
    await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
    expect(sawSignal).toBe(true);
  });

  it('an aborted fetch classifies as timeout and never hangs the turn', async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f))).rejects.toMatchObject({
      errorClass: 'timeout',
    });
    // A timeout is transient → one retry, so exactly two attempts, then surface.
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a user-abort short-circuits ALL recovery: no retry, no fallback (one attempt)', async () => {
    // The signal is already aborted when the fetch rejects (as it would be after
    // a user "stop"). Even though the class is transient (timeout), complete()
    // must NOT retry or fall back — retrying a cancelled request is wasted work.
    const ctrl = new AbortController();
    ctrl.abort();
    const f = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    await expect(
      complete(
        cfg({ provider: 'openrouter', model: 'x:free' }),
        [{ role: 'user', content: 'hi' }],
        [],
        deps(f, { signal: ctrl.signal })
      )
    ).rejects.toBeInstanceOf(Error);
    // Exactly one attempt: the abort guard skipped the same-model retry AND the
    // free-model fallback chain that a :free primary would normally try.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('forwards the external (stop) signal into the fetch so an in-flight request aborts', async () => {
    const ctrl = new AbortController();
    let observed: AbortSignal | undefined;
    const f = vi.fn(async (_url: string, init: any) => {
      observed = init?.signal;
      // The stop fires while the request is "in flight".
      ctrl.abort();
      return okChat();
    });
    await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f, { signal: ctrl.signal }));
    // The fetch's composed signal reflects the external abort (timeout controller
    // + external stop share one AbortController inside fetchWithTimeout).
    expect(observed).toBeInstanceOf(AbortSignal);
    expect(observed!.aborted).toBe(true);
  });

  it('retries a transient server error several times with backoff, then surfaces', async () => {
    // server (5xx) is a pure transport class: a brief upstream blip, not fixable
    // by switching models — so it gets up to MAX_TRANSPORT_RETRIES same-model
    // retries (4 attempts total) before surfacing.
    const f = vi.fn(async () => httpErr(500, { error: { message: 'internal', code: 500 } }));
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
    // random()=0 (deps default) → no jitter, so the sleeps are the pure backoff.
    await expect(
      complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f, { sleep }))
    ).rejects.toMatchObject({ errorClass: 'server' });
    expect(f).toHaveBeenCalledTimes(4); // one original + three retries
    expect(sleep).toHaveBeenCalledTimes(3);
    // Exponential backoff: each wait is strictly larger than the last.
    expect(sleeps).toEqual([600, 1200, 2400]);
    // The surfaced message notes how many retries were spent.
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f))).rejects.toThrow(/after 3 retries/i);
  });

  it('retries a network/CORS failure several times before giving up (the live case)', async () => {
    // The user-reported failure: `fetch` throws a TypeError before any response.
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const sleep = vi.fn(async () => {});
    await expect(
      complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f, { sleep }))
    ).rejects.toMatchObject({ errorClass: 'network' });
    expect(f).toHaveBeenCalledTimes(4); // one original + three retries
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('a network failure that recovers on a later retry returns the completion', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n < 3) throw new TypeError('Failed to fetch');
      return okChat();
    });
    const out = await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
    expect(out.text).toBe('hello');
    expect(f).toHaveBeenCalledTimes(3); // failed, failed, succeeded
  });

  it('a transient error that succeeds on the retry returns the completion', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      return n === 1 ? httpErr(503, { error: { message: 'overloaded' } }) : okChat();
    });
    const out = await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
    expect(out.text).toBe('hello');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on a 429 retry, capped at a few seconds', async () => {
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
    });
    // 600s Retry-After must be capped (random()=0 → delay == the cap exactly).
    const f = vi.fn(async () => httpErr(429, { error: { message: 'slow down' } }, { 'retry-after': '600' }));
    await expect(
      complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f, { sleep }))
    ).rejects.toMatchObject({ errorClass: 'rate_limit' });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(4000); // capped, not 600_000ms
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  // A malformed body used to be a dead end (no retry, no fallback), so one
  // unreadable response from a free model killed the whole run. Live evidence
  // showed free models return unreadable bodies at meaningful rates, so it is
  // now RETRYABLE (and fallback-eligible), exactly like empty_completion: one
  // same-model retry first, then a free substitute where one exists.
  it('RETRIES a malformed completion (valid JSON, no choices array) once, then surfaces', async () => {
    // A non-empty, parseable body that simply isn't a completion shape → an
    // unreadable `malformed`. cfg() is a non-free OpenAI primary, so there is no
    // free substitute: it retries once (same model) and then surfaces.
    const f = vi.fn(async () => okRaw(JSON.stringify({ not: 'a completion' })));
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f))).rejects.toMatchObject({
      errorClass: 'malformed',
    });
    expect(f).toHaveBeenCalledTimes(2); // original + one retry (malformed is retryable)
  });

  it('RETRIES unparseable JSON garbage once, then surfaces as malformed', async () => {
    // Non-empty but not JSON at all (e.g. an HTML error page) → malformed.
    const f = vi.fn(async () => okRaw('<html>gateway error</html>'));
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f))).rejects.toMatchObject({
      errorClass: 'malformed',
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  // ── empty_completion: transient free-model glitch (backlog #17 regression) ──
  // OpenRouter free models (Nemotron 3 Ultra among them) transiently return a
  // 200 that carries no usable output. 755d6e2 classified these as `malformed`
  // (non-retryable, non-fallback), so ONE transient empty killed the whole run.
  // They are now `empty_completion`: retryable AND fallback-eligible.
  describe('empty_completion — empty 200s are retried then fall back, not dead-ended', () => {
    // Every shape of "a 200 with nothing usable in it".
    const emptyShapes: Record<string, unknown> = {
      'empty choices array': { choices: [], usage: {}, model: 'm' },
      'choices[0].message missing': { choices: [{}], usage: {}, model: 'm' },
      'content:"" with no tool_calls': {
        choices: [{ message: { content: '', tool_calls: [] } }],
        usage: {},
        model: 'm',
      },
      'content null with no tool_calls': {
        choices: [{ message: { content: null } }],
        usage: {},
        model: 'm',
      },
    };

    for (const [name, body] of Object.entries(emptyShapes)) {
      it(`${name} → empty_completion (retryable), retried once on a non-free primary`, async () => {
        const f = vi.fn(async () => okRaw(JSON.stringify(body)));
        const sleep = vi.fn(async () => {});
        // Non-free OpenAI primary: no fallback substitute, so it retries once
        // (same model) and then surfaces — exactly two attempts.
        await expect(
          complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f, { sleep }))
        ).rejects.toMatchObject({ errorClass: 'empty_completion' });
        expect(f).toHaveBeenCalledTimes(2); // original + one retry
        expect(sleep).toHaveBeenCalledTimes(1);
      });
    }

    it('a 200 with a blank body is empty_completion, not malformed', async () => {
      const f = vi.fn(async () => okRaw(''));
      await expect(
        complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f))
      ).rejects.toMatchObject({ errorClass: 'empty_completion' });
      expect(f).toHaveBeenCalledTimes(2); // retryable
    });

    it('an empty completion that answers on the retry succeeds (no fallback needed)', async () => {
      let n = 0;
      const f = vi.fn(async () => {
        n++;
        return n === 1 ? okRaw(JSON.stringify({ choices: [], model: 'm' })) : okChat();
      });
      const out = await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
      expect(out.text).toBe('hello');
      expect(f).toHaveBeenCalledTimes(2);
    });

    it('a free OpenRouter primary: empty → retry (same model) → fallback → surface, with attempt counts', async () => {
      const freeCfg = cfg({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' });

      // Every attempt (original, retry, and the fallback-chain attempt) comes
      // back empty, so the run exhausts all three and surfaces.
      const f = vi.fn(async () => okRaw(JSON.stringify({ choices: [], model: 'm' })));
      const buildChain = vi.fn(async () => [
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'a:free',
        'b:free',
      ]);
      const sleep = vi.fn(async () => {});
      const err = await complete(freeCfg, [{ role: 'user', content: 'hi' }], [], deps(f, { sleep, buildFreeFallbackChain: buildChain })).catch((e) => e);

      expect(err).toBeInstanceOf(ClassifiedError);
      expect(err.errorClass).toBe('empty_completion');
      // Order: 1 original + 1 same-model retry + 1 fallback-chain attempt.
      expect(f).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(1); // exactly one retry delay
      expect(buildChain).toHaveBeenCalledTimes(1); // fallback engaged once
      // The fallback attempt (3rd call) carried the substitute chain.
      const thirdBody = JSON.parse((f.mock.calls[2] as any[])[1].body);
      expect(thirdBody.models).toEqual([
        'nvidia/nemotron-3-ultra-550b-a55b:free',
        'a:free',
        'b:free',
      ]);
      // Honest receipt: the surfaced message says what was tried.
      expect(err.message).toMatch(/empty response/i);
      expect(err.message).toMatch(/after retry, then tried a fallback model/i);
    });

    it('a free OpenRouter primary: empty primary but the fallback model answers → substitution receipt', async () => {
      const freeCfg = cfg({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' });
      let n = 0;
      const f = vi.fn(async () => {
        n++;
        // 1: empty, 2: empty retry, 3: the fallback chain answers.
        return n < 3 ? okRaw(JSON.stringify({ choices: [], model: 'm' })) : okChat('backup:free');
      });
      const buildChain = vi.fn(async () => ['nvidia/nemotron-3-ultra-550b-a55b:free', 'a:free', 'b:free']);
      const out = await complete(freeCfg, [{ role: 'user', content: 'hi' }], [], deps(f, { buildFreeFallbackChain: buildChain }));
      expect(out.text).toBe('hello');
      expect(out.servedModel).toBe('backup:free'); // visible substitution
      expect(f).toHaveBeenCalledTimes(3);
    });

    it('a free OpenRouter primary: malformed → retry (same model) → fallback that answers → substitution', async () => {
      // Malformed now behaves exactly like empty_completion for a free primary:
      // it is retryable AND fallback-eligible, so an unreadable body is no longer
      // a dead end. 1: unreadable, 2: unreadable retry, 3: fallback chain answers.
      const freeCfg = cfg({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' });
      let n = 0;
      const f = vi.fn(async () => {
        n++;
        return n < 3 ? okRaw('<html>gateway error</html>') : okChat('backup:free');
      });
      const buildChain = vi.fn(async () => ['nvidia/nemotron-3-ultra-550b-a55b:free', 'a:free', 'b:free']);
      const sleep = vi.fn(async () => {});
      const out = await complete(freeCfg, [{ role: 'user', content: 'hi' }], [], deps(f, { sleep, buildFreeFallbackChain: buildChain }));
      expect(out.text).toBe('hello');
      expect(out.servedModel).toBe('backup:free'); // visible substitution
      expect(f).toHaveBeenCalledTimes(3); // original + retry + fallback attempt
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('content:"" WITH tool_calls is VALID — no retry, no fallback', async () => {
      const body = {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"x":1}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: 'm',
      };
      const f = vi.fn(async () => okRaw(JSON.stringify(body)));
      const out = await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
      expect(out.toolCalls).toHaveLength(1);
      expect(out.toolCalls[0].name).toBe('foo');
      expect(out.toolCalls[0].arguments).toEqual({ x: 1 });
      expect(out.text).toBe('');
      expect(f).toHaveBeenCalledTimes(1); // valid → single attempt
    });

    it('content null + reasoning populated (no tool_calls) → reasoning becomes the text', async () => {
      const body = {
        choices: [{ message: { content: null, reasoning: 'The answer is 42.' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
        model: 'm',
      };
      const f = vi.fn(async () => okRaw(JSON.stringify(body)));
      const out = await complete(cfg({ provider: 'openrouter', model: 'x:free', requestReasoning: true }), [{ role: 'user', content: 'hi' }], [], deps(f));
      expect(out.text).toBe('The answer is 42.'); // extracted from reasoning
      expect(out.reasoning).toBe('The answer is 42.'); // still exposed as the trace
      expect(out.toolCalls).toHaveLength(0);
      expect(f).toHaveBeenCalledTimes(1); // valid → not treated as empty
    });

    it('reasoning is NOT used as text when a real content string is present', async () => {
      const body = {
        choices: [{ message: { content: 'actual answer', reasoning: 'chain of thought' } }],
        usage: {},
        model: 'm',
      };
      const f = vi.fn(async () => okRaw(JSON.stringify(body)));
      const out = await complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(f));
      expect(out.text).toBe('actual answer');
      expect(out.reasoning).toBe('chain of thought');
    });
  });

  it('does NOT retry context_length or bad_key (surfaces at once)', async () => {
    const ctx = vi.fn(async () => httpErr(400, { error: { message: 'maximum context length is 8192 tokens', code: 'context_length_exceeded' } }));
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(ctx))).rejects.toMatchObject({ errorClass: 'context_length' });
    expect(ctx).toHaveBeenCalledTimes(1);

    const key = vi.fn(async () => httpErr(401, { error: { message: 'bad key' } }));
    await expect(complete(cfg(), [{ role: 'user', content: 'hi' }], [], deps(key))).rejects.toMatchObject({ errorClass: 'bad_key' });
    expect(key).toHaveBeenCalledTimes(1);
  });

  it('FREE-MODEL FALLBACK fires on model_unavailable but NOT on bad_key', async () => {
    const freeCfg = cfg({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' });

    // model_unavailable → fallback engaged: buildFreeFallbackChain is called and
    // a second attempt runs with the substitute chain, which succeeds.
    {
      let n = 0;
      const f = vi.fn(async () => {
        n++;
        return n === 1 ? httpErr(404, { error: { message: 'No endpoints found', code: 404 } }) : okChat('backup:free');
      });
      const buildChain = vi.fn(async () => ['nvidia/nemotron-3-ultra-550b-a55b:free', 'a:free', 'b:free']);
      const out = await complete(freeCfg, [{ role: 'user', content: 'hi' }], [], deps(f, { buildFreeFallbackChain: buildChain }));
      expect(buildChain).toHaveBeenCalledTimes(1); // fallback fired
      expect(f).toHaveBeenCalledTimes(2);
      expect(out.servedModel).toBe('backup:free');
      // The substitute chain was sent in the second request body.
      const secondBody = JSON.parse((f.mock.calls[1][1] as any).body);
      expect(secondBody.models).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free', 'a:free', 'b:free']);
    }

    // bad_key → fallback MUST NOT fire: masking a bad key hides the real problem.
    {
      const f = vi.fn(async () => httpErr(401, { error: { message: 'No auth credentials found', code: 401 } }));
      const buildChain = vi.fn(async () => ['x:free', 'y:free']);
      await expect(
        complete(freeCfg, [{ role: 'user', content: 'hi' }], [], deps(f, { buildFreeFallbackChain: buildChain }))
      ).rejects.toMatchObject({ errorClass: 'bad_key' });
      expect(buildChain).not.toHaveBeenCalled(); // no fallback masking the key
      expect(f).toHaveBeenCalledTimes(1); // and no retry either
    }
  });

  it('throws a ClassifiedError carrying the class and a specific message (inheritance root)', async () => {
    const f = vi.fn(async () => httpErr(401, { error: { message: 'No auth credentials found', code: 401 } }));
    const err = await complete(cfg({ provider: 'openrouter' }), [{ role: 'user', content: 'hi' }], [], deps(f)).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifiedError);
    expect(err.errorClass).toBe('bad_key');
    expect(err.message).toMatch(/OpenRouter rejected this API key/);
  });
});
