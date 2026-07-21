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
  const resp = await fetchWithTimeout('https://openrouter.ai/api/v1/models', undefined, CATALOG_TIMEOUT_MS);
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
  const resp = await fetchWithTimeout(
    'https://api.openai.com/v1/models',
    { headers: { Authorization: 'Bearer ' + apiKey } },
    CATALOG_TIMEOUT_MS
  );
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
  const resp = await fetchWithTimeout(
    'https://api.anthropic.com/v1/models',
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    },
    CATALOG_TIMEOUT_MS
  );
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

// ── Error classification + transport hardening ─────────────────────────
// One place decides what a provider failure MEANS. Every caller (the agent
// loop, verify(), the nested llm(), sub-agents) surfaces `err.message`, so
// classifying here — and throwing a ClassifiedError whose message is the
// user-actionable line — makes every path inherit the specific reason for
// free. The classifier is pure and NEVER throws: the three providers' error
// bodies differ, so it parses defensively and falls back to 'unknown'.

// Timeouts: an AbortController caps every provider fetch so a wedged upstream
// can never hang a turn. Constants, not magic numbers.
export const COMPLETION_TIMEOUT_MS = 60_000; // one chat/verify/llm() completion
export const CATALOG_TIMEOUT_MS = 15_000; // a /models catalog fetch

// Retry policy (single bounded retry for transient classes only).
const RETRY_BASE_DELAY_MS = 600;
const RETRY_JITTER_MS = 400;
// Retry-After is honoured but capped — a provider asking us to wait 5 minutes
// must not freeze a browser turn; we cap the wait and surface the class instead.
const RETRY_AFTER_CAP_MS = 4_000;

export type ProviderErrorClass =
  | 'bad_key' // 401/403 or an explicit invalid-key body — surface, never mask
  | 'rate_limit' // 429; Retry-After captured when present
  | 'timeout' // aborted fetch / 408 — the request took too long
  | 'network' // fetch TypeError / CORS / DNS — the host was unreachable
  | 'server' // 5xx or an explicit transient-upstream body
  | 'empty_completion' // a 200 that carried no usable output (empty choices,
  //                      missing message, or content:'' with no tool calls) —
  //                      a transient free-model glitch, so retryable AND
  //                      fallback-eligible.
  | 'malformed' // the completion body was unreadable (non-empty but unparseable
  //               JSON, or a valid-JSON shape with no choices array). Live
  //               evidence: free models return unreadable responses at
  //               meaningful rates, and a retry (or a different free model) most
  //               often gets a readable one — so this is retryable AND
  //               fallback-eligible, exactly like empty_completion.
  | 'context_length' // provider says the prompt exceeds the context window
  | 'model_unavailable' // 404 / model-not-found shapes
  | 'insufficient_credits' // 402 / quota / billing shapes (fallback-eligible)
  | 'unknown';

export interface ClassifiedInfo {
  errorClass: ProviderErrorClass;
  provider: ProviderId;
  message: string; // short, user-actionable
  retryable: boolean; // eligible for the one bounded transport retry
  fallbackEligible: boolean; // eligible for the free-model substitution
  status?: number; // HTTP status when the failure was an HTTP response
  retryAfterMs?: number; // parsed Retry-After (uncapped; capped at wait time)
  detail?: string; // a short excerpt of the provider's own message
}

// Transient transport failures a single retry can plausibly rescue. Both
// empty_completion AND malformed are included: OpenRouter free models
// transiently return a 200 with no usable output (empty) OR an unreadable body
// (malformed), and the same model most often answers cleanly on a second try.
const RETRYABLE_CLASSES = new Set<ProviderErrorClass>(['rate_limit', 'server', 'timeout', 'network', 'empty_completion', 'malformed']);
// Classes the free-model fallback can actually help with. NEVER bad_key (that
// would mask the real problem) or context_length (a bigger model is the only
// fix, and a free substitute is not one). empty_completion AND malformed ARE
// eligible — a free model returning nothing usable or an unreadable body is
// that model glitching, so substituting a different free model is a genuine fix
// (with a visible receipt), not a dead end.
const FALLBACK_CLASSES = new Set<ProviderErrorClass>([
  'model_unavailable',
  'rate_limit',
  'insufficient_credits',
  'empty_completion',
  'malformed',
]);

