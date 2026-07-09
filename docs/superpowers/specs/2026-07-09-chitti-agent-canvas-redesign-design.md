# Chitti: Agent-Chatting-With-Canvas Redesign

## Problem

Chitti's current UI (post "ask-first console, live agent timeline" redesign, commit c2a7115) is form-shaped, not chat-shaped. Despite the commit calling it a "live agent timeline," the actual implementation is a structured build-log/CI-log trace — collapsible steps with pretty-printed key/value blocks, no conversational voice, no sense of an agent narrating its own thinking. There are no chat bubbles, no turn-taking, no personality. It reads like a CI pipeline log, not like talking to an agent.

Goal: redesign the working/trace state (and the idle state that leads into it) so Chitti feels like an actual agent chatting with you while it builds a chart on a canvas beside it — with genuine observability (model, tokens, confidence) baked into the visual metaphor rather than bolted on as a debug panel.

## Layout

Split view, locked in via visual brainstorming:

- **Left rail (~34–36% width):** the agent's trace/narration. Fixed-width, scrollable if it overflows.
- **Right panel (~64–66% width):** the canvas — chart builds here, inline, full height of the working area.
- This replaces the current single-column trace-then-chart-inline structure with true side-by-side, so the chart is visible and building *while* the agent narrates, not appended after.

## Voice

Terse narrator, not conversational prose. Short, present-tense, system-log cadence:

> `search_indicators…`
> `→ SH.DYN.MORT`
> `fetch_worldbank · 217 rows`

Not:

> "Let me check what World Bank tracks for this..."

