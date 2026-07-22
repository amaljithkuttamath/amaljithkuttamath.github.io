---
name: chitti-data-sources
description: >-
  How Chitti queries its data and builds charts — the full agent pipeline
  (find_series → fetch_series → compute → render_chart → finish), the four data
  sources (World Bank, OWID, IMF, WHO) with their id namespaces and code
  formats, country/year parameters, chart types, dashboards, and the query
  gotchas. Use when working on, debugging, or extending Chitti's data querying or
  charting under src/lib/chitti (e.g. "why did find_series return the wrong
  series", "how do OWID ids work", "which chart type", "add a data source").
---

# Chitti — querying the data & building charts

Chitti is a browser-only data-analyst agent: it fetches real numbers live from
free institutional APIs, computes over them, renders a chart, and verifies the
answer. Everything runs client-side (BYOK, zero backend). This skill is the
authoritative reference for the **query + chart** surface. Module structure lives
in [`src/lib/chitti/ARCHITECTURE.md`](../../../src/lib/chitti/ARCHITECTURE.md);
this is the *how to use it* companion.

> Chitti's runtime agent (the LLM in the browser) does **not** consult skills —
> it acts through **function-call tools** driven by its system prompt
> (`src/lib/chitti/prompts.ts`). This skill is for **coding agents** working on
> Chitti, and is the canonical source the system prompt is kept in sync with.

## The pipeline (≈4–5 tool calls per answer)

```
find_series(query)      → pick an id            (search ALL active DBs at once)
fetch_series(id, …)     → rows                  (routes to the right source by id)
growth_stats|correlate|execute_js → computed result
render_chart(spec)      → the chart
finish(one_line_finding)                        (or finish_explanation for prose)
```

Conceptual questions ("what does X mean", "why does Y matter") skip the pipeline
and call **`finish_explanation`** directly — no chart. Hard budget:
`MAX_TOOL_CALLS` (14) per turn; never re-fetch data already held.

## The two core tools

### `find_series(query)`
The single entry point. Searches **every active database at once** and returns
`[{ id, name, source }]`. Pick the id that fits and pass it verbatim to
`fetch_series`. You never choose a database first — the results tell you which
source has the series.

- Ranking is a weighted keyword/synonym scorer (`scoring.ts`), not embeddings.
- Querying an **exact indicator code** (e.g. `NY.GDP.PCAP.KD`) resolves that code
  authoritatively and floats it to the top — it won't be buried under fuzzy
  token matches.

### `fetch_series(id, countries?, year_start?, year_end?)`
One fetch tool, **routed by the id's namespace** (no per-source tool). Returns
rows of `{ country, iso3, year, value, indicator }`.

**Argument synonyms are accepted** (weak models mis-key these — `resolveFetchArgs`
in `session.ts` normalizes them):

| Canonical | Also accepted |
| --- | --- |
| `id` | `indicator`, `indicator_id`, `series`, `series_id`, `code`, `dataset_id`, `slug` |
| `countries` | `country`, `country_ids`, `iso3` (a bare string is wrapped to `[string]`) |
| `year_start` | `start_year`, `from`, `start` |
| `year_end` | `end_year`, `to`, `end` |

## The four data sources

| Source | `id` namespace | Category | Covers | Example ids |
| --- | --- | --- | --- | --- |
| **World Bank** | **bare code, no colon** | Economics & development | Broad default: development, economic, health & social indicators, every country | `NY.GDP.PCAP.CD`, `SH.DYN.MORT`, `SP.POP.TOTL`, `FP.CPI.TOTL.ZG` |
| **Our World in Data** | `owid:<slug>` | Society & environment | Topics WB lacks: CO₂/energy, happiness, HDI, literacy, extreme poverty | `owid:life-expectancy`, `owid:child-mortality` |
| **IMF DataMapper** | `imf:<code>` | Economics & development | Macro **with multi-year forecasts**: GDP growth, inflation, debt, unemployment | `imf:NGDP_RPCH`, `imf:PCPIPCH`, `imf:GGXWDG_NGDP` |
| **WHO GHO** | `who:<IndicatorCode>` | Health | Detailed health: mortality/HALE, immunization, NCD burden, disease incidence | `who:WHOSIS_000015`, `who:MDG_0000000007` |

Routing (`matchesId`): an id **with a colon** goes to the prefix's source
(`owid:`/`imf:`/`who:`); a **colon-free** id is World Bank's. When more than one
source fits a query, **prefer World Bank**; reach for WHO on specifically
health/disease questions and IMF when the question wants **forecasts/projections**
(say "IMF projection" when you use projected years).

### Open vs closed id-space (a key gotcha)
- **World Bank is an OPEN id-space** (`openIdSpace: true`): its live id space is
  far larger than the curated `indicators.json`, so an **unknown WB code still
  fetches**, marked *"unverified id"* in the receipt. If the WB API then rejects
  it, the error is translated into a `find_series` steer.
- **OWID / IMF / WHO are CLOSED catalogs**: an id that is neither in the curated
  catalog nor a recent `find_series` hit is **refused** with a `find_series`
  steer (it would 404). So always take catalog-source ids from `find_series`.

## Countries

Resolved once at the fetch choke point (`routeFetch` → `resolveCountryList`):

- **ISO3 codes** (`USA`, `CHN`, `IND`), **loose names** (`UK`, `Korea`, `euro
  area`) resolved to codes, or **one aggregate** (`WLD` = world, plus OECD/region
  sets via `list_countries`).
- **Omit `countries`, or pass `[]`, for "every country"** — World Bank batches
  all ~195 internally; never build the full list yourself. (`[]` and *omitted*
  are equivalent across all four sources.)
- Unresolvable tokens are **dropped** (never sent as junk); if *nothing* resolves
  yet countries were requested, you get a clean error listing what was dropped —
  no API call is made.
- **OWID aggregate caveat:** OWID codes aggregates as `OWID_*` (world =
  `OWID_WRL`), not the WB `WLD`. Filtering an OWID series by `["WLD"]` matches
  nothing — omit countries for the world series, or use the OWID code.

## Years

`year_start` / `year_end` are **numbers**. Omit either (or pass `null`) for "no
bound" — a `null` is treated as *no bound*, never year 0. World Bank fills an
open side with its own defaults (≈1960 → current year); a missing pair sends no
date filter at all.

## Compute (never rank/diff in prose — one call)

| Tool | Use for | Args |
| --- | --- | --- |
| `growth_stats` | "changed the most/least" — per-country change, %, CAGR, **pre-sorted** | `indicator_id?` |
| `correlate` | relationship between **two** fetched indicators | `indicator_a`, `indicator_b` (ids as stored on rows) |
| `execute_js` | anything else; `rows` = every fetched row `{country, iso3, year, value, indicator}` | `code` |

(With RLM enabled, `execute_js` may `await llm(prompt, dataSlice)` for bounded
*semantic* work over rows — labelling/classifying/summarizing. Its output is
**model-derived, never a data value** — don't chart or cite it.)

## Charts — `render_chart(spec)`

The call's arguments **are** the spec (`ChartSpec`). Build them from the compute
step's result; the model produces the data points, `normalizeSpec` guards them.

```
render_chart({
  type:   'line' | 'bar' | 'scatter' | 'grouped-bar',   // required
  title:  string,                                         // required
  x_axis?: string,
  y_axis?: string,
  series: [{ name: string, data: [[x, y], …] }]           // required
})
```

- **`data` is an array of `[x, y]` pairs.** `x` = **year** (number) for
  `line`/`scatter`, or a **category label** (string) for `bar`. `y` is numeric.
- Pick the type by shape of the answer:

| Type | Use when | x |
| --- | --- | --- |
| `line` | a **time series** (value over years) | year |
| `bar` | a **ranking / single-year comparison** across countries | category label |
| `scatter` | a **relationship between two indicators** (one point per country) | indicator A value |
| `grouped-bar` | a **few countries compared side by side** across categories | category label |

Spec-guarding to know (`spec.ts` `normalizeSpec`): non-numeric `y` points are
**dropped as gaps** (a `null`/`""` is a gap, **not** a false zero); string years
are coerced to numbers; category-label x stays a string. Number formatting on
axes/tooltips lives in `chart-format.ts`.

## Finish

- `finish(one_line_finding)` — ends a **data** turn: 1–2 sentences of **insight**
  (top-line number, then what's notable — the outlier/trend break/implication).
  Not a caption; no methodology, no caveats. A chart must have been rendered.
- `finish_explanation(explanation)` — ends a **conceptual** turn with markdown
  prose, no chart.

After a data turn a second LLM **verifies** the chart answers the question
(`verifier.ts`); the answer carries an honest `verified / not verified /
unavailable` state — never a defaulted pass.

## Dashboards & export (user-initiated only)

- `save_to_dashboard(dashboard_title?, tile_title?)` — pin the just-rendered
  chart (its spec + data + citations) to a saved dashboard. A dashboard holds
  **many** tiles of **mixed** chart types; the only cap is ~200 KB per dashboard
  (localStorage). **Only when the user asks to save/pin.**
- `edit_dashboard(dashboard_title, action, tile_title|tile_index)` — rename,
  remove/reorder a tile, or refresh a dashboard's data. **Only when asked.**
- Each answer also offers **"Copy Markdown"** — an OKF v0.1 export
  (`okf.ts::buildFindingOkf`): front matter + citations as links.

## Multi-database questions

`delegate_source(source, question)` runs a focused **depth-1 sub-agent** against
**one** database and returns a distilled summary; its rows merge back with
citations intact. Use it **only** when a question genuinely spans multiple
databases (delegate each source's slice, then combine) — for anything one
database answers, use the direct tools (delegation costs extra model calls). Not
available in a single-source session.

## Error steers (what they mean)

| Message | Cause → fix |
| --- | --- |
| `unknown <source> id "…"` | closed-catalog id not from `find_series` → call `find_series` first |
| `API rejected id (unverified id)` | open-space WB code the API refused → `find_series` for a valid code |
| `cannot route "…" — namespace not recognized` | id has an unknown prefix → use a real `find_series` id |
| `none of the requested countries could be resolved` | all country tokens junk → use ISO3 / real names / an aggregate |
| `"…" is a <source> series, not available …` | out-of-session/out-of-sub-agent source id → use an id from the allowed sources |

## Adding a new source (the invariant)

One new adapter file + one registry line — the picker, `find_series`,
`fetch_series` routing, citations, and the CSV/evidence UI all pick it up because
they iterate the registry. Implement the **`SourceAdapter`** interface
(`sources/types.ts`); append it to `SOURCES` in `sources/index.ts`. See
`ARCHITECTURE.md` § "Adding a data source" and `owid.ts` (catalog-style) or
`worldbank.ts` (primary-search) as templates.

## Where this maps in code

| Concern | File |
| --- | --- |
| System prompt (the agent's live guidance) | `prompts.ts` |
| Tool schemas | `schemas.ts` |
| The loop / dispatch / routing / arg-synonyms | `session.ts` (`resolveFetchArgs`, `routeFetch`) |
| Source adapters | `sources/{worldbank,owid,imf,who}.ts` |
| Registry + cross-source search | `sources/index.ts` (`findSeriesWithReceipt`) |
| Relevance scoring | `scoring.ts` |
| Chart spec guard / build / format | `spec.ts`, `ui/chart-option.ts`, `chart-format.ts` |
| Verification | `verifier.ts` |
| Markdown/OKF export | `okf.ts` |

Keep this skill and `prompts.ts` in sync: when the query/chart contract changes,
update **both**.