// A thrown error that already carries its classification. Its `.message` is the
// user-actionable line, so anything that surfaces err.message gets it for free.
export class ClassifiedError extends Error {
  readonly errorClass: ProviderErrorClass;
  readonly provider: ProviderId;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly detail?: string;
  constructor(info: ClassifiedInfo) {
    super(info.message);
    this.name = 'ClassifiedError';
    this.errorClass = info.errorClass;
    this.provider = info.provider;
    this.retryable = info.retryable;
    this.fallbackEligible = info.fallbackEligible;
    this.status = info.status;
    this.retryAfterMs = info.retryAfterMs;
    this.detail = info.detail;
  }
}

function providerLabel(p: ProviderId): string {
  return p === 'openrouter' ? 'OpenRouter' : p === 'anthropic' ? 'Anthropic' : 'OpenAI';
}

// Map a class → a short, user-actionable sentence. Kept terse on purpose: this
// is what renders in the run-failed status line and the verify/llm() receipts.
function messageFor(cls: ProviderErrorClass, provider: ProviderId, detail?: string): string {
  const P = providerLabel(provider);
  const tail = detail ? ` — ${detail}` : '';
  switch (cls) {
    case 'bad_key':
      return `${P} rejected this API key — check it in the BYOK settings.`;
    case 'rate_limit':
      return `${P} is rate limiting requests — try again shortly.`;
    case 'timeout':
      return `${P} timed out after ${Math.round(COMPLETION_TIMEOUT_MS / 1000)}s — the model took too long to respond.`;
    case 'network':
      return `Could not reach ${P} — network or CORS error. Check your connection.`;
    case 'server':
      return `${P} had a server error${tail} — try again in a moment.`;
    case 'empty_completion':
      return `${P} returned an empty response.`;
    case 'malformed':
      return `${P} returned an unreadable response.`;
    case 'context_length':
      return `This request is too long for the model's context window${tail} — shorten the conversation or pick a larger-context model.`;
    case 'model_unavailable':
      return `${P} says this model is unavailable or unknown${tail}.`;
    case 'insufficient_credits':
      return `${P} reports insufficient credits${tail} — add credits or switch to a free model.`;
    default:
      return `${P} error${tail || ' — unexpected failure.'}`;
  }
}

function infoFor(
  errorClass: ProviderErrorClass,
  provider: ProviderId,
  extra: { message?: string; status?: number; retryAfterMs?: number; detail?: string } = {}
): ClassifiedInfo {
  return {
    errorClass,
    provider,
    retryable: RETRYABLE_CLASSES.has(errorClass),
    fallbackEligible: FALLBACK_CLASSES.has(errorClass),
    message: extra.message ?? messageFor(errorClass, provider, extra.detail),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

function pickStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

// Parse the three providers' differing error bodies into a common shape.
// OpenRouter: {error:{message,code,metadata}}, OpenAI: {error:{message,type,code}},
// Anthropic: {type:'error', error:{type,message}}. All optional — external input.
function parseProviderErrorBody(rawBody: unknown): {
  message?: string;
  type?: string;
  code?: string;
  detail?: string;
} {
  if (rawBody === null || rawBody === undefined) return {};
  let obj: any = rawBody;
  let str = '';
  if (typeof rawBody === 'string') {
    str = rawBody;
    try {
      obj = JSON.parse(rawBody);
    } catch {
      obj = null;
    }
  } else {
    try {
      str = JSON.stringify(rawBody);
    } catch {
      str = '';
    }
  }
  const errNode = obj && typeof obj === 'object' ? obj.error ?? obj : null;
  const message = pickStr(errNode?.message) ?? pickStr(obj?.message);
  // Anthropic's top-level type is the literal 'error'; the meaningful type is
  // nested under error.type. OpenAI puts a useful type under error.type too.
  const topType = pickStr(obj?.type);
  const type = pickStr(errNode?.type) ?? (topType && topType !== 'error' ? topType : undefined);
  const code = pickStr(errNode?.code) ?? pickStr(obj?.code);
  const detail = shortErr(str).slice(0, 160) || undefined;
  return { message, type, code, detail };
}

// Parse a Retry-After header (integer seconds, fractional seconds, or an HTTP
// date). Returns milliseconds to wait, or undefined when absent/unparseable.
// Never negative. The cap is applied later, at wait time.
export function parseRetryAfter(raw: unknown, nowMs: number = Date.now()): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - nowMs);
  const f = parseFloat(s);
  if (Number.isFinite(f)) return Math.max(0, Math.round(f * 1000));
  return undefined;
}

