# Chitti: Multi-turn conversation

## Problem

Chitti today is one-shot: ask a question, get one receipt + one chart + one
answer, and that's it. To ask a follow-up ("explain this data", "now plot it
as a line chart", "how does this compare to Brazil?") the user has to start
over from a blank textarea, and the agent has no memory of what it already
fetched or rendered.

Also in scope, from the same session: the ask console currently shows a lede
paragraph and a "How it works" 01/02/03 panel by default. Per prior
discussion, both are being removed entirely (not collapsed) so the page is
just: title, search bar, preset chips, BYOK config, and results. This is
already implemented and out of scope for the plan that follows — noted here
only because it's the same file and the same session.

## Goals

- Support follow-up questions that reuse already-fetched data (rows, chart,
  indicators) without re-running the full fetch pipeline, unless the
  follow-up genuinely needs new data.
- Represent the conversation as a stacked thread: each turn keeps its own
  collapsed receipt and frozen chart snapshot; only the latest turn is fully
  live (expanded trace, active canvas).
- A sticky follow-up composer at the bottom of the thread once a
  conversation has started.
- A "new conversation" control that discards all state and restores the
  original top console.

## Non-goals

- Persisting conversations across page reloads (session-only, matches
  existing BYOK key behavior).
- Editing or deleting a specific past turn.
- Branching (asking two different follow-ups off the same earlier turn).

## Agent layer (`src/lib/chitti/agent.ts`)

### Session object

Replace the one-shot `runAgent(cfg, question, cb)` with a session factory:

```ts
export function createSession(cfg: ProviderConfig): ChittiSession {
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const state = { rows: [], chartSpec: null, indicators: new Map(), finding: '' };
  return {
    ask(question: string, cb: AgentCallbacks): Promise<AgentOutput> { ... },
  };
}
```

- `messages` persists across `ask()` calls — each call appends a new `user`
  message to the existing array rather than constructing a fresh one.
- `state.rows`, `state.chartSpec`, `state.indicators` persist across turns.
  A follow-up's `execute_js`/`render_chart` calls operate on the accumulated
  `state.rows`, same as multiple fetches within a single turn do today.
- `MAX_TOOL_CALLS` applies per-turn (each `ask()` gets its own fresh budget),
  not cumulatively across the conversation.
- Verification (`runVerify`) runs every turn, scoped to that turn's chart +
  finding only. The "verified" stamp is per-turn, not conversation-wide.

### System prompt: two variants

- **Turn 1** (first `ask()` on a session): today's `SYSTEM_PROMPT` unchanged
  — the four-step pipeline (search → fetch → execute_js → render_chart →
  finish).
- **Turn 2+**: an additional system-prompt addendum is appended (not a
  replacement) before the new user message, injected fresh each turn so it
  reflects current state:

  > You already have data from earlier in this conversation:
  > `{summarizeRows(state.rows)}`
  > Current chart: `{type/title/series-names summary, or "none"}`.
  > If this question can be answered from what you already have — a
  > different chart type, a slice/filter/re-rank of the same rows, or a
  > prose explanation — do NOT call search_indicators or fetch tools again.
  > Only fetch new data if the question needs something you don't have
  > (a new country, indicator, or year range not already fetched).

  This addendum is what makes "explain this data" resolve with zero tool
  calls (pure reasoning + a `finish`-equivalent text response) and "plot it
  as a line chart" resolve with just one `render_chart` call.

- A turn that produces no chart at all (pure explanation) is a valid
  `AgentOutput` with `chartSpec: null` and a `finding` containing the
  explanation — reuses the existing zero-result rendering path in the UI
  (`ch-finding-empty` already exists, but here it's not an error state, just
  "no chart this turn"; see UI section for the distinction).

### AgentOutput per turn

Unchanged shape. Each `ask()` returns one `AgentOutput`, same as today's
single `runAgent()` call.

## UI layer (`src/pages/apps/chitti.astro`)

### Thread container

- New `#ch-thread` container holds one **turn block** per `ask()` call,
  appended in order.
- A turn block is today's existing per-run markup (`ch-status`, `ch-panel`
  with rail + canvas, `ch-answer` section) — reused as a repeatable template,
  not redesigned.
- Only the **latest** turn block is "live": full trace rendering, active
  ECharts instance wired to the theme-observer and resize listener.
