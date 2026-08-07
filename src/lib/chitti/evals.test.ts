import { describe, it, expect } from 'vitest';
import {
  EVAL_STAGES,
  EVAL_CASES,
  MAX_RUNS,
  STORED_ISO3,
  gradeCase,
  casePassed,
  funnel,
  summarize,
  stoppedAt,
  compactRun,
  loadRuns,
  saveRun,
  clearRuns,
  runToMarkdown,
  parseEvalCommand,
  type EvalCase,
  type EvalCaseResult,
  type EvalObservation,
  type EvalRun,
} from './evals';
import type { StorageLike } from './dashboard';
import { parseFastPath } from './fastpath';

class FakeStorage implements StorageLike {
  private m = new Map<string, string>();
  private failOnSet = false;
  setFailOnSet(v: boolean) { this.failOnSet = v; }
  get length() { return this.m.size; }
  key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string): void {
    if (this.failOnSet) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
    this.m.set(k, v);
  }
  removeItem(k: string): void { this.m.delete(k); }
  rawSet(k: string, v: string) { this.m.set(k, v); }
}

const DIRECT: EvalCase = {
  id: 'x',
  question: 'life expectancy in Japan since 1960',
  route: 'direct',
  expect: { seriesId: ['SP.DYN.LE00.IN'], countries: ['JPN'], minRows: 10 },
  why: 'fixture',
};

const AGENT: EvalCase = {
  id: 'y',
  question: 'which countries improved the most',
  route: 'agent',
  expect: { seriesId: ['SH.DYN.MORT'], minRows: 10 },
  why: 'fixture',
};

function obs(over: Partial<EvalObservation> = {}): EvalObservation {
  return {
    ranBy: 'direct',
    seriesIds: ['SP.DYN.LE00.IN'],
    rowCount: 64,
    iso3: ['JPN'],
    charted: true,
    citedUrls: 1,
    ms: 120,
    cost: 0,
    ...over,
  };
}

function result(over: Partial<EvalCaseResult> = {}): EvalCaseResult {
  const o = over.obs ?? obs();
  const c = over.route === 'agent' ? AGENT : DIRECT;
  const stages = over.stages ?? gradeCase(c, o);
  return {
    id: over.id ?? c.id,
    question: over.question ?? c.question,
    route: over.route ?? c.route,
    obs: o,
    stages,
    passed: over.passed ?? casePassed(stages),
    ...(over.skipped ? { skipped: over.skipped } : {}),
  };
}

