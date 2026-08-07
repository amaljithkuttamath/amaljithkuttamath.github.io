// evals.ts — the eval suite's data model, its grading, and its funnel. Pure:
// this module imports no runtime value from anywhere in the app, so it sits at
// the bottom of the layering next to core.ts and can be graded in a test with
// no network, no key and no DOM.
//
// WHY AN EVAL SUITE LIVES IN THE APP. Chitti's failure mode is not a crash, it
// is a confident wrong answer: the wrong series, the wrong countries, a chart
// with a citation wrapped around it. Nothing in the app noticed that happening
// — the unit tests assert component behaviour and the retrieval eval in
// kb.test.ts covers phrase→series resolution offline, but no test drives a real
// question end to end through the pipeline the user actually gets, because that
// needs the network and (for the agent path) the user's own key. Those are
// exactly the two things only the browser has. So the harness lives here, runs
// on demand, and reports where the pipeline stopped.
//
// THE FUNNEL IS THE POINT. A pass/fail count tells you the suite regressed; it
// does not tell you where. Every answer walks the same six stages — routed →
// resolved → fetched → charted → cited → correct — and each one is a strictly
// harder condition than the last, so a run is a funnel and the drop-off names
// the layer that broke. Retrieval regressions land on `resolved`, a throttled
// or moved API lands on `fetched`, a spec guard lands on `charted`, and a
// silently-wrong series lands on `correct` with everything before it green.
//
// TWO HONESTY RULES, both load-bearing:
//
//  1. A CASE ASSERTS BEHAVIOUR, NEVER A NUMBER. Cases say which series should
//     answer a question and which countries should come back — claims about
//     retrieval and routing, which are ours. No case asserts a value, because
//     the values belong to the source and change when the source updates; an
//     eval that pinned them would either fail on every data release or, worse,
//     tempt someone to write the number down. Same rule the demos file lives
//     under, one layer up: numbers are fetched, never authored.
//
//  2. AN OVER-FIRING FAST PATH IS A FAILURE, NOT A WIN. Half the suite is
//     questions the fast path must REFUSE — ambiguous indicator families, two
//     indicators in one ask, anything needing a ranking. `route: 'agent'` cases
//     fail if the deterministic path answers them. This is the direction the
//     rest of the app is calibrated in (fastpath.ts's MIN_MATCH_SCORE
//     deliberately under-fires), and the suite has to reward it or it would
//     quietly push the threshold the wrong way.
import type { StorageLike } from './dashboard';

// ── The pipeline, as stages ───────────────────────────────────────────────
// Ordered, and each is a superset condition of the next: you cannot chart what
// you did not fetch. The UI renders this array top to bottom as the funnel.
export const EVAL_STAGES = [
  'routed',
  'resolved',
  'fetched',
  'charted',
  'cited',
  'correct',
] as const;

export type EvalStage = (typeof EVAL_STAGES)[number];

// What each stage means, shown in the sidebar so the funnel explains itself.
export const STAGE_LABELS: Record<EvalStage, string> = {
  routed: 'Routed — the expected runner took it',
  resolved: 'Resolved — a series id came back',
  fetched: 'Fetched — rows arrived from the source',
  charted: 'Charted — a valid chart spec was built',
  cited: 'Cited — provenance carries a request URL',
  correct: 'Correct — the expected series and countries',
};

export type StageStatus = 'pass' | 'fail' | 'skip';

export interface StageResult {
  stage: EvalStage;
  status: StageStatus;
  // Why it failed, or what it saw. Kept short — this renders in a sidebar row.
  detail?: string;
}

// ── A case ────────────────────────────────────────────────────────────────
export interface EvalCase {
  id: string;
  question: string;
  // Which runner SHOULD take this question. 'direct' = the deterministic fast
  // path must answer it with no model; 'agent' = the fast path must DECLINE it
  // and the agent answers when a key is connected.
  route: 'direct' | 'agent';
  expect: {
    // Any one of these ids satisfies the case. A list, not a single id, because
    // more than one source can legitimately hold a series and the pick is
    // scored, not hard-coded — pinning exactly one id would fail the day OWID
    // scores higher for the same question without anything being wrong.
    seriesId?: string[];
    // ISO3 codes that must ALL appear in the returned rows.
    countries?: string[];
    minRows?: number;
  };
  // What this case is guarding. Rendered next to a failure, because a failing
  // eval is a question ("did we mean to change this?"), not a verdict.
  why: string;
}

