// providers.ts — a tiny BYOK LLM client that speaks tool-calling to three
// browser-reachable providers, normalised to one provider-agnostic shape:
//
//   • OpenAI      — Chat Completions, native tools
//   • OpenRouter  — OpenAI-compatible (same wire format), includes :free models
//   • Anthropic   — Messages API, tools converted to/from OpenAI format
//
// NVIDIA NIM is intentionally NOT supported: it does not send CORS headers,
// so it cannot be reached from a browser.
//
// Everything runs in the browser. Keys are passed in per-call and never
// persisted here — storage policy lives in the UI layer.

export type ProviderId = 'openai' | 'anthropic' | 'openrouter';

export interface ToolSchema {
  name: string;
  description: string;
  // JSON Schema for the tool's arguments object.
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// A single tool call the model wants us to run.
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// One turn of the conversation, in a provider-neutral shape.
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface CompletionResult {
  // Free-text the model produced alongside (or instead of) tool calls.
  text: string;
  toolCalls: ToolCall[];
  // Rough token accounting for cost display.
  usage: { input: number; output: number };
  // OpenRouter reasoning-model output only (see ModelOption.reasoning) — the
  // model's own reasoning trace for this turn, when the provider actually
  // returns it. Undefined for every other case (non-reasoning model, or a
  // reasoning-capable model whose provider doesn't expose the text — the
  // docs call out OpenAI's o-series as generating but never exposing it,
  // even when routed through OpenRouter).
  reasoning?: string;
  // The model that actually served this completion (OpenRouter returns it).
  // Differs from the requested model when the free-fallback chain kicked in.
  servedModel?: string;
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  // Set by the UI from the selected ModelOption.reasoning (OpenRouter only —
  // see ModelOption.reasoning). Gates whether complete() asks for reasoning
  // at all; requesting it on a model that doesn't support the param is a
  // request error, so this must reflect the *specific selected model*, not
  // just "provider is OpenRouter".
  requestReasoning?: boolean;
}

// ── Provider metadata for the UI dropdowns ─────────────────────────────
export interface ModelOption {
  id: string;
  label: string;
  // Human-readable catalog name (OpenRouter's `name`, e.g. "NVIDIA: Nemotron
  // 3 Ultra 550B"). Undefined when the catalog doesn't provide one — the UI
  // then falls back to the id. Never fabricated.
  name?: string;
  free?: boolean;
  // OpenRouter-only: true when the model's `supported_parameters` includes
  // 'reasoning' (per OpenRouter's own docs, not every provider that flags
  // this actually returns visible reasoning text — notably OpenAI's o-series
  // generates but never exposes it, even via OpenRouter — but requesting
  // reasoning on a model that doesn't support the param at all is a request
  // error, so this flag gates whether we ask in the first place).
  reasoning?: boolean;
  // OpenRouter-only: context window size, used to rank free fallback
  // candidates (a rough capability proxy when nothing better is available).
  ctx?: number;
  // OpenRouter-only: pricing in USD per 1M tokens (prompt / completion).
  // Undefined when the catalog omits the field — never guessed. Zero for
  // genuinely free models.
  promptPricePerM?: number;
  completionPricePerM?: number;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  models: ModelOption[];
  defaultModel: string;
  keyUrl: string;
  keyLabel: string;
  // Subtitle shown under the strip when this provider is selected.
  note?: string;
  freeNote?: boolean;
}

// Small hardcoded fallback lists for when the live /models endpoints are
// unreachable (network issue, rate limit, invalid key). Kept minimal on
// purpose — the dynamic fetch below is the source of truth.
//
// These slugs are only used as a last-resort fallback. Do NOT trust them to
// be current; the live fetch will replace them within a second of page load.
export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    models: [
      // Populated dynamically from openrouter.ai/api/v1/models on page load.
      // Fallback slugs kept intentionally short.
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'nemotron-3-ultra-550b (free)', free: true },
      { id: 'deepseek/deepseek-v4-flash', label: 'deepseek-v4-flash', reasoning: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'nemotron-3-super-120b (free)', free: true },
      { id: 'openrouter/free', label: 'openrouter/free (auto-router)', free: true },
    ],
    // Pin to a single tool-capable model. openrouter/free auto-routes across
    // *different* models between turns, which confuses multi-step tool loops:
    // each turn gets a different model with a different sense of the schema.
    // A specific free model with good tool support behaves consistently.
    //
    // ultra-550b over super-120b specifically: side-by-side testing on this
    // app's actual tool-calling pipeline (not a general benchmark) showed
    // super-120b unreliable — empty-array/tool-schema confusion, occasional
    // hallucinated tool names, and multi-retry runs burning 80k+ tokens on
    // reasoning alone. ultra-550b completed the same questions correctly on
    // the first pass, at a fraction of the token cost. Small free models
    // vary a lot on tool-use reliability specifically, even when their
    // general benchmarks look similar — worth re-checking this pin
    // periodically as OpenRouter's free-tier catalog changes.
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    keyUrl: 'https://openrouter.ai/keys',
    keyLabel: 'Get a free OpenRouter key',
    note: 'Free models load dynamically. nemotron-3-ultra-550b is the most reliable free model we’ve tested for this tool-calling pipeline — smaller free models can be unpredictable at multi-step tool use.',
    freeNote: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      // Populated from api.openai.com/v1/models once a key is entered.
      { id: 'gpt-5-mini', label: 'gpt-5-mini' },
      { id: 'gpt-5', label: 'gpt-5' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ],
    defaultModel: 'gpt-5-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'Get an OpenAI key',
    note: 'Enter your key to load your available models.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      // Populated from api.anthropic.com/v1/models once a key is entered.
      { id: 'claude-haiku-latest', label: 'claude-haiku (latest)' },
      { id: 'claude-sonnet-latest', label: 'claude-sonnet (latest)' },
      { id: 'claude-opus-latest', label: 'claude-opus (latest)' },
    ],
    defaultModel: 'claude-haiku-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'Get an Anthropic key',
    note: 'Enter your key to load your available models.',
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

