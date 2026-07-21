// agent.ts: the deep-agent loop, ported from the langchain-ai/deepagents
// pattern to browser JS. A single top agent calls tools until it calls
// `finish`; a second LLM call then verifies the chart answers the question,
// and if not we retry the pipeline once with the critique in context.

import {
  complete,
  estimateCost,
  type ChatMessage,
  type ProviderConfig,
  type ToolCall,
} from './providers';
import {
  VFS,
  findSeriesWithReceipt,
  datasetName,
  listCountries,
  fetchWorldbank,
  fetchWorldbankAll,
  fetchOwid,
  fetchImf,
  fetchWho,
  growthStats,
  correlate,
  executeJs,
  rowsToCSV,
  citationSourceLabel,
  citationHumanUrl,
  citationsToCsvComments,
  INDICATORS,
  resolveSources,
  schemasForSources,
  subAgentSchemasFor,
  type LlmFn,
  type SourceDef,
  type ChartSpec,
  type DataRow,
  type SearchReceipt,
  type Citation,
} from './tools';
import { resolveCountryList, formatResolutions } from './countries';

const MAX_TOOL_CALLS = 12;

// RLM (Recursive Language Model) bounds for the llm() primitive exposed inside
// execute_js. Hard caps, enforced in code: a run can make at most
// MAX_LLM_PER_RUN calls, and a whole user turn at most MAX_LLM_PER_TURN across
// every execute_js run in it (shared counter). Serialized `data` is refused
// past LLM_DATA_CAP bytes so a single call can't smuggle the whole context
// back into the model — the code must slice smaller. Exceeding any of these
// rejects with a clear, catchable error the model's code can handle.
const MAX_LLM_PER_RUN = 4;
const MAX_LLM_PER_TURN = 8;
const LLM_DATA_CAP = 20_000;

// Depth-1 delegation bounds (delegate_source). A turn may spawn at most
// MAX_DELEGATIONS_PER_TURN per-source sub-agents (shared counter, same pattern
// as turnLlmCalls), and each sub-agent may make at most MAX_SUBAGENT_CALLS tool
// calls before it must return_findings or is stopped. Sub-agent llm() calls
// draw from the SAME per-turn llm budget (MAX_LLM_PER_TURN) as the main loop.
const MAX_DELEGATIONS_PER_TURN = 3;
const MAX_SUBAGENT_CALLS = 6;

// The registry source a fetch id routes to. find_series returns ids that carry
// their source in the namespace, so the router reads it straight off the id:
// "owid:<slug>" → OWID, "imf:<code>" → IMF, a bare code (no ':') → World Bank
// (its ids look like SH.DYN.MORT). A namespaced id whose prefix is neither owid
// nor imf is 'unknown' — NOT silently treated as a World Bank code, so a bad id
// surfaces as a clear routing error instead of a confusing downstream API 404.
// This is the single place fetch source identity is derived (the per-source
// dispatch branches used to each own it).
function fetchSourceOf(id: string): 'worldbank' | 'owid' | 'imf' | 'who' | 'unknown' {
  const s = id.trim().toLowerCase();
  if (s.startsWith('owid:')) return 'owid';
  if (s.startsWith('imf:')) return 'imf';
  if (s.startsWith('who:')) return 'who';
  if (s.includes(':')) return 'unknown';
  return 'worldbank';
}

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

