// agent.ts — the deep-agent loop, ported from the langchain-ai/deepagents
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
  TOOL_SCHEMAS,
  searchIndicators,
  listCountries,
  fetchWorldbank,
  fetchWorldbankAll,
  executeJs,
  rowsToCSV,
  INDICATORS,
  type ChartSpec,
  type DataRow,
} from './tools';

const MAX_TOOL_CALLS = 12;

export interface TraceEvent {
  tool: string;
  argSummary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  // Wall-clock time the event was pushed (epoch ms) — drives the receipt's
  // per-line timestamp. Captured once, at push time, not re-derived later.
  ts: number;
  // Tokens consumed by the LLM turn that produced this tool call, when this
  // step is directly attributable to one. Pure data-fetch/file steps that
  // aren't the result of a turn we're attributing usage to stay undefined —
  // the UI omits the token figure rather than showing a fake zero.
  tokens?: number;
  // Set only on the synthetic 'verify' trace event, once the verifier call
  // has returned a verdict. Drives the ink-stamped VERIFIED badge — the UI
  // must only stamp a step where this is true.
  pass?: boolean;
}

export interface AgentCallbacks {
  onTrace: (events: TraceEvent[]) => void;
  onFiles: (files: Record<string, string>) => void;
  onChart: (spec: ChartSpec) => void;
  onStatus: (msg: string, kind: 'loading' | 'ok' | 'error') => void;
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
}

const SYSTEM_PROMPT = `You are Chitti, a data analyst agent that answers questions about the world using ONLY the World Bank Open Data API. Every tool call you make, and your reasoning before it, is shown live to the user as your work happens — that IS the audit trail. Do not write intermediate planning/shortlist/spec files to narrate a decision you can just state in your reasoning; each extra tool call is a real round-trip with real latency, so only call a tool when you need its actual result.

Minimal pipeline — four tool calls, no more, unless a call fails or you genuinely need extra fetches:
1. search_indicators — pick the right indicator. State which one and why in your reasoning, don't write it to a file.
2. fetch_worldbank (a fixed, named list of countries you already know the ISO3 codes for) OR fetch_worldbank_all (every country — it resolves the full list and batches internally, so never call list_countries yourself just to build a country list for "all countries" questions).
3. execute_js — compute whatever ranking/reduction/percentage-change/comparison the question needs by writing real JS against the fetched rows. Do NOT manually rank, diff, or compare more than a couple of countries in your own reasoning — that is slow and error-prone at scale; write code instead and read back the computed result.
4. render_chart — pick the chart type (line for time series, bar for a single-year ranking, scatter for two indicators, grouped-bar for comparing a few countries) and pass the spec directly as this call's arguments, built from execute_js's result. There is no separate "write the spec, then render it" step — the call's arguments ARE the spec.
Then call finish with a single tight sentence stating the top-line finding. NO methodology, NO caveats.

list_countries, write_file, and read_file still exist for less common cases (a specific named region/group's ISO3 codes, or genuinely needing to stash something too large to hold across many turns) — but for a normal "which countries..." or "all countries" question, you should not need them at all.

Rules:
- Multi-country fetches use ISO3 codes in an array; the tool handles the API formatting.
- Use aggregate ids (e.g. WLD=world, and region aggregate ids) when the question is about a single region or the world as a whole — use fetch_worldbank_all only for genuine "every country" questions.
- fetch_worldbank's country_ids has NO wildcard or "all countries" value — an empty array
  returns nothing; use fetch_worldbank_all for that case instead of trying to build the full list yourself.
- Keep tool arguments minimal and valid. Years must be numbers.
- You have a hard budget of ${MAX_TOOL_CALLS} tool calls. Be efficient. Do NOT re-fetch data you already have.
- The finding must be ONE sentence and contain a concrete number or ranking when possible.`;

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