// Fallback chain for FREE OpenRouter models. Verified tool-callers first;
// the rest is discovered live so it never goes stale. Quality bounds:
// 1. The chain is per-request: every call lists the user's primary first,
//    so a backup only ever serves while the primary is actually down.
// 2. Verified models (tested on this app's pipeline) outrank discovered
//    ones, and discovered candidates must support BOTH tools and reasoning
//    (weeds out most small models that fumble multi-step tool use), ranked
//    by context length as a rough capability proxy.
// 3. No wildcard auto-router — better to fail visibly than answer with a
//    model that hallucinates tool calls.
export const FREE_FALLBACK_VERIFIED = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

export async function buildFreeFallbackChain(primary: string): Promise<string[]> {
  const verified = FREE_FALLBACK_VERIFIED.filter((id) => id !== primary);
  try {
    const models = await fetchModels('openrouter'); // cached 10 min
    const live = new Set(models.map((m) => m.id));
    const discovered = models
      .filter(
        (m) =>
          m.free &&
          m.reasoning &&
          m.id !== primary &&
          !FREE_FALLBACK_VERIFIED.includes(m.id)
      )
      .sort((a, b) => (b.ctx ?? 0) - (a.ctx ?? 0))
      .slice(0, 2)
      .map((m) => m.id);
    // OpenRouter rejects requests with more than 3 entries in `models`
    // ("'models' array must have 3 items or fewer"), so the chain is
    // primary + the best 2 backups.
    return [primary, ...verified.filter((id) => live.has(id)), ...discovered].slice(0, 3);
  } catch {
    return [primary, ...verified].slice(0, 3);
  }
}

// Models verified (by hand, running this app's actual tool-calling pipeline
// — not a general benchmark) to be reliable at multi-step tool use. Small
// free models vary a lot here even when general benchmarks look similar,
// so this list exists to save a user from re-discovering that the hard way.
// Update it as models are tested; remove one the moment it stops holding up.
//
//  - nvidia/nemotron-3-ultra-550b-a55b:free — default. Completed every test
//    question correctly, first pass, at a fraction of the token cost of
//    smaller free models on the same pipeline.
//  - deepseek/deepseek-v4-flash — cheap paid ($0.09/$0.18 per M tokens), also
//    reasoning-capable AND one of the few OpenRouter models that returns
//    real per-token logprobs (supported_parameters includes 'logprobs'/
//    'top_logprobs') — worth knowing about if real confidence-tinting ever
//    gets wired up, not just the visual treatment.
export const RECOMMENDED_OPENROUTER_MODELS = new Set([
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'deepseek/deepseek-v4-flash',
]);

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-latest',
  openrouter: 'nvidia/nemotron-3-ultra-550b-a55b:free',
};

