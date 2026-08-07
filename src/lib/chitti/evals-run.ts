// evals-run.ts — the eval runner: it drives cases through the same two paths a
// user's question takes, and hands each result to the pure grader in evals.ts.
//
// THE SEAMS ARE THE DESIGN. Both runners are injected. `makeDirectRunner` is
// the real deterministic path (parseFastPath → runFastPath, no model, no key),
// and the agent runner is supplied by the caller because only the UI holds the
// key and the provider config. That split buys two things: the runner is
// testable offline with fakes (no network, no key, no DOM — see
// evals-run.test.ts), and the module never imports a session, so nothing in the
// agent layer depends on the eval layer or vice versa.
//
// A FRESH SESSION PER CASE, ALWAYS. The caller's agent runner must create a new
// session for every case. Reusing one would make case N+1 a follow-up to case N
// — the agent would answer "mortality in Kenya" against whatever the previous
// question established, and the suite would be measuring conversation memory
// instead of the thing each case claims to measure.
//
// SPENDING THE USER'S KEY IS A DECISION, NOT A DEFAULT. The agent runs only for
// cases whose expected route is the agent, and only when the caller asked for
// agent mode. A `direct` case the fast path declined has already failed at
// routing; escalating it would spend money to grade stages that are recorded as
// skipped anyway.
import { parseFastPath, runFastPath } from './fastpath';
import {
  gradeCase,
  casePassed,
  type EvalCase,
  type EvalCaseResult,
  type EvalObservation,
} from './evals';
import type { DataRow } from './core';
import type { Citation } from './tools';

// The same ceiling the composer puts on a direct answer: the fast path's whole
// promise is that it is quick, and a hung source API must not strand a suite
// run with no way out.
export const EVAL_FAST_TIMEOUT_MS = 20_000;

// What a runner reports back. Deliberately the smallest shape that both paths
// can produce and the grader can read.
export interface RunnerAnswer {
  rows: DataRow[];
  citations: Citation[];
  charted: boolean;
  cost?: number;
  error?: string;
  aborted?: boolean;
}

// Declining and stalling are different events and the funnel must not blur
// them. REFUSED means the fast path never committed — the question did not
// parse, or the top match scored below the floor. That is a routing outcome,
// and for an `agent` case it is the correct one. STALLED means it did commit to
// a series and then got nothing back (an empty fetch, a dead API, a thrown
// request): routing was right and the break is downstream, so it is graded
// downstream. Collapsing the two would report every source outage as a
// retrieval regression.
export type DirectOutcome =
  | { answered: false; declined: 'refused' }
  | { answered: false; declined: 'stalled'; seriesId?: string; error?: string }
  | ({ answered: true } & RunnerAnswer);

export interface EvalDeps {
  // Runs the deterministic path. `answered: false` means the fast path declined
  // — which for an `agent` case is the correct outcome, not a failure.
  direct(question: string, signal?: AbortSignal): Promise<DirectOutcome>;
  // Runs the full agent. Absent → a key-free run: agent cases are refusal-
  // checked only. MUST use a fresh session per call (see above).
  agent?(question: string, signal?: AbortSignal): Promise<RunnerAnswer>;
}

export interface RunOptions {
  mode: 'direct' | 'agent';
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, current: EvalCase) => void;
  onResult?: (result: EvalCaseResult) => void;
  // Injected so a test can assert the recorded duration without a real clock.
  now?: () => number;
}

// Build an observation from whatever a runner returned. The series ids come
// from the CITATIONS, not from the chart or the model's prose: the citation
// ledger is the app's own record of what was actually fetched, so grading
// against it grades the same provenance the user is shown.
export function observe(
  ranBy: EvalObservation['ranBy'],
  answer: Partial<RunnerAnswer>,
  ms: number
): EvalObservation {
  const citations = answer.citations ?? [];
  const rows = answer.rows ?? [];
  const iso3 = [...new Set(rows.map((r) => String(r.iso3 ?? '')).filter(Boolean))];
  return {
    ranBy,
    seriesIds: [...new Set(citations.map((c) => c.indicatorId).filter(Boolean))],
    rowCount: rows.length,
    iso3,
    iso3Count: iso3.length,
    charted: !!answer.charted,
    citedUrls: citations.filter((c) => !!c.requestUrl).length,
    ...(answer.error ? { error: answer.error } : {}),
    ms,
    cost: answer.cost ?? 0,
  };
}

function emptyObservation(ms: number, error?: string): EvalObservation {
  return observe('none', error ? { error } : {}, ms);
}

