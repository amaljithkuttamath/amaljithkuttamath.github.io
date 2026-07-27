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
| `INDICATOR_MAP` | Already loaded in UI state — the name↔code table an autocomplete needs |

A fetch already produces a uniquely-keyed, provenance-carrying object. The
cache key `sp.dyn.le00.in|IND|2020:2020` *is* an identifier. What's missing is
a human-legible name for it, and a way to say that name from either side.

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

## In the composer

Typing `@` opens a picker over the session's bindings. On selection the token
becomes a **chip showing the human name, with the id underneath** — the chip is
what the user reads; the concrete id, countries and year range are what reach
the agent.

The chip is not decoration. It is the guarantee that what the user pointed at
and what the agent received are the same object — the same discipline as
citations rendering the upstream URL rather than our copy of it.

## What both sides can do with one

This is the "features" half — a variable is data *plus* the affordances that
come with knowing what it is.

- **Reference it** — "chart @g7_gdp against @g7_co2". No re-fetch: the cache
  key is the binding, so a referenced variable is a cache hit by construction.
- **Inspect it** — coverage, completeness, outliers, last broadly-reported year.
  This is `profile_series` on an existing binding rather than a fresh pull.
- **Derive from it** — any compute tool, with the new result bound to a new name
  and its provenance inherited.
- **Cite it** — a variable dereferences to its ledger entry, so anything built
  on it inherits a real citation rather than needing a new one.
- **Export it** — CSV of exactly those rows, already how the evidence table
  works.

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

1. **Does the agent see all bindings, or only referenced ones?** All of them is
   simpler and lets it notice "you already have this". But the binding list
   grows with the session and competes for context against the data itself.
   Leaning toward: names and shapes always, rows only on reference.
2. **What happens to a binding when its underlying fetch is superseded?** A
   snapshot-served variable and a live-fetched one for the same series are
   different objects with different provenance. Probably distinct bindings
   rather than a mutable one.
3. **Auto-naming collisions across sources** — `@life_exp` from World Bank and
   from WHO are different series with different definitions. The name must
   carry the source when both are active.
