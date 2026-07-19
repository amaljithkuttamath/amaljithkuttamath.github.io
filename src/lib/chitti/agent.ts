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
  growthStats,
  correlate,
  executeJs,
  rowsToCSV,
  INDICATORS,
  resolveSources,
  schemasForSources,
  type SourceDef,
  type ChartSpec,
  type DataRow,
  type SearchReceipt,
} from './tools';
import {
  createRlmRun,
  createTurnBudget,
  provenanceNotice,
  type RlmCaller,
  type RlmReceipt,
} from './rlm';

const MAX_TOOL_CALLS = 12;

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
  // Set only on a 'find_series' step: structured search metadata (databases
  // searched, candidate count, top match + which terms/synonyms fired) that
  // the UI renders as a dedicated search-receipt card. UI-only.
  receipt?: SearchReceipt;
  // Set only on an 'execute_js' step whose code called llm(): one nested
  // receipt per bounded judgment call (prompt summary, data size, duration,
  // tokens, depth). The UI renders these indented under the step, so a
  // model-derived value is always visibly attributed as one.
  rlmReceipts?: RlmReceipt[];
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
  confidence: 'ok' | 'low';
  verifierReport: string;
  cost: number;
  retried: boolean;
  kind: 'chart' | 'explanation';
}

// The system prompt is assembled per session from the active databases, so a
// hard-filtered session is never told about — and never reaches for — a source
// it isn't allowed to use.
function buildSystemPrompt(sources: SourceDef[]): string {
  const labels = sources.map((s) => s.label);
  const many = sources.length > 1;
  const defaultLabel = sources.some((s) => s.id === 'worldbank') ? 'World Bank' : labels[0];
  const snippets = sources.map((s) => '   - ' + s.promptSnippet).join('\n');
  const activeLine = many
    ? `Your active databases (find_series searches all of them at once; prefer ${defaultLabel} when more than one fits):`
    : `Your one active database is ${labels[0]}. find_series searches it:`;

  return `You are Chitti, a data analyst agent. You answer questions about the world with real numbers fetched live from free institutional APIs. Your reasoning and every tool call stream to the user as you work — state decisions in your reasoning, never in files.

DECIDE THE SHAPE FIRST, then commit:
- CONCEPTUAL ("what does X mean", "why does Y matter", "explain…") → call finish_explanation with clear markdown prose. No chart. Only fetch data if one concrete number would sharpen the answer.
- DATA ("which countries…", "compare…", "how has X changed…") → pipeline below, ending in render_chart + finish.

PIPELINE — one step at a time, about 4-5 calls total:

1. FIND THE SERIES — call find_series(query) once. It searches all your active databases together and returns matches as {id, name, source}; pick the id that fits.
   ${activeLine}
${snippets}

2. FETCH ONCE using the fetch tool named for your chosen id's source (see above): explicit ISO3 codes (or one aggregate like WLD) for named countries/regions; fetch_worldbank_all for "every country" questions (country_ids has no wildcard — never build the full country list yourself).

3. COMPUTE with ONE call — never rank/diff numbers in your own reasoning:
   - growth_stats → "changed the most/least" questions (per-country change, %, CAGR, pre-sorted). Prefer this.
   - correlate → relationship between two fetched indicators.
   - execute_js → anything else; \`rows\` is every fetched row: {country, iso3, year, value, indicator}.

4. render_chart. line = time series · bar = ranking · scatter = two indicators · grouped-bar = a few countries side by side. The call's arguments ARE the spec — build them from step 3's result.

5. finish — 1-2 sentences of INSIGHT: the top-line number, then what's notable (the outlier, trend break, or implication). Not a caption. If you used IMF projected years, say "IMF projection". No methodology, no caveats.

Rules:
- Hard budget: ${MAX_TOOL_CALLS} tool calls. Never re-fetch data you already have.
- Use ids from search results verbatim. Years are numbers.
- Only the active databases listed above are available — do not mention or attempt any other source.
- list_countries, write_file, read_file exist but are almost never needed.`;
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
}

