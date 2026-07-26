// fastpath.ts — answering the easy questions without a model.
//
// WHY: Chitti's cheapest, most common question is "this indicator, these
// countries, these years, charted". Routing it through the agent costs an API
// key, four to six chained tool calls on a model that may fumble multi-step
// tool use, and a verifier pass — to produce a chart the app already has every
// deterministic piece to build: `findSeriesWithReceipt` (scoring + the live
// search APIs), `adapter.fetchSeries`, `buildCitation`, `buildOption`. None of
// them involve an LLM. So for the questions we can parse with confidence, we
// skip the model entirely: the answer is instant, free, needs no key, and
// cannot hallucinate, because nothing in the path is capable of inventing a
// number.
//
// THE DESIGN RULE IS "REFUSE, DON'T GUESS." A wrong fast-path answer is much
// worse than no fast path: the user asked one thing and silently got another,
// with a chart that looks authoritative. So `parseFastPath` is deliberately
// conservative and returns null on ANY doubt — every rejection simply falls
// through to the agent, which is exactly where an ambiguous question belongs.
// When adding patterns here, the question to ask is never "could we handle
// this?" but "would we handle it wrong?".
import { adapterOfId } from './sources/index';
import { findSeriesWithReceipt } from './sources/index';
import { scoreSeries } from './scoring';
import { extractCountryMentions } from './planner';
import { buildCitation } from './dashboards-agent';
import { growthStats, type ChartSpec, type Citation, type DataRow } from './tools';
import type { TraceEvent } from './receipts';
import type { SeriesHit } from './sources/types';

// The parsed shape of a fast-path question. Everything the deterministic
// pipeline needs and nothing else.
export interface FastPathPlan {
  // What to search the catalogs for — the question with countries, years and
  // framing words removed.
  indicatorQuery: string;
  countries: string[]; // resolved ISO3 codes, in mention order
  countryNames: string[];
  yearStart?: number;
  yearEnd?: number;
  // 'line' for a series over time, 'bar' for a single-year comparison.
  chartType: 'line' | 'bar';
}

// Phrases that mean the question needs reasoning, ranking, computation across
// entities, or an action — all of which are the agent's job. Any hit rejects
// the question outright. Grouped by why they disqualify, so the list stays
// reviewable rather than becoming a pile of regexes.
const AGENT_ONLY = [
  // Ranking / superlatives / cross-country computation.
  /\b(rank(?:ed|ing)?|top \d+|bottom \d+|fastest|slowest|most|least|highest|lowest|biggest|largest|smallest|best|worst|which countr(?:y|ies)|who (?:has|had)|every countr(?:y|ies)?|all countries)\b/,
  // Relationships between two series.
  /\b(correlat\w*|relationship|versus|vs\.?|against|compared with|driven by|explain(?:s|ed)? the|cause[sd]?)\b/,
  // Conceptual / open-ended.
  /\b(what does|what is meant|why|how come|explain|meaning of|define|should i|do you think)\b/,
  // Projection / speculation — the fast path only reports fetched history.
  /\b(project(?:ed|ion|ions)?|forecast\w*|predict\w*|expect(?:ed)? to|by 20[3-9]\d)\b/,
  // Actions that need the agent's tools.
  /\b(save|pin|dashboard|export|write|download|remember)\b/,
  // Aggregation the fast path does not do.
  /\b(average of|sum of|total across|per capita adjusted|share of world)\b/,
];

// Framing words that carry no indicator meaning. Stripped before searching so
// "chart the GDP per capita of India" searches "gdp per capita", not the verb.
const FRAMING = new Set([
  'chart', 'charts', 'graph', 'plot', 'show', 'shows', 'showing', 'display',
  'give', 'gimme', 'get', 'fetch', 'pull', 'draw', 'make', 'trend', 'trends',
  'me', 'us', 'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'from',
  'and', 'with', 'please', 'can', 'you', 'i', 'want', 'need', 'see', 'look',
  'how', 'has', 'have', 'had', 'did', 'does', 'do', 'is', 'are', 'was', 'were',
  'been', 'be', 'changed', 'change', 'changing', 'over', 'time', 'since',
  'between', 'during', 'until', 'through', 'up', 'data', 'numbers', 'figures',
  'statistics', 'stats', 'series', 'indicator', 'value', 'values', 'level',
  'levels', 'what', 'whats', 'compare', 'comparison', 'across', 'by', 'year',
  'years', 'yearly', 'annual', 'annually', 'last', 'past', 'recent', 'today',
  'now', 'currently', 'about', 'its', 'their', 'his', 'her',
]);