function extractRetryAfter(input: any): string | null | undefined {
  if (input && input.retryAfter !== undefined) return input.retryAfter;
  const h = input?.headers;
  if (h && typeof h.get === 'function') return h.get('retry-after');
  if (h && typeof h === 'object') return h['retry-after'] ?? h['Retry-After'];
  return undefined;
}

function isHttpLike(x: unknown): x is { status: number } {
  return !!x && typeof x === 'object' && typeof (x as any).status === 'number';
}

// The classifier. Accepts either a thrown exception (fetch TypeError / abort)
// or an HTTP-error descriptor { status, body, retryAfter? } (or a Response-like
// object with a pre-read `body`). Pure; never throws.
export function classifyProviderError(input: unknown, provider: ProviderId): ClassifiedInfo {
  try {
    // ── HTTP-error path ────────────────────────────────────────────────
    if (isHttpLike(input)) {
      const status = (input as any).status as number;
      const parsed = parseProviderErrorBody((input as any).body);
      const detail = parsed.detail;
      const combined = `${parsed.type ?? ''} ${parsed.code ?? ''} ${parsed.message ?? ''}`.toLowerCase();

      // Provider-explicit "out of credits" shapes. OpenAI reports quota
      // exhaustion as a 429 with code 'insufficient_quota' (NOT a real rate
      // limit), and Anthropic phrases it "credit balance is too low" — both must
      // classify as insufficient_credits (fallback-eligible), not rate_limit.
      const outOfCredits =
        /insufficient (credits|quota|funds|balance)|insufficient_quota|exceeded your current quota|credit balance (is )?too low|too low to access|add (more )?credits|negative balance/i.test(
          combined
        );

      if (status === 401 || status === 403) return infoFor('bad_key', provider, { status, detail });
      if (status === 402) return infoFor('insufficient_credits', provider, { status, detail });
      if (status === 408) return infoFor('timeout', provider, { status });
      if (status === 429) {
        if (outOfCredits) return infoFor('insufficient_credits', provider, { status, detail });
        const ms = parseRetryAfter(extractRetryAfter(input));
        return infoFor('rate_limit', provider, { status, detail, ...(ms !== undefined ? { retryAfterMs: ms } : {}) });
      }
      if (status === 404) return infoFor('model_unavailable', provider, { status, detail });
      if (status >= 500) return infoFor('server', provider, { status, detail });

      // 400 / 422 and other 4xx: the status alone is ambiguous, so read the body.
      if (
        /context[_ ]?length|maximum context|context window|too many tokens|prompt is too long|reduce (the )?(length|number of tokens)|max_tokens.*(exceed|too large)|string too long|is longer than the model/i.test(
          combined
        )
      ) {
        return infoFor('context_length', provider, { status, detail });
      }
      if (outOfCredits || /billing|payment required|not enough credits/i.test(combined)) {
        return infoFor('insufficient_credits', provider, { status, detail });
      }
      if (
        /model[_ ].*(not found|not exist|unavailable|is not a valid|does not exist)|no (allowed )?(endpoints|providers) found|not a valid model|model_not_found|unknown model|no endpoints found/i.test(
          combined
        )
      ) {
        return infoFor('model_unavailable', provider, { status, detail });
      }
      if (
        /invalid.*api key|incorrect api key|no auth credentials|authentication|unauthorized|invalid_api_key|invalid x-api-key|permission|forbidden/i.test(
          combined
        )
      ) {
        return infoFor('bad_key', provider, { status, detail });
      }
      // OpenRouter wraps a flaky free upstream as a 400 "Provider returned
      // error"; treat that (and explicit overload) as a transient server class.
      if (/provider returned error|upstream error|temporarily unavailable|overloaded|try again/i.test(combined)) {
        return infoFor('server', provider, { status, detail });
      }
      return infoFor('unknown', provider, { status, detail });
    }

    // ── Exception path (thrown by fetch) ───────────────────────────────
    if (input instanceof Error || (input && typeof input === 'object' && ('name' in input || 'message' in input))) {
      const name = String((input as any).name ?? '');
      const msg = String((input as any).message ?? '');
      if (name === 'AbortError' || /\baborted\b|timed?\s*out|timeout/i.test(msg)) {
        return infoFor('timeout', provider);
      }
      if (
        name === 'TypeError' ||
        /failed to fetch|networkerror|load failed|\bcors\b|err_|fetch failed|network request failed|dns/i.test(msg)
      ) {
        return infoFor('network', provider);
      }
      return infoFor('unknown', provider, { detail: msg.slice(0, 140) || undefined });
    }

    return infoFor('unknown', provider);
  } catch {
    // The classifier's own contract: it must never throw.
    return infoFor('unknown', provider);
  }
}