export interface TraceEvent {
  tool: string;
  argSummary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  // Wall-clock time the event was pushed (epoch ms). Drives the receipt's
  // per-line timestamp. Captured once, at push time, not re-derived later.
  ts: number;
  // Tokens consumed by the LLM turn that produced this tool call, when this
  // step is directly attributable to one. Pure data-fetch/file steps that
  // aren't the result of a turn we're attributing usage to stay undefined;
  // the UI omits the token figure rather than showing a fake zero.
  tokens?: number;
  // Set only on the synthetic 'verify' trace event, once the verifier call
  // has returned a verdict. Drives the ink-stamped VERIFIED badge. The UI
  // must only stamp a step where this is true.
  pass?: boolean;
  // The three honest verification outcomes, set only on a 'verify' event:
  //   'verified'    — the verifier ran and passed (pass===true; amber stamp).
  //   'unverified'  — the verifier ran and did NOT confirm the answer, or its
  //                   output was unparseable (could-not-verify). pass===false.
  //   'unavailable' — the verify call itself failed (network/provider error) or
  //                   was skipped. NEVER implies the answer was verified.
  // The UI keys its three answer/receipt treatments off this, never off a
  // defaulted-true pass.
  verifyStatus?: 'verified' | 'unverified' | 'unavailable';
  // The verifier's self-reported confidence in ITS verdict (not the finding's).
  // 'none' when the verifier couldn't run (unavailable). Rendered on the verify
  // receipt beside the verdict.
  confidence?: 'high' | 'medium' | 'low' | 'none';
  // The concrete problems the verifier flagged on a non-pass — each a short
  // sentence naming WHAT was doubted (claim vs source, missing citation, number
  // not found). Empty on a pass. Never fabricated: a malformed/unparseable
  // verdict yields [] (could-not-verify), not invented issues.
  issues?: string[];
  // Set only on a 'find_series' step: structured search metadata (databases
  // searched, candidate count, top match + which terms/synonyms fired) that
  // the UI renders as a dedicated search-receipt card. UI-only.
  receipt?: SearchReceipt;
  // Set on a recursive 'llm' step (an llm() call made from inside execute_js):
  // renders as an indented child line-item under its execute_js parent, so the
  // recursion is visible in the trace. The parent execute_js step immediately
  // precedes this step's run in the event list.
  nested?: boolean;
  // Actual measured wall-clock duration (ms) for a step, when known at push
  // time (the llm() receipts set this). The UI prefers it over its own
  // render-time timer so a staged/offline render still shows a real duration.
  durationMs?: number;
  // Serialized-data size (bytes) attached to an llm() call — the size of the
  // data slice the recursive call reasoned over. UI shows it on the receipt.
  dataBytes?: number;
  // Set true on a write_file step whose content is model-derived (produced via
  // llm(), not fetched). Drives the subtle "model-derived" provenance label.
  derived?: boolean;
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
}

export type VerifyStatus = 'verified' | 'unverified' | 'unavailable';

// The verifier's verdict as it leaves verify()/reaches the UI. `pass` is true
// only when status==='verified' — the two are kept in lockstep so a caller can
// never read a truthy pass out of an unavailable/unverified verdict.
export interface VerificationVerdict {
  status: VerifyStatus;
  pass: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  issues: string[];
  report: string;
  tokens?: number;
}

// The shape parseVerifierVerdict extracts from the verifier's raw text. `null`
// from the parser means "could not be parsed" — the caller treats that as
// could-not-verify (never verified, never fabricated issues).
export interface ParsedVerdict {
  pass: boolean;
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
}

