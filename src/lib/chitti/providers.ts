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
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
}

// ── Provider metadata for the UI dropdowns ─────────────────────────────
export interface ModelOption {
  id: string;
  label: string;
  free?: boolean;
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

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
    ],
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: 'Get an OpenAI key',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-3-5-haiku-latest', label: 'claude-3-5-haiku' },
      { id: 'claude-3-5-sonnet-latest', label: 'claude-3-5-sonnet' },
      { id: 'claude-3-7-sonnet-latest', label: 'claude-3-7-sonnet' },
    ],
    defaultModel: 'claude-3-5-haiku-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: 'Get an Anthropic key',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    models: [
      { id: 'deepseek/deepseek-chat-v3.1:free', label: 'deepseek-chat-v3.1 :free', free: true },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'llama-3.3-70b :free', free: true },
      { id: 'qwen/qwen-2.5-72b-instruct:free', label: 'qwen-2.5-72b :free', free: true },
      { id: 'anthropic/claude-3.5-sonnet', label: 'claude-3.5-sonnet (paid)' },
      { id: 'openai/gpt-4o-mini', label: 'gpt-4o-mini (paid)' },
      { id: 'google/gemini-2.5-flash', label: 'gemini-2.5-flash (paid)' },
    ],
    defaultModel: 'deepseek/deepseek-chat-v3.1:free',
    keyUrl: 'https://openrouter.ai/keys',
    keyLabel: 'Get a free OpenRouter key',
    note: 'Free models available — pick a :free model above.',
    freeNote: true,
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  openrouter: 'deepseek/deepseek-chat-v3.1:free',
};

// Approximate USD per 1M tokens (input / output), for the rough cost meter.
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'claude-3-5-haiku-latest': { in: 0.8, out: 4.0 },
  'claude-3-5-sonnet-latest': { in: 3.0, out: 15.0 },
  'claude-3-7-sonnet-latest': { in: 3.0, out: 15.0 },
  'anthropic/claude-3.5-sonnet': { in: 3.0, out: 15.0 },
  'openai/gpt-4o-mini': { in: 0.15, out: 0.6 },
  'google/gemini-2.5-flash': { in: 0.3, out: 2.5 },
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cfg.apiKey,
  };
  if (isRouter) {
    // OpenRouter attribution headers (also help avoid rate limiting).
    headers['HTTP-Referer'] = 'https://amaljithkuttamath.github.io';
    headers['X-Title'] = 'Chitti';
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    const label = isRouter ? 'OpenRouter' : 'OpenAI';
    throw new Error(label + ' ' + resp.status + ': ' + shortErr(errText));
  }

  const data = await resp.json();
  const choice = data.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((tc: any) => ({
    id: tc.id ?? 'call_' + Math.random().toString(36).slice(2),
    name: tc.function?.name ?? '',
    arguments: safeParse(tc.function?.arguments ?? '{}'),
  }));

  return {
    text: choice.content ?? '',
    toolCalls,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
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
    return j.error?.message ?? j.message ?? raw.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}