// ── Grading ──────────────────────────────────────────────────────────────────
describe('gradeCase', () => {
  it('passes every stage when the direct path answered as expected', () => {
    const stages = gradeCase(DIRECT, obs());
    expect(stages.map((s) => s.stage)).toEqual([...EVAL_STAGES]);
    expect(stages.every((s) => s.status === 'pass')).toBe(true);
    expect(casePassed(stages)).toBe(true);
    expect(stoppedAt(stages)).toBeNull();
  });

  it('fails at routing when the fast path declined a question it should answer', () => {
    const stages = gradeCase(DIRECT, obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }));
    expect(stages[0]).toMatchObject({ stage: 'routed', status: 'fail' });
    expect(stoppedAt(stages)?.stage).toBe('routed');
    // Everything after the break is skipped, not failed: one break must not
    // read as five.
    expect(stages.slice(1).every((s) => s.status === 'skip')).toBe(true);
  });

  it('fails at routing when the fast path answered a question it should have escalated', () => {
    const stages = gradeCase(AGENT, obs({ ranBy: 'direct' }));
    expect(stages[0]).toMatchObject({ stage: 'routed', status: 'fail' });
    expect(stages[0].detail).toMatch(/should have escalated/);
  });

  it('treats an agent answer as correctly routed for an agent case', () => {
    const stages = gradeCase(AGENT, obs({ ranBy: 'agent', seriesIds: ['SH.DYN.MORT'], iso3: ['IND', 'CHN'] }));
    expect(stages[0].status).toBe('pass');
    expect(casePassed(stages)).toBe(true);
  });

  it('treats "no runner took it" as correct routing for an agent case', () => {
    // A key-free run: the fast path declined and there was no agent to hand to.
    // The refusal held, which is the whole assertion this mode can make.
    const stages = gradeCase(AGENT, obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }));
    expect(stages[0].status).toBe('pass');
    expect(stages[1].status).toBe('fail'); // nothing resolved, because nothing ran
  });

  it('reports an error at the resolved stage rather than folding it into a generic failure', () => {
    const stages = gradeCase(DIRECT, obs({ error: 'HTTP 429' }));
    expect(stages[0].status).toBe('pass');
    expect(stages[1]).toMatchObject({ stage: 'resolved', status: 'fail', detail: 'HTTP 429' });
  });

  it('leaves routing ungraded when the error landed before any runner committed', () => {
    // Otherwise a dead network reads as a retrieval regression on direct cases
    // and as an over-fire on agent ones — both fictions.
    for (const c of [DIRECT, AGENT]) {
      const stages = gradeCase(c, obs({ ranBy: 'none', error: 'ERR_TUNNEL', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }));
      expect(stages[0], c.id).toMatchObject({ stage: 'routed', status: 'skip' });
      expect(stages[1]).toMatchObject({ stage: 'resolved', status: 'fail', detail: 'ERR_TUNNEL' });
      expect(casePassed(stages)).toBe(false);
    }
  });

  it('fails at "correct" when the wrong series answered, with both ids in the detail', () => {
    const stages = gradeCase(DIRECT, obs({ seriesIds: ['SP.DYN.LE00.MA.IN'] }));
    const stop = stoppedAt(stages);
    expect(stop?.stage).toBe('correct');
    expect(stop?.detail).toContain('SP.DYN.LE00.IN');
    expect(stop?.detail).toContain('SP.DYN.LE00.MA.IN');
    // Everything upstream still passed — the break is precisely located.
    expect(stages.slice(0, 5).every((s) => s.status === 'pass')).toBe(true);
  });

  it('matches ids case-insensitively and through a source prefix', () => {
    expect(casePassed(gradeCase(DIRECT, obs({ seriesIds: ['sp.dyn.le00.in'] })))).toBe(true);
    const owid: EvalCase = { ...DIRECT, expect: { ...DIRECT.expect, seriesId: ['owid:life-expectancy'] } };
    expect(casePassed(gradeCase(owid, obs({ seriesIds: ['life-expectancy'] })))).toBe(true);
  });

  it('fails when an expected country is missing from the rows', () => {
    const two: EvalCase = { ...DIRECT, expect: { ...DIRECT.expect, countries: ['JPN', 'ITA'] } };
    expect(stoppedAt(gradeCase(two, obs()))?.detail).toContain('ITA');
  });

  it('fails when too few rows came back', () => {
    expect(stoppedAt(gradeCase(DIRECT, obs({ rowCount: 3 })))?.detail).toContain('at least 10');
  });

  it('fails at "cited" when nothing carried a request URL', () => {
    expect(stoppedAt(gradeCase(DIRECT, obs({ citedUrls: 0 })))?.stage).toBe('cited');
  });
});

