// The ambiguity CHOICE: an ambiguous direct lookup returns its candidates
// instead of charting a guess, and a series the user picked is looked up with
// no search at all. The refusal itself (pickKbHit → 'ambiguous') is pinned in
// fastpath.test.ts and is unchanged; these cases cover what happens next.
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchSeries = vi.fn();
vi.mock('./sources/index', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sources/index')>();
  return {
    ...real,
    findSeriesWithReceipt: vi.fn(async () => ({ hits: [], receipt: undefined })),
    adapterOfId: (id: string) =>
      id.startsWith('NOPE')
        ? undefined
        : {
            citationSource: 'worldbank',
            normalizeId: (x: string) => x,
            indicatorLabel: (x: string) => x,
            fetchSeries,
          },
  };
});

import {
  runFastPath,
  parseFastPath,
  kbCandidates,
  tiedAlternatives,
  pickKbHit,
  MAX_CANDIDATES,
  type SeriesCandidate,
} from './fastpath';
import { searchKb, type KbHit } from './kb';

const plan = (q: string) => parseFastPath(q, 2026)!;
const rows = (id: string) => [
  { country: 'India', iso3: 'IND', year: 2000, value: 1, indicator: id },
  { country: 'India', iso3: 'IND', year: 2010, value: 2, indicator: id },
];

beforeEach(() => {
  fetchSeries.mockReset();
  fetchSeries.mockImplementation(async (id: string) => ({ rows: rows(id), requestUrl: 'https://api.worldbank.org/x' }));
});