// ── Dynamic model discovery ────────────────────────────────────────────
// Each provider exposes a /models endpoint we can hit from the browser to
// list what's actually available *right now*. This is how we avoid ever
// shipping stale model slugs again.
//
// Cached per provider+key for the tab session.
const MODELS_CACHE = new Map<string, { at: number; models: ModelOption[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

export async function fetchModels(provider: ProviderId, apiKey?: string): Promise<ModelOption[]> {
  const cacheKey = provider + ':' + (apiKey || '');
  const cached = MODELS_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  let models: ModelOption[] = [];
  try {
    if (provider === 'openrouter') {
      models = await fetchOpenRouterModels();
    } else if (provider === 'openai' && apiKey) {
      models = await fetchOpenAIModels(apiKey);
    } else if (provider === 'anthropic' && apiKey) {
      models = await fetchAnthropicModels(apiKey);
    }
  } catch (err) {
    console.warn('fetchModels failed for', provider, err);
  }

  // Fall back to the hardcoded list if the live fetch returned nothing.
  if (!models.length) {
    models = providerMeta(provider).models;
  }

  MODELS_CACHE.set(cacheKey, { at: Date.now(), models });
  return models;
}

// ── OpenRouter catalog: pure, offline-testable parsing ─────────────────
// The live fetch is a thin wrapper; the shape-handling below is pulled out
// as pure functions so the searchable model picker's free-detection, pricing
// formatting, and catalog parsing can be unit-tested against fixture JSON
// without any network. Parse defensively: OpenRouter's payload is external.

// One raw model entry from openrouter.ai/api/v1/models `data[]`. Only the
// fields we read are typed; everything is optional because it's external.
interface RawOpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string | number; completion?: string | number };
}

// A model is "free" when its id is tagged `:free` OR its per-token prompt AND
// completion prices both parse to exactly 0. Requiring both to be zero avoids
// mislabelling a model that reads for free but charges to generate.
export function isFreeModel(m: RawOpenRouterModel): boolean {
  if ((m.id ?? '').endsWith(':free')) return true;
  const prompt = pricePerMillion(m.pricing?.prompt);
  const completion = pricePerMillion(m.pricing?.completion);
  return prompt === 0 && completion === 0;
}

// OpenRouter quotes pricing in USD *per token* as a string (e.g. "0.0000004").
// Convert to USD per 1M tokens. Returns undefined when the field is missing or
// unparseable — the UI omits the figure rather than guessing.
export function pricePerMillion(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return undefined;
  return n * 1e6;
}

// Format a USD-per-1M-tokens figure for the picker. undefined in → undefined
// out (omit the field). $0 for free. Compact otherwise: $0.15, $2, $15.
export function formatPricePerM(perM: number | undefined): string | undefined {
  if (perM === undefined) return undefined;
  if (perM === 0) return '$0';
  // Sub-dollar prices keep two decimals; whole-ish prices trim trailing zeros.
  const s = perM < 1 ? perM.toFixed(2) : perM.toFixed(2).replace(/\.?0+$/, '');
  return '$' + s;
}