// ── What a run observes ───────────────────────────────────────────────────
// Deliberately compact and JSON-clean: this is what gets persisted per case per
// run, so it must stay small enough that twenty runs fit comfortably in
// localStorage, and carry no rows, no key, no trace.
export interface EvalObservation {
  ranBy: 'direct' | 'agent' | 'none';
  // Normalized series ids seen in the answer's provenance.
  seriesIds: string[];
  rowCount: number;
  // Distinct ISO3 codes present in the rows. Trimmed before a run is persisted
  // (see `compactRun`) — grading has already happened by then, and an
  // every-country answer would otherwise store 200 codes per case per run.
  iso3: string[];
  // The true number of distinct countries, kept so a trimmed `iso3` can never
  // read as a smaller answer than the one that was graded.
  iso3Count?: number;
  charted: boolean;
  // Citations carrying a request URL — the traceability claim, not just a link.
  citedUrls: number;
  error?: string;
  ms: number;
  cost: number;
}

export interface EvalCaseResult {
  id: string;
  question: string;
  route: EvalCase['route'];
  obs: EvalObservation;
  stages: StageResult[];
  passed: boolean;
  // Set when the case was not run at all (e.g. an agent case in a key-free
  // run). A skipped case is never counted as a pass and never enters the
  // funnel's denominator — "not run" and "passed" must not blur.
  skipped?: string;
}

export interface EvalRunSummary {
  total: number;
  ran: number;
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  cost: number;
  // The refusal check, reported separately because it is the one assertion a
  // key-free run CAN make about the agent cases: the fast path was offered a
  // question it must not answer, and declined. `checked` counts the agent cases
  // that reached the routing gate at all; `held` counts the ones that declined.
  // Kept out of pass/fail so a run with no key does not look like a half-failed
  // suite when in fact every refusal held.
  refusalsChecked: number;
  refusalsHeld: number;
}

export interface EvalRun {
  at: string; // ISO timestamp
  mode: 'direct' | 'agent';
  sources: string[];
  provider?: string;
  model?: string;
  results: EvalCaseResult[];
  summary: EvalRunSummary;
}

// ── Grading ───────────────────────────────────────────────────────────────
const norm = (s: string) => String(s ?? '').trim().toLowerCase();

// Ids are compared case-insensitively and prefix-tolerantly: the World Bank
// codes are upper-case by convention but arrive lower-cased through some cache
// keys, and an OWID id may be carried as "owid:slug" or normalized to "slug".
function idMatches(seen: string[], wanted: string[]): boolean {
  const have = new Set(seen.map(norm).map((s) => s.replace(/^[a-z]+:/, '')));
  return wanted.some((w) => have.has(norm(w).replace(/^[a-z]+:/, '')));
}