// A plausible data year. Below 1800 is almost certainly not a year in this
// domain, and a future year is not history the sources can serve.
function plausibleYear(n: number, thisYear: number): boolean {
  return n >= 1800 && n <= thisYear;
}

// Pull the year bounds out of a question. Returns the bounds plus the word
// indices consumed, so the caller can strip them from the indicator phrase.
// Recognises the forms people actually type; anything else yields no bounds
// (which is valid — the sources then serve their full range).
export function parseYears(
  question: string,
  thisYear: number
): { yearStart?: number; yearEnd?: number; single?: number; used: number[] } {
  const q = String(question ?? '').toLowerCase();
  const used: number[] = [];
  const collect = (...ys: number[]) => { for (const y of ys) used.push(y); };

  // "from 1990 to 2020" / "between 1990 and 2020" / "1990-2020" / "1990 to 2020"
  const range = q.match(/\b(?:from|between)?\s*(\d{4})\s*(?:-|–|—|to|and|until|through)\s*(\d{4})\b/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (plausibleYear(a, thisYear) && plausibleYear(b, thisYear) && a < b) {
      collect(a, b);
      return { yearStart: a, yearEnd: b, used };
    }
  }

  // "since 2000" / "after 2000" / "from 2000"
  const since = q.match(/\b(?:since|after|from|starting in)\s+(\d{4})\b/);
  if (since) {
    const a = Number(since[1]);
    if (plausibleYear(a, thisYear)) {
      collect(a);
      return { yearStart: a, used };
    }
  }

  // "in the last 20 years" / "over the past 15 years"
  const lastN = q.match(/\b(?:last|past)\s+(\d{1,3})\s+years?\b/);
  if (lastN) {
    const n = Number(lastN[1]);
    if (n >= 2 && n <= 200) return { yearStart: thisYear - n, used };
  }

  // "before 2010" / "up to 2010"
  const before = q.match(/\b(?:before|up to|until|through)\s+(\d{4})\b/);
  if (before) {
    const b = Number(before[1]);
    if (plausibleYear(b, thisYear)) {
      collect(b);
      return { yearEnd: b, used };
    }
  }

  // "in 2019" / "for 2019" / a lone year — a single-year snapshot.
  const one = q.match(/\b(?:in|for|during|at)\s+(\d{4})\b/) || q.match(/\b(\d{4})\b/);
  if (one) {
    const y = Number(one[1]);
    if (plausibleYear(y, thisYear)) {
      collect(y);
      return { yearStart: y, yearEnd: y, single: y, used };
    }
  }

  return { used };
}

