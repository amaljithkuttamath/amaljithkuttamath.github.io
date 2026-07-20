// search-eval.test.ts — offline regression harness for find_series quality.
//
// Runs every curated case in search-eval.fixtures.ts through the real search
// path (findSeries → scoreSeries/explainMatch across the SOURCES registry) with
// fetch stubbed offline, and asserts a top-1 / top-3 hit-rate floor. The floors
// are set just below what the current scorer achieves, so the suite is green now
// but any synonym or weighting change that pushes real queries off the podium
// turns it red. Every miss is printed in the failure message so a regression is
// debuggable at a glance (which query, what was expected, what ranked first).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findSeries } from './tools';
import { EVAL_CASES } from './search-eval.fixtures';

// Floors, not targets. Current measured rates are top-1 98.1% (51/52) and
// top-3 100% (52/52) — measured after the OWID curated catalog was expanded;
// these thresholds sit below that with a small margin so a benign catalog
// reshuffle survives, but losing three-plus top-1 cases (or two top-3 cases)
// to a scoring regression fails the build.
const TOP1_FLOOR = 0.93;
const TOP3_FLOOR = 0.97;

describe('find_series offline eval', () => {
  // Stub fetch to reject: the IMF live-catalog fallback and the World Bank
  // search fallback both call fetch(), and this keeps the eval fully offline
  // and deterministic (curated catalogs only) — the same pattern as the
  // findSeries tests in agent.test.ts.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has a healthy, well-distributed fixture set', () => {
    // Cheap guard so the harness can't silently rot down to a handful of cases,
    // and so every registered source stays represented.
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(25);
    const sources = new Set(EVAL_CASES.map((c) => c.source));
    expect(sources).toEqual(new Set(['worldbank', 'owid', 'imf', 'who']));
  });

  it('meets the top-1 and top-3 hit-rate floors', async () => {
    let top1 = 0;
    let top3 = 0;
    const misses: string[] = [];

    for (const c of EVAL_CASES) {
      const hits = await findSeries(c.query, c.active);
      const rank = hits.findIndex((h) => h.source === c.source && h.id === c.id);
      if (rank === 0) top1++;
      if (rank >= 0 && rank < 3) top3++;
      if (rank !== 0) {
        const got = hits[0] ? `${hits[0].source}:${hits[0].id}` : '(no hits)';
        const where = rank < 0 ? 'not in results' : `ranked #${rank + 1}`;
        misses.push(`  "${c.query}" → want ${c.source}:${c.id}, but got #1 ${got} (expected ${where})`);
      }
    }

    const n = EVAL_CASES.length;
    const top1Rate = top1 / n;
    const top3Rate = top3 / n;
    const report =
      `\nfind_series eval: top-1 ${top1}/${n} (${(100 * top1Rate).toFixed(1)}%), ` +
      `top-3 ${top3}/${n} (${(100 * top3Rate).toFixed(1)}%)\n` +
      (misses.length ? `Cases not ranked #1:\n${misses.join('\n')}\n` : 'All cases ranked #1.\n');

    // Attach the full report to any assertion failure so the miss list is
    // visible in CI output without re-running with logging.
    expect(top1Rate, `top-1 below floor ${TOP1_FLOOR}.${report}`).toBeGreaterThanOrEqual(TOP1_FLOOR);
    expect(top3Rate, `top-3 below floor ${TOP3_FLOOR}.${report}`).toBeGreaterThanOrEqual(TOP3_FLOOR);
  });
});