// The system prompt is assembled per session from the active databases, so a
// hard-filtered session is never told about — and never reaches for — a source
// it isn't allowed to use.
export function buildSystemPrompt(sources: SourceDef[], rlm: boolean = false): string {
  const labels = sources.map((s) => s.label);
  const many = sources.length > 1;
  const defaultLabel = sources.some((s) => s.id === 'worldbank') ? 'World Bank' : labels[0];
  const snippets = sources.map((s) => '   - ' + s.promptSnippet).join('\n');
  const activeLine = many
    ? `Your active databases (find_series searches all of them at once; prefer ${defaultLabel} when more than one fits):`
    : `Your one active database is ${labels[0]}. find_series searches it:`;
  // The recursive llm() capability is opt-in and OFF by default. When off, the
  // prompt never mentions it — the model cannot reach for what it is not told
  // exists (withholding, the same discipline as the source filter). When on,
  // the execute_js guidance gains the llm() paragraph and the provenance rule.
  const llmLine = rlm
    ? `\n     Inside execute_js you may also \`await llm(prompt, dataSlice)\` — a bounded recursive model call for SEMANTIC work over data too big or tedious to hold in context: labelling/classifying/summarizing many rows (e.g. tag each country's trend as "rising"/"falling", group indicator names into themes). It returns TEXT only, no tools. Bounds (hard): at most ${MAX_LLM_PER_RUN} llm() calls per execute_js run and ${MAX_LLM_PER_TURN} per turn; the \`data\` you pass must serialize under ~${Math.round(LLM_DATA_CAP / 1000)}KB — slice smaller if it rejects. Over-cap/over-size calls throw a catchable error. Use llm() to reason ABOUT data, never to invent numbers: its output is model-derived, NOT fetched data.`
    : '';
  const provenanceRule = rlm
    ? `- PROVENANCE: anything llm() produces is model-derived, not fetched. Never present it as a data value, cite it, or put it in a chart as if measured. If you save an llm()-derived artifact with write_file, set derived=true so it is labelled model-derived.\n`
    : '';

  return `You are Chitti, a data analyst agent. You answer questions about the world with real numbers fetched live from free institutional APIs. Your reasoning and every tool call stream to the user as you work — state decisions in your reasoning, never in files.

DECIDE THE SHAPE FIRST, then commit:
- CONCEPTUAL ("what does X mean", "why does Y matter", "explain…") → call finish_explanation with clear markdown prose. No chart. Only fetch data if one concrete number would sharpen the answer.
- DATA ("which countries…", "compare…", "how has X changed…") → pipeline below, ending in render_chart + finish.

PIPELINE — one step at a time, about 4-5 calls total:

1. FIND THE SERIES — call find_series(query) once. It searches all your active databases together and returns matches as {id, name, source}; pick the id that fits.
   ${activeLine}
${snippets}

2. FETCH ONCE with fetch_series(id, …): pass the id from find_series verbatim — it routes to the right source automatically. Give explicit countries (ISO3 codes or loose names like "UK"; or one aggregate like WLD) for named countries/regions, or OMIT countries for "every country" questions (fetch_series batches World Bank internally — never build the full country list yourself).

3. COMPUTE with ONE call — never rank/diff numbers in your own reasoning:
   - growth_stats → "changed the most/least" questions (per-country change, %, CAGR, pre-sorted). Prefer this.
   - correlate → relationship between two fetched indicators.
   - execute_js → anything else; \`rows\` is every fetched row: {country, iso3, year, value, indicator}.${llmLine}

4. render_chart. line = time series · bar = ranking · scatter = two indicators · grouped-bar = a few countries side by side. The call's arguments ARE the spec — build them from step 3's result.

5. finish — 1-2 sentences of INSIGHT: the top-line number, then what's notable (the outlier, trend break, or implication). Not a caption. If you used IMF projected years, say "IMF projection". No methodology, no caveats.

Rules:
- Hard budget: ${MAX_TOOL_CALLS} tool calls. Never re-fetch data you already have.
- Use ids from search results verbatim. Years are numbers.
- Only the active databases listed above are available — do not mention or attempt any other source.
${provenanceRule}${many ? `- delegate_source(source, question) runs a focused sub-agent against ONE database and returns a distilled summary; its fetched rows merge into your data with citations intact. Use it ONLY for a question that genuinely spans multiple databases — delegate each source's slice, then combine. For anything one database answers, use the direct tools: delegation spends extra model calls.\n` : ''}- list_countries, write_file, read_file exist but are almost never needed.`;
}

