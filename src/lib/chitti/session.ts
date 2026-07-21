// session.ts: the deep-agent session core — createSession and its per-turn
// closures (ask/agentPass/dispatch/routeFetch/runSubAgent/makeLlm/runPlan/
// runVerify), the session state, budgets, and the session-facing types. These
// nested functions share turn-scoped mutable state via closure capture, so they
// stay together as one cohesive unit. The pure, session-independent pieces live
// in sibling modules (prompts/planner/verifier/spec/receipts/dashboards-agent),
// imported here. agent.ts is a thin re-export facade over this module + those.
//
// Originally the deep-agent loop, ported from the langchain-ai/deepagents
// pattern to browser JS. A single top agent calls tools until it calls
// `finish`; a second LLM call then verifies the chart answers the question,
// and if not we retry the pipeline once with the critique in context.

import {
  complete,
  estimateCost,
  buildFreeFallbackChain,
  type ChatMessage,
  type CompleteDeps,
  type ProviderConfig,
  type ToolCall,
} from './providers';
import {
  VFS,
  findSeriesWithReceipt,
  listCountries,
  growthStats,
  correlate,
  executeJs,
  rowsToCSV,
  citationsToCsvComments,
  ApiRejection,
  resolveSources,
  schemasForSources,
  subAgentSchemasFor,
  adapterOfId,
  adapterById,
  type LlmFn,
  type SourceDef,
  type ChartSpec,
  type DataRow,
  type SearchReceipt,
  type Citation,
} from './tools';
import { resolveCountryList, formatResolutions } from './countries';
import {
  createDashboard,
  addTile,
  removeTile,
  renameTile,
  renameDashboard,
  moveTile,
  touchTileData,
  markTileStale,
  makeTile,
  saveDashboard,
  loadDashboard,
  listDashboards,
  findDashboardByTitle,
  DashboardCapError,
  type Dashboard,
  type Tile,
  type StorageLike as DashboardStorage,
} from './dashboard';

// ── Extracted modules (Phase A split) ─────────────────────────────────────
// The pure, session-independent pieces (split out by responsibility) are
// imported here for internal use; agent.ts re-exports them for the public API.
import { MAX_TOOL_CALLS, MAX_LLM_PER_RUN, MAX_LLM_PER_TURN, LLM_DATA_CAP, MAX_DELEGATIONS_PER_TURN, MAX_SUBAGENT_CALLS } from './budgets';
import { buildSystemPrompt, buildSubAgentPrompt } from './prompts';
import { needsPlan, parsePlanBrief, type PlanStep, type InsightBrief } from './planner';
import { verify, type VerificationVerdict, type VerifyStatus, type ParsedVerdict } from './verifier';
import { normalizeSpec } from './spec';
import { extractJsonObject } from './parse-json';
import type { TraceEvent } from './receipts';


// The registry source a fetch id routes to is now derived by the source layer:
// sourceOfId/adapterOfId (sources/index.ts) read it straight off the id's
// namespace ("owid:"/"imf:"/"who:" prefix; a bare code → World Bank; an
// unrecognized namespace → no adapter, surfaced as a clear routing error). The
// per-source dispatch branches that used to each own this are gone.

// Normalized session-cache key for one fetch: id + resolved country codes +
// year range. Countries are the RESOLVED codes (so "UK" and "GBR" share a key —
// honestly the same data) sorted for order-independence; no countries (every-
// country / OWID-IMF-all) yields an empty country segment, distinct from a
// specific-country fetch of the same id.
function fetchCacheKey(id: string, codes: string[], ys?: number, ye?: number): string {
  const nid = id.trim().toLowerCase();
  const nc = codes.map((c) => c.trim().toUpperCase()).sort().join(',');
  return `${nid}|${nc}|${ys ?? ''}:${ye ?? ''}`;
}



export interface AgentCallbacks {
  onTrace: (events: TraceEvent[]) => void;
  onFiles: (files: Record<string, string>) => void;
  onChart: (spec: ChartSpec) => void;
  onStatus: (msg: string, kind: 'loading' | 'ok' | 'error') => void;
  // Fired once per turn if OpenRouter's free-fallback chain served the turn
  // with a different model than the one selected.
  onModel?: (servedModel: string) => void;
}

export interface AgentOutput {
  finding: string;
  chartSpec: ChartSpec | null;
  rows: DataRow[];
  csv: string;
  indicators: { id: string; name: string }[];
  // The citation ledger for this session: one structured provenance record per
  // distinct live fetch (backlog #11). Only fetched data appears here —
  // model-derived (llm()) artifacts never enter it. The UI's evidence section
  // renders these; the CSV export carries them as comment lines.
  citations: Citation[];
  confidence: 'ok' | 'low';
  verifierReport: string;
  // The structured verification verdict for this turn, surfaced honestly by the
  // UI as one of three states. null on an explanation turn (verification is not
  // run for prose answers). status/confidence/issues drive the answer-level tag
  // and the verify receipt; the UI must never present a non-'verified' status
  // as verified.
  verification: VerificationVerdict | null;
  cost: number;
  retried: boolean;
  kind: 'chart' | 'explanation';
  // True when the caller stopped this turn mid-run (the signal fired). An
  // aborted turn is NOT an error and NOT verified: `verification` is null, no
  // VERIFIED stamp is earned, and `confidence` is 'low'. Any rows/citations
  // fetched before the stop are still carried here (real data, real
  // provenance) and remain in the session for the next turn. False on every
  // normally-completed turn.
  aborted: boolean;
}



// A compact, model-friendly summary of a data fetch.
function summarizeRows(rows: DataRow[]): string {
  const byCountry: Record<string, DataRow[]> = {};
  for (const r of rows) (byCountry[r.iso3] ??= []).push(r);
  const lines: string[] = [];
  for (const iso3 of Object.keys(byCountry)) {
    const rs = byCountry[iso3].filter((r) => r.value !== null);
    if (!rs.length) continue;
    const first = rs[0];
    const last = rs[rs.length - 1];
    lines.push(
      `${first.country} (${iso3}): ${first.year}=${first.value}, ${last.year}=${last.value}, n=${rs.length}`
    );
  }
  return `rows=${rows.length}, countries=${Object.keys(byCountry).length}\n` + lines.join('\n');
}

export interface ChittiSession {
  // `signal` is the per-turn "stop" control. When it fires, ask() unwinds at the
  // next boundary (or the in-flight fetch aborts) and RESOLVES with an honest
  // AgentOutput carrying `aborted: true` — never a rejection, never a provider
  // error. The session stays reusable: any rows/citations fetched before the
  // stop remain in state, and the next ask() picks up from there.
  ask(question: string, cb: AgentCallbacks, signal?: AbortSignal): Promise<AgentOutput>;
}

import { AbortedError } from './abort';
import {
  resolveTileRef,
  refreshDashboard,
  defaultDashboardTitle,
  buildCitation,
  indicatorName,
} from './dashboards-agent';

// Thrown inside routeFetch when a data API STRUCTURALLY rejected a fetch (a bad
// indicator/slug/code — see ApiRejection). It carries the model-facing steer
// (already prefixed "ERROR:") and a short receipt detail. dispatch's catch
// renders it as an error receipt and returns the steer as the tool result, so
// the model recovers (find_series → corrected fetch) instead of the failure
// surfacing raw. NEVER a run-killer, and never used for a network/CORS failure
// (those keep their existing graceful-fallback wording).
class FetchSteer extends Error {
  readonly detail: string;
  constructor(steer: string, detail: string) {
    super(steer);
    this.name = 'FetchSteer';
    this.detail = detail;
  }
}

// Build the model-facing steer for a structured API rejection. `attempt` is how
// many times this EXACT fetch (id + countries + range) has now been rejected
// this session; on the 2nd+ rejection the steer tells the model in no uncertain
// terms to STOP retrying the id (loop safety — a stubborn model must not burn
// the tool-call budget on one bad id). Pure + exported for the steer unit table.
export function buildRejectionSteer(
  source: 'worldbank' | 'owid' | 'imf' | 'who',
  id: string,
  attempt: number
): string {
  const label =
    source === 'worldbank' ? 'World Bank indicator'
      : source === 'owid' ? 'OWID slug'
      : source === 'imf' ? 'IMF code'
      : 'WHO IndicatorCode';
  const sourceName =
    source === 'worldbank' ? 'World Bank'
      : source === 'owid' ? 'Our World in Data'
      : source === 'imf' ? 'IMF'
      : 'WHO';
  if (attempt >= 2) {
    return (
      `ERROR: ${sourceName} rejected ${label} "${id}" AGAIN — you have now tried this exact id ${attempt} times ` +
      'and it does not exist. STOP retrying it: call find_series for a DIFFERENT, valid id, or answer with the ' +
      'data you already have.'
    );
  }
  return (
    `ERROR: ${sourceName} rejected ${label} "${id}" — it may not exist. Do NOT retry the same id; ` +
    'call find_series to get a valid id, then fetch_series with it.'
  );
}

export interface SessionOptions {
  // Active database ids (from tools.ts SOURCES). Empty/omitted → all sources.
  // The hard filter: only these sources' tools and prompt guidance reach the
  // model, so it can only answer from the databases the user selected.
  sources?: string[];
  // Whether execute_js code may call the bounded recursive `llm()` primitive.
  // Default false, and deliberately so: every nested call spends the user's
  // own key, so the capability is opt-in. Off is enforced by withholding, not
  // by refusing. When off, the system prompt omits the llm() guidance (main
  // loop AND sub-agent) and execute_js is run with no llm argument, so the
  // sandbox binding is the throw-on-call default — the model never learns the
  // capability exists and cannot burn a tool call discovering it is disabled.
  rlm?: boolean;
  // Persistence for the save_to_dashboard tool. Injected so tests can pass a
  // Map-backed fake; in the browser the app passes window.localStorage. When
  // omitted, the tool falls back to a global localStorage if one exists, else
  // refuses cleanly (never throws).
  dashboardStore?: DashboardStorage;
}

