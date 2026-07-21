# Chitti — library architecture (Phases A + B)

Chitti is a browser-only data-analyst agent: it fetches real numbers live from
free institutional APIs (World Bank, Our World in Data, IMF DataMapper, WHO GHO),
computes over them, renders a chart, and verifies the answer. This document maps
the `src/lib/chitti/` modules, the source-adapter interface, the layering rules,
and how to add a new data source.

Phase A was a **behavior-identical** refactor: the former monoliths `tools.ts`
(~1840 lines) and `agent.ts` (~2535 lines) were split by responsibility into
focused modules. `tools.ts` and `agent.ts` are now thin **re-export facades** —
every prior `import { … } from './tools'` / `'./agent'` still resolves, and the
full test suite passes unmodified.

Phase B was the same kind of refactor for the **UI monolith**: the single
~3740-line client `<script>` in `src/pages/apps/chitti.astro` was split into
`src/lib/chitti/ui/` modules behind a thin bootstrap. The `.astro` file now keeps
only its markup, CSS, the PWA-registration inline script, and one
`<script>import '../../lib/chitti/ui/boot';</script>`. Everything moved verbatim —
only import/export plumbing changed — so the page renders pixel-equivalently and
the 472 tests pass unmodified. See the **UI layer** section below.

## Module map

### Data / source layer (`sources/` + siblings)

| Module | Responsibility |
| --- | --- |
| `scoring.ts` | The one weighted relevance scorer (`explainMatch`/`scoreSeries`) + synonym/stopword tables. Pure. |
| `vfs.ts` | The agent's in-memory virtual filesystem (`VFS`, `FileMeta`). |
| `execute-js.ts` | The `execute_js` sandbox (`executeJs`) + the recursive-LM primitive type `LlmFn`. |
| `csv.ts` | CSV read (`parseCsvLine`) + write (`rowsToCSV`). |
| `schemas.ts` | `TOOL_SCHEMAS`, `RETURN_FINDINGS_SCHEMA`, `CORE_TOOL_NAMES`. |
| `sources/types.ts` | **The `SourceAdapter` interface** (documented below) + the shared `Dataset`/`SeriesHit`/`SearchReceipt`/`SourceDef`/`FetchSeriesResult`/`CatalogEntry` shapes. |
| `sources/worldbank.ts` | The World Bank adapter: fetchers (specific + every-country batched), date-param builder, 200-with-error-body parser, primary indicator search. |
| `sources/owid.ts` | The Our World in Data adapter: curated grapher catalog, CSV fetcher, live-catalog parse/fetch/search. |
| `sources/imf.ts` | The IMF DataMapper adapter: curated code catalog, JSON fetcher, live-catalog parse/fetch/search. |
| `sources/who.ts` | The WHO GHO adapter: curated IndicatorCode catalog, OData fetcher, live-catalog parse/fetch/search. |
| `sources/index.ts` | **The registry** (`SOURCES` = the adapter list) + the generic cross-source ops: `findSeriesWithReceipt`, `searchDatasets`, `datasetName`, `resolveSources`, `schemasForSources`, `subAgentSchemasFor`, `datasetSourcesFor`, `sourcesByCategory`, and the id→source router helpers (`adapterOfId`/`adapterById`/`sourceOfId`). |
| `tools.ts` | **Facade** — re-exports all of the above, plus the still-local core types (`Country`/`Indicator`/`DataRow`/`ChartSpec`/`Citation`), `COUNTRIES`/`INDICATORS`/`TOPICS`, `ApiRejection`, `listCountries`, `growthStats`/`correlate`, and the citation helpers. |

### Agent layer

| Module | Responsibility |
| --- | --- |
| `parse-json.ts` | `extractJsonObject` — shared JSON-from-prose extractor (planner + verifier). |
| `budgets.ts` | The per-turn hard budgets (tool-call cap, RLM caps + data cap, delegation bounds). |
| `receipts.ts` | The `TraceEvent` type — one streamed line-item in the live receipt/timeline. |
| `prompts.ts` | `buildSystemPrompt` / `buildSubAgentPrompt`. |
| `planner.ts` | The gated planner heuristic (`needsPlan` + helpers, `countCountryMentions`), `parsePlanBrief`, `matchStepToEvent`, `PlanStep`/`InsightBrief`. |
| `verifier.ts` | `verify` (the second-LLM check) + `parseVerifierVerdict` + verdict types. |
| `spec.ts` | `normalizeSpec` — guard a model chart spec into a valid `ChartSpec`. |
| `abort.ts` | `AbortedError` — the user-cancel sentinel (loop + refresh pipeline). |
| `dashboards-agent.ts` | Agent-side dashboard glue: `resolveTileRef`, the session-less refresh pipeline (`refreshDashboard`/`refreshTile`/`refetchCitation`), `buildCitation`, `indicatorName`, `defaultDashboardTitle`. |
| `session.ts` | **The session core**: `createSession` + its per-turn closures (`ask`/`agentPass`/`dispatch`/`routeFetch`/`runSubAgent`/`makeLlm`/`runPlan`/`runVerify`), session state, session types (`ChittiSession`/`SessionOptions`/`AgentCallbacks`/`AgentOutput`), `runAgent`, `buildRejectionSteer`. |
| `agent.ts` | **Facade** — re-exports `./session` + every split-out module. |

