# Chitti: context variables — named pointers to data

Status: design, not built. Written 2026-07-27.

## The idea

A conversation accumulates data. Right now that data is addressable only by
describing it again in prose ("the life expectancy numbers you pulled for
India"), and the agent re-resolves that description every turn. A **context
variable** gives it a name.

    @ind_life_exp     →  SP.DYN.LE00.IN, IND, 2000–2024, 25 rows, fetched 22:31, live
    @g7_gdp           →  NY.GDP.PCAP.CD, 7 countries, 1990–2024, 245 rows, snapshot 2026-07-27

Both sides use the same names. The user writes one in the composer to point at
data instead of re-describing it; the agent binds results to names as it works
and refers back to them. A name is not a label on a chat message — it is a
handle on a concrete, cited object.

## Why this is small

Almost all of the substrate exists.

| Piece | What it already does |
|---|---|
| `vfs.ts` | Named entries (`files: Record<string,string>`) with per-path provenance (`meta.derived`, `meta.via`), mirrored to the UI on every write |
| `fetchCache` | Keyed by `fetchCacheKey(id, codes, ys, ye)` — every distinct fetch is already a uniquely identified object holding `{rows, result, detail}` |
| citation ledger | One entry per distinct fetch, keyed by the same cache key, carrying `requestUrl`, `sourceUpdated`, `rowCount`, `mirroredAt` |
| `indicator_id` params | `growth_stats`, `correlate`, `breakdown` and `profile_series` already select their input by a free-form string matched against `rows[].indicator` |

A fetch already produces a uniquely-keyed, provenance-carrying object. The
cache key `sp.dyn.le00.in|IND|2020:2020` *is* an identifier. What's missing is
a human-legible name for it, and a way to say that name from either side.

That last row matters most: **the agent already addresses subsets of its data
by name.** `indicator_id` is a variable in everything but generality — it
selects by indicator alone, so two fetches of the same series with different
country sets or year windows collapse into one name and cannot be addressed
separately. Variables are the general form of a selector that already exists,
not a parallel mechanism bolted alongside it.

## Nothing is a fixed list

No part of this may lean on a bundled table of known indicators. The curated 50
in `tools.ts` are the fast path's vocabulary, not the app's: `find_series`
resolves across the whole World Bank catalogue plus OWID, IMF and WHO, and
`kb.json` alone now carries ~1,500 generated entries. A variable layer built on
a static name↔code map would silently cap the feature at whatever was compiled
in, and would break the moment a refresh widened the catalogue.

So a binding is created from **what was actually fetched**, whatever it was and
whichever source it came from. The id is whatever `find_series` returned and
`fetch_series` accepted, carried verbatim — the same rule the prompt already
enforces for ids. Nothing enumerates the space of possible variables ahead of
time, because the space is the union of four live APIs.

## What a variable is

A binding from a name to one of three things:

1. **A fetch** — the common case. Points at a `fetchCache` entry and, through
   the shared key, its citation. Carries: indicator id, countries, year range,
   row count, source, and whether it came from the live API or a dated
   snapshot.
2. **A computed result** — the output of `execute_js`, `growth_stats`,
   `correlate`, `breakdown`. Derived from fetched rows; provenance is the union
   of the fetches it consumed.
3. **A model-derived artifact** — anything from `llm()` when RLM is on, or a
   `write_file` with `derived=true`.

The three are not interchangeable, and that distinction is the whole safety
story (below).

## Naming

**Auto-bound on fetch.** The user should not have to declare a variable to get
one. Every successful `fetch_series` binds a name derived from the indicator
and its scope — deterministic, so the same fetch always gets the same name, and
collisions resolve by appending the distinguishing dimension (`@life_exp_ind`
vs `@life_exp_chn`).

**Agent-bound on compute.** When the agent produces a result worth referring
back to, it names it and says so in its reasoning, which already streams to the
user.

**User-renamable.** Auto names are functional, not pretty. Renaming is cheap
and makes a long session legible.

## How the agent uses them

The agent must be able to *use* a variable, not merely have one described to
it. Three mechanisms, in order of importance — and the first two add no new
tool at all.

The mechanism must be **generic or it does not scale**. A first draft of this
section listed the four tools that would learn to accept a variable name. That
is the wrong shape: it makes referencing a property of each tool, so every tool
written afterwards has to remember to support it, and the one that forgets is
not obviously broken — it just quietly ignores the reference. Eighteen cases in
`dispatch` today, and the feature would rot at the rate new ones are added.

So: **two seams, both in `dispatch` (`session.ts:778`), and no tool knows
variables exist.**

**Seam 1 — resolve on the way in.** Before the switch, walk the tool call's
arguments and replace any reference token with what it points at. Every `case`
below receives plain concrete values and is written exactly as it is today. A
new tool inherits referencing for free, by existing.

**Seam 2 — bind on the way out.** After the switch, any result that carried
rows registers a binding. Not "fetch and compute bind" — that is another list
that goes stale. The rule is structural: a tool returned data, so the data gets
a name. A new tool inherits binding for free too.

**What a reference resolves to.** One thing, uniformly: a **row selector** —
the (indicator, countries, year range) triple that the binding stands for.
Every compute tool here already filters `state.rows` down to a subset; today
that filter is by indicator alone, via `indicator_id`. Resolution hands them a
fuller selector through the same filtering path. So there is no per-parameter
type dispatch, no "this argument wants an id but that one wants rows" — one
token, one selector, one shared filter. `execute_js` is the exception only in
that it receives the selected rows directly, since it already receives `rows`.

This is why the general form matters. `correlate(indicator_a: "NY.GDP.PCAP.CD",
indicator_b: "EN.ATM.CO2E.PC")` silently correlates across whatever countries
happen to be in `rows` for each. `correlate(indicator_a: "@g7_gdp",
indicator_b: "@g7_co2")` correlates two *stated* sets, and the answer can say
which. Same tool, unmodified.

**Backwards compatible by construction.** A string that names no binding falls
through untouched and matches by indicator exactly as today, so every existing
call keeps working and every existing test keeps passing.

**How the agent learns a name.** From the result of the call that created it —
a successful `fetch_series` reports the name it bound alongside the row count.
No lookup tool, no environment preamble, nothing to keep in sync. Renaming is
the only variable-specific verb, and it is optional.

**Why the single seam is a safety property, not just tidiness.** Provenance has
to survive every dereference (below). With per-tool support, a tool author who
forgets to carry the `derived` flag launders model-derived numbers into a cited
chart. With resolution and binding in one place each, no tool author is in a
position to forget, because none of them touch it.

## In the composer

Typing `@` opens a picker over **the session's live bindings** — what this
conversation has actually fetched and computed, nothing else. Not a catalogue
browser: pointing at a series the session has never touched is not a tag
problem, it is just asking a question, and `find_series` already does that
across every active source. Keeping the picker to real bindings is what stops
this from needing a fixed list at all.

On selection the token becomes a **chip showing the human name, with the id
underneath** — the chip is what the user reads; the concrete id, countries and
year range are what reach the agent.

The chip is not decoration. It is the guarantee that what the user pointed at
and what the agent received are the same object — the same discipline as
citations rendering the upstream URL rather than our copy of it.

## What both sides can do with one

This is the "features" half — a variable is data *plus* the affordances that
come with knowing what it is.

**The set of actions is not enumerated anywhere, and must not be.** A fixed
menu of verbs is the same mistake as a fixed list of tools, one layer up: it
would need extending every time the agent gains a capability. What a variable
can be acted on by is simply *every tool*, present and future, because seam 1
resolves references before any tool runs. The list below is what that yields
today — a consequence, not a catalogue.

- **Reference it** — "chart @g7_gdp against @g7_co2". No re-fetch: the cache
  key is the binding, so a referenced variable is a cache hit by construction.
- **Inspect it** — coverage, completeness, outliers, last broadly-reported year.
  This is `profile_series` on an existing binding rather than a fresh pull.
- **Derive from it** — any compute tool, with the new result bound to a new name
  by seam 2 and its provenance inherited.
- **Cite it** — a variable dereferences to its ledger entry, so anything built
  on it inherits a real citation rather than needing a new one.
- **Export it** — CSV of exactly those rows, already how the evidence table
  works.

Add a tool tomorrow and it can act on every existing variable without being
told they exist. That is the test of whether this is generic: if a new
capability needs code to participate, the design has failed.

## The constraint that matters

**A variable carries its receipt, and derived never launders into fetched.**

The VFS already separates these with `meta.derived` / `meta.via`, and the app's
existing rule is that model-derived content is never cited, never charted as if
measured, and never enters the evidence table. Variables must preserve that
across every dereference, including transitively: a result computed from a
model-derived variable is itself model-derived.

The failure this prevents is specific and severe. Bind an `llm()` output to
`@trend_labels`, reference it three turns later, and if the binding has lost its
`derived` flag the app will chart model-invented values with a citation
underneath. That is precisely the dishonesty this codebase is built to avoid,
and it is exactly the kind of thing a naming layer makes easy to do by
accident. The tests for this feature should be provenance tests first and
ergonomics tests second.

Second constraint, smaller: **a variable is session-scoped and dies with the
session**, unless it is pinned to a dashboard — which is the existing mechanism
for "keep this", already cited and already shareable. Variables should not grow
a parallel persistence story.

## Out of scope for v1

- **Arithmetic on variables** (`@a / @b`). Compute tools already do this, and a
  little expression language in the composer is a large surface for a small
  gain.
- **`@tool` tags.** Forcing a specific tool lets a user push the agent into an
  analysis the data doesn't support, presented with the same confidence as a
  good one.
- **`@source` tags.** The source list is a hard filter — the system prompt is
  assembled only from active sources, so the agent is never told an inactive one
  exists. A chat tag that silently widens that set breaks a deliberate
  withholding property. Narrowing within the enabled set is safe and could come
  later; enabling belongs in the panel where it is visible.
- **Cross-session variables.** See the dashboard note above.

## Open questions

1. ~~Does the agent see all bindings, or only referenced ones?~~ **Resolved by
   mechanism 2.** Names arrive in the tool results that created them, so the
   agent knows a binding exists because it made it. Nothing needs to enumerate
   the environment into context each turn, and there is no list to keep in
   sync. Rows are pulled only when a binding is actually referenced.
2. **What happens to a binding when its underlying fetch is superseded?** A
   snapshot-served variable and a live-fetched one for the same series are
   different objects with different provenance. Probably distinct bindings
   rather than a mutable one.
3. **Auto-naming collisions across sources** — `@life_exp` from World Bank and
   from WHO are different series with different definitions. The name must
   carry the source when both are active.