export function createSession(cfg: ProviderConfig, opts?: SessionOptions): ChittiSession {
  const activeSources = resolveSources(opts?.sources);
  const rlmEnabled = opts?.rlm ?? false;
  // Resolve the dashboard store once: explicit injection wins; otherwise use a
  // global localStorage when the runtime has one; otherwise null (tool refuses).
  const dashboardStore: DashboardStorage | null =
    opts?.dashboardStore ??
    (typeof localStorage !== 'undefined' ? (localStorage as unknown as DashboardStorage) : null);
  const toolSchemas = schemasForSources(opts?.sources);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(activeSources, rlmEnabled) },
  ];
  const vfsFiles: Record<string, string> = {};
  const state: {
    rows: DataRow[];
    chartSpec: ChartSpec | null;
    indicators: Map<string, string>;
    // The citation ledger (backlog #11): keyed by the fetch-cache key so a
    // repeat/cached fetch maps to the SAME entry (cite once). Session-scoped,
    // like state.rows — provenance persists across turns. Insertion order is
    // preserved by Map, so the evidence section lists sources in fetch order.
    citations: Map<string, Citation>;
    finding: string;
  } = { rows: [], chartSpec: null, indicators: new Map(), citations: new Map(), finding: '' };

  // Session fetch cache (backlog #9), at the fetch_series choke point. Key =
  // normalized (id + resolved countries + year range); value = the exact
  // model-facing summary + trace detail from the first successful fetch. Lives
  // for the whole SESSION and is deliberately NOT invalidated on a new turn:
  // series like a GDP time-range don't change mid-session, so a repeat fetch of
  // the same id/countries/range is genuinely the same data. A cache HIT never
  // touches the network and never re-appends to state.rows — the rows are
  // already there from the first fetch (invariant: a cache entry implies its
  // rows were merged into state.rows), so re-appending would double them. The
  // receipt discloses the hit rather than pretending fresh work happened
  // (receipts never lie). Shared by the main loop AND delegation sub-agents
  // (both fetch through routeFetch against this same map), so a sub-agent fetch
  // populates the cache the main loop can then hit. Only successful fetches are
  // cached.
  const fetchCache = new Map<string, { rows: DataRow[]; result: string; detail: string }>();

  // Ids that came back from a find_series hit this session (namespaced, lower-
  // cased). The indicator-id guard trusts these alongside the curated catalogs,
  // so a model that legitimately searched then fetched is never second-guessed.
  // Session-scoped and shared by the main loop AND sub-agents (both search
  // through the one dispatch), like fetchCache.
  const seenSeriesIds = new Set<string>();

  // Loop safety: how many times a given fetch key (id + resolved countries +
  // range) has been STRUCTURALLY rejected by its API this session. A second
  // rejection of the identical fetch earns a harder "stop retrying this id"
  // steer (buildRejectionSteer), so a stubborn model can't spend the whole
  // tool-call budget re-fetching one bad id.
  const failedFetches = new Map<string, number>();

  let turnCount = 0;

  async function ask(question: string, cb: AgentCallbacks, signal?: AbortSignal): Promise<AgentOutput> {
    turnCount++;
    // Forwarded to every complete() this turn makes (main loop, verify, llm(),
    // sub-agents) so an in-flight provider fetch aborts the moment the user
    // stops, instead of waiting out the 60s provider timeout.
    const completeDeps: CompleteDeps = signal ? { signal } : {};
    // Boundary guard: called between tool calls / loop iterations so a stop
    // takes effect promptly even when nothing is mid-fetch. Throwing unwinds to
    // ask()'s top-level handler, which builds the honest aborted output.
    const throwIfAborted = () => {
      if (signal?.aborted) throw new AbortedError();
    };
    const trace: TraceEvent[] = [];
    const vfs = new VFS((files) => {
      Object.assign(vfsFiles, files);
      cb.onFiles({ ...vfsFiles });
    });
    let totalCost = 0;
    // Shared per-turn counter for recursive llm() calls across every execute_js
    // run in this turn (the MAX_LLM_PER_TURN cap). Resets each turn by living
    // here, in ask()'s scope. Sub-agent llm() calls increment this same counter,
    // so a delegation cannot escape the turn's overall llm budget.
    let turnLlmCalls = 0;
    // Shared per-turn counter for delegate_source sub-agents (MAX_DELEGATIONS_
    // PER_TURN). Same scope-lifetime pattern as turnLlmCalls.
    let turnDelegations = 0;
    state.finding = ''; // reset per turn; state.rows/chartSpec/indicators persist
    let turnKind: 'chart' | 'explanation' = 'chart';
    // The chart rendered during THIS turn only. state.chartSpec persists
    // across turns as context (the turn-2+ addendum describes it), but
    // returning/act-ing on the persistent one made every follow-up re-show
    // the previous turn's chart and told the model it was already done.
    let turnChartSpec: ChartSpec | null = null;
    // Whether the model-fallback trace note was already emitted this turn.
    let fallbackNoted = false;
    const turnStartIndex = messages.length;

    function pushTrace(e: Omit<TraceEvent, 'ts'>): TraceEvent {
      const withTs: TraceEvent = { ...e, ts: Date.now() };
      trace.push(withTs);
      cb.onTrace([...trace]);
      return withTs;
    }
    function updateTrace() {
      cb.onTrace([...trace]);
    }

    // Build a fresh bounded recursive llm() primitive for one execute_js run.
    // Its per-run counter is local; the per-turn counter (turnLlmCalls) and cost
    // are shared closure state, so llm() calls from the main loop AND from any
    // delegation sub-agent all draw from the one MAX_LLM_PER_TURN budget. Each
    // call streams a nested receipt (child line-item), is text-only with no tool
    // access (depth-1 by construction), and rejects — catchably — past any cap.
    function makeLlm(): LlmFn {
      let runLlmCalls = 0;
      return async (prompt: string, data?: unknown): Promise<string> => {
        const p = String(prompt ?? '');
        if (runLlmCalls >= MAX_LLM_PER_RUN) {
          throw new Error(
            `llm() limit reached: max ${MAX_LLM_PER_RUN} calls per execute_js run. ` +
              'Do fewer, bigger-slice calls, or finish with what you have.'
          );
        }
        if (turnLlmCalls >= MAX_LLM_PER_TURN) {
          throw new Error(
            `llm() limit reached: max ${MAX_LLM_PER_TURN} calls per turn (across all execute_js runs).`
          );
        }
        let serialized = '';
        if (data !== undefined) {
          serialized = JSON.stringify(data) ?? '';
          if (serialized.length > LLM_DATA_CAP) {
            throw new Error(
              `llm() data too large: ${serialized.length} bytes serialized > ${LLM_DATA_CAP} cap. ` +
                'Slice the data smaller (fewer rows/fields per call) and try again.'
            );
          }
        }
        // Count the call only once it's past every guard — a rejected
        // (over-cap or over-size) call must not consume budget.
        runLlmCalls++;
        turnLlmCalls++;
        const childEv = pushTrace({
          tool: 'llm',
          argSummary: p.slice(0, 80),
          status: 'running',
          nested: true,
          dataBytes: serialized.length,
        });
        const started = Date.now();
        const fullPrompt = data !== undefined ? `${p}\n\nDATA (JSON):\n${serialized}` : p;
        try {
          const res = await complete(cfg, [{ role: 'user', content: fullPrompt }], [], completeDeps);
          // Price against the model that actually served the nested call, not
          // cfg.model — OpenRouter's free-fallback chain can serve a different
          // one (matches the main-loop attribution).
          totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);
          childEv.status = 'ok';
          childEv.durationMs = Date.now() - started;
          childEv.tokens = res.usage.input + res.usage.output;
          childEv.detail = serialized ? formatBytes(serialized.length) + ' in' : 'no data';
          updateTrace();
          return res.text ?? '';
        } catch (err: any) {
          childEv.status = 'error';
          childEv.durationMs = Date.now() - started;
          childEv.detail = 'llm() failed: ' + (err?.message ?? String(err));
          updateTrace();
          // Reject with a catchable error: user code may try/catch it; an
          // uncaught rejection fails that execute_js run via the normal
          // error-receipt path, and the loop continues.
          throw new Error('llm() failed: ' + (err?.message ?? String(err)));
        }
      };
    }

    // Run a depth-1 per-source sub-agent (a delegate_source target). It drives
    // its OWN small tool loop over a source-scoped schema set (find_series
    // restricted to this source, the source's fetch tool, execute_js+llm(), and
    // return_findings) against a SEPARATE message array — so the raw fetched
    // rows land in the sub-agent's context, never the main model's. Rows and
    // indicators still merge into the shared `state` (and VFS) via the reused
    // dispatch(), keeping every citation intact. Returns only a distilled text
    // summary. Errors and the step cap degrade to an ok:false failure summary;
    // the main loop always continues.
    async function runSubAgent(
      src: SourceDef,
      question: string
    ): Promise<{ ok: boolean; summary: string; detail: string }> {
      const subSchemas = subAgentSchemasFor(src.id);
      const subMessages: ChatMessage[] = [
        { role: 'system', content: buildSubAgentPrompt(src, rlmEnabled) },
        { role: 'user', content: question || `Fetch and distil the relevant ${src.label} data.` },
      ];
      let steps = 0;
      let summary = '';
      let returned = false;
      try {
        while (steps < MAX_SUBAGENT_CALLS) {
          throwIfAborted();
          const res = await complete(cfg, subMessages, subSchemas, completeDeps);
          totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);
          if (!res.toolCalls.length) {
            // No tool call — nudge once toward acting, counting it against the
            // step budget so a silent model can't loop forever.
            steps++;
            subMessages.push({ role: 'assistant', content: res.text });
            subMessages.push({
              role: 'user',
              content: 'Call a tool: fetch what the sub-question needs, then return_findings with a short distilled summary.',
            });
            continue;
          }
          subMessages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });
          const turnTokens = res.usage.input + res.usage.output;
          for (const [idx, tc] of res.toolCalls.entries()) {
            steps++;
            const out = await dispatch(tc, {
              tokens: idx === 0 ? turnTokens : undefined,
              nested: true,
              sourceIds: [src.id],
              allowDelegate: false,
            });
            subMessages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out });
            if (tc.name === 'return_findings') {
              returned = true;
              // Read defensively: safeParse can yield a non-object (a bare
              // `null`/array/number from `arguments:"null"`) that dispatch()
              // already tolerates. Dereferencing `.summary` off null here would
              // throw and demote a sub-agent that DID return findings to a
              // swallowed "failed, continuing without it".
              const args = tc.arguments && typeof tc.arguments === 'object' ? (tc.arguments as Record<string, unknown>) : {};
              summary = String(args.summary ?? '').trim();
            }
            if (steps >= MAX_SUBAGENT_CALLS) break;
          }
          if (returned) break;
        }
      } catch (err: any) {
        // A user-stop is not a sub-agent failure — let it unwind to ask()'s
        // top-level handler so the whole turn ends as "stopped", not as a
        // degraded "continuing without it" summary.
        if (err instanceof AbortedError || signal?.aborted) throw err;
        // A hard failure (e.g. a model call rejected). Any rows fetched before
        // it still merged with citations; report and let the main loop continue.
        return {
          ok: false,
          summary: `Sub-agent for ${src.label} failed: ${err?.message ?? String(err)}. Continuing without it.`,
          detail: 'error',
        };
      }
      if (returned) {
        return {
          ok: true,
          summary: `[${src.label}] ${summary || '(sub-agent returned no summary text)'}`,
          detail: `${steps} step${steps === 1 ? '' : 's'}`,
        };
      }
      return {
        ok: false,
        summary: `Sub-agent for ${src.label} reached its ${MAX_SUBAGENT_CALLS}-step limit without returning findings. Continuing without it.`,
        detail: 'cap reached',
      };
    }

    // routeFetch is the single fetch choke point behind fetch_series (and the
    // legacy per-source tool names). It (1) reads the source off the id's
    // namespace, (2) enforces the source hard-filter — an id outside the
    // caller's allowed sources is refused (this is how a hard-filtered session,
    // and a source-scoped sub-agent, keep out-of-namespace data out), (3)
    // resolves loose country inputs ONCE (was duplicated across the three
    // branches), (4) serves the session cache on a repeat, and only otherwise
    // (5) calls the underlying per-source fetcher. Country resolution + receipt
    // style match the pre-router per-source branches exactly. Sets ev.detail and
    // returns the model-facing result string.
    async function routeFetch(
      ev: TraceEvent,
      id: string,
      rawCountries: string[] | undefined,
      ys: number | undefined,
      ye: number | undefined,
      allowedSourceIds: string[]
    ): Promise<string> {
      // The adapter that owns this id's namespace (see sources/index.ts). Router
      // is now generic: no per-source switch — every branch below reads off the
      // adapter. An unrecognized namespace has no adapter.
      const adapter = adapterOfId(id);
      if (!adapter) {
        ev.detail = 'unknown source';
        return (
          `ERROR: cannot route "${id}" — its source namespace is not recognized. Use an id from ` +
          'find_series (a plain World Bank code, "owid:<slug>", or "imf:<code>").'
        );
      }
      const source = adapter.citationSource;
      if (!allowedSourceIds.includes(source)) {
        ev.detail = 'refused: out-of-source id';
        return (
          `ERROR: "${id}" is a ${source} series, not available ${allowedSourceIds.length === 1 ? 'to this sub-agent' : 'in this session'}. ` +
          `Use a find_series id from: ${allowedSourceIds.join(', ')}.`
        );
      }

      // ── Indicator-id guard (heuristic, not a wall) ──────────────────────
      // Trust an id that is in a curated catalog OR came back from a find_series
      // hit this session (seenSeriesIds). Otherwise:
      //  - World Bank: its live id space is far larger than our local
      //    indicators.json, so an unknown WB id PROCEEDS — but the receipt is
      //    marked "unverified id", and we stand ready to translate an API
      //    rejection into a find_series steer (see the ApiRejection catch below).
      //  - Curated-catalog sources (OWID/IMF/WHO): the id space here is CLOSED
      //    (a curated slug/code round-trips; anything else 404s), so an id that
      //    is neither in the catalog nor a session hit is almost certainly a
      //    hallucinated slug/code — refuse with a find_series steer rather than
      //    spend a fetch that will fail.
      const idLc = id.trim().toLowerCase();
      const idSeen = seenSeriesIds.has(idLc);
      let unverifiedWbId = false;
      if (adapter.openIdSpace) {
        // Open id space (World Bank): an unknown id PROCEEDS, marked unverified.
        unverifiedWbId = !adapter.hasCuratedId(id) && !idSeen;
      } else if (!adapter.hasCuratedId(id) && !idSeen) {
        // Closed catalog id space (OWID/IMF/WHO): refuse with a find_series steer.
        ev.detail = `unknown ${source} id`;
        return (
          `ERROR: unknown ${adapter.idLabel} "${id}" — it is not in the ${source.toUpperCase()} catalog ` +
          'or any recent find_series result. Call find_series to get a valid id, then fetch_series with it.'
        );
      }

      // ── Country policy: DROP unresolvable tokens; never send junk to the API ─
      // Resolve loose country inputs ("UK", "Korea", "euro area") to WB
      // ISO3/aggregate codes ONCE, here at the choke point. A token that cannot
      // be resolved is DROPPED (was: passed through unchanged, which the World
      // Bank then rejected with "provided parameter value is not valid"). We
      // fetch only what resolved and disclose the drops in both the tool result
      // and the receipt. If NOTHING resolves (yet countries WERE requested), we
      // return a tool error WITHOUT touching the API — junk never leaves here.
      const hasCountries = Array.isArray(rawCountries) && rawCountries.length > 0;
      const resolved = hasCountries ? resolveCountryList(rawCountries!) : undefined;
      const codes = resolved?.codes ?? [];
      const changes = resolved?.changes ?? [];
      const dropped = resolved?.dropped ?? [];

      if (hasCountries && codes.length === 0) {
        ev.detail = 'no countries resolved';
        const names = dropped.map((d) => `"${d.from}"`).join(', ');
        const sugg = [...new Set(dropped.flatMap((d) => d.suggestions))].slice(0, 5);
        return (
          `ERROR: none of the requested countries could be resolved (${names}) — nothing was fetched. ` +
          (sugg.length ? `Did you mean: ${sugg.join(', ')}? ` : '') +
          'Use ISO3 codes (e.g. USA, CHN), common country names, or one aggregate like WLD, then fetch_series again.'
        );
      }

      const dropNote = dropped.length
        ? `Could not resolve ${dropped.map((d) => `"${d.from}"`).join(', ')} — ` +
          `fetched only the resolved ${codes.length === 1 ? 'country' : 'countries'}: ${codes.join(', ')}.\n`
        : '';
      const dropDetail = dropped.length ? `dropped ${dropped.map((d) => d.from).join(', ')} · ` : '';
      const idDetail = unverifiedWbId ? 'unverified id · ' : '';

      const resNote = (changes.length ? `Resolved countries: ${formatResolutions(changes)}.\n` : '') + dropNote;
      const resDetail = idDetail + dropDetail + (changes.length ? `${formatResolutions(changes)} · ` : '');

      // Cache lookup on the normalized (id + resolved countries + range) key.
      const key = fetchCacheKey(id, codes, ys, ye);
      const cached = fetchCache.get(key);
      if (cached) {
        // Hit: no network, no re-append (rows already in state.rows). Disclose it.
        ev.detail = 'cached · ' + cached.detail;
        return '(cached — fetched earlier this session; not re-fetched)\n' + cached.result;
      }

      let rows: DataRow[] = [];
      let body = '';
      let detail = '';
      // Provenance captured verbatim from the fetcher, for the citation ledger.
      // nid is the adapter's normalized indicator id (the citation key part).
      const nid = adapter.normalizeId(id);
      let requestUrl = ''; // the exact API URL that was hit
      let sourceUpdated: string | undefined; // source data vintage, when present
      try {
        // One generic fetch through the adapter — it owns per-source id handling,
        // request URL, vintage, and (for World Bank) every-country batching.
        const r = await adapter.fetchSeries(id, hasCountries ? codes : undefined, ys, ye, signal);
        rows = r.rows;
        requestUrl = r.requestUrl;
        sourceUpdated = r.sourceUpdated;
        state.indicators.set(nid, adapter.indicatorLabel(nid, r));
        if (adapter.reportsBatches && !hasCountries) {
          // Every-country path (World Bank batches internally): its own detail,
          // and no country-resolution notes (there were no countries to resolve).
          body = summarizeRows(rows);
          detail = `${rows.length} rows · ${r.countryCount} countries · ${r.batchCount} batch${r.batchCount === 1 ? '' : 'es'}`;
        } else {
          body = resNote + summarizeRows(rows);
          if (r.truncatedFrom) {
            body +=
              `\n\nNOTE: you requested ${r.truncatedFrom} countries but only the first 60 were ` +
              `fetched (per-call limit). Call fetch_series again with the remaining countries and merge results.`;
          }
          detail = resDetail + `${rows.length} rows` + adapter.detailSuffix(r);
        }
      } catch (err: any) {
        // A user-stop unwinds untouched. A STRUCTURED rejection (ApiRejection:
        // the API answered "no" to this id/parameter) becomes a model-recoverable
        // steer, with loop-safety counting identical rejected fetches. Anything
        // else (a network/CORS failure, or the WB "no data returned" plain Error)
        // re-throws to dispatch's generic catch, keeping its graceful-fallback
        // wording — only structured rejections are turned into steers.
        if (err instanceof AbortedError || signal?.aborted) throw err;
        if (err instanceof ApiRejection) {
          const attempt = (failedFetches.get(key) ?? 0) + 1;
          failedFetches.set(key, attempt);
          throw new FetchSteer(
            buildRejectionSteer(source, id, attempt),
            (attempt >= 2 ? 'rejected again — stop retrying' : 'API rejected id') +
              (unverifiedWbId ? ' (unverified id)' : '')
          );
        }
        throw err;
      }
      state.rows = state.rows.concat(rows);
      // Cache only this successful result (and the rows it merged — the entry is
      // a faithful record; state.rows already holds them, see the map's header).
      fetchCache.set(key, { rows, result: body, detail });
      // Record the citation ledger entry for this fetch (backlog #11). Keyed by
      // the same cache key, so a later identical (cached) fetch reuses THIS entry
      // rather than duplicating it — a cache hit returns above, before here, and
      // never overwrites. Only a real, successful fetch writes a citation, so a
      // model-derived artifact can never enter the ledger. Mirrored into the VFS
      // as citations.json (via:'fetch') so the model can read it with read_file.
      recordCitation(key, source, nid, codes, ys, ye, rows.length, requestUrl, sourceUpdated);
      ev.detail = detail;
      return body;
    }

    // Build and store one citation ledger entry, then re-mirror the whole ledger
    // to the VFS as citations.json with via:'fetch' meta (symmetric to a
    // model-derived artifact's via:'llm'). fetchedAt is stamped here — the moment
    // Chitti fetched — kept strictly distinct from sourceUpdated (the source's
    // own vintage). Idempotent per key: a repeat with the same key overwrites an
    // identical record, so the ledger stays one-entry-per-distinct-fetch.
    function recordCitation(
      key: string,
      source: 'worldbank' | 'owid' | 'imf' | 'who',
      nid: string,
      codes: string[],
      ys: number | undefined,
      ye: number | undefined,
      rowCount: number,
      requestUrl: string,
      sourceUpdated: string | undefined
    ): void {
      const citation = buildCitation(key, source, nid, codes, ys, ye, rowCount, requestUrl, sourceUpdated);
      state.citations.set(key, citation);
      vfs.write(
        'citations.json',
        JSON.stringify([...state.citations.values()], null, 2),
        { via: 'fetch' }
      );
    }

    // dispatch runs one tool call. Options let the SAME dispatcher serve both
    // the main loop and a delegation sub-agent, so a sub-agent's fetch merges
    // rows/indicators exactly as a direct fetch would (citations intact):
    //   nested       — render this step as an indented child receipt (sub-agent
    //                  steps stream under their delegate_source parent).
    //   sourceIds    — which databases find_series searches (a sub-agent scopes
    //                  it to its one source).
    //   allowDelegate — false inside a sub-agent, so delegate_source is refused
    //                  at runtime too, not only structurally (depth-1).
    interface DispatchOpts {
      tokens?: number;
      nested?: boolean;
      sourceIds?: string[];
      allowDelegate?: boolean;
    }
    async function dispatch(tc: ToolCall, opts: DispatchOpts = {}): Promise<string> {
      const {
        tokens,
        nested,
        sourceIds = activeSources.map((s) => s.id),
        allowDelegate = true,
      } = opts;
      // Harden against a tool call whose arguments are not a plain object. The
      // provider's safeParse only guarantees an object on a THROWN JSON error —
      // a model that emits `arguments: "null"` / "[...]" / a bare number yields
      // null / an array / a primitive that still satisfies `Record<...>`. The
      // summarizeArgs call below runs OUTSIDE the try, so a null used to
      // dereference (e.g. `a.query`) and reject the entire ask(). Normalize to
      // {} so a malformed call becomes a clean tool error, never a turn crash.
      const a: Record<string, unknown> =
        tc.arguments && typeof tc.arguments === 'object' && !Array.isArray(tc.arguments)
          ? tc.arguments
          : {};
      const ev = pushTrace({ tool: tc.name, argSummary: summarizeArgs(tc.name, a), status: 'running', tokens, nested });
      try {
        let result = '';
        switch (tc.name) {
          case 'find_series': {
            const { hits, receipt } = await findSeriesWithReceipt(
              String(a.query ?? ''),
              sourceIds
            );
            // Attach the structured receipt for the UI's search-receipt card.
            // The model still receives only the SeriesHit[] JSON (plus a single
            // orientation line) — no context bloat.
            ev.receipt = receipt;
            // Remember these ids so the indicator-id guard trusts a subsequent
            // fetch of any of them (the model searched, then fetched a real hit).
            for (const h of hits) seenSeriesIds.add(String(h.id).trim().toLowerCase());
            if (hits.length) {
              const top = receipt.topMatch;
              const summary =
                `searched ${receipt.sourcesSearched.length} database${receipt.sourcesSearched.length === 1 ? '' : 's'} · ` +
                `${receipt.candidateCount} candidate${receipt.candidateCount === 1 ? '' : 's'}` +
                (top ? ` · top: ${top.name} (${top.sourceLabel})` : '');
              result = summary + '\n' + JSON.stringify(hits);
            } else {
              result = 'No matching series in the active databases — try different keywords.';
            }
            ev.detail = `${hits.length} hit${hits.length === 1 ? '' : 's'}`;
            break;
          }
          case 'list_countries': {
            const list = listCountries(a.filter ? String(a.filter) : 'all');
            result = JSON.stringify(list.map((c) => ({ id: c.id, name: c.name, region: c.region })));
            break;
          }
          case 'fetch_series': {
            // The router (backlog #7): one fetch tool, routed by the id's source
            // namespace. Country resolution + session caching happen once, inside
            // routeFetch, for every source. `sourceIds` is the allowed-source set
            // (all active sources in the main loop; one source in a sub-agent),
            // so out-of-namespace ids are refused here.
            const rawCountries = Array.isArray(a.countries) ? (a.countries as string[]) : undefined;
            result = await routeFetch(
              ev,
              String(a.id ?? ''),
              rawCountries,
              numOrUndef(a.year_start),
              numOrUndef(a.year_end),
              sourceIds
            );
            break;
          }
          // Legacy per-source fetch tool names — retired from the model's schema
          // surface (it now sees find_series → fetch_series only), but still
          // dispatched here so a stubborn model that reaches for an old name by
          // habit keeps working. All route through the SAME fetch_series choke
          // point (routeFetch: resolution + cache), so behavior/receipts match.
          // Undocumented on purpose.
          case 'fetch_worldbank': {
            const rawIds = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : [];
            result = await routeFetch(
              ev,
              String(a.indicator_id ?? ''),
              rawIds,
              // A missing OR null bound stays undefined — never Number(null)===0
              // or Number(undefined)===NaN leaking into the World Bank URL.
              numOrUndef(a.year_start),
              numOrUndef(a.year_end),
              sourceIds
            );
            break;
          }
          case 'fetch_worldbank_all': {
            result = await routeFetch(
              ev,
              String(a.indicator_id ?? ''),
              undefined, // no countries → every-country path
              numOrUndef(a.year_start),
              numOrUndef(a.year_end),
              sourceIds
            );
            break;
          }
          case 'execute_js': {
            const code = String(a.code ?? '');
            // Guard the most common wasted-budget loops observed in real runs:
            // computing against an empty dataset, and code that ran fine but
            // never `return`ed (models often write expression-style snippets).
            if (!state.rows.length) {
              result = 'ERROR: no rows fetched yet in this conversation — call a fetch tool first, then compute.';
              ev.detail = 'no data';
              break;
            }
            // The bounded recursive llm() primitive for THIS execute_js run.
            // Shared between the main loop and delegation sub-agents (makeLlm),
            // so every llm() call — wherever it originates — draws from the same
            // per-turn budget and emits the same nested receipt.
            //
            // Gated off by default (opts.rlm, see rlmEnabled): when RLM is
            // disabled we pass NO llm to executeJs, so the sandbox's `llm`
            // binding is the default that throws on call and the model was
            // never told the capability exists (buildSystemPrompt omits it).
            // Enforcement is by withholding, exactly like the source filter.
            // One llm closure is reused across BOTH executeJs attempts so the
            // retry shares the per-run 4-call allowance, not a fresh one.
            const llm = rlmEnabled ? makeLlm() : undefined;
            // Isolate the canonical row set: the sandboxed code runs on a
            // per-row COPY, so an in-place mutation — rows.push / rows.sort /
            // rows.splice / rows[i].value = … (sort and reverse are common and
            // mutate in place) — can never corrupt state.rows, the traceable
            // source of truth behind every chart, citation and CSV export. The
            // model still sees identical data and computes the same result; only
            // its own working copy is mutable. The same view feeds the retry.
            const rowsView = state.rows.map((r) => ({ ...r }));
            let out = await executeJs(code, rowsView, llm);
            if (out.ok && (out.result === null || out.result === undefined) && !/\breturn\b/.test(code)) {
              // Expression-style code with no return — retry wrapped.
              out = await executeJs('return (' + code + ')', rowsView, llm);
            }
            if (out.ok && (out.result === null || out.result === undefined)) {
              result =
                'Your code ran without error but returned null/undefined. It must END with a ' +
                '`return <value>` statement (e.g. "...; return top10;"). Fix that one thing and ' +
                'call execute_js again — do not change your whole approach.';
              ev.detail = 'returned null';
            } else {
              result = out.ok ? JSON.stringify(out.result) : 'ERROR: ' + out.error;
              ev.detail = out.ok ? 'ok' : 'error: ' + out.error;
            }
            break;
          }
          case 'write_file': {
            // Provenance: a model-derived artifact (produced via llm()) is
            // marked so the VFS entry carries { derived, via } and the trace
            // shows a "model-derived" label — it must never read as fetched.
            const derived = a.derived === true;
            vfs.write(
              String(a.path),
              String(a.content ?? ''),
              derived ? { derived: true, via: 'llm' } : undefined
            );
            if (derived) ev.derived = true;
            result = derived ? 'written (model-derived)' : 'written';
            break;
          }
          case 'read_file': {
            result = vfs.read(String(a.path)) || '(empty)';
            break;
          }
          case 'fetch_owid':
          case 'fetch_imf': {
            // Legacy per-source names (see the note above fetch_worldbank).
            const rawIds = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : undefined;
            result = await routeFetch(
              ev,
              String(a.dataset_id ?? ''),
              rawIds,
              numOrUndef(a.year_start),
              numOrUndef(a.year_end),
              sourceIds
            );
            break;
          }
          case 'growth_stats': {
            const stats = growthStats(state.rows, a.indicator_id ? String(a.indicator_id) : undefined);
            result = stats.length
              ? JSON.stringify(stats.slice(0, 60))
              : 'No computable rows — fetch data first (need 2+ years per country).';
            ev.detail = `${stats.length} countries`;
            break;
          }
          case 'correlate': {
            const out = correlate(
              state.rows,
              String(a.indicator_a ?? ''),
              String(a.indicator_b ?? ''),
              a.year !== undefined ? Number(a.year) : undefined
            );
            result = JSON.stringify(out);
            ev.detail = out.r === null ? out.note ?? 'n/a' : `r=${out.r.toFixed(3)}, n=${out.n}`;
            break;
          }
          case 'render_chart': {
            const spec = normalizeSpec(a as unknown as ChartSpec);
            state.chartSpec = spec;
            turnChartSpec = spec;
            cb.onChart(spec);
            result = 'rendered';
            break;
          }
          case 'save_to_dashboard': {
            // Pin THIS turn's rendered chart to a named dashboard (create if
            // absent). Only real, non-derived state is pinned: the spec the model
            // rendered, the fetched rows behind it (state.rows — the same source
            // of truth the CSV/share paths use, which already excludes llm()-
            // derived content), and the citation ledger. Refuses cleanly when
            // there is no chart this turn or no storage is available.
            if (!turnChartSpec) {
              ev.detail = 'no chart this turn';
              result =
                'ERROR: no chart has been rendered this turn, so there is nothing to pin. ' +
                'Render a chart with render_chart first, then save_to_dashboard.';
              break;
            }
            if (!dashboardStore) {
              ev.detail = 'no storage';
              result = 'ERROR: dashboard storage is unavailable in this environment — cannot pin.';
              break;
            }
            const dashTitle =
              String(a.dashboard_title ?? '').trim() || defaultDashboardTitle(question);
            const tileTitle =
              String(a.tile_title ?? '').trim() || turnChartSpec.title || dashTitle;
            const existing = findDashboardByTitle(dashboardStore, dashTitle);
            const created = !existing;
            let dash = existing ?? createDashboard(dashTitle);
            const tile = makeTile({
              title: tileTitle,
              spec: turnChartSpec,
              rows: state.rows,
              citations: [...state.citations.values()],
            });
            try {
              dash = addTile(dash, tile);
            } catch (e: any) {
              ev.detail = 'over cap';
              result = 'ERROR: ' + (e instanceof DashboardCapError ? e.message : (e?.message ?? String(e)));
              break;
            }
            const saved = saveDashboard(dashboardStore, dash);
            if (!saved.ok) {
              ev.detail = 'save failed';
              result = 'ERROR: ' + saved.error;
              break;
            }
            const nTiles = dash.tiles.length;
            const citeNote = tile.citations.length
              ? ` with ${tile.citations.length} citation${tile.citations.length === 1 ? '' : 's'}`
              : '';
            ev.detail = `→ ${dash.title}${created ? ' (new)' : ''} · ${nTiles} tile${nTiles === 1 ? '' : 's'}`;
            result =
              `Pinned "${tileTitle}"${citeNote} to ${created ? 'new dashboard' : 'dashboard'} ` +
              `"${dash.title}" (now ${nTiles} tile${nTiles === 1 ? '' : 's'}).`;
            break;
          }
          case 'edit_dashboard': {
            // Conversational editing (increment 2): ONE tool, one action per
            // call. Every branch applies through the PURE dashboard ops, persists
            // via the store, and records a receipt ("dashboard 'X': removed tile
            // 'Y'"). Tile references resolve title → case-insensitive → 1-based
            // index (resolveTileRef); an ambiguous/missing ref returns a clear
            // error listing the tiles. Refuses cleanly with no storage.
            if (!dashboardStore) {
              ev.detail = 'no storage';
              result = 'ERROR: dashboard storage is unavailable in this environment — cannot edit a dashboard.';
              break;
            }
            const dashTitle = String(a.dashboard_title ?? '').trim();
            const dash = dashTitle ? findDashboardByTitle(dashboardStore, dashTitle) : null;
            if (!dash) {
              ev.detail = 'no such dashboard';
              const names = listDashboards(dashboardStore).map((d) => `"${d.title}"`);
              result =
                `ERROR: no saved dashboard titled "${dashTitle}". ` +
                (names.length ? `Saved dashboards: ${names.join(', ')}.` : 'There are no saved dashboards yet.');
              break;
            }
            const action = String(a.action ?? '').trim();
            const tileRef = {
              title: a.tile_title !== undefined ? String(a.tile_title) : undefined,
              index: a.tile_index !== undefined ? Number(a.tile_index) : undefined,
            };
            // Persist a mutated dashboard, set the receipt detail, and return the
            // model-facing message. A save failure surfaces cleanly (never a crash).
            const persist = (next: Dashboard, receipt: string, msg: string): string => {
              const saved = saveDashboard(dashboardStore, next);
              if (!saved.ok) { ev.detail = 'save failed'; return 'ERROR: ' + saved.error; }
              ev.detail = receipt;
              return msg;
            };

            switch (action) {
              case 'rename_dashboard': {
                const nt = String(a.new_title ?? '').trim();
                if (!nt) { ev.detail = 'missing new_title'; result = 'ERROR: rename_dashboard needs new_title.'; break; }
                const next = renameDashboard(dash, nt);
                result = persist(
                  next,
                  `dashboard "${dash.title}": renamed to "${next.title}"`,
                  `Renamed dashboard "${dash.title}" to "${next.title}".`
                );
                break;
              }
              case 'rename_tile': {
                const nt = String(a.new_title ?? '').trim();
                if (!nt) { ev.detail = 'missing new_title'; result = 'ERROR: rename_tile needs new_title.'; break; }
                const r = resolveTileRef(dash, tileRef);
                if (!r.ok) { ev.detail = 'tile not resolved'; result = 'ERROR: ' + r.error; break; }
                const next = renameTile(dash, r.tile.id, nt);
                result = persist(
                  next,
                  `dashboard "${dash.title}": renamed tile "${r.tile.title}" to "${nt}"`,
                  `Renamed tile "${r.tile.title}" to "${nt}" in "${dash.title}".`
                );
                break;
              }
              case 'remove_tile': {
                const r = resolveTileRef(dash, tileRef);
                if (!r.ok) { ev.detail = 'tile not resolved'; result = 'ERROR: ' + r.error; break; }
                const next = removeTile(dash, r.tile.id);
                const n = next.tiles.length;
                result = persist(
                  next,
                  `dashboard "${dash.title}": removed tile "${r.tile.title}"`,
                  `Removed tile "${r.tile.title}" from "${dash.title}" (now ${n} tile${n === 1 ? '' : 's'}).`
                );
                break;
              }
              case 'move_tile': {
                const dir = String(a.direction ?? '').trim();
                if (dir !== 'up' && dir !== 'down') { ev.detail = 'bad direction'; result = 'ERROR: move_tile needs direction "up" or "down".'; break; }
                const r = resolveTileRef(dash, tileRef);
                if (!r.ok) { ev.detail = 'tile not resolved'; result = 'ERROR: ' + r.error; break; }
                const next = moveTile(dash, r.tile.id, dir as 'up' | 'down');
                if (next === dash) {
                  const edge = dir === 'up' ? 'top' : 'bottom';
                  ev.detail = `tile "${r.tile.title}" already at ${edge}`;
                  result = `Tile "${r.tile.title}" is already at the ${edge} of "${dash.title}".`;
                  break;
                }
                result = persist(
                  next,
                  `dashboard "${dash.title}": moved tile "${r.tile.title}" ${dir}`,
                  `Moved tile "${r.tile.title}" ${dir} in "${dash.title}".`
                );
                break;
              }
              case 'refresh_dashboard': {
                if (!dash.tiles.length) { ev.detail = 'no tiles'; result = `Dashboard "${dash.title}" has no tiles to refresh.`; break; }
                const out = await refreshDashboard(dashboardStore, dash.id, { signal });
                if (out.saveError) { ev.detail = 'save failed'; result = 'ERROR: ' + out.saveError; break; }
                if (out.aborted) throw new AbortedError();
                const ok = out.results.filter((rr) => rr.ok).length;
                const stale = out.results.length - ok;
                ev.detail =
                  `dashboard "${dash.title}": refreshed ${out.results.length} tile${out.results.length === 1 ? '' : 's'} · ${ok} ok, ${stale} stale`;
                const lines = out.results.map((rr) => `${rr.ok ? '✓' : '✗'} ${rr.title} — ${rr.detail}`);
                result = `Refreshed "${dash.title}":\n` + lines.join('\n');
                break;
              }
              default:
                ev.detail = 'unknown action';
                result =
                  `ERROR: unknown edit action "${action}". Use rename_dashboard, rename_tile, remove_tile, move_tile, or refresh_dashboard.`;
            }
            break;
          }
          case 'finish': {
            state.finding = String(a.one_line_finding ?? '').trim();
            turnKind = 'chart';
            result = 'done';
            break;
          }
          case 'finish_explanation': {
            state.finding = String(a.explanation ?? '').trim();
            turnKind = 'explanation';
            result = 'done';
            break;
          }
          case 'delegate_source': {
            // Gating: refused inside a sub-agent (allowDelegate=false → depth-1)
            // and refused when only one source is active (nothing to delegate
            // across — and the tool isn't even in a single-source schema).
            if (!allowDelegate || activeSources.length <= 1) {
              result =
                'ERROR: delegate_source is unavailable here — use the direct fetch/compute tools for this source.';
              ev.detail = 'unavailable';
              break;
            }
            if (turnDelegations >= MAX_DELEGATIONS_PER_TURN) {
              result =
                `ERROR: delegation budget spent (max ${MAX_DELEGATIONS_PER_TURN} per turn). ` +
                'Combine what the sub-agents already returned, or use the direct tools.';
              ev.detail = 'cap reached';
              break;
            }
            const wanted = String(a.source ?? '').trim().toLowerCase();
            const src = activeSources.find(
              (s) => s.id.toLowerCase() === wanted || s.label.toLowerCase() === wanted
            );
            if (!src) {
              result =
                `ERROR: "${a.source}" is not an active source. Active: ` +
                activeSources.map((s) => s.label).join(', ') + '.';
              ev.detail = 'unknown source';
              break;
            }
            turnDelegations++;
            const subQ = String(a.question ?? '').trim();
            // Friendly parent-receipt summary: "World Bank → 'life expectancy…'".
            ev.argSummary = `${src.label} → "${subQ.slice(0, 60)}"`;
            updateTrace();
            const sub = await runSubAgent(src, subQ);
            if (!sub.ok) {
              // Failure: the parent receipt shows an error, the distilled failure
              // summary goes back as the tool result, and the main loop continues.
              ev.status = 'error';
              ev.detail = sub.detail;
              updateTrace();
              return sub.summary;
            }
            ev.detail = sub.detail;
            result = sub.summary;
            break;
          }
          case 'return_findings': {
            // Terminal tool of a sub-agent; consumed by runSubAgent, which reads
            // the summary off the call. Here it just acknowledges the step.
            ev.detail = 'returned';
            result = 'ok';
            break;
          }
          default:
            result = 'unknown tool';
        }
        ev.status = 'ok';
        updateTrace();
        return result;
      } catch (err: any) {
        // A user-stop that aborted an in-flight fetch is not a tool error — mark
        // the receipt neutrally and unwind, rather than recording a torn ERROR
        // receipt and looping on.
        if (err instanceof AbortedError || signal?.aborted) {
          ev.status = 'error';
          ev.detail = 'stopped';
          updateTrace();
          throw new AbortedError();
        }
        // A structured API rejection: render an error receipt and hand the model
        // the specific find_series steer (already "ERROR:"-prefixed). Recoverable
        // — the model's find_series → corrected fetch streams as normal receipts.
        if (err instanceof FetchSteer) {
          ev.status = 'error';
          ev.detail = err.detail;
          updateTrace();
          return err.message;
        }
        ev.status = 'error';
        ev.detail = err?.message ?? String(err);
        updateTrace();
        return 'ERROR: ' + (err?.message ?? String(err));
      }
    }

    async function agentPass(critique?: string, plan?: InsightBrief | null): Promise<void> {
      // On a verifier-FAIL retry (critique set), the first pass already pushed
      // the turn addendum and the question onto the shared messages array, so
      // append only the critique. Re-pushing them would duplicate the question
      // (and the large turn-2+ reminder) in the session for the rest of the run.
      // On the first pass (no critique), push the addendum (turn 2+) + question.
      if (critique) {
        messages.push({
          role: 'user',
          content: 'A previous attempt was judged insufficient. Fix this: ' + critique,
        });
      } else {
        if (turnCount > 1 && !state.rows.length) {
          // Follow-up turn but nothing was ever fetched (e.g. turn 1 was a
          // pure explanation). The data-reuse addendum below would claim
          // "data already fetched: rows=0" and steer the model into
          // computing against an empty dataset — observed burning the whole
          // budget on null execute_js results. Treat as a fresh question.
          messages.push({
            role: 'user',
            content:
              'No data has been fetched yet in this conversation. Treat this as a fresh question: ' +
              'run the full pipeline (search → fetch → compute → chart), or finish_explanation if it is conceptual.',
          });
        } else if (turnCount > 1) {
          const chartSummary = state.chartSpec
            ? `${state.chartSpec.type} chart "${state.chartSpec.title}" with series: ${state.chartSpec.series.map((s) => s.name).join(', ')}`
            : 'none';
          messages.push({
            role: 'user',
            content:
              `Data already fetched this conversation (compressed preview — orientation only, NEVER chart from it):\n${summarizeRows(state.rows)}\n\n` +
              `Current chart: ${chartSummary}.\n\n` +
              'Decide simply — this follow-up is one of three things:\n' +
              '(a) A new view of the SAME data → growth_stats/correlate/execute_js on the existing rows, then render_chart.\n' +
              "(b) Needs data you don't have (new indicator, country, or years) → fetch just that, then continue the pipeline.\n" +
              '(c) Asks to explain or interpret → finish_explanation in prose, no chart.\n' +
              'Never repeat the previous chart or finding — every turn must add something new.',
          });
        }
        // Prepend the insight brief (backlog #10) as a system-side note so the
        // executor commits to the story it set out to surface — but deviation is
        // explicitly sanctioned, so the plan never hardens into a false contract.
        // First pass only: on a retry the note is already in the shared history.
        if (plan) {
          const stepLines = plan.steps
            .map((s, i) => `${i + 1}. ${s.what}${s.tool_hint ? ` [${s.tool_hint}]` : ''}`)
            .join('\n');
          messages.push({
            role: 'system',
            content:
              `Your plan for this question:\nInsight to surface: ${plan.insight}\nSteps:\n${stepLines}` +
              (plan.chart_intent ? `\nChart intent: ${plan.chart_intent}` : '') +
              '\n\nExecute against this. Deviate if the data demands it, and say so when you do.',
          });
        }
        messages.push({ role: 'user', content: question });
      }

      const norm = (m: string) => m.replace(/:free$/, '');
      // Which fallback-chain builder to use for a loop-level model substitution
      // (Fix 2). Injectable via CompleteDeps for tests; the real one otherwise.
      const buildChain = completeDeps.buildFreeFallbackChain ?? buildFreeFallbackChain;
      let calls = 0;
      let noopTurns = 0;
      // The model this turn's executor loop is talking to. Starts as the selected
      // model; after a nudge fails to reform a :free primary it is swapped ONCE to
      // a substitute free model (Fix 2 — a loop-level substitution, since a
      // no-tool-call response is not a transport error and must not enter
      // complete()'s error taxonomy). Every OTHER complete() this turn (verify,
      // summariser, llm(), sub-agents) stays on the selected cfg.
      let activeCfg = cfg;
      let substituted = false;
      while (calls < MAX_TOOL_CALLS) {
        throwIfAborted();
        const status = pipelineStatus(state, calls);
        cb.onStatus(status, 'loading');

        const res = await complete(activeCfg, messages, toolSchemas, completeDeps);
        totalCost += estimateCost(res.servedModel ?? activeCfg.model, res.usage);

        // Note (once per turn) when the free-fallback chain served this call
        // with a different model — visible in the trace and the rail label.
        if (res.servedModel && norm(res.servedModel) !== norm(activeCfg.model) && !fallbackNoted) {
          fallbackNoted = true;
          pushTrace({
            tool: 'fallback',
            argSummary: res.servedModel,
            status: 'ok',
            // Name both models so the substitution is never silent — Chitti
            // shows its work. e.g. "nemotron-…:free unavailable → fell back to
            // nemotron-super-…:free".
            detail: `${activeCfg.model} unavailable → fell back to ${res.servedModel}`,
          });
          cb.onModel?.(res.servedModel);
        }

        if (res.reasoning) {
          pushTrace({ tool: 'reasoning', argSummary: '', status: 'ok', detail: res.reasoning });
        }

        if (!res.toolCalls.length) {
          // Before treating a no-tool-call turn as narration, try to recover a
          // tool call the model printed as JSON text (models with weak native
          // function-calling do this). If we can, dispatch it as if it were
          // native — otherwise the tool never runs and the JSON leaks into the
          // answer. Guarded to the offered tools, so real prose falls through.
          const salvaged = salvageToolCall(res.text, new Set(toolSchemas.map((s) => s.name)));
          if (salvaged) {
            // Unique id per recovered call so two salvaged turns never collide.
            salvaged.id = `${salvaged.id}_${calls}`;
            pushTrace({
              tool: 'salvage',
              argSummary: salvaged.name,
              status: 'ok',
              detail: `recovered a tool call the model wrote as text → ${salvaged.name}`,
            });
            messages.push({ role: 'assistant', content: res.text, tool_calls: [salvaged] });
            calls++;
            const out = await dispatch(salvaged, { tokens: res.usage.input + res.usage.output });
            messages.push({ role: 'tool', tool_call_id: salvaged.id, name: salvaged.name, content: out });
            if (salvaged.name === 'finish' || salvaged.name === 'finish_explanation') return;
            continue;
          }

          noopTurns++;
          const fallbackText = res.text.trim() || res.reasoning?.trim() || '';
          // Per-turn spec here, NOT the session one: on follow-up turns the
          // session still holds last turn's chart, and treating that as "done"
          // ended the turn early with a stale chart and no new work.
          if (turnChartSpec && state.rows.length && fallbackText) {
            state.finding = extractOneSentence(fallbackText);
            return;
          }

          // FIRST no-op this turn (Fix 1): the model returned prose with no tool
          // call and no usable answer — it NARRATED instead of acting (the live
          // failure: a free model describing a fictional "skills" system rather
          // than calling tools). Inject ONE corrective system nudge and let it
          // try again; a muted receipt records the nudge. One nudge per turn.
          if (noopTurns === 1) {
            pushTrace({
              tool: 'nudge',
              argSummary: '',
              status: 'ok',
              detail: 'nudged: model narrated instead of acting',
            });
            messages.push({ role: 'assistant', content: res.text });
            messages.push({
              role: 'system',
              content: turnChartSpec
                ? 'You have function TOOLS (tool calls) — there are no "skills". The chart is already rendered: call finish now with the insight. Do not narrate a plan.'
                : 'You have function TOOLS (tool calls) — there are no "skills". Do not narrate a plan. Call find_series now with a search query for the data you need.',
            });
            calls++;
            continue;
          }

          // Post-nudge and STILL nothing (Fix 2). If the primary is an OpenRouter
          // :free model and we have not already substituted this turn, try ONE
          // substitute free model. This lives in the loop (not complete()): a
          // no-tool-call response is a semantically empty turn, not a transport
          // failure — complete() already returned a valid result — so folding it
          // into the provider error taxonomy would contort it. We reuse
          // buildFreeFallbackChain + the visible 'fallback' substitution receipt.
          if (!substituted && activeCfg.provider === 'openrouter' && activeCfg.model.endsWith(':free')) {
            substituted = true;
            let chain: string[] = [];
            try {
              chain = await buildChain(activeCfg.model);
            } catch {
              chain = [];
            }
            const substitute = chain.find((m) => norm(m) !== norm(activeCfg.model));
            if (substitute) {
              pushTrace({
                tool: 'fallback',
                argSummary: substitute,
                status: 'ok',
                detail: `${activeCfg.model} narrated instead of calling tools → substituted ${substitute}`,
              });
              cb.onModel?.(substitute);
              activeCfg = { ...cfg, model: substitute };
              messages.push({ role: 'assistant', content: res.text });
              messages.push({
                role: 'user',
                content:
                  'You have function TOOLS (tool calls) — there are no "skills". Call find_series now with a search query for the data you need.',
              });
              calls++;
              continue;
            }
          }

          // The nudge (and any substitution) failed to produce a single tool
          // call. Give up — return with an empty run. The turn surfaces honestly
          // as "no result"; the trace carries the nudge + fallback receipts so
          // the reader sees what was tried, and verify() is skipped downstream.
          return;
        }

        messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });

        let finished = false;
        const turnTokens = res.usage.input + res.usage.output;
        // Dispatch EVERY tool_call in this response — never break mid-batch. The
        // assistant message above announced all of them, and an OpenAI/Anthropic
        // history where an assistant tool_call has no matching tool result is a
        // 400 on the next complete(), which would poison the rest of the session.
        // The MAX_TOOL_CALLS cap is a soft budget: overshooting by the few calls
        // in one already-emitted batch is fine; the outer `while` stops us after.
        for (const [idx, tc] of res.toolCalls.entries()) {
          throwIfAborted();
          calls++;
          const out = await dispatch(tc, { tokens: idx === 0 ? turnTokens : undefined });
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out });
          if (tc.name === 'finish' || tc.name === 'finish_explanation') finished = true;
        }
        if (finished) return;

        if (turnChartSpec && state.rows.length && calls >= 6) return;
      }

      if (!state.finding) {
        cb.onStatus('Budget reached — summarizing…', 'loading');
        const res = await complete(
          cfg,
          [
            { role: 'system', content: 'Summarize the analysis so far in ONE sentence with a concrete finding. No caveats.' },
            { role: 'user', content: question + '\n\nData summary:\n' + summarizeRows(state.rows) },
          ],
          [],
          completeDeps
        );
        totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);
        state.finding = res.text.trim() || 'Analysis incomplete within the tool-call budget.';
      }
    }

    // The gated planning turn (backlog #10): ONE extra complete() call, before
    // the tool loop, asking for a structured insight brief. Abort-aware — a stop
    // mid-plan unwinds to the aborted output (no plan card, which is fine). Every
    // other failure (provider error, malformed/unparseable brief) degrades to
    // `null`: the run proceeds EXACTLY as it would with no plan, and NO plan
    // receipt is pushed (we never render a faked or empty plan). Only a
    // well-formed brief pushes the 'plan' event — first in the trace, so the
    // card renders at the top of the turn.
    async function runPlan(q: string): Promise<InsightBrief | null> {
      throwIfAborted();
      const sourceList = activeSources.map((s) => s.label).join(', ');
      const planMessages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You are Chitti\'s planner. BEFORE any data work, commit to the single most specific, ' +
            'surfaceable INSIGHT the question is really after — the concrete story or claim to investigate, ' +
            'NOT a restatement of the question. Then list the few steps to test it.\n\n' +
            'Respond with ONLY a JSON object, no prose, no code fences:\n' +
            '{"insight": "...", "steps": [{"what": "...", "tool_hint": "find_series|fetch_series|execute_js|delegate_source"}], "chart_intent": "...", "sources_expected": ["..."]}\n\n' +
            '- insight: one sharp sentence naming the specific thing worth showing (an outlier, a divergence, a turning point) — a hypothesis, not the question reworded.\n' +
            '- steps: 2–5 concrete actions; tool_hint is optional and only from that set.\n' +
            '- chart_intent: the chart that would make the insight legible (optional).\n' +
            '- sources_expected: which of the active databases you expect to use (optional).',
        },
        {
          role: 'user',
          content: `Question: ${q}\n\nActive databases: ${sourceList}`,
        },
      ];
      // Planning was gated IN, so the absence of a plan card must be EXPLAINED,
      // never silent: whenever the brief turns out unusable (the planning call
      // errored, or its output didn't parse), emit a muted one-line receipt so
      // the reader knows the plan was attempted and skipped — NOT an error dot,
      // and NOT a faked/empty plan card (that carries no `plan` field).
      const skipReceipt = () =>
        pushTrace({
          tool: 'plan',
          argSummary: '',
          status: 'ok',
          detail: 'plan skipped — model returned no usable brief',
        });
      let res;
      try {
        res = await complete(cfg, planMessages, [], completeDeps);
      } catch (err) {
        // A user-stop unwinds to the aborted output; any other provider error
        // just means "no plan" — proceed without one, but say so.
        if (err instanceof AbortedError || signal?.aborted) throw new AbortedError();
        skipReceipt();
        return null;
      }
      totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);
      const brief = parsePlanBrief(res.text);
      if (!brief) {
        // Unusable brief → no plan card, but the muted receipt explains why.
        skipReceipt();
        return null;
      }
      pushTrace({
        tool: 'plan',
        argSummary: '',
        status: 'ok',
        tokens: res.usage.input + res.usage.output,
        plan: brief,
      });
      return brief;
    }

    async function runVerify(critique?: string, insight?: string): Promise<VerificationVerdict> {
      const ev = pushTrace({ tool: 'verify', argSummary: critique ? 'retry' : '', status: 'running' });
      // Hand the verifier the structured ledger entries (truthful URLs +
      // vintages) rather than reconstructed citation strings — light touch, the
      // verdict logic is unchanged (backlog #11 point 5). When a plan was made,
      // the intended insight rides along so the verdict judges the answer
      // against what it SET OUT to show, not only the raw question (backlog #10).
      const result = await verify(cfg, question, turnChartSpec, state.finding, [...state.citations.values()], (c) => (totalCost += c), completeDeps, insight);
      // A genuine pass is the only 'ok' receipt; unverified AND unavailable both
      // read as error receipts (existing torn-receipt styling). The stamp is
      // driven off `pass` alone, so only a real pass can be stamped.
      ev.status = result.status === 'verified' ? 'ok' : 'error';
      ev.pass = result.pass;
      ev.verifyStatus = result.status;
      ev.confidence = result.confidence;
      ev.issues = result.issues;
      ev.detail = result.report;
      ev.tokens = result.tokens;
      updateTrace();
      return result;
    }

    // Build the citation ledger + indicator list the same way for either exit
    // (normal or stopped), so a stopped turn still carries every row and
    // citation it managed to fetch — real data with real provenance.
    const buildOutput = (over: {
      confidence: 'ok' | 'low';
      verification: VerificationVerdict | null;
      retried: boolean;
      aborted: boolean;
    }): AgentOutput => {
      const indicators = [...state.indicators.keys()].map((id) => ({ id, name: indicatorName(id) }));
      const citations = [...state.citations.values()];
      return {
        finding: state.finding,
        // Only the chart rendered THIS turn. Returning the persistent session
        // spec made every chart-less follow-up re-display the previous chart.
        chartSpec: turnChartSpec,
        rows: state.rows,
        // Provenance rides along at the top of the export as `#` comment lines,
        // so a downloaded CSV carries the citation ledger with it (backlog #11).
        csv: citationsToCsvComments(citations) + rowsToCSV(state.rows),
        indicators,
        citations,
        confidence: over.confidence,
        verifierReport: over.verification?.report ?? '',
        verification: over.verification,
        cost: totalCost,
        retried: over.retried,
        kind: turnKind,
        aborted: over.aborted,
      };
    };

    let retried = false;
    let confidence: 'ok' | 'low' = 'ok';
    // The final verdict for the turn (null on an explanation turn — verification
    // does not run for prose answers).
    let verification: VerificationVerdict | null = null;

    try {
      cb.onStatus('Planning…', 'loading');
      // Gated plan mode (backlog #10): a cheap heuristic (or explicit user
      // phrasing) decides if this question earns ONE extra planning turn before
      // the tool loop. A simple lookup skips it entirely — zero extra cost. The
      // brief, when made, is prepended to the executor's context and its insight
      // is later handed to the verifier. A malformed brief → null → the run is
      // identical to today. Only run on the FIRST turn's fresh question shape;
      // planning is a per-question commitment, not re-litigated on the retry.
      const plan = needsPlan(question, activeSources.length) ? await runPlan(question) : null;
      await agentPass(undefined, plan);

      // A stop between the pipeline and verification must not earn a verify call
      // (or a stamp): check before running the verifier.
      throwIfAborted();

      // Empty run (Fix 4): the turn produced no answer text, no chart this turn,
      // and no fetched rows — there is genuinely nothing to verify. Do NOT call
      // verify() at all (no LLM spend, no verdict retry). Record a muted
      // "nothing to verify" receipt (status ok, not error-red) and a distinct
      // 'skipped' verdict so the UI never mislabels an empty run as could-not-
      // verify. Only meaningful under turnKind 'chart'; an explanation turn
      // already skips verification.
      const emptyRun = !state.finding && !turnChartSpec && !state.rows.length;
      if (turnKind === 'chart' && emptyRun) {
        pushTrace({
          tool: 'verify',
          argSummary: '',
          status: 'ok',
          verifyStatus: 'skipped',
          detail: 'nothing to verify — the run produced no result',
        });
        verification = {
          status: 'skipped',
          pass: false,
          confidence: 'none',
          issues: [],
          report: 'nothing to verify — the run produced no result',
        };
        confidence = 'low';
      } else if (turnKind === 'chart') {
        cb.onStatus('Verifying…', 'loading');
        verification = await runVerify(undefined, plan?.insight);
        vfs.write('verifier_report.md', verification.report);

        // Retry ONLY on a genuine 'unverified' verdict — the verifier ran and
        // said the answer isn't good enough. An 'unavailable' verdict (the
        // verify call itself failed) is NOT retried: re-running the pipeline
        // can't fix a verifier network/provider error, a wasted round.
        if (verification.status === 'unverified') {
          throwIfAborted();
          retried = true;
          cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
          await agentPass(verification.report);
          throwIfAborted();
          const second = await runVerify(verification.report, plan?.insight);
          vfs.write('verifier_report.md', verification.report + '\n\n---\nRetry verdict:\n' + second.report);
          verification = second; // the retry's verdict is the turn's final one
        }
        // Low confidence when the final verdict is not a clean pass, or the pass
        // itself came back low-confidence. Verified-but-medium/high stays 'ok'.
        confidence =
          verification.status === 'verified' && verification.confidence !== 'low' ? 'ok' : 'low';
      }
    } catch (err: any) {
      // The user stopped this turn (a boundary check threw, or an in-flight
      // fetch aborted while the signal was set). This is NOT a failure and NOT
      // a rejection to the caller: resolve with an honest aborted output. Any
      // rows/citations fetched so far remain in `state` (and ride out on the
      // output). Roll this turn's messages back to the pre-turn boundary so the
      // shared history stays well-formed (no dangling assistant tool_calls
      // without their tool results) and the session is immediately reusable.
      if (err instanceof AbortedError || signal?.aborted) {
        messages.length = turnStartIndex;
        return buildOutput({ confidence: 'low', verification: null, retried: false, aborted: true });
      }
      throw err;
    }

    cb.onStatus('Done', 'ok');

    // Trim this turn's tool-result messages down to a short marker. state.rows
    // (plain JS memory, not `messages`) remains the durable source of truth for
    // chart data across turns. See the design doc's context retention policy.
    // Only messages pushed during THIS turn are in range; earlier turns were
    // already trimmed when they completed.
    for (let i = turnStartIndex; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.content.length > 200) {
        messages[i] = { ...m, content: `(trimmed — ${m.content.length} chars, see current data summary next turn)` };
      }
    }

    return buildOutput({ confidence, verification, retried, aborted: false });
  }

  return { ask };
}