- Every prior turn block, once superseded:
  - Its receipt collapses into a closed `<details>` showing the turn's
    question text and one-line finding only.
  - Its chart (if it rendered one) freezes as a static image or a disposed,
    non-reactive ECharts instance — not wired to theme/resize listeners.
    (Implementation detail to confirm in the plan: cheapest is disposing the
    live instance and re-rendering once into a static canvas snapshot at the
    moment it's superseded.)

### Entry point vs. sticky composer

- **Turn 1**: existing top console (title, badges, textarea, preset chips,
  BYOK strip) is the only input, exactly as it works today.
- **Turn 2+**: once the first turn's answer lands, the top console collapses
  fully (not just the chips/BYOK — the whole console), and a sticky composer
  bar appears docked at the bottom of the viewport (or bottom of thread,
  whichever reads better in testing — confirm in implementation). Reuses
  `ch-q`/`ch-btn` styling, just in a docked bar instead of the top block.
- BYOK config (provider/model/key) is not re-shown in the sticky composer.
  It was already set for turn 1 and carries forward via the session's `cfg`
  — there's no reason to re-expose it per turn. A small persistent label
  (e.g. today's `ch-byok-state` string) stays visible near the sticky
  composer so the user can see what's connected without it taking space.

### New conversation control

- A small text control (e.g. "+ new conversation") sits near the sticky
  composer.
- Clicking it: discards the `ChittiSession` object, clears `#ch-thread`,
  restores the original top console (textarea, chips, BYOK strip) as the
  active input. Does not clear the saved API key from sessionStorage (BYOK
  key persistence is unrelated and already session-scoped).

## Prompt caching (`src/lib/chitti/providers.ts`)

### Why this belongs in this design

Today `runAgent()` is one-shot, so the messages array is short-lived and
caching barely matters. Multi-turn changes that: `messages` now persists and
grows across `ask()` calls, with the system prompt and every prior turn's
history re-sent verbatim on each new call. Without caching, every follow-up
re-bills and re-latencies the entire conversation-so-far from scratch, which
directly undercuts the "reuse fetched data, don't redo work" goal above —
the tool-call savings would be real, but the token cost/latency savings
would be left on the table for no reason.

### Current state (confirmed by reading providers.ts)

- `toOpenAIMessages()` (used for both OpenAI and OpenRouter) sends `messages`
  as a plain array with string content — no `cache_control` markers.
- `toAnthropic()` sends `system` as a plain string — Anthropic's prompt
  caching requires the system prompt (and optionally message content) to be
  an array of content blocks, with `cache_control: { type: 'ephemeral' }` on
  the block that ends the cacheable prefix.
- No caching is applied on any provider path today. This was not a prior
  gap that mattered much (short one-shot calls); it becomes a real gap once
  history grows across turns.

### Approach

- **Anthropic** (`toAnthropic` / `complete` Anthropic branch): change
  `system` from a string to `[{ type: 'text', text: SYSTEM_PROMPT_TEXT,
  cache_control: { type: 'ephemeral' } }]`. This is the highest-value,
  lowest-effort win — the system prompt is identical across every turn in a
  session and is large enough (the full pipeline instructions) to be worth
  caching on its own.
- Optionally also mark the last message of the "stable prefix" (everything
  before the current turn's new user message) with a cache breakpoint, so a
  long-running conversation's earlier turns aren't re-processed from
  scratch either. Start with just the system-prompt breakpoint; add the
  history breakpoint only if real multi-turn testing shows it's worth the
  added complexity (Anthropic allows up to 4 breakpoints per request).
- **OpenRouter**: when the routed model is an Anthropic model, apply the
  same `cache_control` shape (OpenRouter passes it through). For other
  models routed through OpenRouter, caching support is provider-dependent
  and in several cases automatic with no request changes needed — no code
  change to force it, just don't assume it's happening for cost-estimation
  purposes.
- **OpenAI**: no `cache_control` mechanism (OpenAI's prompt caching is
  automatic server-side for identical prefixes ≥1024 tokens, not something
  the request body opts into) — no code change needed for this provider.
- `estimateCost()` should account for cache-read vs. cache-write pricing
  where the provider reports it in `usage`, rather than assuming every
  token costs the same as a fresh input token. Check what `usage` actually
  returns per-provider before committing to a specific field name here —
  confirm in the implementation plan.

### Non-goals

- Building a caching abstraction that works identically across all three
  providers. The mechanisms are genuinely different (explicit breakpoints
  vs. automatic); the code should reflect that rather than paper over it.

## Open questions for the implementation plan

- Exact mechanism for "freezing" a superseded chart (disposed ECharts
  instance re-rendered as static image, vs. just leaving it live but
  unresponsive to theme/resize — cheaper but slightly wasteful). Recommend
  disposing to a static snapshot; confirm during implementation once the
  ECharts snapshot API is checked.
- Whether the sticky composer docks to the viewport bottom (always visible
  while scrolling the thread) or just sits after the last turn block
  (simpler, no fixed-position overlap concerns with the canvas). Recommend
  starting with the simpler non-fixed placement and revisiting if it feels
  wrong in testing.
