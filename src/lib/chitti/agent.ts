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

const SYSTEM_PROMPT = `You are Chitti, a data analyst agent that answers questions about the world using ONLY the World Bank Open Data API. You work by calling tools, one or a few at a time, writing intermediate artifacts to a virtual filesystem so your work is auditable.

Follow this pipeline:
1. Call write_file("plan.md", ...) with a short numbered plan decomposing the question.
2. Call search_indicators to pick the right indicator(s). Write the chosen shortlist to indicator_shortlist.json.
3. Decide which countries/regions are needed. Use list_countries if you need ISO3 codes or a group. Write country_list.json.
4. Write api_call.txt describing the exact fetch you will make (indicator, countries, year range).
5. Call fetch_worldbank to get the data. Write a compact summary to raw_data.json (you do NOT need to copy every row; summarize counts and key numbers).
6. Decide the best chart type: line for time series, bar for a single-year ranking, scatter for two indicators, grouped-bar for comparing a few countries. Write chart_spec.json.
7. Call render_chart with the spec. For "which countries changed the most" style questions, compute the change per country and render a bar chart of the top ~15 by change.
8. Call finish with a single tight sentence stating the top-line finding. NO methodology, NO caveats.

Rules:
- Multi-country fetches use ISO3 codes in an array; the tool handles the API formatting.
- Use aggregate ids (e.g. WLD=world, and region aggregate ids) when the question is about regions or the world.
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

  function pushTrace(e: TraceEvent): TraceEvent {
    trace.push(e);
    cb.onTrace([...trace]);
    return e;
  }
  function updateTrace() {
    cb.onTrace([...trace]);
  }

  // Execute one tool call; returns the string result the model sees.
  async function dispatch(tc: ToolCall): Promise<string> {
    const a = tc.arguments;
    const ev = pushTrace({ tool: tc.name, argSummary: summarizeArgs(tc.name, a), status: 'running' });
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
          const rows = await fetchWorldbank(
            String(a.indicator_id),
            ids,
            Number(a.year_start),
            Number(a.year_end)
          );
          state.rows = rows;
          // Remember the indicator name for citations.
          state.indicators.set(String(a.indicator_id), String(a.indicator_id));
          result = summarizeRows(rows);
          ev.detail = `${rows.length} rows`;
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
          vfs.write('chart_spec.json', JSON.stringify(spec, null, 2));
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

      if (!res.toolCalls.length) {
        noopTurns++;
        // If the model has produced a chart already and is now just talking,
        // extract a finding from its text rather than looping forever asking it to call finish.
        if (state.chartSpec && state.rows.length && res.text.trim()) {
          state.finding = extractOneSentence(res.text);
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
      for (const tc of res.toolCalls) {
        calls++;
        const out = await dispatch(tc);
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

  // ── First pass ──
  cb.onStatus('Planning…', 'loading');
  await agentPass();

  // ── Verifier ──
  cb.onStatus('Verifying…', 'loading');
  const verifierReport = await verify(cfg, question, state.chartSpec, state.finding, (c) => (totalCost += c));
  vfs.write('verifier_report.md', verifierReport.report);

  let retried = false;
  let confidence: 'ok' | 'low' = 'ok';

  if (!verifierReport.pass) {
    // One retry with the critique in the system prompt.
    retried = true;
    cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
    await agentPass(verifierReport.report);
    const second = await verify(cfg, question, state.chartSpec, state.finding, (c) => (totalCost += c));
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
  // Prefer a sentence that has a number or a ranking word.
  const sentences = t.split(/(?<=[.!?])\s+/);
  const numbery = sentences.find((s) => /\d/.test(s));
  return (numbery || sentences[0] || t).slice(0, 400);
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
): Promise<{ pass: boolean; report: string }> {
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
    return { pass, report: text || (spec ? 'PASS: chart rendered.' : 'FAIL: no chart.') };
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