// Grade one observation against one case. Pure, total, and ordered: the first
// failure stops the walk and every later stage is 'skip', because "charted" is
// not meaningfully false when nothing was ever fetched — reporting it as a
// failure would double-count one break as five.
export function gradeCase(c: EvalCase, obs: EvalObservation): StageResult[] {
  const out: StageResult[] = [];
  let dead = false;
  const step = (stage: EvalStage, ok: boolean, detail?: string) => {
    if (dead) {
      out.push({ stage, status: 'skip' });
      return;
    }
    out.push({ stage, status: ok ? 'pass' : 'fail', ...(detail ? { detail } : {}) });
    if (!ok) dead = true;
  };

  // 0. A runner that errored before any runner committed leaves routing
  //    UNKNOWABLE — reporting it as a routing failure would blame retrieval for
  //    a dead network, and reporting it as a pass would hide the break. So the
  //    route goes ungraded and the error is reported at the first stage where
  //    it was observable. The case still counts as a failure: nothing was
  //    verified.
  if (obs.error && obs.ranBy === 'none') {
    out.push({ stage: 'routed', status: 'skip' });
    out.push({ stage: 'resolved', status: 'fail', detail: obs.error });
    for (const stage of EVAL_STAGES.slice(2)) out.push({ stage, status: 'skip' });
    return out;
  }

  // 1. Routed. For an agent case this is the whole point of the case: the fast
  //    path must have declined it. `ranBy: 'none'` in a key-free run means it
  //    declined and there was no agent to hand to — which is a correct route.
  const routedOk =
    c.route === 'direct' ? obs.ranBy === 'direct' : obs.ranBy !== 'direct';
  step(
    'routed',
    routedOk,
    routedOk
      ? undefined
      : c.route === 'direct'
        ? 'the fast path declined a question it should answer'
        : 'the fast path answered a question it should have escalated'
  );

  if (obs.error) {
    // An error after routing is a real stop, reported where it happened rather
    // than folded into a generic failure.
    step('resolved', false, obs.error);
    step('fetched', false);
    step('charted', false);
    step('cited', false);
    step('correct', false);
    return out;
  }

  step('resolved', obs.seriesIds.length > 0, obs.seriesIds.length ? undefined : 'no series id in the answer');
  step('fetched', obs.rowCount > 0, obs.rowCount ? undefined : 'no rows');
  step('charted', obs.charted, obs.charted ? undefined : 'no chart spec');
  step('cited', obs.citedUrls > 0, obs.citedUrls ? undefined : 'no citation carried a request URL');

  const wantIds = c.expect.seriesId ?? [];
  const wantCountries = (c.expect.countries ?? []).map((x) => x.toUpperCase());
  const missingCountries = wantCountries.filter((x) => !obs.iso3.map((y) => y.toUpperCase()).includes(x));
  const minRows = c.expect.minRows ?? 1;
  let why = '';
  if (wantIds.length && !idMatches(obs.seriesIds, wantIds)) {
    why = `expected ${wantIds.join(' or ')}, got ${obs.seriesIds.join(', ') || '—'}`;
  } else if (missingCountries.length) {
    why = `missing ${missingCountries.join(', ')} in the rows`;
  } else if (obs.rowCount < minRows) {
    why = `${obs.rowCount} rows, expected at least ${minRows}`;
  }
  step('correct', why === '', why || undefined);
  return out;
}

export function casePassed(stages: StageResult[]): boolean {
  return stages.length > 0 && stages.every((s) => s.status === 'pass');
}

// ── The funnel ────────────────────────────────────────────────────────────
export interface FunnelRow {
  stage: EvalStage;
  label: string;
  reached: number; // cases that passed this stage
  lost: number; // cases that failed AT this stage
  pct: number; // reached / ran, 0–1 (0 when nothing ran)
}

// Build the funnel over the cases that actually ran. Skipped cases are excluded
// entirely: a key-free run that could not exercise the agent cases must not
// report them as drop-off, or every key-free run would look like a 50% failure.
export function funnel(results: EvalCaseResult[]): FunnelRow[] {
  const ran = results.filter((r) => !r.skipped);
  return EVAL_STAGES.map((stage) => {
    let reached = 0;
    let lost = 0;
    for (const r of ran) {
      const s = r.stages.find((x) => x.stage === stage);
      if (s?.status === 'pass') reached++;
      else if (s?.status === 'fail') lost++;
    }
    return {
      stage,
      label: STAGE_LABELS[stage],
      reached,
      lost,
      pct: ran.length ? reached / ran.length : 0,
    };
  });
}

export function summarize(results: EvalCaseResult[]): EvalRunSummary {
  const ran = results.filter((r) => !r.skipped);
  const routed = (r: EvalCaseResult) => r.stages.find((s) => s.stage === 'routed');
  const refusals = results.filter((r) => r.route === 'agent' && routed(r)?.status !== 'skip');
  return {
    total: results.length,
    ran: ran.length,
    passed: ran.filter((r) => r.passed).length,
    failed: ran.filter((r) => !r.passed).length,
    skipped: results.length - ran.length,
    // Every case's wall-clock, including the skipped ones: a refusal check still
    // costs the fast path's parse, and time the user waited is time spent.
    ms: results.reduce((a, r) => a + (r.obs.ms || 0), 0),
    cost: results.reduce((a, r) => a + (r.obs.cost || 0), 0),
    refusalsChecked: refusals.length,
    refusalsHeld: refusals.filter((r) => routed(r)?.status === 'pass').length,
  };
}