Unchanged, already-scoped modules: `providers.ts`, `countries.ts`, `chart-link.ts`,
`chart-format.ts`, `share.ts`, `codec.ts`, `dashboard.ts`, `dashboard-share.ts`,
`sw-cache.ts`, `a11y.ts`.

### UI layer (`ui/`)

The browser client. Every module is loaded (transitively) by the single
`<script>` in `chitti.astro`, which does nothing but `import './boot'`. These
run in the browser only; the lib layers above are shared with the test suite.

| Module | Responsibility |
| --- | --- |
| `ui/dom.ts` | Pure DOM/string helpers: `$`/`q`, `esc`/`escapeHtml`/`inlineMd`/`mdToHtml`, `cssVar`, `prefersReducedMotion`, the `format*`/`fmt*` formatters, `fileExt`. No state. |
| `ui/chart-option.ts` | `buildOption` — the pure `ChartSpec → ECharts option` builder (theme via `cssVar`, formatting via `chart-format`). |
| `ui/state.ts` | **The one shared-state module**: all DOM element handles, the per-turn `TurnBlock` interface, the live-chart registries (`allTurns`/`liveChartTurns`/`liveDashCharts`), the `dashStore` localStorage handle, `INDICATOR_MAP`, and the run-lifecycle scalars as a shared `run` object (`session`/`running`/`runController`). |
| `ui/trace.ts` | `renderTrace` + the plan card, verify stamp, nested-receipt cards, panel summary, and inline `write_file` rows (`renderFiles`). |
| `ui/charts.ts` | ECharts lifecycle: `loadECharts` (CDN import cache), `renderChart`, the chart↔table linking glue, and the theme/resize observers (registered on import). |
| `ui/evidence.ts` | The data table (+ chart↔row hover), citations ledger, confidence-tinted finding, verification cue, running token/cost total. |
| `ui/actions.ts` | Answer-share permalink build + clipboard (`shareTurn`/`buildShareUrl`/`writeClipboard`/`copyToClipboard`), shared by the turn UI and the dashboards copy paths. |
| `ui/turns.ts` | `createTurnBlock` (clones the turn template, wires CSV/share/pin), `setStatus`, `renderQuestion`. |
| `ui/config.ts` | Config-sheet logic: provider/model pickers, key field, source picker, RLM toggle, sheet open/close + focus trap. Owns `sourcesLocked`/`modelPickAll`/`RLM_HINT_DEFAULT`/`vv`. Its event listeners stay in `boot.ts`. |
| `ui/dashboards-view.ts` | Pin picker, dashboards grid + detail view, tile cards, refresh log, share/export/import, read-only shared-dashboard render. Owns its private state (`currentDashId`/`sharedDashState`/`pinContext`/…); exposes `syncDashboardsAfterTurn`/`resetSharedDashState` so `boot` never reaches into it. |
| `ui/restore.ts` | Restore-on-load: `#share=` answer and `#dash=` dashboard fragments + their invalid-link error states, driving the app's own render path. |
| `ui/composer.ts` | The run flow: `handleAskSubmit` (turn creation → `session.ask` streaming → stop control → terminal-state rendering) and the "+ new question" two-step reset. Owns the `newQuestion*` state. |
| `ui/debug-seam.ts` | `installDebugSeam()` — the `?chittidebug` `__chittiDebug` test seam (render/dashboard/stop hooks). Render helpers only; screenshot harnesses depend on it. |
| `ui/boot.ts` | **The bootstrap**: imports the modules, registers every top-level DOM event listener (config sheet, provider/model, sources, dash nav, composer, new-question), runs the init sequence (`maybeRestoreFromFragment`, `updateDashNavCount`, `installDebugSeam`), in the same order the monolith did. No render/agent logic of its own. |

## UI layering (bottom → top), and no cycles

```
state.ts (els + TurnBlock + run + registries)   dom.ts   chart-option.ts
  trace · actions · charts · config · evidence
    turns · dashboards-view
      restore · composer
        debug-seam
          boot.ts   (wiring + init only)
```

Rules that keep the UI layer honest:

- **State lives in exactly one module.** `state.ts` owns every piece of
  cross-module mutable/shared state. Reassigned scalars are properties of the
  exported `run` object (an ESM `let` binding can't be reassigned by an importer,
  so the object gives every module a live read/write handle without a `window`
  global). The registries (`allTurns`, …) are exported `const` arrays mutated in
  place. The only browser global is `window.__chittiDebug`, exactly as before.
- **Module-private state stays private.** `config` owns `sourcesLocked` (boot
  reads it live via the ESM binding, never writes it); `dashboards-view` owns
  `currentDashId`/`sharedDashState` and exposes `syncDashboardsAfterTurn`/
  `resetSharedDashState` accessors rather than letting `boot` touch them;
  `composer` owns `newQuestion*`.