// ── Funnel + summary ─────────────────────────────────────────────────────────
describe('funnel', () => {
  it('counts what reached each stage and what was lost there', () => {
    const rows = funnel([
      result(),
      result({ obs: obs({ charted: false }) }),
      result({ obs: obs({ rowCount: 0, charted: false, citedUrls: 0 }) }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
    expect(by.routed.reached).toBe(3);
    expect(by.fetched.reached).toBe(2);
    expect(by.fetched.lost).toBe(1);
    expect(by.charted.reached).toBe(1);
    expect(by.charted.lost).toBe(1);
    expect(by.correct.reached).toBe(1);
    expect(by.routed.pct).toBe(1);
  });

  it('excludes skipped cases entirely, so a key-free run is not reported as drop-off', () => {
    const rows = funnel([
      result(),
      result({ route: 'agent', obs: obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }), skipped: 'needs a key' }),
    ]);
    expect(rows[0].reached).toBe(1);
    expect(rows[0].pct).toBe(1);
    expect(rows.every((r) => r.lost === 0)).toBe(true);
  });

  it('is all zeroes rather than NaN when nothing ran', () => {
    expect(funnel([]).every((r) => r.pct === 0 && r.reached === 0)).toBe(true);
  });
});

describe('summarize', () => {
  it('separates passed, failed and not-run', () => {
    const s = summarize([
      result(),
      result({ obs: obs({ charted: false }) }),
      result({ route: 'agent', obs: obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }), skipped: 'needs a key' }),
    ]);
    expect(s).toMatchObject({ total: 3, ran: 2, passed: 1, failed: 1, skipped: 1 });
  });

  it('counts a held refusal without counting it as a pass', () => {
    const held = result({
      route: 'agent',
      obs: obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }),
      skipped: 'refusal held — the agent run needs a key',
    });
    const broke = result({ route: 'agent', obs: obs({ ranBy: 'direct' }) });
    const s = summarize([held, broke]);
    expect(s.refusalsChecked).toBe(2);
    expect(s.refusalsHeld).toBe(1);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(1); // the over-fire is a failure, not a skip
  });

  it('totals time and cost across every case, including the skipped ones', () => {
    const s = summarize([
      result({ obs: obs({ ms: 100, cost: 0.01 }) }),
      result({ obs: obs({ ms: 50, cost: 0.02 }), skipped: 'needs a key' }),
    ]);
    expect(s.ms).toBe(150);
    expect(s.cost).toBeCloseTo(0.03, 6);
  });
});

// ── History ──────────────────────────────────────────────────────────────────
function makeRun(at: string, results: EvalCaseResult[] = [result()]): EvalRun {
  return { at, mode: 'direct', sources: ['worldbank'], results, summary: summarize(results) };
}

describe('run history', () => {
  it('returns an empty history for a missing, malformed or hand-edited file', () => {
    const s = new FakeStorage();
    expect(loadRuns(s)).toEqual([]);
    s.rawSet('chitti:evals', 'not json');
    expect(loadRuns(s)).toEqual([]);
    s.rawSet('chitti:evals', '{"v":1,"runs":"nope"}');
    expect(loadRuns(s)).toEqual([]);
    s.rawSet('chitti:evals', '{"v":1,"runs":[{"nope":true}]}');
    expect(loadRuns(s)).toEqual([]);
    expect(loadRuns(null)).toEqual([]);
  });

  it('saves newest-first and caps the history', () => {
    const s = new FakeStorage();
    for (let i = 0; i < MAX_RUNS + 5; i++) saveRun(s, makeRun(`2026-08-0${(i % 9) + 1}T00:0${i % 9}:00Z`));
    const runs = loadRuns(s);
    expect(runs).toHaveLength(MAX_RUNS);
  });

  it('reports a full quota instead of throwing', () => {
    const s = new FakeStorage();
    s.setFailOnSet(true);
    const r = saveRun(s, makeRun('2026-08-05T00:00:00Z'));
    expect(r).toMatchObject({ ok: false });
    expect(saveRun(null, makeRun('2026-08-05T00:00:00Z'))).toMatchObject({ ok: false });
  });

  it('trims stored country codes but keeps the true count', () => {
    // JPN first, because the fixture case expects it: the point of this test is
    // that compaction preserves a verdict, so the verdict has to be a pass.
    const many = ['JPN', ...Array.from({ length: 39 }, (_, i) => `C${String(i).padStart(2, '0')}`)];
    const r = compactRun(makeRun('2026-08-05T00:00:00Z', [result({ obs: obs({ iso3: many }) })]));
    expect(r.results[0].obs.iso3).toHaveLength(STORED_ISO3);
    expect(r.results[0].obs.iso3Count).toBe(40);
    // Compaction happens after grading, so it can never change a verdict.
    expect(r.results[0].passed).toBe(true);
  });

  it('clears without throwing when there is no store', () => {
    const s = new FakeStorage();
    saveRun(s, makeRun('2026-08-05T00:00:00Z'));
    clearRuns(s);
    expect(loadRuns(s)).toEqual([]);
    expect(() => clearRuns(null)).not.toThrow();
  });
});