export function createSession(cfg: ProviderConfig, opts?: SessionOptions): ChittiSession {
  const activeSources = resolveSources(opts?.sources);
  const toolSchemas = schemasForSources(opts?.sources);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(activeSources) },
  ];
  const vfsFiles: Record<string, string> = {};
  const state: {
    rows: DataRow[];
    chartSpec: ChartSpec | null;
    indicators: Map<string, string>;
    finding: string;
  } = { rows: [], chartSpec: null, indicators: new Map(), finding: '' };

  let turnCount = 0;

  async function ask(question: string, cb: AgentCallbacks): Promise<AgentOutput> {
    turnCount++;
    const trace: TraceEvent[] = [];
    const vfs = new VFS((files) => {
      Object.assign(vfsFiles, files);
      cb.onFiles({ ...vfsFiles });
    });
    let totalCost = 0;
    state.finding = ''; // reset per turn; state.rows/chartSpec/indicators persist
    let turnKind: 'chart' | 'explanation' = 'chart';
    // The chart rendered during THIS turn only. state.chartSpec persists
    // across turns as context (the turn-2+ addendum describes it), but
    // returning/act-ing on the persistent one made every follow-up re-show
    // the previous turn's chart and told the model it was already done.
    let turnChartSpec: ChartSpec | null = null;
    // Whether the model-fallback trace note was already emitted this turn.
    let fallbackNoted = false;
    // The 8-calls-per-turn llm() budget, shared by every execute_js run in
    // this turn (including the verifier-FAIL retry pass, which is the same
    // turn and must not get a fresh allowance).
    const rlmBudget = createTurnBudget();
    // Depth-1 by construction: the nested completion is issued with an EMPTY
    // tool array, so the inner model cannot call execute_js (or anything
    // else) and cannot recurse. There is no depth counter, because there is
    // no edge for the recursion to follow.
    const rlmCaller: RlmCaller = async (prompt: string) => {
      const res = await complete(cfg, [{ role: 'user', content: prompt }], []);
      totalCost += estimateCost(cfg.model, res.usage);
      return { text: res.text, usage: res.usage };
    };
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

    async function dispatch(tc: ToolCall, tokens?: number): Promise<string> {
      const a = tc.arguments;
      const ev = pushTrace({ tool: tc.name, argSummary: summarizeArgs(tc.name, a), status: 'running', tokens });
      try {
        let result = '';
        switch (tc.name) {
          case 'find_series': {
            const { hits, receipt } = await findSeriesWithReceipt(
              String(a.query ?? ''),
              activeSources.map((s) => s.id)
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
          case 'fetch_worldbank': {
            const ids = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : [];
            const { rows, truncatedFrom } = await fetchWorldbank(
              String(a.indicator_id),
              ids,
              Number(a.year_start),
              Number(a.year_end)
            );
            state.rows = state.rows.concat(rows);
            state.indicators.set(String(a.indicator_id), String(a.indicator_id));
            result = summarizeRows(rows);
            if (truncatedFrom) {
              result +=
                `\n\nNOTE: you requested ${truncatedFrom} countries but only the first 60 were ` +
                `fetched (per-call limit). Call fetch_worldbank again with the remaining ` +
                `country_ids and merge results if you need full coverage.`;
            }
            ev.detail = `${rows.length} rows` + (truncatedFrom ? ` (truncated from ${truncatedFrom})` : '');
            break;
          }
          case 'fetch_worldbank_all': {
            const { rows, countryCount, batchCount } = await fetchWorldbankAll(
              String(a.indicator_id),
              Number(a.year_start),
              Number(a.year_end)
            );
            state.rows = state.rows.concat(rows);
            state.indicators.set(String(a.indicator_id), String(a.indicator_id));
            result = summarizeRows(rows);
            ev.detail = `${rows.length} rows · ${countryCount} countries · ${batchCount} batch${batchCount === 1 ? '' : 'es'}`;
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
            // ONE RlmRun across both attempts: the retry below re-executes the
            // same body, and a fresh run would hand that second execution a
            // fresh 4-call allowance, so code calling llm() without returning
            // could spend 8 in what the model wrote as one run.
            const rlmRun = createRlmRun(rlmCaller, rlmBudget);
            let out = await executeJs(code, state.rows, rlmRun.llm);
            if (out.ok && (out.result === null || out.result === undefined) && !/\breturn\b/.test(code)) {
              // Expression-style code with no return — retry wrapped.
              out = await executeJs('return (' + code + ')', state.rows, rlmRun.llm);
            }
            if (rlmRun.receipts.length) ev.rlmReceipts = [...rlmRun.receipts];
            if (out.ok && (out.result === null || out.result === undefined)) {
              result =
                'Your code ran without error but returned null/undefined. It must END with a ' +
                '`return <value>` statement (e.g. "...; return top10;"). Fix that one thing and ' +
                'call execute_js again — do not change your whole approach.';
              ev.detail = 'returned null';
            } else {
              result = out.ok ? JSON.stringify(out.result) : 'ERROR: ' + out.error;
              // State the provenance in the model's own context, not only in
              // the UI: this result is part model judgment, and the model is
              // the thing that decides what to chart and what to claim next.
              if (rlmRun.receipts.length) result = provenanceNotice(rlmRun.receipts.length) + '\n' + result;
              ev.detail =
                (out.ok ? 'ok' : 'error: ' + out.error) +
                (rlmRun.receipts.length
                  ? ` · ${rlmRun.receipts.length} llm() call${rlmRun.receipts.length === 1 ? '' : 's'} (model-derived)`
                  : '');
            }
            break;
          }
          case 'write_file': {
            vfs.write(String(a.path), String(a.content ?? ''));
            result = 'written';
            break;
          }
          case 'read_file': {
            result = vfs.read(String(a.path)) || '(empty)';
            break;
          }
          case 'fetch_owid': {
            const id = String(a.dataset_id ?? '');
            const ids = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : undefined;
            const { rows, metric } = await fetchOwid(
              id,
              ids,
              a.year_start !== undefined ? Number(a.year_start) : undefined,
              a.year_end !== undefined ? Number(a.year_end) : undefined
            );
            state.rows = state.rows.concat(rows);
            const nid = 'owid:' + id.replace(/^owid:/, '');
            state.indicators.set(nid, datasetName(nid) ?? metric);
            result = summarizeRows(rows);
            ev.detail = `${rows.length} rows · OWID`;
            break;
          }
          case 'fetch_imf': {
            const id = String(a.dataset_id ?? '');
            const ids = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : undefined;
            const { rows } = await fetchImf(
              id,
              ids,
              a.year_start !== undefined ? Number(a.year_start) : undefined,
              a.year_end !== undefined ? Number(a.year_end) : undefined
            );
            state.rows = state.rows.concat(rows);
            const nid = 'imf:' + id.replace(/^imf:/, '').toUpperCase();
            state.indicators.set(nid, datasetName(nid) ?? nid);
            result = summarizeRows(rows);
            ev.detail = `${rows.length} rows · IMF (incl. forecasts)`;
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
        totalCost += estimateCost(cfg.model, res.usage);

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
          const out = await dispatch(tc, idx === 0 ? turnTokens : undefined);
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
        totalCost += estimateCost(cfg.model, res.usage);
        state.finding = res.text.trim() || 'Analysis incomplete within the tool-call budget.';
      }
    }

    async function runVerify(critique?: string): Promise<{ pass: boolean; report: string }> {
      const ev = pushTrace({ tool: 'verify', argSummary: critique ? 'retry' : '', status: 'running' });
      const result = await verify(cfg, question, turnChartSpec, state.finding, (c) => (totalCost += c));
      ev.status = result.pass ? 'ok' : 'error';
      ev.pass = result.pass;
      ev.detail = result.report;
      ev.tokens = result.tokens;
      updateTrace();
      return result;
    }

    cb.onStatus('Planning…', 'loading');
    await agentPass();

    let verifierReport = { pass: true, report: '' };
    let retried = false;
    let confidence: 'ok' | 'low' = 'ok';

    if (turnKind === 'chart') {
      cb.onStatus('Verifying…', 'loading');
      verifierReport = await runVerify();
      vfs.write('verifier_report.md', verifierReport.report);

      if (!verifierReport.pass) {
        retried = true;
        cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
        await agentPass(verifierReport.report);
        const second = await runVerify(verifierReport.report);
        vfs.write('verifier_report.md', verifierReport.report + '\n\n---\nRetry verdict:\n' + second.report);
        if (!second.pass) confidence = 'low';
      }
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

    return {
      finding: state.finding,
      // Only the chart rendered THIS turn. Returning the persistent session
      // spec made every chart-less follow-up re-display the previous chart.
      chartSpec: turnChartSpec,
      rows: state.rows,
      csv: rowsToCSV(state.rows),
      indicators,
      confidence,
      verifierReport: verifierReport.report,
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

// ── Verifier: a second LLM call judging whether the chart answers the question.
async function verify(
  cfg: ProviderConfig,
  question: string,
  spec: ChartSpec | null,
  finding: string,
  addCost: (c: number) => void
): Promise<{ pass: boolean; report: string; tokens?: number }> {
  const specText = spec ? JSON.stringify({ type: spec.type, title: spec.title, series: spec.series.map((s) => ({ name: s.name, points: s.data.length })) }) : 'NO CHART RENDERED';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a strict verifier. Given a user question, a rendered chart spec, and a one-line finding, ' +
        'judge whether the chart and finding actually answer the question. ' +
        'Respond with a single line starting with either "PASS:" or "FAIL:" followed by a brief reason. ' +
        'FAIL only for real problems (wrong indicator, no data, chart type mismatched to the question, finding not supported).',
    },
    {
      role: 'user',
      content: `Question: ${question}\n\nChart spec: ${specText}\n\nFinding: ${finding || '(none)'}`,
    },
  ];
  try {
    const res = await complete(cfg, messages, []);
    addCost(estimateCost(cfg.model, res.usage));
    const text = res.text.trim();
    const pass = /^\s*PASS/i.test(text) || (!/^\s*FAIL/i.test(text) && !!spec && !!finding);
    return {
      pass,
      report: text || (spec ? 'PASS: chart rendered.' : 'FAIL: no chart.'),
      tokens: res.usage.input + res.usage.output,
    };
  } catch (err: any) {
    // If the verifier call itself fails, don't block shipping.
    return { pass: !!spec && !!finding, report: 'Verifier unavailable: ' + (err?.message ?? err) };
  }
}

// ── Helpers ──
function summarizeArgs(tool: string, a: Record<string, unknown>): string {
  switch (tool) {
    case 'find_series':
      return String(a.query ?? '');
    case 'list_countries':
      return String(a.filter ?? 'all');
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
