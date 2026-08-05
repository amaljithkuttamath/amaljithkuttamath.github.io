# Chitti: use cases derived from CopilotKit

Status: survey + design sketch, nothing built. Written 2026-08-05.

## Why read CopilotKit at all

CopilotKit is the frontend stack for agents — React hooks and an event protocol
(AG-UI) for putting an agent *inside* an application rather than beside it in a
chat window. Chitti cannot adopt the library: CopilotKit assumes React and a
runtime process on a server, and Chitti is vanilla TS modules on a static
GitHub Pages build with no backend and the user's own key
([`AGENTS.md`](../../../AGENTS.md), the BYOK/zero-backend rule). So this is not
an integration plan.

What CopilotKit is useful for is its **taxonomy**. It has enumerated, with a
name for each, the seams where an agent meets an app: what the agent can *read*
of the app, what it can *do* to the app, what the app *renders* on the agent's
behalf, where the agent *pauses* for a human, and what state the two *share*.
That list is worth holding Chitti against, because Chitti has independently
built several of those seams already — which is evidence the taxonomy transfers
— and the interesting part is the ones it hasn't.

Every use case below is judged against the same fences the rest of this app is
built on: no backend, no telemetry, key stays in the browser, and **nothing the
model produces may be presented as data**. Several CopilotKit patterns fail
those fences outright; they are listed too, in *What Chitti should decline*,
because a survey that only lists the appealing half is not a survey.

## The mapping

| CopilotKit primitive | What it does there | Chitti's equivalent today | Gap |
|---|---|---|---|
| `useCopilotReadable` | Publishes app state into the agent's context | **Nothing.** The session is fed the conversation and its own tool results, and nothing else (`createSession` takes `sources`/`rlm`/`dashboardStore` — `session.ts:226`) | Large — the agent cannot see what you are looking at |
| `useCopilotAction` (frontend actions) | Lets the agent call into the running app | `render_chart`, `save_to_dashboard`, `edit_dashboard` (`schemas.ts`) — these *are* frontend actions | Mostly covered |
| Generative UI (`render` on an action) | Agent-chosen components rendered in the chat | Chart + data table + citations ledger + trace, all rendered from typed specs (`ui/charts.ts`, `ui/evidence.ts`, `ui/trace.ts`) | Deliberately narrower; a bounded version is worth having |
| `renderAndWaitForResponse` (human-in-the-loop) | Agent pauses, renders a control, waits for a human | The clarify gate (`1b93a81`) — one prose question, once, always with a stated default | Prose-only; no structured control, no confirm-before-cost |
| Shared state (`useCoAgent`) | Agent and UI read/write one live state object | Dashboards are the shared object, but the sync is one-way and end-of-turn (`ui/dash-chat.ts`) | Real gap, small surface |
| Agentic state streaming (`useCoAgentStateRender`) | Renders the agent's intermediate state as it runs | The `TraceEvent` stream, plan card, nested sub-agent receipts, live `write_file` rows | **Chitti is ahead here** |
| Chat suggestions | Model-generated next-question chips | Hard-coded preset chips (`chitti.astro:111`, wired in `ui/boot.ts:194`) | Real gap, and the honesty rule shapes the fix |
| `CopilotTextarea` (in-field AI autocomplete) | Completes prose in a text field | Nothing; the composer is a plain textarea | Real gap, and cheaper here than there |
| AG-UI protocol | A standard event stream between agent and any frontend | `TraceEvent` is a private one; LangSmith export already reshapes it (`tracing.ts`) | Speculative until a second frontend exists |
| Backend tool rendering | Server tools return UI to the client | N/A — there is no server | Declined |
| Self-learning / CLHF, per-user adaptation | Agents learn from feedback per user | Nothing | Declined as designed; a small declared-preferences version is defensible |
| Multi-frontend (Slack, Teams, mobile) | One agent backend, many surfaces | The `#share=` permalink and `#dash=` export are the distribution channel | N/A |

Two rows are worth pausing on. **Chitti is ahead of CopilotKit on intermediate
state rendering** — the receipt is the product here, not a debug affordance, and
it already streams plan steps, tool calls, sub-agent receipts and file writes.
And **Chitti already has frontend actions**; what it lacks is the other
direction, readability. The agent can change the app and cannot see it.

## The use cases, ranked

### 1. The agent can see what you are looking at (`useCopilotReadable`)

