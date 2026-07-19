import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFreeModel,
  pricePerMillion,
  formatPricePerM,
  parseOpenRouterCatalog,
  fetchModels,
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