// Temporary one-shot compatibility wrapper for chitti.astro, which still calls
// this directly. Removed once chitti.astro is updated to call createSession()
// and manage its own session across turns (see the multi-turn UI plan).
export async function runAgent(
  cfg: ProviderConfig,
  question: string,
  cb: AgentCallbacks,
  opts?: SessionOptions
): Promise<AgentOutput> {
  return createSession(cfg, opts).ask(question, cb);
}


// Coerce a model-supplied year bound to a number, treating a JSON `null` (and
// undefined / '') as "no bound". `x !== undefined ? Number(x) : undefined` let
// a `null` through, and Number(null) === 0 — so `year_start: null` ("no lower
// bound") became year 0, a degenerate request range. Only a finite number wins.
function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Well-known hallucinated tool names → the real tool. Some free models
// (observed: OpenRouter NVIDIA models) print a tool call as JSON text and pick
// a plausible-but-wrong name — `fetch_data` for `fetch_series` was the live
// failure. Only names the model was actually offered are ever dispatched (the
// salvager re-checks against the active schema set), so this map is a courtesy,
// not a trust boundary.
const TOOL_NAME_ALIASES: Record<string, string> = {
  fetch_data: 'fetch_series',
  get_data: 'fetch_series',
  get_series: 'fetch_series',
  fetch: 'fetch_series',
  search: 'find_series',
  search_series: 'find_series',
  find: 'find_series',
  chart: 'render_chart',
  plot: 'render_chart',
};