export async function runAgent(
  cfg: ProviderConfig,
  question: string,
  cb: AgentCallbacks
): Promise<AgentOutput> {
  const trace: TraceEvent[] = [];
  const vfs = new VFS((files) => cb.onFiles(files));
  let totalCost = 0;

  // Shared state captured from tool executions.
  const state: {
    rows: DataRow[];
    chartSpec: ChartSpec | null;
    indicators: Map<string, string>;
    finding: string;
  } = { rows: [], chartSpec: null, indicators: new Map(), finding: '' };

  function pushTrace(e: Omit<TraceEvent, 'ts'>): TraceEvent {
    const withTs: TraceEvent = { ...e, ts: Date.now() };
    trace.push(withTs);
    cb.onTrace([...trace]);
    return withTs;
  }
  function updateTrace() {
    cb.onTrace([...trace]);
  }

  // Execute one tool call; returns the string result the model sees.
  // `tokens`, when given, is the LLM turn's usage that produced this call —
  // attributed to exactly one tool call per turn (the first), so a turn that
  // requests several tool calls at once doesn't double-count its usage.
  async function dispatch(tc: ToolCall, tokens?: number): Promise<string> {
    const a = tc.arguments;
    const ev = pushTrace({ tool: tc.name, argSummary: summarizeArgs(tc.name, a), status: 'running', tokens });
    try {
      let result = '';
      switch (tc.name) {
        case 'search_indicators': {
          const hits = await searchIndicators(String(a.query ?? ''), a.topic ? String(a.topic) : undefined);
          result = JSON.stringify(hits.map((h) => ({ id: h.id, name: h.name })));
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
          // Accumulate rather than overwrite: a question may need more than
          // one fetch (e.g. a truncation follow-up call), and execute_js
          // should see every row fetched so far, not just the last call's.
          state.rows = state.rows.concat(rows);
          // Remember the indicator name for citations.
          state.indicators.set(String(a.indicator_id), String(a.indicator_id));
          // Tell the model explicitly when its country list got truncated —
          // otherwise it has no signal the data is incomplete and will
          // report a finding as if every requested country were fetched.
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
          const { ok, result: value, error } = executeJs(String(a.code ?? ''), state.rows);
          result = ok ? JSON.stringify(value) : 'ERROR: ' + error;
          ev.detail = ok ? 'ok' : 'error: ' + error;
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
        case 'render_chart': {
          const spec = normalizeSpec(a as unknown as ChartSpec);
          state.chartSpec = spec;
          cb.onChart(spec);
          result = 'rendered';
          break;
        }
        case 'finish': {
          state.finding = String(a.one_line_finding ?? '').trim();
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

  // One full agent pass (planner + tool loop up to the cap). Optionally seeded
  // with a verifier critique to steer a retry.
  async function agentPass(critique?: string): Promise<void> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT + (critique ? '\n\nA previous attempt was judged insufficient. Fix this: ' + critique : '') },
      { role: 'user', content: question },
    ];

    let calls = 0;
    let noopTurns = 0;  // model kept talking without calling tools
    while (calls < MAX_TOOL_CALLS) {
      // Give a more informative status hint based on where we are in the pipeline.
      const status = pipelineStatus(state, calls);
      cb.onStatus(status, 'loading');

      const res = await complete(cfg, messages, TOOL_SCHEMAS);
      totalCost += estimateCost(cfg.model, res.usage);

      // OpenRouter reasoning models only (cfg.requestReasoning gates the
      // request itself in providers.ts) — a synthetic trace event, same
      // pattern as the 'verify' step, so the receipt shows what the model
      // was thinking right before the tool calls it made as a result.
      if (res.reasoning) {
        pushTrace({ tool: 'reasoning', argSummary: '', status: 'ok', detail: res.reasoning });
      }

      if (!res.toolCalls.length) {
        noopTurns++;
        // If the model has produced a chart already and is now just talking,
        // extract a finding from its text rather than looping forever asking it to call finish.
        // Reasoning models sometimes put this "here's my summary" narration
        // entirely in `reasoning` with an empty `text` (observed directly:
        // a real run rendered a correct, verified chart, then had a no-tool
        // turn whose `reasoning` field said "the chart has been rendered,
        // let me summarize..." while `text` was blank — falling back to
        // `text` alone produced "No finding produced." despite a real
        // finding being sitting right there in `reasoning`).
        const fallbackText = res.text.trim() || res.reasoning?.trim() || '';
        if (state.chartSpec && state.rows.length && fallbackText) {
          state.finding = extractOneSentence(fallbackText);
          return;
        }
        // If it keeps refusing to call tools, give up on nudging and bail to
        // the post-loop summarizer.
        if (noopTurns >= 2) return;
        messages.push({ role: 'assistant', content: res.text });
        messages.push({
          role: 'user',
          content:
            'Continue by calling a tool. ' +
            (state.chartSpec
              ? 'The chart is already rendered — call finish now with a one-line finding.'
              : 'Pick the next tool in the pipeline.'),
        });
        calls++;
        continue;
      }

      messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });

      let finished = false;
      const turnTokens = res.usage.input + res.usage.output;
      for (const [idx, tc] of res.toolCalls.entries()) {
        calls++;
        // Attribute this turn's usage to the first tool call it produced only.
        const out = await dispatch(tc, idx === 0 ? turnTokens : undefined);
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out });
        if (tc.name === 'finish') finished = true;
        if (calls >= MAX_TOOL_CALLS) break;
      }
      if (finished) return;

      // Early-exit heuristic: if we've rendered a chart with real data and
      // used at least 6 calls, don't wait for the model to explicitly finish
      // — synthesize the finding from the data. Prevents the free auto-router
      // from burning tool-call budget on redundant write_file spam.
      if (state.chartSpec && state.rows.length && calls >= 6) return;
    }

    // Hit the cap without finishing: force a summary from what we have.
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

  // Runs the verifier LLM call wrapped in a trace event, so the receipt has
  // a visible 'verify' line-item to ink-stamp (or cross out) — separate from
  // `verify()` itself, which stays a pure judge call untouched by trace concerns.
  async function runVerify(critique?: string): Promise<{ pass: boolean; report: string }> {
    const ev = pushTrace({ tool: 'verify', argSummary: critique ? 'retry' : '', status: 'running' });
    const result = await verify(cfg, question, state.chartSpec, state.finding, (c) => (totalCost += c));
    ev.status = result.pass ? 'ok' : 'error';
    ev.pass = result.pass;
    ev.detail = result.report;
    ev.tokens = result.tokens;
    updateTrace();
    return result;
  }

  // ── First pass ──
  cb.onStatus('Planning…', 'loading');
  await agentPass();

  // ── Verifier ──
  cb.onStatus('Verifying…', 'loading');
  const verifierReport = await runVerify();
  vfs.write('verifier_report.md', verifierReport.report);

  let retried = false;
  let confidence: 'ok' | 'low' = 'ok';

  if (!verifierReport.pass) {
    // One retry with the critique in the system prompt.
    retried = true;
    cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
    await agentPass(verifierReport.report);
    const second = await runVerify(verifierReport.report);
    vfs.write('verifier_report.md', verifierReport.report + '\n\n---\nRetry verdict:\n' + second.report);
    if (!second.pass) confidence = 'low';
  }

  cb.onStatus('Done', 'ok');

  const indicators = [...state.indicators.keys()].map((id) => ({ id, name: indicatorName(id) }));

  return {
    finding: state.finding,
    chartSpec: state.chartSpec,
    rows: state.rows,
    csv: rowsToCSV(state.rows),
    indicators,
    confidence,
    verifierReport: verifierReport.report,
    cost: totalCost,
    retried,
  };
}

function indicatorName(id: string): string {
  // Enrich the raw indicator id with its friendly curated name when we have one.
  const hit = INDICATORS.find((i) => i.id === id);
  return hit ? hit.name : id;
}

// Pull the first plausible one-sentence takeaway out of a model's text.
// Free models sometimes narrate progress instead of calling finish; if they've
// done the real work, we can still get a usable finding.
function extractOneSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const sentences = t.split(/(?<=[.!?])\s+/);
  // Prefer the LAST numbery sentence, not the first: this text may be a
  // model's raw reasoning (used as a fallback when `text` was empty — see
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
    case 'search_indicators':
      return String(a.query ?? '') + (a.topic ? ` · ${a.topic}` : '');
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
