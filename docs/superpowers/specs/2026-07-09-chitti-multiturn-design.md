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
  > Do NOT call search_indicators or fetch tools again unless this question
  > needs data you don't have (a new country, indicator, or year range not
  > already fetched).
  > If this question needs a different chart from the SAME data (a new
  > chart type, a re-ranked/filtered/re-aggregated view), you MUST call
  > execute_js again against the existing rows to (re-)derive the exact
  > values before calling render_chart — `summarizeRows` above is a
  > compressed preview (first year, last year, count) for your own
  > orientation only, never a source of chart data. Never call render_chart
  > from the summary directly.
  > If this question just asks you to explain, describe, or interpret the
  > data in words, call `finish_explanation` with your answer — do not call
  > render_chart at all.

  This addendum is what makes "explain this data" resolve with zero tool
  calls beyond `finish_explanation`, and "plot it as a line chart" resolve
  with an `execute_js` re-derivation + one `render_chart` call — never a
  render straight from the lossy summary.

- New tool: `finish_explanation` (schema: single string arg, the prose
  answer). This is distinct from `finish` (which requires a rendered chart
  in today's pipeline) so the two intents aren't overloaded onto one tool
  the model has to reason about differently depending on hidden state.

### Two turn kinds: chart turns vs. explanation turns

The Turn 1 pipeline (verify against a rendered chart, `!spec` = fail =
retry) is correct for chart-producing turns and must not change. But it is
**only valid when the turn actually attempted a chart.** Applying it
unconditionally to explanation turns is a real bug in the original draft
of this design: `verify()`'s pass condition requires `!!spec`, and the
verifier prompt is handed `NO CHART RENDERED` for any null spec — so an
explanation turn would fail verification by construction, trigger the
existing retry-with-critique path, and coerce the model into rendering a
chart the user never asked for. Confirmed against `agent.ts`'s `verify()`
(the `pass` expression) and its retry branch.

Fix: branch on which tool ended the turn.

- **Chart turn** (`finish` called, or a chart was rendered): today's
  `runVerify()` / retry-once behavior, unchanged.
- **Explanation turn** (`finish_explanation` called, no `render_chart` this
  turn): skip `runVerify()` entirely. There is no chart to check, and
  forcing the model to produce one just to satisfy a verifier built for a
  different kind of turn is the bug, not a case for a "prose-aware
  verifier." `AgentOutput.chartSpec` stays whatever it already was
  (`state.chartSpec` from the last chart turn, unchanged) so the canvas
  keeps showing the last real chart; `finding` carries the explanation
  text; a new `AgentOutput.kind: 'chart' | 'explanation'` field tells the
  UI which rendering path to use (see UI section — an explanation turn is
  a normal answer, not the zero-result/error state).

### AgentOutput per turn

Same shape as today plus one new field: `kind: 'chart' | 'explanation'`,
set by which tool ended the turn. `chartSpec: null` no longer means
"nothing to show" by itself — the UI must check `kind` before deciding
whether to render the zero-result/error state (only for a chart turn that
genuinely produced no chart) or the explanation state (a deliberate
`finish_explanation` turn, always a normal answer).

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

### Rendering by `AgentOutput.kind`

The submit handler must branch on `out.kind` before falling into today's
`!out.chartSpec` zero-result/error path:

- `kind: 'explanation'` → always a normal answer turn. Render `out.finding`
  in the turn's answer section as prose, no confidence badge, no data
  table/citations (nothing new was fetched), no error status. The turn's
  canvas area shows the same chart as the previous turn (unchanged,
  `state.chartSpec` carries forward) or stays empty if no chart exists yet
  — never routes through `ch-finding-empty` / `setStatus('error', ...)`.
- `kind: 'chart'` with `chartSpec` present → today's normal success path,
  unchanged.
- `kind: 'chart'` with `chartSpec: null` → today's existing zero-result
  path (`ch-finding-empty`, error status) — this is now correctly scoped to
  only the case it was meant for: a chart was attempted and genuinely
  failed to materialize, not "no chart was attempted this turn."

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

## Context retention policy (`messages` growth across turns)

Multi-turn means `messages` no longer resets per call — it accumulates for
the life of the session. Three things are coupled to this and must be
decided together rather than independently, per the design review:

- **Re-plot fidelity** (System prompt section above) requires the full
  `execute_js` JSON result for a prior fetch to still be reasoned over, or
  requires re-deriving it. This design already commits to re-deriving via
  `execute_js` against `state.rows` (kept in JS memory, not re-sent through
  `messages` every turn) rather than depending on old tool-result JSON
  still sitting in the message history. That decision is what makes the
  next point possible.
- **Trimming is safe** because of the above: `state.rows` (plain JS state,
  outside `messages`) is the durable source of truth for chart data across
  turns. The `messages` array itself — old `tool` role messages carrying
  large fetched-row JSON — can be trimmed/summarized once a turn is
  complete, since nothing downstream depends on re-reading that raw JSON
  back out of history. Concretely: after a turn ends, collapse that turn's
  `tool` messages down to a short marker (e.g. "fetched N rows for
  indicator X, see current data") instead of keeping the full JSON blob in
  history forever. `state.rows` itself is never trimmed (it's the answer to
  "what data do we have"); only the `messages` copies of it are.
- **A free model's context window is finite.** A couple of `fetch_worldbank_all`
  calls (hundreds of rows each) left untrimmed in `messages` will crowd a
  smaller model's window within a handful of turns. Trimming per the point
  above is what keeps a long conversation viable, independent of whether
  caching ever gets built.

This is a plain context-size correctness concern (a long conversation must
keep working), not an optimization — it belongs in the multi-turn
implementation itself, unlike caching below.

## Prompt caching (`src/lib/chitti/providers.ts`) — deferred, separate phase

### Why this is being scoped out of the multi-turn implementation

The original draft of this section led with Anthropic `cache_control`
plumbing on the strength of "growing history gets expensive." That's true
in general, but Chitti's actual default is `nemotron-3-ultra-550b (free)`
on OpenRouter — on that path, cost savings from caching are $0 (the model
is free), and latency savings are unconfirmed (free-tier OpenRouter routing
doesn't guarantee cache hits land on the same backend instance). Leading
implementation effort with Anthropic-specific request shaping optimizes a
path most users of this page never take. Real, but not yet worth the
column-inches original given it here.

Caching is being split out as its own follow-up, gated on: (1) shipping
multi-turn first and confirming with real usage whether history growth
actually causes a noticeable cost/latency problem on the models people
pick, and (2) if so, which provider path that shows up on. Until then this
section stays as a record of the mechanism, not a committed phase.

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