// Parse a question into a fast-path plan, or null to hand it to the agent.
// `thisYear` is injected rather than read from the clock so the unit table is
// deterministic.
export function parseFastPath(
  question: string,
  thisYear: number = new Date().getFullYear()
): FastPathPlan | null {
  const raw = String(question ?? '').trim();
  if (raw.length < 6 || raw.length > 200) return null;
  const lower = raw.toLowerCase();

  // Gate 1: anything that needs reasoning, ranking or an action is the agent's.
  for (const re of AGENT_ONLY) if (re.test(lower)) return null;

  // Gate 2: a question with no country in it is either "every country" (an
  // aggregation the fast path deliberately does not do) or too vague to serve.
  const { words, rawWords, mentions } = extractCountryMentions(raw);
  if (!mentions.length) return null;
  const seen = new Set<string>();
  const unique = mentions.filter((m) => (seen.has(m.code) ? false : (seen.add(m.code), true)));
  // More than a handful of named countries is a comparison the agent frames
  // better (and a chart nobody can read).
  if (unique.length > 6) return null;

  const years = parseYears(raw, thisYear);

  // The indicator phrase: everything that is not a country mention, a year, or
  // a framing word. Country spans are removed by index, so "United States" goes
  // in one piece and never leaves "united" behind to poison the search.
  const covered = new Set<number>();
  for (const m of mentions) for (let i = m.start; i < m.end; i++) covered.add(i);
  // Kept on rawWords so "CO2" survives as "CO2" rather than "CO".
  const residual = rawWords.filter((_, i) => !covered.has(i)).filter((w) => !/^\d+$/.test(w));
  const terms = residual.filter((w) => !FRAMING.has(w.toLowerCase()));
  const indicatorQuery = terms.join(' ').trim();

  // Gate 3: nothing recognisable left to search for. "Show me India" has no
  // indicator; that is a question for the agent, not a guess at GDP.
  if (indicatorQuery.length < 3 || terms.length === 0) return null;

  // Gate 4: two indicators in one question ("GDP and population in India") —
  // the fast path fetches exactly one series, so it must not silently answer
  // half the question. Tested on the residual BEFORE framing words are removed:
  // "and" is itself a framing word, so by the time it reaches indicatorQuery it
  // is long gone. A conjunction only disqualifies when it genuinely joins two
  // content phrases — in "Japan and Korea" the countries are already stripped,
  // leaving nothing content-bearing after "and", which is the case we want to
  // keep (two countries, one indicator, a perfectly good fast-path question).
  const conj = residual.findIndex((w) => /^(and|plus|versus|vs)$/i.test(w));
  if (conj !== -1) {
    const contentBefore = residual.slice(0, conj).some((w) => !FRAMING.has(w.toLowerCase()));
    const contentAfter = residual.slice(conj + 1).some((w) => !FRAMING.has(w.toLowerCase()));
    if (contentBefore && contentAfter) return null;
  }

  return {
    indicatorQuery,
    countries: unique.map((m) => m.code),
    countryNames: unique.map((m) => m.name),
    ...(years.yearStart !== undefined ? { yearStart: years.yearStart } : {}),
    ...(years.yearEnd !== undefined ? { yearEnd: years.yearEnd } : {}),
    // A single named year is a snapshot across countries (bar); anything else
    // is a series over time (line).
    chartType: years.single !== undefined ? 'bar' : 'line',
  };
}

// How well the top search hit must match before the fast path will commit to
// it. Below this we do NOT chart a maybe — we hand the question to the agent,
// which can search again, reason about the mismatch, and pick a better id.
//
// Calibrated against the curated catalog rather than guessed. In `scoring.ts` an
// exact phrase hit is +10 and each distinct matched term is +2, so 4 means "the
// phrase appears, or at least two content terms do". Measured: "gdp per capita"
// 22, "inflation" 21, "life expectancy" 20, "population" 18, "literacy rate" 18,
// "CO2 emissions per capita" 10, "unemployment rate" 4, "electricity access" 4 —
// all fire. "child mortality" and "internet users" score 2 (the catalog words
// them "under-5" and "Individuals using the Internet") and so does nonsense like
// "banana exports" — the low end cannot be separated by score, so all three are
// refused and escalate to the agent.
//
// That means the threshold deliberately UNDER-fires: it turns away some good
// matches to guarantee it never charts a bad one. That is the correct direction
// for this trade — a wrong fast answer is worse than a slower right one.
export const MIN_MATCH_SCORE = 4;

export interface FastPathResult {
  plan: FastPathPlan;
  hit: SeriesHit;
  spec: ChartSpec;
  rows: DataRow[];
  citations: Citation[];
  // A factual sentence built from the fetched values — NOT model insight, and
  // never presented as such.
  summary: string;
  // The completed step list, so the caller can render the same receipt the
  // agent's turns show. Identical TraceEvent shape; there are simply no model
  // steps in it, because none happened.
  trace: TraceEvent[];
}

// Why the fast path declined, when it declined after starting. Surfaced so the
// caller can escalate honestly rather than showing a dead end.
export type FastPathMiss =
  | { ok: false; reason: 'no-match' }
  | { ok: false; reason: 'weak-match'; best: SeriesHit }
  | { ok: false; reason: 'no-data'; hit: SeriesHit };

