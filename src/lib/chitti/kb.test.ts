import { describe, it, expect } from 'vitest';
import { buildKb, searchKb, navigateKb, formatChoices, KB_MIN_SCORE, type KbNode } from './kb';
import { scoreSeries } from './scoring';
import { INDICATORS } from './tools';
import kbData from '../../data/chitti/kb.json';

// Name-only keyword scoring over the World Bank shortlist — the mechanism this
// module replaces. NOTE this is not all of what find_series does: it also
// searches the shared OWID/IMF/WHO catalogue, which resolves some of these on
// its own. The comparison below is therefore about the SCORING, not a claim
// that the whole search was broken.
function flatBest(query: string): { id: string; score: number } {
  const best = INDICATORS
    .map((i) => ({ id: i.id, score: scoreSeries(query, i.id, i.name) }))
    .sort((a, b) => b.score - a.score)[0];
  return best;
}

// The eval set. Each row is a query a real user would type, and the series it
// must resolve to — or null when the catalogue genuinely cannot serve it and
// the right answer is to refuse.
const EVAL: [string, string | null][] = [
  ['child mortality', 'SH.DYN.MORT'],
  ['internet users', 'IT.NET.USER.ZS'],
  ['how long people live', 'SP.DYN.LE00.IN'],
  ['cost of living', 'FP.CPI.TOTL.ZG'],
  ['children per woman', 'SP.DYN.TFRT.IN'],
  ['carbon emissions per person', 'EN.GHG.CO2.PC.CE.AR5'],
  ['gdp per capita', 'NY.GDP.PCAP.CD'],
  ['people with electricity', 'EG.ELC.ACCS.ZS'],
  ['deforestation', 'AG.LND.FRST.ZS'],
  ['women in parliament', 'SG.GEN.PARL.ZS'],
  ['banana exports', null],
  ['olympic medals', null],
];

const top = (q: string) => searchKb(q, ['worldbank'])[0];
const resolves = (q: string, want: string | null): boolean => {
  const h = top(q);
  const acted = h && h.score >= KB_MIN_SCORE;
  return want ? !!acted && h.seriesId === want : !acted;
};

describe('the retrieval eval', () => {
  for (const [query, want] of EVAL) {
    it(`${want ? 'resolves' : 'refuses'} "${query}"`, () => {
      const h = top(query);
      expect(
        resolves(query, want),
        want
          ? `expected ${want}, got ${h ? `${h.seriesId} @ ${h.score}` : 'no hit'}`
          : `expected a refusal, got ${h ? `${h.seriesId} @ ${h.score}` : 'no hit'}`
      ).toBe(true);
    });
  }

  it('beats the name-only scoring it replaces', () => {
    // The regression this guards: name-only scoring over the shortlist could not
    // separate a correct match from an impossible one — both landed on 2.
    const flatOk = EVAL.filter(([q, want]) => {
      const f = flatBest(q);
      return want ? f.id === want && f.score >= 4 : f.score < 4;
    }).length;
    const kbOk = EVAL.filter(([q, want]) => resolves(q, want)).length;
    expect(kbOk).toBe(EVAL.length);
    expect(kbOk).toBeGreaterThan(flatOk);
  });

  it('keeps a real gap between what it can serve and what it cannot', () => {
    // The property that makes a threshold possible at all. With flat scoring
    // there was no gap, which is why MIN_MATCH_SCORE had to under-fire.
    const answerable = EVAL.filter(([, w]) => w).map(([q]) => top(q).score);
    const unanswerable = EVAL.filter(([, w]) => !w).map(([q]) => top(q)?.score ?? 0);
    expect(Math.min(...answerable)).toBeGreaterThan(Math.max(...unanswerable));
    expect(Math.min(...answerable)).toBeGreaterThan(KB_MIN_SCORE);
    expect(Math.max(...unanswerable)).toBeLessThan(KB_MIN_SCORE);
  });
});