describe('an ambiguous phrase becomes a choice, never a chart', () => {
  it('returns the candidates and fetches nothing', async () => {
    const result = await runFastPath(plan('rural population of India'));
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous', phrase: 'rural population' });
    if (!('candidates' in result)) throw new Error('expected candidates');
    const ids = result.candidates.map((c) => c.id);
    expect(ids).toContain('SP.RUR.TOTL');
    expect(ids).toContain('SP.RUR.TOTL.ZS');
    expect(result.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(fetchSeries).not.toHaveBeenCalled();
    expect('spec' in result).toBe(false);
  });

  it.each([
    'rural population of India',
    'remittances in India',
    'male literacy in India',
    'youth unemployment in Spain',
    'tourism in Thailand',
    'adult mortality in India',
  ])('offers only series that answer every word: %s', (q) => {
    const hits = searchKb(plan(q).indicatorQuery);
    expect(pickKbHit(hits)).toBe('ambiguous');
    const offered = kbCandidates(hits);
    expect(offered.length).toBeGreaterThanOrEqual(2);
    for (const c of offered) expect(hits.find((h) => h.seriesId === c.id)!.unmatched).toEqual([]);
  });

  it('stays a plain refusal when fewer than two series answer the whole phrase', async () => {
    // "of women" has no series that covers every word in the core tier, and
    // "Mexico city" is a city, not a series qualifier: both still escalate.
    for (const q of ['life expectancy of women in Japan', 'population of Mexico city']) {
      const result = await runFastPath(plan(q));
      expect(result).toEqual({ ok: false, reason: 'no-match' });
    }
    expect(fetchSeries).not.toHaveBeenCalled();
  });

  it('lists the general series before the narrow one at an equal score, and caps the list', () => {
    const hit = (id: string, name: string, score: number, unmatched: string[] = []): KbHit =>
      ({ seriesId: id, name, source: 'worldbank', score, path: [], tuned: false, unmatched });
    const offered = kbCandidates([
      hit('A', 'Rural population living below 5 meters', 30),
      hit('B', 'Rural population', 30),
      hit('C', 'Rural population growth', 30),
      hit('A', 'duplicate id', 30),
      hit('D', 'Rural women', 30, ['population']),
      hit('E', 'Rural population (% of total)', 29),
      hit('F', 'Rural population, extra', 28),
      hit('G', 'Too weak', 1),
    ]);
    expect(offered.map((c) => c.id)).toEqual(['B', 'C', 'A', 'E']);
  });
});

describe('a chosen series is looked up without searching', () => {
  const chosen: SeriesCandidate = { id: 'SP.RUR.TOTL.ZS', name: 'Rural population (% of total population)', source: 'worldbank' };

  it('charts exactly the series the user picked and keeps the rest as switches', async () => {
    const result = await runFastPath(plan('rural population of India'), { chosen });
    if (!('spec' in result)) throw new Error('expected an answer');
    expect(fetchSeries.mock.calls[0][0]).toBe('SP.RUR.TOTL.ZS');
    expect(result.hit.id).toBe('SP.RUR.TOTL.ZS');
    expect(result.trace[0].detail).toContain('chosen by you');
    expect(result.alternatives.map((c) => c.id)).not.toContain('SP.RUR.TOTL.ZS');
    expect(result.alternatives.map((c) => c.id)).toContain('SP.RUR.TOTL');
  });

  it('refuses a chosen id no adapter serves', async () => {
    const result = await runFastPath(plan('rural population of India'), {
      chosen: { id: 'NOPE.1', name: 'x', source: 'x' },
    });
    expect(result).toEqual({ ok: false, reason: 'no-match' });
    expect(fetchSeries).not.toHaveBeenCalled();
  });

  it('re-runs an edited plan (fewer countries) against the same series', async () => {
    const edited = { ...plan('life expectancy in India and Japan since 1990'), countries: ['IND'], countryNames: ['India'] };
    const result = await runFastPath(edited, { chosen: { id: 'SP.DYN.LE00.IN', name: 'Life expectancy at birth, total (years)', source: 'worldbank' } });
    expect(fetchSeries.mock.calls[0].slice(0, 4)).toEqual(['SP.DYN.LE00.IN', ['IND'], 1990, undefined]);
    if (!('spec' in result)) throw new Error('expected an answer');
    // A re-run keeps offering exactly the tie the original lookup disclosed.
    const original = await runFastPath(plan('life expectancy in India and Japan since 1990'));
    if (!('spec' in original)) throw new Error('expected an answer');
    expect(result.alternatives).toEqual(original.alternatives);
  });

  it('offers the tuned winner back after switching away from it', async () => {
    const male = { id: 'SP.DYN.LE00.MA.IN', name: 'Life expectancy at birth, male (years)', source: 'worldbank' };
    const result = await runFastPath(plan('life expectancy in Japan'), { chosen: male });
    if (!('spec' in result)) throw new Error('expected an answer');
    const ids = result.alternatives.map((c) => c.id);
    expect(ids[0]).toBe('SP.DYN.LE00.IN');
    expect(ids).not.toContain(male.id);
  });
});

describe('a tuned series that wins a tie discloses the tie', () => {
  it('charts the total and offers male and female as switches', async () => {
    const result = await runFastPath(plan('life expectancy in Japan'));
    if (!('spec' in result)) throw new Error('expected an answer');
    expect(result.hit.id).toBe('SP.DYN.LE00.IN');
    const names = result.alternatives.map((c) => c.name).join(' | ');
    expect(names).toMatch(/male/);
    expect(result.alternatives.every((c) => c.id !== 'SP.DYN.LE00.IN')).toBe(true);
  });

  it('offers nothing when the winner had no tie', () => {
    const hits = searchKb(plan('population of Nigeria').indicatorQuery);
    const top = pickKbHit(hits);
    if (!top || top === 'ambiguous') throw new Error('expected a hit');
    expect(tiedAlternatives(hits, top)).toEqual([]);
  });
});

describe('each settled step carries its measured duration', () => {
  it('records durationMs on every direct step', async () => {
    const result = await runFastPath(plan('life expectancy in Japan'));
    if (!('spec' in result)) throw new Error('expected an answer');
    expect(result.trace.map((e) => e.tool)).toEqual(['find_series', 'fetch_series', 'render_chart']);
    for (const e of result.trace) {
      expect(typeof e.durationMs).toBe('number');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