// Recover a tool call a model printed as JSON *text* instead of a native
// tool_call. Without this, a model with unreliable function-calling (several
// free models) sees its `{"tool":"fetch_data","arguments":{…}}` treated as
// narration — the tool never runs and the raw JSON can leak into the answer.
// Accepts the common key spellings ({tool|name|tool_name|action|function},
// {arguments|args|parameters|input}) and a JSON-string arguments value, maps a
// known alias, and returns a ToolCall ONLY when the resolved name is a tool the
// model was offered (`validNames`) — otherwise null, so genuine narration falls
// through to the existing nudge path.
export function salvageToolCall(text: string, validNames: Set<string>): ToolCall | null {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  let rawName: unknown = obj.tool ?? obj.name ?? obj.tool_name ?? obj.action;
  let rawArgs: unknown = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  const fn = obj.function;
  if (typeof rawName !== 'string' && fn && typeof fn === 'object') {
    const f = fn as Record<string, unknown>;
    if (typeof f.name === 'string') rawName = f.name;
    if (rawArgs === undefined) rawArgs = f.arguments ?? f.parameters;
  }
  if (typeof rawName !== 'string' || !rawName.trim()) return null;
  const key = rawName.trim().toLowerCase();
  const name = validNames.has(key) ? key : TOOL_NAME_ALIASES[key] ?? key;
  if (!validNames.has(name)) return null;
  if (typeof rawArgs === 'string') {
    try { rawArgs = JSON.parse(rawArgs); } catch { /* leave as-is → normalized to {} below */ }
  }
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  return { id: 'call_salvaged_' + name, name, arguments: args };
}