Rationale (user's explicit choice over the more conversational alternative): the terse register keeps the canvas as the visual star and avoids the rail feeling like a chatbot transcript competing for attention.

**Note on "chatting" in the title:** this redesign's goal is that Chitti feels like an agent that is *present and narrating live* — not that it exchanges back-and-forth dialogue. "Chatting with the canvas" describes the liveness/presence quality (an agent visibly at work beside its own output), not a literal chat-bubble UI or multi-turn dialogue. See "Single-shot only" below for the interaction-model implication.

### Single-shot only, no conversation history

Confirmed against `agent.ts`: each run builds a fresh message list from scratch; there is no persisted conversation history across asks today. This redesign does not change that. A follow-up question starts a **new run** with its own fresh receipt — it does not append to, or converse within, the same trace. Prototypes should not imply a persistent chat input that expects the agent to "remember" prior turns.

## Visual signature: the receipt

The distinguishing idea, chosen over "chart draws itself" and "floating glass panel" alternatives: **the trace rail is styled as a physical receipt.**

- **Torn top edge:** a jagged/perforated SVG edge at the top of the rail, as if torn from a roll.
- **Timestamped steps:** each step line-item shows a precise timestamp (`14:02:01.4`) before it, monospace, low-opacity.
- **Completed steps strike through** and fade to ~40% opacity as the agent moves on; the **active step** shows a small glowing amber dot (`box-shadow` glow, pulsing).
- **Dashed perforation lines** (`border: 1px dashed var(--fg-faint)` — see token mapping below) separate sections, echoing a receipt's tear lines.
- **Verification step is ink-stamped:** when the self-check tool call passes, an amber-bordered "VERIFIED" stamp renders rotated ~-8°, like a rubber ink stamp, overlapping the verification line. This is the single most distinctive visual beat in the whole design — it's the moment of trust made visible.
- Final answer settles at the bottom of the rail, inside the last "torn" section, not as a separate disconnected block elsewhere on the page.

## Observability: model, cost, and confidence — folded into the receipt

Explicit requirement: model used, per-item token count, and (where available) log-probability–based confidence must be visible, not hidden in a debug toggle. This is real telemetry presented as part of the receipt, not a developer-only overlay.

- **Header line:** model name + provider pinned at the top of the rail (e.g. `nemotron-3-super-120b` / `openrouter`), always visible, low-opacity monospace.
- **Per-step token count:** each trace line-item shows its own **token count** (not a dollar figure) right-aligned, receipt-style (e.g. `fetch_worldbank · 217 rows` ⟷ `1.8k tok`). This is feasible today — `agent.ts`/`providers.ts` already track per-call `usage.input`/`usage.output`.
- **Running total:** a dashed-rule totals line near the bottom, combining the run's total token count with the existing `estimateCost` dollar figure: `total` ⟷ `3.1k tok · $0.00 free`. Per-step is tokens only; the dollar figure only ever appears once, at the run-level total, matching what `estimateCost` already computes.
- **Confidence-tinted final answer (provider-dependent, see below):** where log-probabilities are available, the answer's own words are colored by their per-token log-probability. High-confidence tokens render in the default off-white; low-confidence tokens shift toward a semantic "low confidence" tone with a dotted underline, and expose the exact logprob value on hover/title (e.g. `title="logprob -2.81"`).
- **Small legend:** two tiny swatches under the answer — "confident" / "uncertain" — so the color coding is self-explanatory without a tooltip hunt. Only rendered when logprobs are present for that run.

### Logprob availability is provider-dependent — this is a real constraint, not a footnote

Checked against the three providers in Chitti's picker:
- **OpenAI:** supports `logprobs`/`top_logprobs` directly via its Chat Completions API, reachable from a BYOK browser call. Works.
- **Anthropic:** the Messages API does not expose logprobs at all, for any model. Never available.
- **OpenRouter:** proxies logprobs only for the subset of upstream models/providers whose own APIs support it — inconsistent, not guaranteed even for a given model day-to-day.

Net effect: confidence tinting — the second-most distinctive interaction in this design after the ink stamp — will simply never appear for Anthropic, and may or may not appear on OpenRouter depending on the routed model. Token counts and model/provider name have no such dependency and always render.

This also means implementing logprobs for real is **not purely a front-end skin** — `agent.ts`/`providers.ts` currently track token usage but have no logprob plumbing anywhere, so wiring this up touches the agent runtime, which the Non-goals section below rules out. This spec treats full logprob wiring as a **stretch goal for the prototype step**: the full-fidelity mockups should show what confidence-tinting looks like (using representative/sample logprob values), but actually wiring it into live runs against OpenAI is follow-up implementation work, not guaranteed by this round. The Non-goals section is amended accordingly.

## States to design at full fidelity

1. **Idle / start state** — the ask input, restyled to match the new receipt system: same near-black background, amber accent, mixed serif/mono type already established on the marketing page; carry over existing copy and example chips as-is (no new copywriting in this round).
2. **Live trace, mid-run** — the core deliverable: torn-paper rail with timestamped steps, one active/glowing, others struck through, model header, per-step token counts, chart building in the right panel.
3. **Final answer state** — verification stamp applied, confidence-tinted answer text (sample/representative values — see logprob availability note above) settled at the bottom of the rail, running total shown, chart fully rendered in the right panel with its own citation link(s) back to the World Bank source, consistent with existing "CITED" promise on the landing page.
4. **Zero-result state** — a run that completes with no chart/no finding (a real code path in `agent.ts`'s bailout logic). The receipt still closes out (timestamped, no fabricated "VERIFIED" stamp), with a plain-language line explaining nothing was found, styled as part of the same trace rather than a separate error component.

Error/retry states from the current implementation (inline warn-accent step, automatic retry note) are in scope for this round and should be restyled to fit the receipt system (e.g., a torn/crossed-out line-item rather than a generic red banner) — not deferred.

## Non-goals for this round

- No changes to the actual agent runtime (`src/lib/chitti/agent.ts`, `tools.ts`) for token counts, cost, or the existing retry logic — this is a front-end/visual redesign of `src/pages/apps/chitti.astro` for those pieces.
- **Exception:** wiring real log-probabilities into live runs is explicitly allowed to require provider-layer changes (see logprob availability note above), but is treated as a stretch goal / follow-up — the full-fidelity prototypes only need to show the confidence-tinting interaction with representative sample data, not a working end-to-end logprob pipeline.
- No redesign of the marketing copy/explainer section below the console (the "01/02/03 how it works" block) unless it visually clashes with the new console styling.
- Mobile/responsive layout not explored in brainstorming — flag as a follow-up, not blocking this round's prototypes.
- No multi-turn/conversation-history feature — see "Single-shot only" above.

## Reconciling with the site's existing design system

The portfolio site has its own design system (Inter/Newsreader/JetBrains Mono fonts, `--signal` amber reserved for live/status meaning, translucent glass surfaces via CSS custom properties, no raw color values in components). This redesign should lean on those tokens wherever it's a natural fit, and introduce new named tokens (not raw hex/rgba) where the receipt concept needs something the palette doesn't have. Concrete mapping, so the prototype step doesn't re-litigate this per element:

| Element | Token |
|---|---|
| Trace rail / receipt paper background | existing `--bg-elevated` |
| Perforation / tear-line borders | existing `--fg-faint` (not a new raw `rgba(255,255,255,0.15)`) |
| Active-step glow dot, "VERIFIED" stamp border/text | existing `--signal` (legitimate use — both are live/status indicators, consistent with the token's reserved purpose) |
| Completed-step strike-through/fade | existing `--fg-muted` |
| Low-confidence token tint + underline | new token, e.g. `--confidence-low`, seeded from the existing `--danger` semantic hue rather than an arbitrary new hex |
| Body/label text in the rail | JetBrains Mono (site's existing mono token), not a generic monospace stack |
| Trace timestamps, model/provider header | JetBrains Mono, `--fg-muted`, matching existing `--text-label` sizing |
| Card/rail border-radius | existing 8px token |

Everything in the brainstorm mockups used raw hex/rgba for speed; the full-fidelity prototype step re-expresses all of it through this table.

## Deliverable

Polished HTML prototypes (via Artifact) covering the four states above (idle, live-trace, final-answer, zero-result), at real visual fidelity — dark theme, matching Chitti's existing amber-on-near-black/mixed serif+monospace system, expressed through the token mapping above — suitable for either direct visual reference or handoff into the actual `chitti.astro` implementation.