// The first stage where a case stopped — the one line worth reading when a case
// fails. Null when it passed everything.
export function stoppedAt(stages: StageResult[]): StageResult | null {
  return stages.find((s) => s.status === 'fail') ?? null;
}

// ── Tracking: history in localStorage ─────────────────────────────────────
export const EVALS_KEY = 'chitti:evals';
// Twenty runs is enough to see a trend and small enough to never threaten the
// storage quota dashboards share. Oldest are dropped first.
export const MAX_RUNS = 20;

interface EvalsFile {
  v: 1;
  runs: EvalRun[];
}

// Defensive on the way in, like every other stored shape in this app: a
// malformed or hand-edited file yields an empty history, never a throw.
export function loadRuns(store: StorageLike | null): EvalRun[] {
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(EVALS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const runs = (parsed as EvalsFile).runs;
    if (!Array.isArray(runs)) return [];
    return runs.filter(
      (r): r is EvalRun =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as EvalRun).at === 'string' &&
        Array.isArray((r as EvalRun).results) &&
        !!(r as EvalRun).summary
    );
  } catch {
    return [];
  }
}

export type SaveRunResult = { ok: true; runs: EvalRun[] } | { ok: false; error: string };

// How many country codes survive into storage per case. Twelve is more than any
// case's expectation names, so the stored record still shows what was matched;
// the count is preserved separately either way.
export const STORED_ISO3 = 12;

// Shrink a run to what history needs. The verdicts (`stages`, `passed`) are
// already computed, so nothing here can change a result — it only stops an
// every-country answer from carrying 200 codes into localStorage twenty times
// over, which is how a well-meaning history evicts the user's dashboards.
export function compactRun(r: EvalRun): EvalRun {
  return {
    ...r,
    results: r.results.map((c) => ({
      ...c,
      obs: {
        ...c.obs,
        iso3Count: c.obs.iso3Count ?? c.obs.iso3.length,
        iso3: c.obs.iso3.slice(0, STORED_ISO3),
      },
    })),
  };
}

export function saveRun(store: StorageLike | null, runRecord: EvalRun): SaveRunResult {
  if (!store) return { ok: false, error: 'Browser storage is unavailable — this run was not saved.' };
  const runs = [compactRun(runRecord), ...loadRuns(store)].slice(0, MAX_RUNS);
  try {
    store.setItem(EVALS_KEY, JSON.stringify({ v: 1, runs } satisfies EvalsFile));
  } catch {
    return { ok: false, error: 'Could not save this run — browser storage is full.' };
  }
  return { ok: true, runs };
}

export function clearRuns(store: StorageLike | null): void {
  try {
    store?.removeItem(EVALS_KEY);
  } catch {
    /* nothing to do — clearing is best-effort */
  }
}