describe('inherited context', () => {
  it('finds a series through its group when its own name lacks the words', () => {
    // "child" appears nowhere in "Mortality rate, under-5" — the group supplies
    // it. This single case is the reason the tree exists.
    const h = top('child mortality');
    expect(h.seriesId).toBe('SH.DYN.MORT');
    expect(h.path.join(' > ')).toMatch(/Child & maternal mortality/);
    expect(scoreSeries('child mortality', 'SH.DYN.MORT', 'Mortality rate, under-5 (per 1,000 live births)'))
      .toBeLessThan(KB_MIN_SCORE);
  });

  it("lets a leaf's own wording break a tie with its siblings", () => {
    // Inheritance lifts every sibling equally, so without leaf weighting all
    // three Gender series scored the same and the wrong one won.
    const h = top('women in parliament');
    expect(h.seriesId).toBe('SG.GEN.PARL.ZS');
  });

  it('does not mis-rank a query that name matching gets backwards', () => {
    // Measured against the app's real search: "how long people live" returned
    // the CHILD MORTALITY series. A wrong confident answer is worse than a
    // refusal, and it is why the KB runs before the flat search, not after.
    expect(top('how long people live').seriesId).toBe('SP.DYN.LE00.IN');
  });

  it('returns the route, so a choice can be explained', () => {
    expect(top('deforestation').path[0]).toBe('World Bank Open Data');
    expect(top('deforestation').path.length).toBeGreaterThan(2);
  });
});

describe('buildKb', () => {
  const leaves = (n: KbNode): KbNode[] =>
    n.seriesId ? [n] : n.children.flatMap(leaves);

  it('respects the connected-database filter', () => {
    const wb = buildKb(['worldbank']);
    expect(wb.children.map((c) => c.path)).toEqual(['worldbank']);
    expect(leaves(buildKb(['owid'])).every((l) => l.source === 'owid')).toBe(true);
  });

  it('only ever points at ids that came from real data, never invented ones', () => {
    // An invented id would 404 at fetch time, so every leaf must trace back to
    // bundled data. There are two legitimate origins, and this assertion once
    // knew only the first: the curated shortlist (INDICATORS) and the generated
    // World Bank catalogue (kb.json). The first live catalogue refresh failed
    // here on SG.VAW.1549.ZS — a perfectly real WDI indicator that simply is not
    // among the curated 50. The test was stale, not the data: it encoded "the KB
    // holds only curated ids", which was true before the generated tier existed
    // and is false by design now. What it MEANT — no id may be conjured — is
    // what it checks now.
    const known = new Set([
      ...INDICATORS.map((i) => i.id),
      ...((kbData as { entries?: { seriesId?: string }[] }).entries ?? [])
        .map((e) => e?.seriesId)
        .filter((id): id is string => !!id),
    ]);
    for (const leaf of leaves(buildKb(['worldbank']))) {
      expect(
        known.has(leaf.seriesId!),
        `${leaf.seriesId} is in neither the curated shortlist nor the generated catalogue`
      ).toBe(true);
    }
  });

  it('gives every leaf a full path', () => {
    for (const leaf of leaves(buildKb(['worldbank']))) {
      expect(leaf.path.split('/').length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('model-driven navigation', () => {
  it('walks the tree to a leaf from the choices it is shown', async () => {
    // Stands in for the model: pick the branch whose rendered line mentions the
    // word we are looking for.
    const choose = async (prompt: string) => {
      const lines = prompt.split('\n').filter((l) => /^\d+\./.test(l));
      const i = lines.findIndex((l) => /mortality|under-5/i.test(l));
      return i + 1; // 1-based; 0 when not found, which navigateKb treats as "none fit"
    };
    const hit = await navigateKb('child deaths', choose, ['worldbank']);
    expect(hit?.seriesId).toBe('SH.DYN.MORT');
    expect(hit?.path.length).toBeGreaterThan(1);
  });

  it('stops rather than guessing when the model declines', async () => {
    expect(await navigateKb('anything', async () => 0, ['worldbank'])).toBeNull();
  });

  it('refuses an out-of-range choice instead of descending anyway', async () => {
    expect(await navigateKb('anything', async () => 999, ['worldbank'])).toBeNull();
    expect(await navigateKb('anything', async () => -1, ['worldbank'])).toBeNull();
  });

  it('renders choices with an escape hatch and the vocabulary each covers', () => {
    // The World Bank node's children are topics, which roll up their groups'
    // vocabulary — so "covers:" must appear at the first real decision point.
    const text = formatChoices(buildKb(['worldbank']).children[0]);
    expect(text).toMatch(/0 if none fit/);
    expect(text).toMatch(/covers:/);
  });
});
