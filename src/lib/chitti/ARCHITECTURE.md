# Chitti — library architecture (Phases A + B)

Chitti is a browser-run data-analyst agent: it fetches real numbers live from
free institutional APIs (World Bank, Our World in Data, IMF DataMapper, WHO GHO),
computes over them, renders a chart, and verifies the answer. This document maps
the `src/lib/chitti/` modules, the source-adapter interface, the layering rules,
and how to add a new data source. Optional Jev routing and review use a hosted
relay; planning, computation, and the workspace remain in the browser.

The page mounts one React workspace. The browser engine emits AG-UI events;
A2UI v0.9 surfaces render only registered analysis and clarification components.
There is no required server or arbitrary generated UI code.

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
| `okf.ts` | `buildFindingOkf` — export one answer as an Open Knowledge Format (OKF) v0.1 Markdown concept (front matter + citations as links). Pure. Copied via the turn's "Copy Markdown" action (`Workspace.tsx`). |
| `abort.ts` | `AbortedError` — the user-cancel sentinel (loop + refresh pipeline). |
| `dashboards-agent.ts` | Agent-side dashboard glue: `resolveTileRef`, the session-less refresh pipeline (`refreshDashboard`/`refreshTile`/`refetchCitation`), `buildCitation`, `indicatorName`, `defaultDashboardTitle`. |
| `session.ts` | **The session core**: `createSession` + its per-turn closures (`ask`/`agentPass`/`dispatch`/`routeFetch`/`runSubAgent`/`makeLlm`/`runPlan`/`runVerify`), session state, session types (`ChittiSession`/`SessionOptions`/`AgentCallbacks`/`AgentOutput`), `runAgent`, `buildRejectionSteer`. |
| `agent.ts` | **Facade** — re-exports `./session` + every split-out module. |

Unchanged, already-scoped modules: `providers.ts`, `countries.ts`, `chart-link.ts`,
`chart-format.ts`, `share.ts`, `codec.ts`, `dashboard.ts`, `dashboard-share.ts`,
`sw-cache.ts`, `a11y.ts`.

### Workspace and protocol layers

| Module | Responsibility |
| --- | --- |
| `workspace/agent.ts` | `AbstractAgent` adapter: runs, state snapshots, text, A2UI custom events, cancellation, and input replies. Provider credentials remain private configuration. |
| `workspace/model.ts` | Whitelisted result surfaces, clarification payloads, analysis state and safe source URLs. |
| `components/chitti/Workspace.tsx` | One request/change/result thread; inline steering, undo/redo, history, configuration, sharing and exports. |
| `components/chitti/Surface.tsx` | Official A2UI processor and React renderer, with a two-component catalog. Replies dispatch A2UI actions into the waiting agent tool. |
| `components/chitti/Result.tsx` | Finding, chart/data/source tabs and honest verification status. |
| `components/chitti/Chart.tsx` | Lazy bundled ECharts, theme/resize lifecycle and cleanup. No CDN runtime. |
| `components/chitti/Settings.tsx` | Provider, model, source scope and optional per-tab key storage. |
| `components/chitti/Dashboards.tsx` | Existing local dashboard schema, pinning, imports, exports, shared snapshots and refresh. |
| `ui/dom.ts`, `ui/chart-option.ts` | Retained pure formatting/chart helpers. The old DOM bootstrap and mutable UI globals are retired. |

`/apps/chitti/catalog.json` publishes the renderer's actual catalog. AG-UI is
currently an in-process adapter, not an HTTP agent endpoint. A2UI result surfaces
carry sanitized JSON strings; the catalog never accepts HTML or executable code.
`request_input` pauses the current in-memory run, accepts a matching request ID,
and rejects on Stop. It is not a durable checkpoint across page reloads.

A rendered chart now emits an evidence-bearing draft immediately through `onPreview`,
before the final finding and verification. Repeated A2UI updates reuse the surface
processor so the current tab and filter stay open. Drafts carry no verification.

The result's focus and recent-period controls dispatch A2UI actions into AG-UI
runs. They change the chart using recorded values, retain the full source rows
and timestamps, and discard the old conclusion/verdict. Each revision links back
to its exact parent view. The workspace shows a deterministic difference summary
next to Undo, Redo and Steer. Undo/redo restores snapshots without rerunning the
agent; starting a new branch clears redo but keeps the old branch in History.
The single composer uses the restored view as its context. Earlier turns and
exports are collapsed, and running input requests/errors stay beside the result. Chart clicks have the same focus action as the keyboard
accessible selector. Questions sent from a result seed a new engine session with
that selected chart, rows and citation ledger; the engine reads `workspace.csv`,
`workspace-view.json`, and `citations.json`. A fresh pull replaces overlapping
recorded rows. The composer can detach from the current view for a fresh query.
There is still no durable background agent or remote workspace service.

Tests cover the actual protocol processor/action round trip, follow-up routing,
key-free source filtering, stop-before-start and stop-while-waiting, credential
exclusion, and the real session's input-tool continuation with a stubbed model.

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

## Optional Jev assist

`jev.ts` supplies bounded typed dataset selection and evidence review, enabled through Connect → Model & databases. `SessionOptions.jev` injects the configured relay and optional fetch dependency. A new client is created per turn, sharing a two-route/two-review budget across parent and delegated tool calls. Existing direct answers do not invoke it.

After `find_series`, Jev can promote one of the first eight hits; source restrictions and the remaining hit set are preserved. Its separate receipt does not rewrite the lexical retrieval evidence. For chart turns, Jev replaces the final generative verifier with five independent evidence checks over actual rows, chart points, and citation metadata. Thresholds are explicit policies, not calibrated confidence. All supplied rows are sent or the review reports unavailable; there is no silent sampling.

Fixed task definitions in `src/data/jev/chitti-tasks.json` are shared by the Cloudflare Worker and local Python relay. The public service uses the existing shared hard quota and private TypeSafe secret. This opt-in path sends the disclosed analysis material to the hosted relay; API credentials, VFS files, and conversation history are excluded. `verifyEngine` receipts and the optional `engine` verdict field preserve attribution through UI and answer exports.