// ── Export, so tracking can leave the browser ─────────────────────────────
// A run is only useful over time, and this app has nowhere to send it. Markdown
// is the portable form: paste it into a PR or an issue and the funnel is
// readable without the app. Same instinct as the turn's "Copy Markdown" (okf.ts)
// — the artifact travels, the tool does not have to.
export function runToMarkdown(r: EvalRun): string {
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  const lines: string[] = [];
  lines.push(`# Chitti evals — ${r.at}`);
  lines.push('');
  lines.push(
    `**${r.summary.passed}/${r.summary.ran} passed** · mode: ${r.mode}` +
      (r.model ? ` · ${r.provider ?? ''} ${r.model}`.trimEnd() : '') +
      ` · sources: ${r.sources.join(', ') || 'all'}` +
      (r.summary.skipped ? ` · ${r.summary.skipped} not run` : '') +
      (r.summary.cost > 0 ? ` · ~$${r.summary.cost.toFixed(4)}` : '')
  );
  if (r.summary.refusalsChecked) {
    lines.push('');
    lines.push(
      `Refusals held: **${r.summary.refusalsHeld}/${r.summary.refusalsChecked}** — questions the ` +
        'fast path must escalate rather than answer.'
    );
  }
  lines.push('');
  lines.push('| Stage | Reached | Lost here |');
  lines.push('| --- | ---: | ---: |');
  for (const f of funnel(r.results)) {
    lines.push(`| ${f.stage} | ${f.reached} (${pct(f.reached, r.summary.ran)}%) | ${f.lost || ''} |`);
  }
  lines.push('');
  lines.push('| Case | Route | Result | Stopped at |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of r.results) {
    const stop = stoppedAt(c.stages);
    const verdict = c.skipped ? 'not run' : c.passed ? 'pass' : 'fail';
    const detail = c.skipped ?? (stop ? `${stop.stage}${stop.detail ? ` — ${stop.detail}` : ''}` : '');
    lines.push(`| ${c.question} | ${c.route} | ${verdict} | ${detail} |`);
  }
  lines.push('');
  lines.push(
    '_Cases assert which series and which countries answer a question — never a value. ' +
      'Numbers belong to the source._'
  );
  return lines.join('\n');
}

// ── The chat command ──────────────────────────────────────────────────────
// Evals are reachable from the composer, because that is where the user already
// is. A SLASH PREFIX IS THE FENCE: "/evals" cannot be a question about the
// world, whereas "run evals" plausibly could be, and a composer that swallowed
// a data question to open a panel would be the worst kind of clever. Anything
// after the recognised words returns null and falls through to the normal ask
// path — an unrecognised argument is a question, not a typo to guess at.
export interface EvalCommand {
  run: boolean;
  mode: 'direct' | 'agent';
}

export function parseEvalCommand(input: string): EvalCommand | null {
  const parts = String(input ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts[0] !== '/eval' && parts[0] !== '/evals') return null;
  const rest = parts.slice(1);
  if (!rest.length) return { run: false, mode: 'direct' };
  const words = new Set(rest);
  const known = new Set(['run', 'agent', 'direct', 'fast']);
  if (rest.some((w) => !known.has(w))) return null;
  const mode: EvalCommand['mode'] = words.has('agent') ? 'agent' : 'direct';
  // "/evals agent" means run with the agent — naming a mode is asking for a run.
  return { run: true, mode };
}

