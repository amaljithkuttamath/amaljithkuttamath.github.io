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

## Visual signature: the receipt

The distinguishing idea, chosen over "chart draws itself" and "floating glass panel" alternatives: **the trace rail is styled as a physical receipt.**

- **Torn top edge:** a jagged/perforated SVG edge at the top of the rail, as if torn from a roll.
- **Timestamped steps:** each step line-item shows a precise timestamp (`14:02:01.4`) before it, monospace, low-opacity.
- **Completed steps strike through** and fade to ~40% opacity as the agent moves on; the **active step** shows a small glowing amber dot (`box-shadow` glow, pulsing).
- **Dashed perforation lines** (`border: 1px dashed rgba(255,255,255,0.15)`) separate sections, echoing a receipt's tear lines.
- **Verification step is ink-stamped:** when the self-check tool call passes, an amber-bordered "VERIFIED" stamp renders rotated ~-8°, like a rubber ink stamp, overlapping the verification line. This is the single most distinctive visual beat in the whole design — it's the moment of trust made visible.
- Final answer settles at the bottom of the rail, inside the last "torn" section, not as a separate disconnected block elsewhere on the page.

## Observability: model, cost, and confidence — folded into the receipt

Explicit requirement: model used, per-item token cost, and log-probability–based confidence must be visible, not hidden in a debug toggle. This is real telemetry presented as part of the receipt, not a developer-only overlay.

- **Header line:** model name + provider pinned at the top of the rail (e.g. `nemotron-3-super-120b` / `openrouter`), always visible, low-opacity monospace.
- **Per-step token cost:** each trace line-item shows its own token count right-aligned, receipt-style (e.g. `fetch_worldbank · 217 rows` ⟷ `1.8k tok`).
- **Running total:** a dashed-rule totals line near the bottom: `total` ⟷ `3.1k tok · $0.00 free`.
- **Confidence-tinted final answer:** the answer's own words are colored by their per-token log-probability. High-confidence tokens render in the default off-white; low-confidence tokens shift toward an amber/red tone (`#c94f2f`) with a dotted underline, and expose the exact logprob value on hover/title (e.g. `title="logprob -2.81"`).
- **Small legend:** two tiny swatches under the answer — "confident" (off-white) / "uncertain" (red-orange) — so the color coding is self-explanatory without a tooltip hunt.
- **Graceful degradation:** not every OpenRouter-routed model/provider returns logprobs. When unavailable for the selected model, the confidence tinting and legend are simply omitted (answer renders in default color) — no error state, no placeholder, no broken hover. Token counts and model/provider name have no such dependency and always render when the API returns usage data.

## States to design at full fidelity

1. **Idle / start state** — the ask input, still needs to feel like the opening of a conversation rather than a form (not yet detailed in visual brainstorming; carry over existing copy/example chips but restyle to match the new system — same near-black background, amber accent, mixed serif/mono type already established on the marketing page).
2. **Live trace, mid-run** — the core deliverable: torn-paper rail with timestamped steps, one active/glowing, others struck through, model header, per-step token costs, chart building in the right panel.
3. **Final answer state** — verification stamp applied, confidence-tinted answer text settled at the bottom of the rail, running total shown, chart fully rendered in the right panel with its own citation link(s) back to the World Bank source, consistent with existing "CITED" promise on the landing page.

Error/retry states from the current implementation (inline warn-accent step, automatic retry note) should be preserved functionally but restyled to fit the receipt system — out of scope for the first round of visual prototypes unless time permits; call this out explicitly rather than silently dropping it.

## Non-goals for this round

- No changes to the actual agent runtime (`src/lib/chitti/agent.ts`, `tools.ts`) — this is a front-end/visual redesign of `src/pages/apps/chitti.astro` only.
- No redesign of the marketing copy/explainer section below the console (the "01/02/03 how it works" block) unless it visually clashes with the new console styling.
- Mobile/responsive layout not explored in brainstorming — flag as a follow-up, not blocking this round's prototypes.

## Reconciling with the site's existing design system

The portfolio site has its own design system (Inter/Newsreader/JetBrains Mono fonts, `--signal` amber reserved for live/status meaning, translucent glass surfaces via CSS custom properties). This redesign should lean on those tokens wherever it's a natural fit — fonts, base surface colors, border-radius/spacing scale — rather than inventing a parallel palette from scratch. But the receipt concept's distinctive, load-bearing details (torn-paper edge, ink-stamp verification, confidence-tinted text) are new visual ideas earned by this feature, and shouldn't be watered down just to fit existing tokens where no natural equivalent exists. Reconcile where it's a natural extension; introduce new tokens/colors where the concept genuinely needs them.

## Deliverable

2–3 polished HTML prototypes (via Artifact) covering idle, live-trace, and final-answer states, at real visual fidelity — dark theme, matching Chitti's existing amber-on-near-black/mixed serif+monospace system — suitable for either direct visual reference or handoff into the actual `chitti.astro` implementation.