**Today.** Standing in a dashboard, "add China to that" has to be resolved from
prose. The dashboard session (`ui/dash-chat.ts:138`) is scoped to the board's
id, which keeps two boards' conversations apart — but the board itself is never
put in front of the model. It reaches tiles only by *calling a tool* and naming
a dashboard by title (`edit_dashboard`, resolved through `resolveTileRef`,
`dashboards-agent.ts:42`), which is the agent asking "what am I standing on?"
at the cost of a round trip, and getting it wrong when the title is ambiguous.

**The use case.** Publish a small, typed, whitelisted **view of the current app
state** into each turn: the open dashboard and its tiles (title, indicator id,
countries, year window, snapshot-or-live), the chart currently on screen, the
selected databases, the RLM toggle. "Make that per-capita", "drop the last
tile", "same window for India" resolve without a describe-it-again round trip.

**Why it is small.** The context-variables design
([2026-07-27](2026-07-27-chitti-context-variables-design.md)) is this feature
with names attached — a variable is a readable that the *user* can also point
at. These should ship as one thing, not two: the readable view is what the
`@name` table is built over.

**Fences.** The view is a **whitelist**, built like `cleanShareState`
(`share.ts`) — never the key, never the VFS, never trace. It is *descriptive*:
publishing that a tile holds `SP.DYN.LE00.IN` for IND 2000–2024 is publishing
what was already fetched and cited; it must never become a channel for numbers
the model then reports without fetching. Cite from the ledger, as now.

### 2. Disambiguation as a control, not a paragraph (`renderAndWaitForResponse`)

**Today.** The clarify gate is good and its fences are the design: ask only
when the answer changes *which numbers come back*, one question once, always
state the default, options must be real series from `find_series` or
`browse_dataset`, never ask what `profile_series` can answer. It costs a turn,
and for a key-free visitor that turn lands before Chitti has done anything
worth trusting.

**The use case.** Render that same question as a **choice card**: two or three
real series (id, source, coverage), the default preselected, one click sends
the answer. Same gate, same fences, one interaction instead of a typed reply —
and the cost is removed for the user who does not care, because the default is
already chosen and "go" is a click.

**Fences.** Unchanged, plus one: the card may only offer ids that came back
from a search in *this* turn, carried verbatim. A picker that lets the model
invent an option is worse than the paragraph, because a control reads as
authoritative.

### 3. Grounded follow-up suggestions (chat suggestions)

**Today.** The chips on the empty state are hard-coded prompt starters. After
an answer there is nothing — the user has to invent the next question at
exactly the moment the data has just told them what it should be.

**The use case.** After a turn, offer two or three next questions **derived from
what was actually computed**: the outlier the chart shows, the country whose
series ends early (coverage is already computed — `eda.ts`, `profile_series`),
the paired indicator the correlation suggests. Each chip carries the concrete
scope, so most of them land on the fast path (`fastpath.ts`) — no key, no model
call, no cost.

**Fences.** Derive them from computed facts, not from a model asked "what
should they ask next?". That is the demos rule (`demos.ts`, and the
AGENTS.md section on it) applied to a new surface: in a provenance tool, a
suggestion that implies a finding the data does not support is the app lying in
a softer form. A chip that cannot be derived is not shown.

### 4. Composer autocomplete over the knowledge base (`CopilotTextarea`)