// Coerce any thrown value into a ClassifiedError (idempotent — a ClassifiedError
// passes straight through, so a re-thrown one is never re-wrapped).
function asClassified(err: unknown, provider: ProviderId): ClassifiedError {
  if (err instanceof ClassifiedError) return err;
  return new ClassifiedError(classifyProviderError(err, provider));
}

// Clone a ClassifiedError, appending an honest receipt of what was already
// tried before it surfaced — so the run-failed line reads e.g. "…empty response
// (retried, then tried a fallback model)." instead of pretending it was a
// first-and-only attempt. Nothing is appended when neither recovery ran.
function exhaustedError(ce: ClassifiedError, tried: { retried: boolean; fellBack: boolean }): ClassifiedError {
  let suffix = '';
  if (tried.retried && tried.fellBack) suffix = ' (retried, then tried a fallback model).';
  else if (tried.retried) suffix = ' (after retry).';
  else if (tried.fellBack) suffix = ' (after trying a fallback model).';
  if (!suffix) return ce;
  return new ClassifiedError({
    errorClass: ce.errorClass,
    provider: ce.provider,
    retryable: ce.retryable,
    fallbackEligible: ce.fallbackEligible,
    message: ce.message.replace(/\.\s*$/, '') + suffix,
    ...(ce.status !== undefined ? { status: ce.status } : {}),
    ...(ce.retryAfterMs !== undefined ? { retryAfterMs: ce.retryAfterMs } : {}),
    ...(ce.detail ? { detail: ce.detail } : {}),
  });
}

