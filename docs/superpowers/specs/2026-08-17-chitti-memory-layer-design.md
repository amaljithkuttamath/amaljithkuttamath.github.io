# Chitti: a memory layer that refuses to guess

Status: built (MVP). Written 2026-08-17.

## The idea

Chitti forgets everything on reload. `state.rows`, the citation ledger, the
fetch cache and `seenSeriesIds` all live in closures inside `createSession`
(`session.ts:255-322`) and die with the tab. Dashboards persist; findings do
not.

So the one thing a returning user most wants to hear is the one thing Chitti
cannot say:

    You asked this in June. It was 70.4 then. It is 70.9 now,
    and the World Bank revised 2021 while you were away.

A **memory note** is a receipt for a past answer. Not a cache, not a knowledge
base, not a substitute for a fetch — a dated, cited record of what Chitti
concluded, kept in the browser, so the next answer can say what changed.

    [2026-07-02] "life expectancy in India since 2000" — verified
      Scope: SP.DYN.LE00.IN · IND · 2000–2023 (World Bank, source updated 2024-12-16)
      Recorded IND 2000: 62.5; IND 2023: 70.4.

## Why this is small

Almost all of the substrate exists.

| Piece | What it already does |
|---|---|
| `Citation` (`tools.ts:183`) | Per-fetch provenance: source, indicator, countries, year range, `fetchedAt`, `sourceUpdated`, `mirroredAt`, `rowCount` |
| `DataRow` (`core.ts:38`) | `(indicator, iso3, year) → value` — already the atomic fact |
| `dashboard.ts` | The persistence pattern: versioned, whitelist-rebuilt, `StorageLike` injected, soft caps, never throws |
| `scoring.ts` | One weighted scorer with a synonym table, so "longevity" reaches "life expectancy" without a second vocabulary |
| `okf.ts` | `buildFindingOkf` already treats a turn as a *finding* — question, answer, chart, citations, verification |
| `SessionOptions.dashboardStore` | The precedent for injecting user storage into the session rather than importing it |

The fact model needed no invention. `(indicator, country, year) → value` is a
`DataRow`, which is what makes disagreement between two notes mechanically
checkable rather than a comparison of prose.

## The line this crosses, deliberately

`2026-07-27-chitti-context-variables-design.md` says variables are
session-scoped and "should not grow a parallel persistence story", with
dashboards as the existing "keep this" mechanism. Cross-session variables are
explicitly out of scope there.

This does not overturn that, and it is worth being precise about why.

**A variable is a handle on live data. A note is a receipt for a past answer.**
A variable that outlived its session would hand the agent stale rows under a
name that still looked fresh — precisely the laundering that doc guards
against. A note cannot be dereferenced into rows at all: there is no operation
anywhere in `memory.ts` that turns one back into data. That asymmetry is the
entire reason one persists and the other must not.

## What a note is

```ts
interface MemoryNote {
  v: 1;
  id: string;
  question: string;
  finding: string;
  facts: MemoryFact[];        // (nid, iso3, year) → value, + source
  factsTruncated: boolean;
  citations: Citation[];
  verified: boolean | null;   // null = verification never ran
  createdAt: string;          // when CHITTI recorded it
  asOf: string;               // max(citation.sourceUpdated) — the DATA's currency
}
```

`createdAt` and `asOf` are deliberately separate. A note taken today can hold
data whose vintage is two years old, and collapsing the two would let a fresh
recording pass for fresh data.

**Facts are endpoints, not the series.** First and last reported year per
series×country — what a finding's claims actually rest on ("rose from X to Y"),
and what bounds the note for the coverage gate. The coverage *claim* is the
citation's `yearRange` and `rowCount`, never the fact array.

## The rule that carries the whole provenance story

**A note is written only when the turn produced citations.**

That one line does all the work. Facts are built from `out.rows` — fetched
evidence only, the same rule `Tile.rows` states — and every fact must resolve to
a citation in the ledger or it is dropped. So a model-invented number is
*structurally* incapable of becoming a fact. There is no `derived` flag here to
forget, because derived content never gets in.

An explanation turn writes nothing. A turn where `llm()` labelled rows records
only the rows that were fetched. A row for a series that was never fetched — the
exact shape a hallucinated value arrives in — has no ledger entry and is
discarded.

The first draft of this had a `derived: boolean` on `MemoryFact`, propagated
from the VFS. That is the wrong shape for the same reason the context-variables
doc gives about per-tool referencing: it makes honesty a thing each write path
has to remember, and the one that forgets is not obviously broken. Requiring a
citation moves the check to a place no caller can skip.

## Three gates