// ── The suite ─────────────────────────────────────────────────────────────
// Small on purpose. Every case earns its place by guarding a decision the app
// has already made and could silently lose; a suite nobody reads the failures
// of is worse than no suite. The `direct` half is the deterministic pipeline
// (retrieval → fetch → chart → cite, no key, no cost); the `agent` half is
// mostly the refusals that keep that pipeline honest.
export const EVAL_CASES: EvalCase[] = [
  {
    id: 'life-expectancy-jp-it',
    question: 'life expectancy in Japan and Italy since 1960',
    route: 'direct',
    expect: { seriesId: ['SP.DYN.LE00.IN'], countries: ['JPN', 'ITA'], minRows: 60 },
    why: 'The canonical fast-path shape: one indicator, two countries, a window. If this breaks, the deterministic path is broken.',
  },
  {
    id: 'gdp-per-capita-in-cn',
    question: 'GDP per capita in India and China since 2000',
    route: 'direct',
    // Current US$ and PPP are both honest readings of "GDP per capita" and the
    // knowledge base scores them level, so either passes. What must NOT come
    // back is the aggregate — that is the failure this case is here for.
    expect: { seriesId: ['NY.GDP.PCAP.CD', 'NY.GDP.PCAP.PP.CD'], countries: ['IND', 'CHN'], minRows: 30 },
    why: '"per capita" must select a per-capita series, not the aggregate one — a wrong pick here is the wrong answer with a right-looking chart.',
  },
  {
    id: 'inflation-brazil',
    question: 'inflation in Brazil since 2010',
    route: 'direct',
    // The World Bank CPI series and the IMF's (which carries forecasts) score
    // within a point of each other; both answer the question asked.
    expect: { seriesId: ['FP.CPI.TOTL.ZG', 'imf:PCPIPCH'], countries: ['BRA'], minRows: 10 },
    why: 'A single-country series with a start year and no end year — the open-ended window parse.',
  },
  {
    id: 'population-nigeria',
    question: 'population of Nigeria since 1990',
    route: 'direct',
    expect: { seriesId: ['SP.POP.TOTL'], countries: ['NGA'], minRows: 25 },
    why: 'The plainest possible question. It is in the suite as the canary: if this fails, the failure is upstream of retrieval.',
  },
  {
    id: 'co2-per-capita-us',
    question: 'CO2 emissions per capita in the United States since 1990',
    route: 'direct',
    // OWID currently outscores the World Bank code here. Both are the right
    // measure, which is exactly why this field is a list: pinning one id would
    // fail the day the scorer changes its mind for a good reason.
    expect: { seriesId: ['owid:co-emissions-per-capita', 'EN.GHG.CO2.PC.CE.AR5'], countries: ['USA'], minRows: 20 },
    why: 'A multi-word country name, a term the tokeniser must keep intact ("CO2"), and a series that resolves across two different databases.',
  },
  {
    id: 'life-expectancy-single-year',
    question: 'life expectancy in Brazil, India and Nigeria in 2019',
    route: 'direct',
    expect: { seriesId: ['SP.DYN.LE00.IN'], countries: ['BRA', 'IND', 'NGA'], minRows: 3 },
    why: 'A named single year is a cross-country snapshot (bar), not a series over time — the other branch of the year parse.',
  },
  {
    id: 'child-mortality-india',
    question: 'child mortality in India since 2000',
    route: 'direct',
    expect: { seriesId: ['SH.DYN.MORT', 'owid:child-mortality'], countries: ['IND'], minRows: 15 },
    why: 'The knowledge base\'s headline claim, exercised through the live pipeline rather than in isolation: no word of "child mortality" appears in "Mortality rate, under-5", so only the hierarchy\'s inherited vocabulary can reach it. Flat scoring rates this pair 2 — below the fast path\'s floor — so if the KB stops being consulted first, this case is what notices.',
  },
  {
    id: 'ranking-child-mortality',
    question: 'Which countries reduced child mortality the most since 2000?',
    route: 'agent',
    expect: { seriesId: ['SH.DYN.MORT'], minRows: 20 },
    why: 'A ranking across every country is compute, not a lookup. The fast path must never attempt it.',
  },
  {
    id: 'two-indicators-one-ask',
    question: 'GDP and population in Japan since 2000',
    route: 'agent',
    expect: { countries: ['JPN'], minRows: 20 },
    why: 'Two indicators in one question. The fast path fetches exactly one series, so answering this would silently answer half the question.',
  },
  {
    id: 'ambiguous-mortality',
    question: 'mortality in Kenya',
    route: 'agent',
    expect: { countries: ['KEN'] },
    // KNOWN RED, AND DELIBERATELY SO — do not "fix" this by flipping the route.
    // Measured: the KB scores infant mortality 54 and under-5 52 for the bare
    // word "mortality", so the fast path commits to infant on a two-point
    // margin, charts it, and the user is never told there was a choice. The
    // clarify gate cannot help, because no model ever sees the question. This
    // case is the app's open bug, written down where a run will keep raising
    // it; the fix belongs in retrieval (refuse a near-tie across indicator
    // families), not here.
    why: 'An ambiguous indicator family (under-5? infant? maternal?) belongs to the clarify gate. Charting one reading of it with no model and no mention of the others is the confident-wrong-answer failure this whole app is built to avoid.',
  },
  {
    id: 'correlation-gdp-life',
    question: 'Is GDP per capita correlated with life expectancy across countries?',
    route: 'agent',
    expect: { minRows: 40 },
    why: 'Two series, a join and a statistic — the agent\'s work. Also the case where the pair-coverage rule (never correlate on the latest shared year) is exercised for real.',
  },
];