// The system prompt for a depth-1 per-source sub-agent — scoped to ONE
// database. It fetches and distils; it never charts, verifies, or delegates
// (those belong to the main loop, and delegate_source is not in its schema).
export function buildSubAgentPrompt(src: SourceDef, rlm: boolean = false): string {
  // Sub-agents obey the same llm() toggle as the main loop: when RLM is off,
  // their execute_js guidance never mentions llm() either, and their
  // execute_js runs get no llm argument (the shared dispatch gates on the same
  // rlmEnabled). So a delegation cannot become a back door to the capability.
  const execLine = rlm
    ? 'execute_js (compute over the rows fetched so far — you may also `await llm(prompt, dataSlice)` for bounded semantic work)'
    : 'execute_js (compute over the rows fetched so far)';
  return `You are a focused sub-agent. You work with exactly ONE database: ${src.label}.
${src.promptSnippet}

Your tools: find_series (searches ${src.label} only), fetch_series (fetch a ${src.label} id it returns — ids from other sources are refused here), ${execLine}, and return_findings.

Do the minimum needed to answer the sub-question: find the series, fetch it, optionally compute, then call return_findings with a SHORT distilled summary — a few sentences naming the key numbers and what they show. Your fetched rows are automatically merged back to the main agent WITH their citations, so never paste raw rows into the summary. Budget: ${MAX_SUBAGENT_CALLS} tool calls. Call tools; do not narrate a plan in prose.`;
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
  ask(question: string, cb: AgentCallbacks): Promise<AgentOutput>;
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
}