// Parse OpenRouter's /models JSON into ModelOption[]: tool-capable models only
// (a deep-agent needs tools), preview/deprecated `~`-prefixed slugs dropped,
// free models first then alphabetical. Pure — no fetch, no PRICING mutation.
export function parseOpenRouterCatalog(json: unknown): ModelOption[] {
  const data = (json as { data?: unknown })?.data;
  const raw: RawOpenRouterModel[] = Array.isArray(data) ? (data as RawOpenRouterModel[]) : [];

  const opts: ModelOption[] = [];
  for (const m of raw) {
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id) continue;
    // Skip preview/deprecated models (prefixed with ~ on OpenRouter).
    if (id.startsWith('~')) continue;
    const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    if (!params.includes('tools')) continue;

    const free = isFreeModel(m);
    const reasoning = params.includes('reasoning');
    const ctx = typeof m.context_length === 'number' ? m.context_length : undefined;
    const name = typeof m.name === 'string' && m.name.trim() ? m.name.trim() : undefined;
    // Free models cost nothing regardless of any stray catalog figure.
    const promptPricePerM = free ? 0 : pricePerMillion(m.pricing?.prompt);
    const completionPricePerM = free ? 0 : pricePerMillion(m.pricing?.completion);

    opts.push({
      id,
      label: id + (free ? '  · free' : '') + (reasoning ? '  · reasoning' : ''),
      name,
      free,
      reasoning,
      ctx,
      promptPricePerM,
      completionPricePerM,
    });
  }

  // Free first, then alphabetical.
  opts.sort((a, b) => {
    if (!!a.free !== !!b.free) return a.free ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return opts;
}

// OpenRouter — public endpoint, no auth. Delegates parsing to the pure
// parseOpenRouterCatalog and, as its one side effect, caches per-model pricing
// so estimateCost tracks the live catalog.
async function fetchOpenRouterModels(): Promise<ModelOption[]> {
  const resp = await fetch('https://openrouter.ai/api/v1/models');
  if (!resp.ok) return [];
  const j = await resp.json();
  const opts = parseOpenRouterCatalog(j);
  for (const m of opts) {
    const inPrice = m.promptPricePerM ?? 0;
    const outPrice = m.completionPricePerM ?? 0;
    if (inPrice || outPrice) PRICING[m.id] = { in: inPrice, out: outPrice };
  }
  return opts;
}

// OpenAI — needs the user's key. Return only the chat-completions family.
async function fetchOpenAIModels(apiKey: string): Promise<ModelOption[]> {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
  });
  if (!resp.ok) return [];
  const j = await resp.json();
  const raw = (j.data || []) as any[];
  const opts: ModelOption[] = [];
  for (const m of raw) {
    const id: string = m.id || '';
    // Keep chat models that support tools; drop embeddings/audio/vision-only.
    if (!/^(gpt-|o1|o3|o4)/i.test(id)) continue;
    if (/(embedding|whisper|tts|dall-e|realtime|image|audio|transcribe|moderation|search)/i.test(id)) continue;
    opts.push({ id, label: id });
  }
  // Prefer newest models first by lexical desc within the same prefix.
  opts.sort((a, b) => b.id.localeCompare(a.id));
  return opts;
}

// Anthropic — needs the user's key. Every returned model supports tools.
async function fetchAnthropicModels(apiKey: string): Promise<ModelOption[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
  if (!resp.ok) return [];
  const j = await resp.json();
  const raw = (j.data || []) as any[];
  const opts: ModelOption[] = raw.map((m: any) => ({
    id: m.id,
    label: (m.display_name ?? m.id) + ' (' + (m.id) + ')',
  }));
  opts.sort((a, b) => b.id.localeCompare(a.id));
  return opts;
}

// Approximate USD per 1M tokens (input / output), for the rough cost meter.
// OpenRouter models are populated dynamically from the live pricing feed.
// Direct-provider models keep sane fallbacks; if we're wrong, worst case
// the cost estimate shows a small over- or under-estimate.
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-5-mini': { in: 0.4, out: 1.6 },
  'gpt-5': { in: 2.0, out: 8.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'claude-haiku-latest': { in: 0.8, out: 4.0 },
  'claude-sonnet-latest': { in: 3.0, out: 15.0 },
  'claude-opus-latest': { in: 15.0, out: 75.0 },
};

export function estimateCost(model: string, usage: { input: number; output: number }): number {
  // :free OpenRouter models cost nothing.
  if (model.endsWith(':free')) return 0;
  const p = PRICING[model] ?? { in: 0.2, out: 0.8 };
  return (usage.input / 1e6) * p.in + (usage.output / 1e6) * p.out;
}

// ── OpenAI-compatible wire format (OpenAI + OpenRouter) ────────────────
function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length) {
        out.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
        // OpenAI wants content null when only tool calls are present.
        if (!m.content) out.content = null;
      }
      return out;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

