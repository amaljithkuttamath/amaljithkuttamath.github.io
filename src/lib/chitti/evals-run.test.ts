import { describe, it, expect, vi } from 'vitest';
import { runEvalCase, runEvalSuite, observe, type EvalDeps } from './evals-run';
import { stoppedAt, type EvalCase } from './evals';
import type { DataRow } from './core';
import type { Citation } from './tools';

const DIRECT: EvalCase = {
  id: 'direct',
  question: 'life expectancy in Japan since 1960',
  route: 'direct',
  expect: { seriesId: ['SP.DYN.LE00.IN'], countries: ['JPN'], minRows: 2 },
  why: 'fixture',
};

const AGENTC: EvalCase = {
  id: 'agent',
  question: 'which countries improved the most',
  route: 'agent',
  expect: { seriesId: ['SH.DYN.MORT'], minRows: 2 },
  why: 'fixture',
};

const rows = (iso3: string, n = 4): DataRow[] =>
  Array.from({ length: n }, (_, i) => ({
    country: iso3,
    iso3,
    year: 2000 + i,
    value: i,
    indicator: 'whatever',
  })) as DataRow[];

const cite = (indicatorId: string): Citation =>
  ({
    id: `${indicatorId}|x`,
    source: 'worldbank',
    sourceLabel: 'World Bank Open Data',
    indicatorId,
    indicatorName: indicatorId,
    url: 'https://data.worldbank.org/indicator/' + indicatorId,
    requestUrl: 'https://api.worldbank.org/v2/country/JPN/indicator/' + indicatorId,
    countries: ['JPN'],
    yearRange: { start: 2000, end: 2003 },
    fetchedAt: '2026-08-05T00:00:00Z',
  }) as Citation;

const answered = (id = 'SP.DYN.LE00.IN', iso3 = 'JPN') => ({
  answered: true as const,
  rows: rows(iso3),
  citations: [cite(id)],
  charted: true,
});

const declined = { answered: false as const, declined: 'refused' as const };

// A clock that advances a fixed amount per read, so recorded durations are
// asserted rather than tolerated.
function fakeClock(step = 10) {
  let t = 1000;
  return () => (t += step);
}

describe('observe', () => {
  it('reads the series ids off the citations, not the chart', () => {
    const o = observe('direct', { rows: rows('JPN'), citations: [cite('SP.DYN.LE00.IN')], charted: true }, 5);
    expect(o).toMatchObject({ ranBy: 'direct', seriesIds: ['SP.DYN.LE00.IN'], rowCount: 4, iso3: ['JPN'], citedUrls: 1 });
  });

  it('counts only citations that carry a request URL', () => {
    const bare = { ...cite('SP.POP.TOTL') };
    delete (bare as { requestUrl?: string }).requestUrl;
    expect(observe('direct', { rows: rows('JPN'), citations: [bare], charted: true }, 5).citedUrls).toBe(0);
  });

  it('dedupes ids and countries', () => {
    const o = observe('agent', {
      rows: [...rows('IND'), ...rows('IND'), ...rows('CHN')],
      citations: [cite('SH.DYN.MORT'), cite('SH.DYN.MORT')],
      charted: true,
    }, 5);
    expect(o.seriesIds).toEqual(['SH.DYN.MORT']);
    expect(o.iso3).toEqual(['IND', 'CHN']);
    expect(o.iso3Count).toBe(2);
  });
});