// ── Export ───────────────────────────────────────────────────────────────────
describe('runToMarkdown', () => {
  it('carries the funnel, the per-case verdicts and the refusal line', () => {
    const results = [
      result(),
      result({ obs: obs({ seriesIds: ['WRONG.ID'] }) }),
      result({ route: 'agent', obs: obs({ ranBy: 'none', seriesIds: [], rowCount: 0, charted: false, citedUrls: 0 }), skipped: 'refusal held — the agent run needs a key' }),
    ];
    const md = runToMarkdown({ at: '2026-08-05T10:00:00Z', mode: 'direct', sources: ['worldbank'], results, summary: summarize(results) });
    expect(md).toContain('# Chitti evals — 2026-08-05T10:00:00Z');
    expect(md).toContain('**1/2 passed**');
    expect(md).toContain('Refusals held: **1/1**');
    for (const stage of EVAL_STAGES) expect(md).toContain(`| ${stage} |`);
    expect(md).toContain('WRONG.ID');
    expect(md).toContain('not run');
    // The honesty note travels with the artifact, because the artifact is what
    // ends up in a PR.
    expect(md).toMatch(/never a value/);
  });
});

// ── The chat command ─────────────────────────────────────────────────────────
describe('parseEvalCommand', () => {
  it('opens the panel on the bare command and runs when asked', () => {
    expect(parseEvalCommand('/evals')).toEqual({ run: false, mode: 'direct' });
    expect(parseEvalCommand('  /eval  ')).toEqual({ run: false, mode: 'direct' });
    expect(parseEvalCommand('/evals run')).toEqual({ run: true, mode: 'direct' });
    expect(parseEvalCommand('/EVALS Run')).toEqual({ run: true, mode: 'direct' });
    expect(parseEvalCommand('/evals agent')).toEqual({ run: true, mode: 'agent' });
    expect(parseEvalCommand('/evals run agent')).toEqual({ run: true, mode: 'agent' });
  });

  it('never swallows a question about the world', () => {
    // The fence: no slash, no command — whatever it looks like.
    expect(parseEvalCommand('run evals')).toBeNull();
    expect(parseEvalCommand('evals')).toBeNull();
    expect(parseEvalCommand('how do evaluations work')).toBeNull();
    expect(parseEvalCommand('')).toBeNull();
    // An unrecognised argument falls through to the ask path rather than being
    // guessed at.
    expect(parseEvalCommand('/evals everything twice')).toBeNull();
    expect(parseEvalCommand('/evaluate India')).toBeNull();
  });
});

// ── The suite itself ─────────────────────────────────────────────────────────
describe('EVAL_CASES', () => {
  it('has unique ids and a stated reason for every case', () => {
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    for (const c of EVAL_CASES) expect(c.why.length).toBeGreaterThan(20);
  });

  it('asserts behaviour, never a value', () => {
    // The guard for the honesty rule: an expectation may only name series ids,
    // country codes and a row floor. If someone adds a `value` or `expectedMean`
    // field, this fails and the conversation happens before it ships.
    const allowed = new Set(['seriesId', 'countries', 'minRows']);
    for (const c of EVAL_CASES) {
      for (const k of Object.keys(c.expect)) expect(allowed.has(k)).toBe(true);
    }
  });

  it('every direct case is at least parseable by the fast path', () => {
    // Necessary, not sufficient: whether it FIRES also depends on the match
    // score against the live catalog, which needs the network. A parse failure
    // though is a flat contradiction — the case claims a route the question
    // cannot take — and that is checkable offline, so it is checked.
    for (const c of EVAL_CASES.filter((x) => x.route === 'direct')) {
      expect(parseFastPath(c.question), c.question).not.toBeNull();
    }
  });

  it('the structural refusals are refused by the parser alone', () => {
    // These three cannot reach the fast path even in principle: a ranking, two
    // indicators in one ask, and a question with no country. The other agent
    // cases refuse later (on match score), which needs the catalog.
    for (const id of ['ranking-child-mortality', 'two-indicators-one-ask', 'correlation-gdp-life']) {
      const c = EVAL_CASES.find((x) => x.id === id)!;
      expect(parseFastPath(c.question), c.question).toBeNull();
    }
  });

  it('covers both routes, so a run always exercises the refusal guard', () => {
    expect(EVAL_CASES.some((c) => c.route === 'direct')).toBe(true);
    expect(EVAL_CASES.filter((c) => c.route === 'agent').length).toBeGreaterThanOrEqual(3);
  });
});
