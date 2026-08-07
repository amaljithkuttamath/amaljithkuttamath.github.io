# Chitti: evals, the funnel, and how to track them

Status: built. Written 2026-08-07. Code: `src/lib/chitti/evals.ts` (model +
grading + history), `evals-run.ts` (the runner), `ui/evals-view.ts` (the
sidebar).

## What this is

An eval suite that lives inside the app and runs on demand — from the header's
**Evals** button, or by typing **`/evals run`** in the composer. It drives real
questions through the same two paths a user's question takes, grades each one
against what the app claims to do, and shows where the pipeline stopped.

Chitti's failure mode is not a crash. It is a confident wrong answer: the wrong
series, the wrong countries, a chart with a citation wrapped around it. Nothing
noticed that happening. The unit tests assert component behaviour, and
`kb.test.ts` grades phrase→series retrieval offline — but no test drives a
question end to end through the pipeline the user actually gets, because that
needs the network and, for the agent path, the user's own key. Those are the two
things only the browser has, which is why the harness is here and not in vitest.

## The funnel

Six stages, in pipeline order. Each is a strictly harder condition than the one
before, so a run is a funnel and the drop-off names the layer that broke.

| Stage | Passes when | A loss here means |
|---|---|---|
| `routed` | the expected runner took it | the fast path over-fired, or refused something it should answer |
| `resolved` | a series id came back | retrieval — the KB or the catalogue search |
| `fetched` | rows arrived | the source API: moved, throttled, empty |
| `charted` | a valid spec was built | `normalizeSpec` or the chart path |
| `cited` | provenance carries a request URL | the citation ledger — the traceability claim itself |
| `correct` | the expected series and countries | a silently wrong answer, with everything upstream green |

The last row is the one that matters most: a case can pass five stages and fail
the sixth, which is precisely the failure the app's own tests cannot see.

## Two things the grading refuses to blur

**Refusing is not failing.** Roughly a third of the suite is questions the fast
path must *decline* — a ranking, two indicators in one ask, an ambiguous
indicator family. `route: 'agent'` cases fail if the deterministic path answers
them. The app is calibrated to under-fire on purpose (`MIN_MATCH_SCORE` in
`fastpath.ts`), and a suite that rewarded coverage alone would quietly push that
threshold the wrong way. In a key-free run these are reported separately as
**refusals held**, never folded into the pass count.

**Not-run is not passed.** An agent case in a key-free run has been refusal-
checked and nothing more; it is excluded from the funnel entirely. If skipped
cases counted as drop-off, every key-free run would look like a half-failed
suite.

There is a third, subtler one. A runner that throws *before any runner commits*
leaves routing unknowable — a dead network is neither an over-fire nor a
retrieval regression. Those cases leave `routed` ungraded and report the error at
`resolved`. Without that, one afternoon of source-API trouble reads as a
retrieval regression on every direct case, and the funnel's whole value is that
it points at the right layer.

## What a case may assert

Which series answers a question, which countries come back, and a row floor.
**Never a value.** Values belong to the source and change when it updates; a case
that pinned one would either fail on every data release or tempt someone to write
the number down — the same lie the demos file exists to prevent, one layer up. A
test asserts this: adding a `value`-shaped expectation fails the suite's own
suite.

Expected ids are a **list**, and that is deliberate. "GDP per capita" is honestly
answered by current US$ or PPP; "CO2 emissions per capita" resolves to OWID today
and the World Bank code yesterday. Pinning exactly one id would fail the day the
scorer changes its mind for a good reason.

## Modes and cost

- **Fast path only** (default): no key, no model, no tokens. Grades the whole
  deterministic pipeline plus every refusal. This is the mode to run habitually.
- **With the agent**: a fresh session per case — never a shared one, or case N+1
  becomes a follow-up to case N and the suite measures conversation memory
  instead. It spends the user's key and shows the cost in the status line and in
  the history row. A `direct` case the fast path declined has already failed at
  routing, so the agent is never escalated to for it: no run buys stages that
  are recorded as skipped anyway.

## How to track it

**In the browser.** Every completed run is filed to `localStorage` under
`chitti:evals` — twenty runs, newest first, oldest evicted. Each history row is
date, pass-rate bar, `passed/ran`, mode (or model), and cost. Stopped runs are
shown but never filed: a history you cannot compare like for like is worse than a
shorter one. Stored runs are compacted first (country lists trimmed, true counts
kept), so a history can never crowd out the user's dashboards.

**Out of the browser.** There is nowhere to send a run — no backend, by design —
so the artifact travels instead. **Copy Markdown** emits the funnel table and the
per-case verdicts, ready to paste into a PR or an issue; **Export JSON** writes
the whole run. The Markdown carries the honesty note with it, because the note
matters most where the numbers are read out of context.

**What to watch, in order.** A drop at `routed` is the most alarming — the fast
path changed its mind about what it will answer, which is a change to what runs
with no model at all. A drop at `resolved` after a `kb:refresh` means the
catalogue refresh moved retrieval. A drop at `fetched` alone is almost always the
source, not us. A drop at `correct` with everything else green is the one worth
stopping for.

**When to run.** Before and after anything that touches retrieval (`kb.ts`,
`scoring.ts`, the KB refresh), the fast path's gates, `normalizeSpec`, or a
source adapter. Copy the before-run into the PR alongside the after.

## Known red: `mortality in Kenya`

The first run of this harness found one. For the bare word "mortality" the
knowledge base scores infant mortality 54 and under-5 52 — so the fast path
commits to infant on a two-point margin, charts it with no model, and never tells
the user there was a choice. The clarify gate cannot help: no model sees the
question. The case is `route: 'agent'` and stays red until retrieval refuses a
near-tie across indicator families. It is written down where a run keeps raising
it, which is the point of having the suite at all — do not resolve it by flipping
the case.

## What this deliberately is not

Not a CI gate: the suite needs the network and, for half of it, a key, so it
cannot run on a runner and must not become a required check. Not telemetry:
nothing leaves the browser unless the user copies it out. Not a benchmark of
model quality: the agent mode grades whether *this app* gets the right series and
the right countries, not whether the model is clever.