async function callOpenAICompatible(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[]
): Promise<CompletionResult> {
  const isRouter = cfg.provider === 'openrouter';
  const endpoint = isRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toOpenAIMessages(messages),
    temperature: 0.2,
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  // OpenRouter reasoning models only — see ProviderConfig.requestReasoning.
  // Requesting this param on a model that doesn't support it is a request
  // error, so this must only be set when the UI resolved the *selected*
  // model as reasoning-capable (OpenRouter's supported_parameters).
  if (isRouter && cfg.requestReasoning) {
    body.reasoning = { enabled: true };
  }
  // Free-model resilience: give OpenRouter a fallback chain so a flaky free
  // upstream degrades to the next-best free model instead of failing the
  // run. Only for :free primaries — paid model choices are never swapped.
  if (isRouter && cfg.model.endsWith(':free')) {
    body.models = await buildFreeFallbackChain(cfg.model);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cfg.apiKey,
  };
  if (isRouter) {
    // OpenRouter attribution headers (also help avoid rate limiting).
    headers['HTTP-Referer'] = 'https://amaljithkuttamath.github.io';
    headers['X-Title'] = 'Chitti';
  }

  const doFetch = () =>
    fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

  let resp = await doFetch();
  if (!resp.ok) {
    const errText = await resp.text();
    // Free-tier upstreams behind OpenRouter fail transiently all the time —
    // surfaced as 400 "Provider returned error", 429, or 5xx. One retry
    // after a short pause rescues most of these; a genuine request-shape
    // error will fail identically the second time and surface as before.
    const transient =
      resp.status === 429 ||
      resp.status >= 500 ||
      (resp.status === 400 && /provider returned error/i.test(errText));
    if (transient) {
      await new Promise((r) => setTimeout(r, 1200));
      resp = await doFetch();
      if (!resp.ok) {
        const retryText = await resp.text();
        const label = isRouter ? 'OpenRouter' : 'OpenAI';
        throw new Error(label + ' ' + resp.status + ' (after retry): ' + shortErr(retryText));
      }
    } else {
      const label = isRouter ? 'OpenRouter' : 'OpenAI';
      throw new Error(label + ' ' + resp.status + ': ' + shortErr(errText));
    }
  }

  const data = await resp.json();
  const choice = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((tc: any) => ({
    id: tc.id ?? 'call_' + Math.random().toString(36).slice(2),
    name: tc.function?.name ?? '',
    arguments: safeParse(tc.function?.arguments ?? '{}'),
  }));

  // Per OpenRouter's docs, reasoning text appears under one of two
  // interchangeable string fields: `reasoning` or `reasoning_content`.
  // Absent entirely for non-reasoning models, and — per the same docs —
  // sometimes absent even for a reasoning-capable model whose underlying
  // provider generates but doesn't expose it (OpenAI's o-series via
  // OpenRouter is the documented example).
  const reasoning: string | undefined = choice.reasoning || choice.reasoning_content || undefined;

  return {
    text: choice.content ?? '',
    toolCalls,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
    reasoning,
    servedModel: typeof data.model === 'string' ? data.model : undefined,
  };
}

// ── Anthropic Messages (tools converted to/from OpenAI shape) ──────────
function toAnthropic(messages: ChatMessage[]): { system: string; msgs: unknown[] } {
  let system = '';
  const msgs: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content;
      continue;
    }
    if (m.role === 'user') {
      msgs.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
      }
      msgs.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic delivers tool results as a user turn with tool_result blocks.
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
      });
    }
  }
  return { system, msgs };
}

async function callAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[]
): Promise<CompletionResult> {
  const { system, msgs } = toAnthropic(messages);
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: 1536,
    temperature: 0.2,
    messages: msgs,
  };
  if (system) body.system = system;
  if (tools.length) {
    // Convert OpenAI-format tool schemas to Anthropic's input_schema shape.
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // Allow calling the API directly from a browser.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Anthropic ' + resp.status + ': ' + shortErr(errText));
  }

  const data = await resp.json();
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      // Normalise Anthropic tool_use back into the OpenAI-shaped ToolCall.
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  return {
    text,
    toolCalls,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
  };
}

// ── Unified entry point ────────────────────────────────────────────────
export async function complete(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[] = []
): Promise<CompletionResult> {
  if (!cfg.apiKey) throw new Error('No API key provided. Enter a key in the BYOK strip.');
  if (cfg.provider === 'anthropic') return callAnthropic(cfg, messages, tools);
  // openai + openrouter share the OpenAI-compatible client.
  return callOpenAICompatible(cfg, messages, tools);
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function shortErr(raw: string): string {
  try {
    const j = JSON.parse(raw);
    let msg: string = j.error?.message ?? j.message ?? raw.slice(0, 200);
    // OpenRouter wraps the upstream provider's actual complaint in
    // error.metadata.raw — without it, a passthrough failure reads as the
    // useless "Provider returned error".
    const meta = j.error?.metadata;
    const detail = typeof meta?.raw === 'string' ? meta.raw : undefined;
    if (detail && detail !== msg) {
      msg += ' — ' + (meta.provider_name ? meta.provider_name + ': ' : '') + detail.slice(0, 300);
    }
    return msg;
  } catch {
    return raw.slice(0, 200);
  }
}