// Pull the first plausible one-sentence takeaway out of a model's text.
// Free models sometimes narrate progress instead of calling finish; if they've
// done the real work, we can still get a usable finding.
function extractOneSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/);
  // Prefer the LAST numbery sentence, not the first: this text may be a
  // model's raw reasoning (used as a fallback when `text` was empty, see
  // call site), which explores several numbers while working through the
  // problem before landing on its actual conclusion at the end. Taking the
  // first numbery sentence from reasoning tends to grab an exploratory
  // aside, not the finding.
  const numbery = [...sentences].reverse().find((s) => /\d/.test(s));
  return (numbery || sentences[sentences.length - 1] || t).slice(0, 400);
}

// A short user-facing hint of where we are in the pipeline.
function pipelineStatus(
  state: { rows: unknown[]; chartSpec: unknown; finding: string },
  calls: number
): string {
  if (state.finding) return 'Finalizing…';
  if (state.chartSpec) return 'Verifying answer…';
  if (state.rows && (state.rows as unknown[]).length) return 'Choosing a chart…';
  if (calls > 3) return 'Fetching data…';
  if (calls > 1) return 'Picking indicators…';
  return 'Planning…';
}




// ── Helpers ──
// Compact byte size for the llm() receipt: "812 B", "1.2 KB".
function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function summarizeArgs(tool: string, a: Record<string, unknown>): string {
  switch (tool) {
    case 'find_series':
      return String(a.query ?? '');
    case 'list_countries':
      return String(a.filter ?? 'all');
    case 'fetch_series': {
      const ids = Array.isArray(a.countries) ? (a.countries as string[]) : [];
      const shown = ids.length
        ? ids.slice(0, 4).join(',') + (ids.length > 4 ? `+${ids.length - 4}` : '')
        : 'all countries';
      const hasYears = a.year_start !== undefined || a.year_end !== undefined;
      return `${a.id} · ${shown}` + (hasYears ? ` · ${a.year_start ?? ''}–${a.year_end ?? ''}` : '');
    }
    case 'fetch_worldbank': {
      const ids = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : [];
      const shown = ids.slice(0, 4).join(',') + (ids.length > 4 ? `+${ids.length - 4}` : '');
      return `${a.indicator_id} · ${shown} · ${a.year_start}–${a.year_end}`;
    }
    case 'write_file':
      return String(a.path ?? '');
    case 'read_file':
      return String(a.path ?? '');
    case 'render_chart':
      return `${a.type} · ${a.title}`;
    case 'save_to_dashboard':
      return String(a.dashboard_title ?? a.tile_title ?? 'current chart');
    case 'edit_dashboard': {
      const ref = a.tile_title !== undefined ? `"${a.tile_title}"` : a.tile_index !== undefined ? `#${a.tile_index}` : '';
      return `${a.action ?? ''} · ${a.dashboard_title ?? ''}` + (ref ? ` · ${ref}` : '');
    }
    case 'finish':
      return String(a.one_line_finding ?? '').slice(0, 80);
    case 'delegate_source':
      return `${a.source} → "${String(a.question ?? '').slice(0, 60)}"`;
    case 'return_findings':
      return String(a.summary ?? '').slice(0, 80);
    default:
      return '';
  }
}