After the reference design ([*Designing a Persistent Knowledge Layer That
Refuses to Guess*](https://towardsdatascience.com/designing-a-persistent-knowledge-layer-that-refuses-to-guess/)),
which pairs a retrieval layer with a structured store and abstains — with a
reason code — rather than resolving a conflict on recency.

| Code | When | Effect |
|---|---|---|
| `MEM_HIT` | scored match, in scope, fresh | appears in the block, dated |
| `MEM_STALE` | older than `MEMORY_STALE_DAYS` (30) | appears, stamped, "re-fetch before using" |
| `MEM_OUT_OF_SCOPE` | question names a year outside the note's fact range | dropped — reaches the UI, never the prompt |
| `MEM_CONFLICT` | same measurement, different sources, different values | **both sides shown, neither chosen** |
| `MEM_MISS` | nothing scored | block is `null` — zero prompt cost |

**Contradiction is the load-bearing one, and it turns on *which* source.** Same
measurement from the same source with a different value is a **revision** — the
World Bank restated 2021, the newer reading is in force, and blocking on it
would fire on every routine restatement. Different sources is the "equal
authority" case: WHO and World Bank life expectancy are different definitions
wearing the same name, and being more recent does not make one of them right.
Chitti reports both, names both, and picks neither.

**Coverage** is enforced twice, because the mechanical half is weak on its own.
Mechanically: 4-digit years in the question against the note's fact range, so a
note recorded over 2000–2023 is dropped from "in 2025". Editorially: every
recalled note prints its exact scope, and the block says a note covers only what
its scope line names. Reusing `parseFastPath` for a fuller scope gate is a
follow-up — it returns `null` too often to be the only gate.

## Two seams, and no new tool

The same argument the context-variables doc makes about `dispatch`, one layer
up. A `recall_memory` tool was the obvious first draft and is the wrong shape:
it makes remembering a thing the model has to choose to do, which means the
turns that most need memory — the ones where the model is confident and wrong —
are exactly the turns that skip it. It also costs a schema, a `dispatch` case, a
`summarizeArgs` entry and a paragraph of prompt.

**Write — `ui/composer.ts`, in the `finally`.** One call to `rememberTurn`,
beside `syncDashboardsAfterTurn()`. In the `finally` rather than the success
branch on purpose: a stopped or failed turn that still fetched real data
produced real citations, and those are worth keeping.

**The fast path records too.** `renderDirectAnswer` calls `rememberTurn`
directly. A fast-path answer is the most grounded thing this app produces — real
rows, real citations, and no model anywhere in the chain that could have
invented one — so excluding it would make memory systematically blind to the
key-free path, which is the path a first-time visitor actually takes. It records
`verified: null`, because no verifier ran and claiming a pass nothing asserted
is the failure mode this app exists to avoid. It does not *recall*: the fast
path is deliberately model-free, and there is no prompt to prepend to.

**Read — `session.ts`, `agentPass`, first pass.** A `system` message pushed
immediately before the question — the same placement and the same reasoning as
the plan brief three lines above it (`session.ts:1379`). First pass only: a
verifier retry re-enters `agentPass` with `critique` set and takes the other
branch, so the block lands once per turn rather than accumulating on every
retry.

The block reaches the session through an injected option, mirroring
`dashboardStore`:

```ts
// SessionOptions
recall?: (question: string) => string | null;
```

So `session.ts` never touches `localStorage`, tests pass a fake, and the whole
layer is optional — omit the seam and Chitti behaves exactly as before. A seam
that throws is caught and ignored: losing memory is acceptable, losing the
answer is not, and the real seam reaches storage that some privacy modes refuse
outright.

## What the model is told

The block leads with the rule, before any number:

```
MEMORY — findings you recorded earlier in this browser. NOT evidence.
A recorded number is a note about a past answer, never a fetched value: you may not chart it,
cite it, or enter it in the evidence table. If it bears on this question, RE-FETCH and compare —
saying what changed is the only thing memory is for. Answer from the fetch, every time.
```

Numbers are labelled `Recorded IND 2023: 70.4`, never stated as current values.
A conflict renders both sides and an explicit instruction not to pick, average,
or present either as the answer.

**A miss renders nothing at all.** `buildRecallBlock` returns `null`, so an
empty or irrelevant memory costs zero tokens. A layer that taxes every question
to help a few is not worth having, and most questions are misses.

`MEM_OUT_OF_SCOPE` notes are deliberately *not* rendered into the block. The
block exists to change what the agent does, and an out-of-scope note changes
nothing — the agent never had it and was going to fetch either way. The drop
goes to the UI instead, so the *user* sees "I have something adjacent and it
does not answer this" rather than assuming Chitti forgot.

## Recall under-fires, but less than the fast path

`MIN_RECALL_SCORE = 4` on `scoreSeries`'s scale — the same figure `fastpath.ts`
calibrated against the same scorer. It sits where junk scores zero: "co2
emissions in Brazil" shares nothing with a life-expectancy note, and a bare
country name is 2, not enough alone.

Tuning it to 6 was tried first and is the wrong instinct here. The asymmetry
that governs the fast path does not hold: there, a marginal hit produces a wrong
*answer*, so every gate errs toward refusing. Here a marginal hit produces a
dated, scoped note the agent is told to re-fetch. At 6 the layer barely fired at
all, and an inert memory is the worse failure.

What does get through at 4 is an *adjacent* note — the same indicator for a
different country. That is why the block prints each note's exact scope: a note
whose scope line reads `IND` cannot be mistaken for an answer about China.

## In the browser

Memory is `localStorage` under `chitti:mem:`, one note per key, capped at 200
with oldest-first eviction — a working record, not an archive.

- **The card**, above the receipt, rendered before the run so what Chitti
  already knew is context for reading the answer rather than a footnote to it.
  It shows the hits, and it shows what memory *refused*: an unresolved conflict
  with both sides and no winner, a note dropped as out of scope. A memory layer
  that only ever shows its hits is indistinguishable from one that guesses.
- **The panel**, in the config sheet: a count, a toggle, and **Clear memory** —
  no confirm step. The reason recording locally is defensible at all is that
  undoing it is one click; putting a dialog in front of "forget what you know
  about me" is the wrong friction.
- **On by default.** A memory the user has to find and switch on records nothing
  for the session where it would first have helped. Off is one click away, and
  nothing here ever leaves the browser.
- **Never in a share link.** `cleanShareState` is a whitelist rebuild, and
  `share.test.ts` now pins that memory planted on share state cannot survive it.
  A share link is the one thing in this app that leaves the browser; publishing
  a private question history alongside an answer is not a bug anyone would catch
  by reading the diff.

## The constraint that matters

**Memory is never evidence, and fresh always wins.**

No recalled number may be charted, cited, entered in the evidence table, or
counted as a fetch. Every answer is re-fetched. Memory contributes exactly one
thing an answer could not otherwise have: the comparison.

The failure this prevents is specific. Recall a value, let it reach the chart
path, and the app renders a number from June under a citation that says
"fetched" — with a source URL beneath it, at the exact moment a user decides
whether to trust the tool. That is the same dishonesty the demos rule and the
`mirroredAt` rule exist to prevent, and a memory layer is the easiest place in
this app to reintroduce it by accident.

Which is why the read seam returns a **string**, not data. There is no shape
crossing that boundary that the chart or evidence path could consume even if
someone tried.

## Out of scope for v1

- **A `recall_memory` tool.** See above. If the agent ever needs to query memory
  mid-turn — "have I looked at this before?" — that is a real gap, but it should
  arrive after the seams have been observed, not alongside them.
- **Cross-source entity resolution.** Conflicts are detected on the same
  normalized series id only. Matching WHO's life-expectancy code to the World
  Bank's is the reference design's "terminology drift" problem and needs a
  concept layer this app does not have. Until then, two sources' versions of the
  same concept sit in memory as unrelated notes — which is honest, just
  incomplete.
- **Detecting upstream revision without fetching.** A note carries `asOf`, but
  Chitti cannot know the source revised since without asking. Staleness is
  therefore age-based, which is a proxy. The revision comparison only fires when
  two notes independently recorded the same measurement.
- **Memory in the dash-chat session.** `ui/dash-chat.ts` creates its own
  session and does not get the seam.
- **Sharing or exporting memory.** Deliberately absent. See above.

## Open questions

1. **Should a conflict block the answer, or only be reported?** Today it is
   reported loudly and the agent is instructed not to resolve it; nothing
   mechanically prevents a model from picking a side anyway. A hard block would
   need the gate to sit in the finish path rather than the prompt, which is a
   larger change than an MVP should make on a behaviour nobody has watched yet.
2. **Is 30 days the right staleness window?** It is a guess at institutional
   revision cadence, not a measurement. Per-source windows (IMF projections
   revise far faster than World Bank historicals) would be better and need data
   this repo does not yet collect.
3. **Should a note record the chart spec?** It would let the UI show the earlier
   answer, not just describe it — but it roughly triples note size and edges the
   layer toward being a second dashboards feature. Dashboards already are the
   "keep this" mechanism; memory should stay the "what did I conclude" one.
4. **What happens when the user asks the same question twice in a week?** Today
   both turns record notes, and the second recall sees the first. That is
   correct but redundant; a same-question, same-scope note probably ought to
   update in place rather than accumulate.