**Today.** The composer is a plain textarea. `kb.ts` already resolves a phrase
to a series by walking a hierarchy (a leaf inherits its ancestors' vocabulary),
and `src/data/chitti/kb.json` carries ~1,500 generated entries.

**The use case.** Type "child mort" and see the real series — with source and
coverage — as an inline completion; accept it and the question now names an id.
Same field, the `@` prefix pulls from the variables/readables table from use
case 1.

**Why it is the cheapest item here.** CopilotKit's version needs a model call
per keystroke-batch; Chitti's needs **none**. The retrieval already exists and
is offline. And every accepted completion pushes a question toward the fast
path's "indicator × countries × years" shape, which means more answers with no
key and no model — the direction this app has been moving in all year.

**Fences.** Suggest only what `kb.ts` resolves; never complete a country or an
indicator the catalog does not hold. Keyboard-first and dismissible; the
retrieval eval in `kb.test.ts` is the regression table for what it offers.

### 5. The board updates while the agent works (shared state)

**Today.** A dashboard ask runs to completion and *then* a tile appears
(`askIntoDashboard`, `ui/dash-chat.ts:97`), and the surface deliberately
suppresses the trace so the board stays the artifact. That is the right call
about noise, but it leaves the user watching one status line for a whole run.

**The use case.** A **placeholder tile** the moment the ask starts, filled in
as the run produces a spec — and, in the other direction, an edit made in
another tab is picked up before the tile is written. The reload-before-write in
`addChartTile` is already half of that story; the missing half is the agent
seeing the board it is about to change (which is use case 1 again).

**Fences.** A pending tile must be visibly pending — never a chart shape that
could be read as data before its citations exist.

### 6. Confirm before cost, confirm before loss (HITL, second form)

**Today.** `edit_dashboard` may remove a tile on the user's request, an
omitted `countries` argument fetches **every** country (a 60-country
1960–2024 pull is ~3,900 rows, walked page by page), and an RLM run spends the
user's key inside `execute_js`. None of these pauses.

**The use case.** A one-click confirm on the two irreversible-or-expensive
classes: destructive board edits, and a run about to cross a cost/size
threshold. This is exactly CopilotKit's `renderAndWaitForResponse` argument,
and it is the one place the pattern applies unchanged.

**Fences.** Thresholds, not vibes, and never a confirm on the cheap path — a
tool that asks permission for everything trains the user to click through it.

### 7. A bounded component vocabulary (generative UI, defanged)

**Today.** Every answer is one chart plus a table plus citations. `render_chart`
normalizes a model spec through `normalizeSpec` (`spec.ts`) — the model chooses
*within* a guarded shape, never emits markup.

**The use case.** Widen the vocabulary, not the freedom: let the agent choose
between a small set of *typed, hand-rendered* answer components — comparison
card, small multiples, a coverage strip, a delta callout — the way it already
chooses a chart type. Some findings are not a line chart, and today they are
rendered as one anyway.

**Fences.** The model picks a component name from a closed enum and fills a
typed spec. It never authors HTML. Model-authored markup in a provenance tool
is both an injection surface (`escapeHtml` vs `esc`, AGENTS.md) and a category
error: the app draws the evidence, the model does not get to draw its own.

### 8. Declared preferences, not learned ones (adaptation, bounded)

**Today.** Nothing persists between visits except the key (if saved) and
dashboards.

**The use case.** A small, **visible, editable** preferences object — default
countries, default year window, preferred databases, per-capita by default —
stored in localStorage and published through the same readable view as use case
1. It is the honest 5% of CopilotKit's per-user adaptation.

**Fences.** Declared, never inferred. See the next section.

## What Chitti should decline

- **The CopilotKit runtime and Cloud.** A server in the path ends zero-backend
  and BYOK privacy at once. The whole reason this app can promise no telemetry
  is that there is nowhere for telemetry to go.
- **Model-authored UI.** Generative UI as "the model returns components" is a
  provenance failure here, not just an injection risk. Use case 7 is the
  version that survives the fences.
- **Silent learning from feedback (CLHF).** An agent that quietly changes what
  it does based on accumulated behavior is unauditable, and auditability is the
  entire claim of this app — the receipt, the citation ledger, the verifier
  stamp, the "snapshot vs fetched" label all exist to make a run explicable
  after the fact. Preferences the user can read and edit (use case 8) are the
  part worth keeping.
- **React.** Not ideology — the UI layer's shape (`ui/state.ts` owning all
  shared state, `ui/boot.ts` as composition root, the asserted acyclic layering
  in `layering.test.ts`) is a working design, and a framework migration buys
  none of the eight items above.
- **Chat-first framing.** CopilotKit's default shape is a chat surface with the
  app behind it. The agent-canvas redesign
  ([2026-07-09](2026-07-09-chitti-agent-canvas-redesign-design.md)) settled the
  inverse for Chitti: the canvas is the product and the agent narrates beside
  it in a terse trace rail — deliberately not conversational prose. Every use
  case above lands on the canvas or the composer; none of them should quietly
  grow the chat back into the centre.
- **AG-UI as a protocol adoption.** Worth reading for event vocabulary;
  adopting it while `TraceEvent` has exactly one consumer would be building a
  seam for a frontend that does not exist. Revisit if a second one does.

## Where this leaves the roadmap

Use cases **1, 3 and 4** are the near-term set, and they compound: the readable
view (1) is the substrate the `@` mentions in (4) point at, and both make the
grounded suggestions in (3) cheap to derive. (1) should be built *as* the
context-variables design rather than beside it. (2) is a UI change over a gate
that already exists and already has tests. (6) is small and independent. (5)
waits on (1). (7) is the largest and least urgent. (8) is an afternoon, and is
only worth doing with its editor visible from the start.

Nothing here needs a backend, a framework, or a dependency — which is the
useful conclusion of reading a framework you are not going to adopt.