// Run a parsed plan with NO model call: search, fetch, chart, cite. Streams the
// same TraceEvent shape the agent does, so the receipt UI renders it unchanged
// — the user sees the identical timeline, minus the model steps that aren't
// there. Returns a miss (never a guess) when the data doesn't support an answer.
export async function runFastPath(
  plan: FastPathPlan,
  opts: {
    sources?: string[];
    onTrace?: (events: TraceEvent[]) => void;
    signal?: AbortSignal;
  } = {}
): Promise<FastPathResult | FastPathMiss> {
  const trace: TraceEvent[] = [];
  const push = (ev: TraceEvent) => { trace.push(ev); opts.onTrace?.([...trace]); };
  const settle = (ev: TraceEvent, status: 'ok' | 'error', detail: string) => {
    ev.status = status;
    ev.detail = detail;
    opts.onTrace?.([...trace]);
  };

  // 1. Find the series — the same cross-source search the agent's find_series
  //    tool calls, receipt and all.
  const findEv: TraceEvent = {
    tool: 'find_series',
    argSummary: plan.indicatorQuery,
    status: 'running',
    ts: Date.now(),
  };
  push(findEv);
  const { hits, receipt } = await findSeriesWithReceipt(plan.indicatorQuery, opts.sources, opts.signal);
  findEv.receipt = receipt;
  if (!hits.length) {
    settle(findEv, 'error', 'no matching series');
    return { ok: false, reason: 'no-match' };
  }
  const hit = hits[0];
  // Commit only to a confident match. `scoreSeries` is the same scorer that
  // ranked the hits, so this is a threshold on the ranking we already trust.
  const score = scoreSeries(plan.indicatorQuery, hit.id, hit.name);
  if (score < MIN_MATCH_SCORE) {
    settle(findEv, 'error', `best match too weak (${hit.name})`);
    return { ok: false, reason: 'weak-match', best: hit };
  }
  settle(findEv, 'ok', `${hit.name} (${hit.id})`);

  // 2. Fetch it, through the id's own adapter — the same router path a live
  //    run takes.
  const adapter = adapterOfId(hit.id);
  if (!adapter) return { ok: false, reason: 'no-match' };
  const fetchEv: TraceEvent = {
    tool: 'fetch_series',
    argSummary: `${hit.id} · ${plan.countries.join(', ')}`,
    status: 'running',
    ts: Date.now(),
  };
  push(fetchEv);
  const result = await adapter.fetchSeries(
    hit.id,
    plan.countries,
    plan.yearStart,
    plan.yearEnd,
    opts.signal
  );
  const rows: DataRow[] = (result.rows || [])
    .map((r) => ({ ...r, indicator: hit.id }))
    .filter((r) => r.value !== null);
  if (!rows.length) {
    settle(fetchEv, 'error', 'no values for those countries/years');
    return { ok: false, reason: 'no-data', hit };
  }
  settle(fetchEv, 'ok', `${rows.length} rows`);

  const nid = adapter.normalizeId(hit.id);
  const citations = [
    buildCitation(
      `${adapter.citationSource}:${nid}:${plan.countries.join(',')}:${plan.yearStart ?? ''}-${plan.yearEnd ?? ''}`,
      adapter.citationSource,
      nid,
      plan.countries,
      plan.yearStart,
      plan.yearEnd,
      rows.length,
      result.requestUrl || '',
      result.sourceUpdated
    ),
  ];

  // 3. Chart it. Deterministic: the spec is a direct projection of the rows.
  const chartEv: TraceEvent = {
    tool: 'render_chart',
    argSummary: plan.chartType,
    status: 'running',
    ts: Date.now(),
  };
  push(chartEv);
  const label = pickLabel(hit.name, adapter.indicatorLabel(nid, result), nid);
  const spec = buildFastSpec(plan, rows, label);
  settle(chartEv, 'ok', `${spec.series.length} series`);

  return {
    plan, hit, spec, rows, citations, trace,
    summary: buildFastSummary(plan, rows, label),
  };
}

// Choose the human label for the chart title, axis and summary.
//
// The search hit's name wins. `SourceAdapter.indicatorLabel` exists to feed the
// session's indicator map, where the UI later enriches a bare id through
// INDICATOR_MAP — so World Bank implements it as `(nid) => nid` and returns a
// raw code like "NY.GDP.PCAP.CD". The fast path has no such enrichment step, so
// preferring it produced answers reading "India: NY.GDP.PCAP.CD rose from…".
// The catalog name ("GDP per capita (current US$)") is human by construction for
// every source; the adapter label is the fallback, and the id the last resort.
// Pure — exported for its unit table.
export function pickLabel(hitName: string, adapterLabel: string, nid: string): string {
  const hit = (hitName || '').trim();
  // A "name" that is just the id repeated is no better than no name.
  if (hit && hit.toLowerCase() !== nid.toLowerCase()) return hit;
  const adapted = (adapterLabel || '').trim();
  if (adapted && adapted.toLowerCase() !== nid.toLowerCase()) return adapted;
  return nid;
}