// Run one case. Never throws: a runner that blows up is recorded as an error on
// the case, because a suite that dies on case three tells you less than a suite
// that finishes and shows you where case three stopped.
export async function runEvalCase(
  c: EvalCase,
  deps: EvalDeps,
  opts: RunOptions
): Promise<EvalCaseResult> {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const wantsAgent = c.route === 'agent' && opts.mode === 'agent' && !!deps.agent;

  let obs: EvalObservation;
  let aborted = false;

  let direct: DirectOutcome;
  try {
    direct = await deps.direct(c.question, opts.signal);
  } catch (e: any) {
    // A runner that throws before committing to anything has refused, not
    // stalled — but the message still travels, so the stage detail can say the
    // fast path errored rather than implying it made a judgement.
    direct = { answered: false, declined: 'stalled', error: e?.message ?? String(e) };
  }

  if (direct.answered) {
    obs = observe('direct', direct, now() - startedAt);
    aborted = !!direct.aborted;
  } else if (direct.declined === 'stalled') {
    obs = direct.seriesId
      ? {
          // It committed to a series and then got nothing. Routing and
          // retrieval both happened; the break is at the fetch.
          ...observe('direct', { ...(direct.error ? { error: direct.error } : {}) }, now() - startedAt),
          seriesIds: [direct.seriesId],
        }
      : // It threw before committing to anything. We cannot say whether routing
        // was right, and guessing would either invent an over-fire or blame
        // retrieval for a dead network — so the route goes ungraded and the
        // error is reported where it was first observable.
        observe('none', { error: direct.error ?? 'the fast path stopped without an answer' }, now() - startedAt);
  } else if (wantsAgent) {
    try {
      const a = await deps.agent!(c.question, opts.signal);
      obs = observe('agent', a, now() - startedAt);
      aborted = !!a.aborted;
    } catch (e: any) {
      obs = observe('agent', { error: e?.message ?? String(e) }, now() - startedAt);
    }
  } else {
    // The fast path declined and no agent was asked for. For an `agent` case
    // that is the expected outcome; the routing gate below is what grades it.
    obs = emptyObservation(now() - startedAt, direct.error);
  }

  const stages = gradeCase(c, obs);
  const routed = stages.find((s) => s.stage === 'routed');

  // "Not run" vs "failed" must never blur. An agent case that correctly
  // escalated in a key-free run has PASSED the only assertion this mode can
  // make (the refusal held) and has not been graded on anything else.
  let skipped: string | undefined;
  if (aborted) skipped = 'stopped';
  else if (c.route === 'agent' && obs.ranBy !== 'agent' && routed?.status === 'pass') {
    skipped = deps.agent
      ? 'refusal held — agent run not requested'
      : 'refusal held — the agent run needs a key';
  }

  return {
    id: c.id,
    question: c.question,
    route: c.route,
    obs,
    stages,
    passed: !skipped && casePassed(stages),
    ...(skipped ? { skipped } : {}),
  };
}

// Run the suite in order, one case at a time. Sequential on purpose: these
// calls hit public APIs that rate-limit, and a parallel burst is the fastest
// way to turn a green suite into a wall of 429s that look like real failures.
export async function runEvalSuite(
  cases: EvalCase[],
  deps: EvalDeps,
  opts: RunOptions
): Promise<EvalCaseResult[]> {
  const out: EvalCaseResult[] = [];
  for (const c of cases) {
    if (opts.signal?.aborted) break;
    opts.onProgress?.(out.length, cases.length, c);
    const r = await runEvalCase(c, deps, opts);
    out.push(r);
    opts.onResult?.(r);
  }
  return out;
}

// The real deterministic runner. Mirrors what the composer does for a typed
// question — same parse, same timeout, same source filter — so a `direct` case
// passing here means the user would get that answer.
export function makeDirectRunner(sources: string[]): EvalDeps['direct'] {
  return async (question, signal) => {
    const plan = parseFastPath(question);
    if (!plan) return { answered: false, declined: 'refused' };
    const res = await runFastPath(plan, {
      sources,
      signal: signal ?? AbortSignal.timeout(EVAL_FAST_TIMEOUT_MS),
    });
    if ('ok' in res) {
      // 'no-data' is the one miss that already picked a series: the fast path
      // committed and the fetch came back empty. The other two never committed.
      return res.reason === 'no-data'
        ? { answered: false, declined: 'stalled', seriesId: res.hit.id }
        : { answered: false, declined: 'refused' };
    }
    return {
      answered: true,
      rows: res.rows,
      citations: res.citations,
      charted: !!res.spec,
    };
  };
}