- **Cross-module function calls form cycles** (e.g. `turns → actions`,
  `charts ⇄ evidence` via the hover glue, `restore → {turns, charts, evidence,
  trace, dashboards-view}`). ESM tolerates them because every reference is inside
  a function body, evaluated only when the user acts — never at module-init time.
- **`boot.ts` is the composition root**: it imports downward and is imported by
  nothing. It holds the event-listener *registrations* (so their order is
  byte-for-byte unchanged) while the handler *bodies* live in the topical modules.
- **Astro style scoping**: JS-built DOM is outside Astro's component-style scope,
  so the CSS in `chitti.astro` already targets it via `:global(...)` — an
  established pattern that the split preserves (moving JS out of the `.astro`
  script changes nothing here, since bundled scripts were never style-scoped).

## The `SourceAdapter` interface (`sources/types.ts`)

Every data source implements one `SourceAdapter`. The router (`routeFetch`), the
cross-source search (`findSeriesWithReceipt`), and citation-building are all
**generic over this interface** — there is no per-source `switch`/`if` chain left
in any of them. Key members:

- **Registry/UI metadata** (extends `SourceDef`): `id`, `label`, `category`,
  `blurb`, `toolNames`, `promptSnippet`, `cite`, `datasetSource?`.
- **Citation identity**: `citationSource`, `sourceLabel`, `humanUrl(id)`.
- **Id namespace**: `matchesId(id)` (owns `owid:`/`imf:`/`who:` prefixes; World
  Bank owns bare, colon-free codes), `normalizeId(id)` (the citation "nid").
- **Search**: `curated` (catalog entries), `usesSharedCatalog`,
  `primarySearch?(q)` (World Bank's curated+live-API search), `liveCatalogSearch?(q)`.
- **Id-space guard**: `openIdSpace` (World Bank proceeds on an unknown id, marked
  "unverified"; catalog sources refuse), `idLabel`, `hasCuratedId(id)`.
- **Fetch + describe**: `fetchSeries(id, countries, ys, ye, signal) → FetchSeriesResult`,
  `reportsBatches`, `detailSuffix(result)`, `indicatorLabel(nid, result)`.

`FetchSeriesResult` = `{ rows, requestUrl, sourceUpdated?, truncatedFrom?,
countryCount?, batchCount?, metric? }` — the union of what any source's fetch
reports; the router reads the optionals when present.

## Layering (bottom → top), and no cycles

```
JSON data · providers · countries · codec
  scoring · vfs · execute-js · csv · schemas · parse-json · budgets
    sources/types            (SourceAdapter + shared shapes)
      sources/{worldbank,owid,imf,who}   (import ApiRejection/COUNTRIES/INDICATORS
                                          from tools ONLY inside functions)
        sources/index         (registry + generic search/routing)
          tools.ts            (facade + remaining core types/consts/helpers)
    receipts · prompts · planner · verifier · spec · abort
      dashboards-agent
        session.ts            (createSession + closures)
          agent.ts            (facade)
```

Rules that keep it acyclic:

- Shared **types** sit at the bottom (`sources/types.ts`, the core types still in
  `tools.ts` are imported *type-only* by the source files — erased at build, no
  runtime edge).
- The source adapter files import `tools.ts` runtime values (`ApiRejection`,
  `COUNTRIES`, `INDICATORS`) **only inside function bodies**, never at module
  top-level. So although `tools.ts ⇄ sources/*` is a static cycle, nothing reads
  a not-yet-initialized binding during evaluation — the vitest/vite import graph
  (which evaluates every module) is green.
- `session.ts`/`agent.ts` sit at the top; nothing below imports them.

## Adding a data source (the invariant)

Adding a fifth source touches **only a new adapter file + one registry line**:

1. Create `sources/<newsource>.ts`: move/author the source's fetcher, curated
   catalog, any live-catalog search and error parsing, and export a
   `SourceAdapter` object (see `owid.ts` as the closest template for a
   catalog-style source, or `worldbank.ts` for a primary-search source).
2. Append the adapter to `SOURCES` in `sources/index.ts`.

That is all. The picker (grouped by `category`), `find_series` (primary search →
shared catalog → live fallback), `fetch_series` routing, the id-space guard,
citations, and the CSV/evidence UI all pick the new source up automatically,
because every one of them iterates the registry rather than naming sources.

If the source needs its own bespoke tool, add its schema to `schemas.ts` and list
it in the adapter's `toolNames`; otherwise the source-agnostic core tools suffice.

## Codec adoption note

The verifier's verdict parsing (`parseVerifierVerdict`) and the planner's brief
parsing (`parsePlanBrief`) keep their exact bespoke semantics and were **not**
forced onto `codec.ts` — doing so would change observable parsing behavior. They
share the same defensive discipline (`extractJsonObject` in `parse-json.ts`);
that shared helper is the cross-reference, which is enough.