// Build the chart spec from fetched rows. Pure — exported for its unit table.
export function buildFastSpec(plan: FastPathPlan, rows: DataRow[], label: string): ChartSpec {
  if (plan.chartType === 'bar') {
    // Single-year snapshot: one bar per country, ordered as asked.
    const byIso = new Map(rows.map((r) => [r.iso3, r]));
    const data: [string, number][] = [];
    for (const code of plan.countries) {
      const r = byIso.get(code);
      if (r && r.value !== null) data.push([r.country, r.value]);
    }
    return {
      type: 'bar',
      title: `${label}${plan.yearStart ? `, ${plan.yearStart}` : ''}`,
      x_axis: 'Country',
      y_axis: label,
      series: [{ name: label, data }],
    };
  }
  // Time series: one line per country, years ascending.
  const byCountry = new Map<string, DataRow[]>();
  for (const r of rows) {
    const list = byCountry.get(r.iso3) || [];
    list.push(r);
    byCountry.set(r.iso3, list);
  }
  const series = plan.countries
    .map((code) => byCountry.get(code))
    .filter((list): list is DataRow[] => !!list && list.length > 0)
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.year - b.year);
      return {
        name: sorted[0].country,
        data: sorted.map((r) => [r.year, r.value as number] as [number, number]),
      };
    });
  const years = rows.map((r) => r.year);
  const span = years.length ? `, ${Math.min(...years)}–${Math.max(...years)}` : '';
  return {
    type: 'line',
    title: `${label}${span}`,
    x_axis: 'Year',
    y_axis: label,
    series,
  };
}

const num = (n: number): string =>
  Math.abs(n) >= 1000
    ? Math.round(n).toLocaleString('en-US')
    : Number(n.toFixed(Math.abs(n) < 10 ? 1 : 0)).toLocaleString('en-US');

// A factual sentence derived ENTIRELY from the fetched rows — first and last
// values, the change between them. It states what the data says and stops.
// It is deliberately not "insight": no model ran, so nothing here may read as
// interpretation the app cannot back up. Pure; exported for its unit table.
export function buildFastSummary(plan: FastPathPlan, rows: DataRow[], label: string): string {
  if (plan.chartType === 'bar') {
    const sorted = [...rows].sort((a, b) => (b.value as number) - (a.value as number));
    if (!sorted.length) return '';
    const year = sorted[0].year;
    if (sorted.length === 1) {
      return `${sorted[0].country}: ${num(sorted[0].value as number)} (${label}, ${year}).`;
    }
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    return (
      `In ${year}, ${hi.country} is highest at ${num(hi.value as number)} and ` +
      `${lo.country} lowest at ${num(lo.value as number)} (${label}).`
    );
  }
  const stats = growthStats(rows).filter((s) => s.firstYear !== s.lastYear);
  if (!stats.length) return '';
  if (stats.length === 1) {
    const s = stats[0];
    const dir = s.absChange >= 0 ? 'rose' : 'fell';
    const pct = s.pctChange === null ? '' : ` (${s.pctChange >= 0 ? '+' : ''}${num(s.pctChange)}%)`;
    return `${s.country}: ${label} ${dir} from ${num(s.firstValue)} in ${s.firstYear} to ${num(s.lastValue)} in ${s.lastYear}${pct}.`;
  }
  // Several countries: report the span and each endpoint compactly, without
  // ranking or editorialising.
  const parts = stats.map(
    (s) => `${s.country} ${num(s.firstValue)} → ${num(s.lastValue)}${s.pctChange === null ? '' : ` (${s.pctChange >= 0 ? '+' : ''}${num(s.pctChange)}%)`}`
  );
  const first = stats[0];
  return `${label}, ${first.firstYear}–${first.lastYear}: ${parts.join('; ')}.`;
}