// The delay before the single retry: a capped Retry-After when the provider
// gave one, else a small base, both plus jitter to avoid synchronized retries.
function retryDelayMs(ce: ClassifiedError, random: () => number): number {
  const base = ce.retryAfterMs !== undefined ? Math.min(ce.retryAfterMs, RETRY_AFTER_CAP_MS) : RETRY_BASE_DELAY_MS;
  return base + Math.floor(random() * RETRY_JITTER_MS);
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// Every provider fetch runs under an AbortController so a wedged upstream can
// never hang a turn; a timeout surfaces as an AbortError → classified 'timeout'.
// An optional external signal (the user's "stop") is composed in manually — a
// listener that forwards the caller's abort to the same controller — rather
// than via AbortSignal.any(), so this works on every runtime the app targets
// without a feature check. A user-abort and a timeout both abort `ctrl`, so the
// fetch rejects at once; the caller (complete/ask) tells the two apart by
// inspecting the external signal, never by the error class.
async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  ms: number,
  f?: FetchLike,
  extSignal?: AbortSignal
): Promise<Response> {
  const doFetch: FetchLike = f ?? ((u, i) => (globalThis.fetch as FetchLike)(u, i));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onExtAbort = () => ctrl.abort();
  if (extSignal) {
    if (extSignal.aborted) ctrl.abort();
    else extSignal.addEventListener('abort', onExtAbort, { once: true });
  }
  try {
    return await doFetch(url, { ...(init ?? {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    if (extSignal) extSignal.removeEventListener('abort', onExtAbort);
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
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

// One attempt against an OpenAI-compatible endpoint (OpenAI or OpenRouter).
// It performs exactly ONE fetch (timeout-bounded) and throws a ClassifiedError
// on any failure — HTTP error, network/abort, or a malformed completion. The
// retry/fallback orchestration lives in complete(), never here, so retries are
// never stacked. `models` sets OpenRouter's free-fallback chain (see complete).
async function attemptOpenAICompatible(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  f: FetchLike,
  models?: string[],
  signal?: AbortSignal
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
  // Free-model resilience: OpenRouter's server-side fallback chain, engaged
  // reactively by complete() only when the primary fails with a class the
  // fallback can help. Paid model choices are never swapped.
  if (isRouter && models && models.length) {
    body.models = models;
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

  let resp: Response;
  try {
    resp = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, COMPLETION_TIMEOUT_MS, f, signal);
  } catch (err) {
    // Network failure, CORS, or an abort (timeout) — classify and throw.
    throw asClassified(err, cfg.provider);
  }
  if (!resp.ok) {
    const errText = await safeText(resp);
    throw new ClassifiedError(
      classifyProviderError({ status: resp.status, body: errText, headers: resp.headers }, cfg.provider)
    );
  }

  // Read the body as text first so an empty body (a 200 with nothing in it —
  // a common transient free-model glitch) is told apart from genuine garbage:
  //   • blank/whitespace body           → empty_completion (retry + fallback)
  //   • non-empty but unparseable JSON  → malformed (surface at once)
  const rawText = await safeText(resp);
  if (!rawText.trim()) {
    throw new ClassifiedError(infoFor('empty_completion', cfg.provider));
  }
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new ClassifiedError(infoFor('malformed', cfg.provider));
  }
  // A well-formed OpenAI-compatible success always carries a choices array.
  // Its absence means the body parsed but wasn't a completion shape at all.
  if (!data || typeof data !== 'object' || !Array.isArray(data.choices)) {
    throw new ClassifiedError(infoFor('malformed', cfg.provider));
  }
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

  // Extract the assistant text from `content`. Reasoning models (Nemotron 3
  // Ultra among them) sometimes return content:null/'' with the actual answer
  // sitting only in `reasoning`; fall back to it ONLY when there is no content
  // AND no tool calls, so we never fabricate over a real content or tool-call
  // turn (a tool-call turn with empty content is valid and stays valid).
  const rawContent = typeof choice.content === 'string' ? choice.content : '';
  let text = rawContent;
  if (!rawContent.trim() && toolCalls.length === 0 && reasoning && reasoning.trim()) {
    text = reasoning;
  }
  // Nothing usable came back — no text, no reasoning, no tool calls (empty
  // choices array, a missing message, or content:'' ). That's the free model
  // glitching, so classify it retryable + fallback-eligible rather than as a
  // dead-end `malformed`.
  if (!text.trim() && toolCalls.length === 0) {
    throw new ClassifiedError(infoFor('empty_completion', cfg.provider));
  }

  return {
    text,
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

// One attempt against the Anthropic Messages API. Same contract as
// attemptOpenAICompatible: a single timeout-bounded fetch, throwing a
// ClassifiedError on HTTP error, network/abort, or a malformed completion.
async function attemptAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  f: FetchLike,
  signal?: AbortSignal
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

  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          // Allow calling the API directly from a browser.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      },
      COMPLETION_TIMEOUT_MS,
      f,
      signal
    );
  } catch (err) {
    throw asClassified(err, cfg.provider);
  }

  if (!resp.ok) {
    const errText = await safeText(resp);
    throw new ClassifiedError(
      classifyProviderError({ status: resp.status, body: errText, headers: resp.headers }, cfg.provider)
    );
  }

  // Empty body (a 200 with nothing in it) vs genuine garbage, as above.
  const rawText = await safeText(resp);
  if (!rawText.trim()) {
    throw new ClassifiedError(infoFor('empty_completion', cfg.provider));
  }
  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new ClassifiedError(infoFor('malformed', cfg.provider));
  }
  // A well-formed Anthropic success always carries a content block array.
  if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
    throw new ClassifiedError(infoFor('malformed', cfg.provider));
  }
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of data.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use') {
      // Normalise Anthropic tool_use back into the OpenAI-shaped ToolCall.
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  // An empty content array (no text, no tool_use) is the model glitching, not
  // a dead-end — retryable + fallback-eligible like the OpenAI-compatible path.
  if (!text.trim() && toolCalls.length === 0) {
    throw new ClassifiedError(infoFor('empty_completion', cfg.provider));
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

// Injectable seams so tests can drive retry timing/jitter and the fallback
// chain without real sleeps or network. All default to the real thing.
export interface CompleteDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  buildFreeFallbackChain?: (primary: string) => Promise<string[]>;
  // The caller's "stop" signal, forwarded to every provider fetch this call
  // makes. When it fires mid-request the fetch rejects immediately; complete()
  // then skips its transport retry and free-model fallback (retrying a request
  // the user just cancelled would be wasted work) and rethrows. The caller
  // recognises the abort by inspecting the signal, not the error class — a
  // user-cancel is never surfaced as a provider error.
  signal?: AbortSignal;
}

// ── Unified entry point ────────────────────────────────────────────────
// The SINGLE place transport retry + free-model fallback are orchestrated, so
// neither is ever stacked across callers. At most one extra network attempt:
//   • a fallback-eligible class on a :free OpenRouter primary → one attempt
//     with the free substitution chain (its result is final); OR
//   • a transient class → one bounded retry after a jittered (Retry-After-
//     capped) delay.
// Everything else surfaces immediately as a ClassifiedError whose .message is
// the user-actionable line every caller already renders.
export async function complete(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  tools: ToolSchema[] = [],
  deps: CompleteDeps = {}
): Promise<CompletionResult> {
  if (!cfg.apiKey) throw new Error('No API key provided. Enter a key in the BYOK strip.');

  const f: FetchLike = deps.fetch ?? ((u, i) => (globalThis.fetch as FetchLike)(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const buildChain = deps.buildFreeFallbackChain ?? buildFreeFallbackChain;

  const attempt = (models?: string[]) =>
    cfg.provider === 'anthropic'
      ? attemptAnthropic(cfg, messages, tools, f, deps.signal)
      : attemptOpenAICompatible(cfg, messages, tools, f, models, deps.signal);

  try {
    return await attempt();
  } catch (err) {
    // A user-cancel short-circuits ALL recovery: the abort already rejected the
    // fetch, so a same-model retry or free-model fallback would only re-hit an
    // already-aborted signal (or, worse, spend a fresh request on work the user
    // stopped). Rethrow the classified error at once; ask() maps it to its
    // honest "stopped" outcome by inspecting the signal.
    if (deps.signal?.aborted) throw asClassified(err, cfg.provider);
    const ce = asClassified(err, cfg.provider);
    // Free-model fallback applies to OpenRouter :free primaries. Whether the
    // ERROR class is eligible must be judged on the LATEST error, not the first:
    // a first error that is retryable-but-not-fallback-eligible (e.g. `network`)
    // can, after the bounded retry, surface as a fallback-eligible class (e.g.
    // `empty_completion`) — for which switching free models is the intended
    // remedy. Computed per-error below, off `current`, not frozen off `ce`.
    const fallbackEligibleFor = (c: ClassifiedError) =>
      c.fallbackEligible && cfg.provider === 'openrouter' && cfg.model.endsWith(':free');

    // One bounded transport retry against the SAME model, for transient classes
    // only (rate_limit / server / timeout / network / empty_completion). The
    // same-model retry runs first: a free model that just glitched empty most
    // often answers on a second try, and that's cheaper than a substitution.
    let retried = false;
    let current = ce;
    if (ce.retryable) {
      await sleep(retryDelayMs(ce, random));
      retried = true;
      try {
        return await attempt();
      } catch (err2) {
        current = asClassified(err2, cfg.provider);
      }
    }

    // Free-model fallback SECOND, only on classes it can help and only where a
    // real substitute exists (OpenRouter :free primaries). Never on bad_key or
    // context_length — those surface so the user sees the truth (a different
    // free model cannot fix a bad key or an over-long prompt). The substitution
    // receipt stays visible via the served model.
    if (fallbackEligibleFor(current)) {
      let chain: string[] = [];
      try {
        chain = await buildChain(cfg.model);
      } catch {
        chain = [];
      }
      // Only worth an attempt if the chain offers a genuine alternative.
      if (chain.length > 1) {
        try {
          // The fallback attempt's outcome is final — no further retry stacking.
          return await attempt(chain);
        } catch (err3) {
          throw exhaustedError(asClassified(err3, cfg.provider), { retried, fellBack: true });
        }
      }
    }

    // Nothing recovered it — surface the (possibly post-retry) classified error
    // with an honest note of what was tried.
    throw exhaustedError(current, { retried, fellBack: false });
  }
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