export function createSession(cfg: ProviderConfig, opts?: SessionOptions): ChittiSession {
  const activeSources = resolveSources(opts?.sources);
  const rlmEnabled = opts?.rlm ?? false;
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

  let turnCount = 0;

  async function ask(question: string, cb: AgentCallbacks): Promise<AgentOutput> {
    turnCount++;
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
          const res = await complete(cfg, [{ role: 'user', content: fullPrompt }], []);
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
          const res = await complete(cfg, subMessages, subSchemas);
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
              summary = String(tc.arguments.summary ?? '').trim();
            }
            if (steps >= MAX_SUBAGENT_CALLS) break;
          }
          if (returned) break;
        }
      } catch (err: any) {
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
      const source = fetchSourceOf(id);
      if (source === 'unknown') {
        ev.detail = 'unknown source';
        return (
          `ERROR: cannot route "${id}" — its source namespace is not recognized. Use an id from ` +
          'find_series (a plain World Bank code, "owid:<slug>", or "imf:<code>").'
        );
      }
      if (!allowedSourceIds.includes(source)) {
        ev.detail = 'refused: out-of-source id';
        return (
          `ERROR: "${id}" is a ${source} series, not available ${allowedSourceIds.length === 1 ? 'to this sub-agent' : 'in this session'}. ` +
          `Use a find_series id from: ${allowedSourceIds.join(', ')}.`
        );
      }

      // Resolve loose country inputs ("UK", "Korea", "euro area") to WB
      // ISO3/aggregate codes ONCE, here at the choke point. Unresolved names
      // pass through unchanged; the receipt surfaces any rewrites.
      const hasCountries = Array.isArray(rawCountries) && rawCountries.length > 0;
      const resolved = hasCountries ? resolveCountryList(rawCountries!) : undefined;
      const codes = resolved?.codes ?? [];
      const changes = resolved?.changes ?? [];
      const resNote = changes.length ? `Resolved countries: ${formatResolutions(changes)}.\n` : '';
      const resDetail = changes.length ? `${formatResolutions(changes)} · ` : '';

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
      let nid = id; // the normalized indicator id used as the citation key part
      let requestUrl = ''; // the exact API URL that was hit
      let sourceUpdated: string | undefined; // source data vintage, when present
      switch (source) {
        case 'worldbank': {
          if (hasCountries) {
            const r = await fetchWorldbank(id, codes, Number(ys), Number(ye));
            rows = r.rows;
            requestUrl = r.requestUrl;
            sourceUpdated = r.sourceUpdated;
            body = resNote + summarizeRows(rows);
            if (r.truncatedFrom) {
              body +=
                `\n\nNOTE: you requested ${r.truncatedFrom} countries but only the first 60 were ` +
                `fetched (per-call limit). Call fetch_series again with the remaining countries and merge results.`;
            }
            detail =
              resDetail + `${rows.length} rows` + (r.truncatedFrom ? ` (truncated from ${r.truncatedFrom})` : '');
          } else {
            // No countries → every real country, batched internally.
            const r = await fetchWorldbankAll(id, Number(ys), Number(ye));
            rows = r.rows;
            requestUrl = r.requestUrl;
            sourceUpdated = r.sourceUpdated;
            body = summarizeRows(rows);
            detail = `${rows.length} rows · ${r.countryCount} countries · ${r.batchCount} batch${r.batchCount === 1 ? '' : 'es'}`;
          }
          state.indicators.set(id, id);
          break;
        }
        case 'owid': {
          const r = await fetchOwid(id, hasCountries ? codes : undefined, ys, ye);
          rows = r.rows;
          requestUrl = r.requestUrl;
          nid = 'owid:' + id.replace(/^owid:/, '');
          state.indicators.set(nid, datasetName(nid) ?? r.metric);
          body = resNote + summarizeRows(rows);
          detail = resDetail + `${rows.length} rows · OWID`;
          break;
        }
        case 'imf': {
          const r = await fetchImf(id, hasCountries ? codes : undefined, ys, ye);
          rows = r.rows;
          requestUrl = r.requestUrl;
          nid = 'imf:' + id.replace(/^imf:/, '').toUpperCase();
          state.indicators.set(nid, datasetName(nid) ?? nid);
          body = resNote + summarizeRows(rows);
          detail = resDetail + `${rows.length} rows · IMF (incl. forecasts)`;
          break;
        }
        case 'who': {
          // GHO IndicatorCodes are case-sensitive, so the code is kept verbatim
          // (never upper-cased) — the id from find_series is used as-is.
          const r = await fetchWho(id, hasCountries ? codes : undefined, ys, ye);
          rows = r.rows;
          requestUrl = r.requestUrl;
          nid = 'who:' + id.replace(/^who:/i, '');
          state.indicators.set(nid, datasetName(nid) ?? nid);
          body = resNote + summarizeRows(rows);
          detail = resDetail + `${rows.length} rows · WHO GHO`;
          break;
        }
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
      const humanUrl = citationHumanUrl(source, nid);
      const citation: Citation = {
        id: key,
        source,
        sourceLabel: citationSourceLabel(source),
        indicatorId: nid,
        indicatorName: indicatorName(nid),
        url: humanUrl,
        // Keep the API request URL only when it genuinely differs from the human
        // page (it always does across our sources, but stay honest structurally).
        ...(requestUrl && requestUrl !== humanUrl ? { requestUrl } : {}),
        countries: codes,
        yearRange: ys !== undefined || ye !== undefined ? { start: ys, end: ye } : null,
        fetchedAt: new Date().toISOString(),
        ...(sourceUpdated ? { sourceUpdated } : {}),
        rowCount,
        cached: false,
      };
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
      const a = tc.arguments;
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
              a.year_start !== undefined ? Number(a.year_start) : undefined,
              a.year_end !== undefined ? Number(a.year_end) : undefined,
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
              Number(a.year_start),
              Number(a.year_end),
              sourceIds
            );
            break;
          }
          case 'fetch_worldbank_all': {
            result = await routeFetch(
              ev,
              String(a.indicator_id ?? ''),
              undefined, // no countries → every-country path
              Number(a.year_start),
              Number(a.year_end),
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
            let out = await executeJs(code, state.rows, llm);
            if (out.ok && (out.result === null || out.result === undefined) && !/\breturn\b/.test(code)) {
              // Expression-style code with no return — retry wrapped.
              out = await executeJs('return (' + code + ')', state.rows, llm);
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
              a.year_start !== undefined ? Number(a.year_start) : undefined,
              a.year_end !== undefined ? Number(a.year_end) : undefined,
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
        ev.status = 'error';
        ev.detail = err?.message ?? String(err);
        updateTrace();
        return 'ERROR: ' + (err?.message ?? String(err));
      }
    }

    async function agentPass(critique?: string): Promise<void> {
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
        messages.push({ role: 'user', content: question });
      }

      let calls = 0;
      let noopTurns = 0;
      while (calls < MAX_TOOL_CALLS) {
        const status = pipelineStatus(state, calls);
        cb.onStatus(status, 'loading');

        const res = await complete(cfg, messages, toolSchemas);
        totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);

        // Note (once per turn) when the free-fallback chain served this call
        // with a different model — visible in the trace and the rail label.
        const norm = (m: string) => m.replace(/:free$/, '');
        if (res.servedModel && norm(res.servedModel) !== norm(cfg.model) && !fallbackNoted) {
          fallbackNoted = true;
          pushTrace({
            tool: 'fallback',
            argSummary: res.servedModel,
            status: 'ok',
            // Name both models so the substitution is never silent — Chitti
            // shows its work. e.g. "nemotron-…:free unavailable → fell back to
            // nemotron-super-…:free".
            detail: `${cfg.model} unavailable → fell back to ${res.servedModel}`,
          });
          cb.onModel?.(res.servedModel);
        }

        if (res.reasoning) {
          pushTrace({ tool: 'reasoning', argSummary: '', status: 'ok', detail: res.reasoning });
        }

        if (!res.toolCalls.length) {
          noopTurns++;
          const fallbackText = res.text.trim() || res.reasoning?.trim() || '';
          // Per-turn spec here, NOT the session one: on follow-up turns the
          // session still holds last turn's chart, and treating that as "done"
          // ended the turn early with a stale chart and no new work.
          if (turnChartSpec && state.rows.length && fallbackText) {
            state.finding = extractOneSentence(fallbackText);
            return;
          }
          if (noopTurns >= 2) return;
          messages.push({ role: 'assistant', content: res.text });
          messages.push({
            role: 'user',
            content:
              'Continue by calling a tool. ' +
              (turnChartSpec
                ? 'The chart is already rendered — call finish now with the insight.'
                : 'Pick the next tool in the pipeline, or call finish_explanation if prose answers this better.'),
          });
          calls++;
          continue;
        }

        messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });

        let finished = false;
        const turnTokens = res.usage.input + res.usage.output;
        for (const [idx, tc] of res.toolCalls.entries()) {
          calls++;
          const out = await dispatch(tc, { tokens: idx === 0 ? turnTokens : undefined });
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out });
          if (tc.name === 'finish' || tc.name === 'finish_explanation') finished = true;
          if (calls >= MAX_TOOL_CALLS) break;
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
          []
        );
        totalCost += estimateCost(res.servedModel ?? cfg.model, res.usage);
        state.finding = res.text.trim() || 'Analysis incomplete within the tool-call budget.';
      }
    }

    async function runVerify(critique?: string): Promise<VerificationVerdict> {
      const ev = pushTrace({ tool: 'verify', argSummary: critique ? 'retry' : '', status: 'running' });
      // Hand the verifier the structured ledger entries (truthful URLs +
      // vintages) rather than reconstructed citation strings — light touch, the
      // verdict logic is unchanged (backlog #11 point 5).
      const result = await verify(cfg, question, turnChartSpec, state.finding, [...state.citations.values()], (c) => (totalCost += c));
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

    cb.onStatus('Planning…', 'loading');
    await agentPass();

    let retried = false;
    let confidence: 'ok' | 'low' = 'ok';
    // The final verdict for the turn (null on an explanation turn — verification
    // does not run for prose answers).
    let verification: VerificationVerdict | null = null;

    if (turnKind === 'chart') {
      cb.onStatus('Verifying…', 'loading');
      verification = await runVerify();
      vfs.write('verifier_report.md', verification.report);

      // Retry ONLY on a genuine 'unverified' verdict — the verifier ran and said
      // the answer isn't good enough. An 'unavailable' verdict (the verify call
      // itself failed) is NOT retried: re-running the pipeline can't fix a
      // verifier network/provider error, and doing so would be a wasted round.
      if (verification.status === 'unverified') {
        retried = true;
        cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
        await agentPass(verification.report);
        const second = await runVerify(verification.report);
        vfs.write('verifier_report.md', verification.report + '\n\n---\nRetry verdict:\n' + second.report);
        verification = second; // the retry's verdict is the turn's final one
      }
      // Low confidence when the final verdict is not a clean pass, or the pass
      // itself came back low-confidence. Verified-but-medium/high stays 'ok'.
      confidence =
        verification.status === 'verified' && verification.confidence !== 'low' ? 'ok' : 'low';
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
      confidence,
      verifierReport: verification?.report ?? '',
      verification,
      cost: totalCost,
      retried,
      kind: turnKind,
    };
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

function indicatorName(id: string): string {
  // Enrich the raw indicator id with its friendly curated name when we have
  // one — checking the World Bank list first, then the OWID/IMF catalogs.
  const hit = INDICATORS.find((i) => i.id === id);
  return hit ? hit.name : (datasetName(id) ?? id);
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

// ── Verdict parsing (pure, exported for tests) ────────────────────────────
// Pull the first balanced-looking top-level JSON object out of a text blob.
// The verifier is asked for bare JSON, but models wrap it in ``` fences or a
// sentence of prose; we take the slice from the first '{' to the last '}' and
// try to parse it. Returns a plain object or null (never throws).
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Parse the verifier's raw text into a structured verdict, DEFENSIVELY. The
// contract, in priority order:
//   1. A JSON object {pass:bool, confidence:'high'|'medium'|'low', issues:[str]}
//      — accepted only when ALL three fields are the right shape. A present-but-
//      malformed JSON verdict returns null (could-not-verify) rather than a
//      half-guessed one: we never invent a pass or fabricate issues.
//   2. Legacy "PASS: …" / "FAIL: …" prefix (the pre-structured format, still
//      emitted by older prompts and exercised by the existing tests). PASS →
//      pass with high confidence; FAIL → not-pass, low confidence, the reason
//      text kept as the single issue.
//   3. Anything else (empty, or neither JSON nor a PASS/FAIL prefix) → null.
// A null return ALWAYS means could-not-verify; it never means verified.
export function parseVerifierVerdict(raw: string): ParsedVerdict | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  const json = extractJsonObject(text);
  if (json) {
    const pass = typeof json.pass === 'boolean' ? json.pass : null;
    const conf = json.confidence;
    const confOk = conf === 'high' || conf === 'medium' || conf === 'low';
    const issues = Array.isArray(json.issues)
      ? (json.issues as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : null;
    // Every field must be well-formed. A partial object is could-not-verify.
    if (pass !== null && confOk && issues !== null) {
      return { pass, confidence: conf as 'high' | 'medium' | 'low', issues };
    }
    return null;
  }

  if (/^\s*PASS\b/i.test(text)) {
    return { pass: true, confidence: 'high', issues: [] };
  }
  if (/^\s*FAIL\b/i.test(text)) {
    const reason = text.replace(/^\s*FAIL\s*:?\s*/i, '').trim();
    return { pass: false, confidence: 'low', issues: reason ? [reason] : [] };
  }
  return null;
}

// ── Verifier: a second LLM call judging whether the chart answers the question.
// It returns one of three honest outcomes (see VerifyStatus). It NEVER defaults
// to verified: a provider error is 'unavailable', an unparseable verdict is
// 'unverified' (could-not-verify), and only a genuine parsed pass is 'verified'.
async function verify(
  cfg: ProviderConfig,
  question: string,
  spec: ChartSpec | null,
  finding: string,
  citations: Citation[],
  addCost: (c: number) => void
): Promise<VerificationVerdict> {
  const specText = spec ? JSON.stringify({ type: spec.type, title: spec.title, series: spec.series.map((s) => ({ name: s.name, points: s.data.length })) }) : 'NO CHART RENDERED';
  // The ledger's own entries — truthful source, indicator, URL and vintage,
  // straight from the fetch (not reconstructed). Gives the verifier real
  // provenance to check the finding against.
  const citeText = citations.length
    ? citations
        .map((c) => `${c.sourceLabel}: ${c.indicatorName} (${c.indicatorId}) ${c.url}${c.sourceUpdated ? ` [updated ${c.sourceUpdated}]` : ''}`)
        .join('\n')
    : '(no live data fetched)';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a strict verifier. Given a user question, a rendered chart spec, a one-line finding, and the ' +
        'citation ledger, judge whether the chart and finding actually answer the question and are supported by ' +
        'the cited sources.\n\n' +
        'Respond with ONLY a JSON object, no prose, no code fences:\n' +
        '{"pass": true|false, "confidence": "high"|"medium"|"low", "issues": ["..."]}\n\n' +
        '- pass=false ONLY for real problems: wrong indicator, no data, chart type mismatched to the question, a ' +
        'number in the finding not supported by the sources, or a claim with no citation.\n' +
        '- confidence: how sure you are of THIS verdict.\n' +
        '- issues: one short concrete sentence per real problem, naming WHAT is doubted (claim vs source mismatch, ' +
        'missing citation, number not found in the data). Use an empty array when pass=true.',
    },
    {
      role: 'user',
      content: `Question: ${question}\n\nChart spec: ${specText}\n\nFinding: ${finding || '(none)'}\n\nSources (citation ledger):\n${citeText}`,
    },
  ];
  try {
    const res = await complete(cfg, messages, []);
    addCost(estimateCost(res.servedModel ?? cfg.model, res.usage));
    const text = res.text.trim();
    const tokens = res.usage.input + res.usage.output;
    const parsed = parseVerifierVerdict(text);
    if (!parsed) {
      // The call succeeded but its verdict is unparseable — could-not-verify.
      // Honest: not verified, and NO fabricated issues (we don't know what was
      // wrong, only that we couldn't read the verdict).
      return {
        status: 'unverified',
        pass: false,
        confidence: 'low',
        issues: [],
        report: text || 'Verifier returned an unreadable verdict — could not verify.',
        tokens,
      };
    }
    return {
      status: parsed.pass ? 'verified' : 'unverified',
      pass: parsed.pass,
      confidence: parsed.confidence,
      issues: parsed.issues,
      report: text || (parsed.pass ? 'PASS' : 'FAIL'),
      tokens,
    };
  } catch (err: any) {
    // The verify call itself failed (network/provider error). Verification is
    // UNAVAILABLE — we say so plainly and NEVER imply the answer was verified.
    return {
      status: 'unavailable',
      pass: false,
      confidence: 'none',
      issues: [],
      report: 'verification unavailable — provider error: ' + (err?.message ?? String(err)),
    };
  }
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

// Guard the chart spec into a valid shape (models occasionally return strings).
function normalizeSpec(raw: any): ChartSpec {
  const type = ['line', 'bar', 'scatter', 'grouped-bar'].includes(raw?.type) ? raw.type : 'line';
  const series = Array.isArray(raw?.series) ? raw.series : [];
  const cleanSeries = series.map((s: any) => ({
    name: String(s?.name ?? 'series'),
    data: Array.isArray(s?.data)
      ? s.data
          .map((pt: any) => {
            if (!Array.isArray(pt) || pt.length < 2) return null;
            const x = typeof pt[0] === 'number' ? pt[0] : isNaN(Number(pt[0])) ? pt[0] : Number(pt[0]);
            const y = Number(pt[1]);
            return isNaN(y) ? null : [x, y];
          })
          .filter((p: any) => p !== null)
      : [],
  }));
  return {
    type,
    title: String(raw?.title ?? 'Chart'),
    x_axis: raw?.x_axis ? String(raw.x_axis) : undefined,
    y_axis: raw?.y_axis ? String(raw.y_axis) : undefined,
    series: cleanSeries,
  };
}