describe('runEvalCase', () => {
  it('grades a direct case off the fast path and never touches the agent', async () => {
    const agent = vi.fn();
    const deps: EvalDeps = { direct: async () => answered(), agent };
    const r = await runEvalCase(DIRECT, deps, { mode: 'agent', now: fakeClock() });
    expect(r.passed).toBe(true);
    expect(r.obs.ranBy).toBe('direct');
    expect(r.obs.ms).toBe(10);
    expect(agent).not.toHaveBeenCalled();
  });

  it('does not spend the key on a direct case the fast path declined', async () => {
    // It has already failed at routing; escalating would buy nothing but a bill.
    const agent = vi.fn(async () => answered());
    const r = await runEvalCase(DIRECT, { direct: async () => declined, agent }, { mode: 'agent' });
    expect(agent).not.toHaveBeenCalled();
    expect(r.passed).toBe(false);
    expect(stoppedAt(r.stages)?.stage).toBe('routed');
  });

  it('runs the agent for an agent case in agent mode', async () => {
    const deps: EvalDeps = {
      direct: async () => declined,
      agent: async () => ({ rows: rows('IND'), citations: [cite('SH.DYN.MORT')], charted: true, cost: 0.02 }),
    };
    const r = await runEvalCase(AGENTC, deps, { mode: 'agent' });
    expect(r.obs.ranBy).toBe('agent');
    expect(r.obs.cost).toBe(0.02);
    expect(r.passed).toBe(true);
    expect(r.skipped).toBeUndefined();
  });

  it('marks a held refusal as not-run, never as a pass', async () => {
    const r = await runEvalCase(AGENTC, { direct: async () => declined }, { mode: 'direct' });
    expect(r.skipped).toMatch(/refusal held/);
    expect(r.skipped).toMatch(/needs a key/);
    expect(r.passed).toBe(false);
    expect(r.stages[0]).toMatchObject({ stage: 'routed', status: 'pass' });
  });

  it('says "not requested" rather than "needs a key" when a key was there', async () => {
    const deps: EvalDeps = { direct: async () => declined, agent: async () => answered() };
    const r = await runEvalCase(AGENTC, deps, { mode: 'direct' });
    expect(r.skipped).toMatch(/not requested/);
  });

  it('fails an agent case the fast path answered — an over-fire is a failure, not a skip', async () => {
    const r = await runEvalCase(AGENTC, { direct: async () => answered('SH.DYN.MORT', 'IND') }, { mode: 'direct' });
    expect(r.skipped).toBeUndefined();
    expect(r.passed).toBe(false);
    expect(stoppedAt(r.stages)?.detail).toMatch(/should have escalated/);
  });

  it('records a thrown runner as an error on the case instead of dying', async () => {
    const r = await runEvalCase(DIRECT, { direct: async () => { throw new Error('network down'); } }, { mode: 'direct' });
    expect(r.passed).toBe(false);
    expect(r.obs.error).toBe('network down');
  });

  it('does not blame routing for a runner that threw before committing', async () => {
    // A dead network is not a retrieval regression and not an over-fire. The
    // route goes ungraded; the error is reported where it was observable.
    const boom: EvalDeps = { direct: async () => { throw new Error('ERR_TUNNEL'); } };
    for (const c of [DIRECT, AGENTC]) {
      const r = await runEvalCase(c, boom, { mode: 'direct' });
      expect(r.stages[0], c.id).toMatchObject({ stage: 'routed', status: 'skip' });
      expect(stoppedAt(r.stages)).toMatchObject({ stage: 'resolved', detail: 'ERR_TUNNEL' });
      expect(r.passed).toBe(false);
      expect(r.skipped).toBeUndefined(); // an errored case is a failure, not a not-run
    }
  });

  it('grades a committed-then-empty fetch downstream, not as a routing failure', async () => {
    // The fast path picked a series and the fetch came back empty: routing and
    // retrieval both worked, so the break belongs at "fetched".
    const stalled: EvalDeps = {
      direct: async () => ({ answered: false, declined: 'stalled', seriesId: 'SP.DYN.LE00.IN' }),
    };
    const r = await runEvalCase(DIRECT, stalled, { mode: 'direct' });
    expect(r.stages[0]).toMatchObject({ stage: 'routed', status: 'pass' });
    expect(r.stages[1]).toMatchObject({ stage: 'resolved', status: 'pass' });
    expect(stoppedAt(r.stages)?.stage).toBe('fetched');
  });

  it('treats a committed-then-empty fetch as an over-fire on an agent case', async () => {
    // It reached a series above the score floor for a question it must escalate
    // — the only thing that saved it was the data being missing.
    const stalled: EvalDeps = {
      direct: async () => ({ answered: false, declined: 'stalled', seriesId: 'SH.DYN.MORT' }),
    };
    const r = await runEvalCase(AGENTC, stalled, { mode: 'direct' });
    expect(stoppedAt(r.stages)).toMatchObject({ stage: 'routed' });
    expect(r.skipped).toBeUndefined();
  });

  it('records a thrown agent as an error on the case', async () => {
    const deps: EvalDeps = {
      direct: async () => declined,
      agent: async () => { throw new Error('401 bad key'); },
    };
    const r = await runEvalCase(AGENTC, deps, { mode: 'agent' });
    expect(r.obs.ranBy).toBe('agent');
    expect(r.obs.error).toBe('401 bad key');
    expect(stoppedAt(r.stages)?.detail).toBe('401 bad key');
  });

  it('treats a stopped run as not-run rather than failed', async () => {
    const deps: EvalDeps = {
      direct: async () => declined,
      agent: async () => ({ rows: [], citations: [], charted: false, aborted: true }),
    };
    const r = await runEvalCase(AGENTC, deps, { mode: 'agent' });
    expect(r.skipped).toBe('stopped');
    expect(r.passed).toBe(false);
  });
});

describe('runEvalSuite', () => {
  it('runs sequentially and reports progress per case', async () => {
    const seen: string[] = [];
    const deps: EvalDeps = {
      direct: async (q) => { seen.push(q); return answered(); },
    };
    const done: number[] = [];
    const results = await runEvalSuite([DIRECT, { ...DIRECT, id: 'second' }], deps, {
      mode: 'direct',
      onProgress: (n) => done.push(n),
    });
    expect(seen).toEqual([DIRECT.question, DIRECT.question]);
    expect(done).toEqual([0, 1]);
    expect(results).toHaveLength(2);
  });

  it('stops at the next case boundary when the run is aborted', async () => {
    const ctrl = new AbortController();
    const deps: EvalDeps = {
      direct: async () => { ctrl.abort(); return answered(); },
    };
    const results = await runEvalSuite([DIRECT, { ...DIRECT, id: 'b' }, { ...DIRECT, id: 'c' }], deps, {
      mode: 'direct',
      signal: ctrl.signal,
    });
    expect(results).toHaveLength(1);
  });

  it('streams each result as it lands, so the sidebar fills in live', async () => {
    const streamed: string[] = [];
    await runEvalSuite([DIRECT, AGENTC], { direct: async () => declined }, {
      mode: 'direct',
      onResult: (r) => streamed.push(r.id),
    });
    expect(streamed).toEqual(['direct', 'agent']);
  });
});
