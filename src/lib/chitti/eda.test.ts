import { describe, it, expect } from 'vitest';
import {
  quantile, describe as describeStats, profileSeries, breakdown,
  formatProfile, formatBreakdown, breakdownChartData, isRealCountry,
  pairCoverage, JOINT_COVERAGE,
} from './eda';
import { correlate } from './tools';
import type { DataRow } from './tools';

const row = (iso3: string, country: string, year: number, value: number | null): DataRow =>
  ({ country, iso3, year, value, indicator: 'X' });

describe('quantile / describe', () => {
  it('interpolates quartiles the way a spreadsheet does', () => {
    const v = [1, 2, 3, 4];
    expect(quantile(v, 0)).toBe(1);
    expect(quantile(v, 0.25)).toBeCloseTo(1.75);
    expect(quantile(v, 0.5)).toBeCloseTo(2.5);
    expect(quantile(v, 1)).toBe(4);
  });

  it('summarises a set of values', () => {
    const d = describeStats([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(d.n).toBe(8);
    expect(d.min).toBe(2);
    expect(d.max).toBe(9);
    expect(d.mean).toBeCloseTo(5);
    expect(d.sd).toBeCloseTo(2.138, 2); // sample sd (n-1)
  });

  it('returns null for nothing usable, and sd 0 for one point', () => {
    expect(describeStats([])).toBeNull();
    expect(describeStats([NaN, Infinity])).toBeNull();
    expect(describeStats([5])!.sd).toBe(0);
  });
});

describe('isRealCountry', () => {
  it('separates countries from World Bank aggregates', () => {
    expect(isRealCountry('IND')).toBe(true);
    expect(isRealCountry('USA')).toBe(true);
    expect(isRealCountry('WLD')).toBe(false); // World
    expect(isRealCountry('ZZZ')).toBe(false); // unknown
  });
});

describe('profileSeries', () => {
  // Three real countries, 2000–2002, one hole; plus a World aggregate that
  // must not contaminate the statistics.
  const rows: DataRow[] = [
    row('IND', 'India', 2000, 10), row('IND', 'India', 2001, 12), row('IND', 'India', 2002, 14),
    row('CHN', 'China', 2000, 20), row('CHN', 'China', 2001, 22), row('CHN', 'China', 2002, 24),
    row('BRA', 'Brazil', 2000, 30), row('BRA', 'Brazil', 2001, null), row('BRA', 'Brazil', 2002, 34),
    row('WLD', 'World', 2002, 9999),
  ];

  it('reports coverage and excludes aggregates from the statistics', () => {
    const p = profileSeries(rows)!;
    expect(p.countryCount).toBe(3);
    expect(p.aggregatesExcluded).toBe(1);
    expect(p.yearStart).toBe(2000);
    expect(p.yearEnd).toBe(2002);
    // The World aggregate's 9999 would wreck every statistic if included.
    expect(p.latest!.max).toBe(34);
  });

  it('measures missingness across the covered rectangle', () => {
    // 3 countries × 3 years = 9 cells, 8 present ⇒ ~11% missing.
    expect(profileSeries(rows)!.missingPct).toBeCloseTo(11.1, 0);
  });

  it('describes the distribution at the latest well-reported year', () => {
    const p = profileSeries(rows)!;
    expect(p.latestUsableYear).toBe(2002);
    expect(p.latest!.n).toBe(3);
    expect(p.latest!.median).toBe(24);
  });

  it('ignores a near-empty final year when picking one to rank on', () => {
    // This is the trap the tool exists to catch: 2023 has a single reporter,
    // so ranking on it would rank who reports early, not who leads.
    const sparse = [
      ...rows.filter((r) => r.iso3 !== 'WLD'),
      row('IND', 'India', 2023, 99),
    ];
    const p = profileSeries(sparse)!;
    expect(p.yearEnd).toBe(2023);
    expect(p.latestUsableYear).toBe(2002);
    expect(formatProfile(p)).toMatch(/last year with broad reporting/);
  });

  it('names outliers rather than only counting them', () => {
    const withOutlier = [
      ...['IND', 'CHN', 'BRA', 'FRA', 'DEU', 'ITA', 'ESP', 'JPN'].map((c, i) =>
        row(c, c, 2002, 10 + i)
      ),
      row('QAT', 'Qatar', 2002, 5000),
    ];
    const p = profileSeries(withOutlier)!;
    expect(p.outliers.map((o) => o.country)).toContain('Qatar');
    expect(p.outliers[0].side).toBe('high');
  });

  it('returns null when there is nothing real to profile', () => {
    expect(profileSeries([])).toBeNull();
    expect(profileSeries([row('WLD', 'World', 2000, 1)])).toBeNull();
  });
});

describe('breakdown', () => {
  // Real ISO3 codes so the bundled World Bank metadata classifies them.
  const rows: DataRow[] = [
    row('USA', 'United States', 2020, 100), // North America / High income
    row('CAN', 'Canada', 2020, 90),         // North America / High income
    row('IND', 'India', 2020, 20),          // South Asia / Lower middle
    row('BGD', 'Bangladesh', 2020, 15),     // South Asia / Lower middle
    row('NGA', 'Nigeria', 2020, 10),        // Sub-Saharan Africa / Lower middle
    row('ETH', 'Ethiopia', 2020, 5),        // Sub-Saharan Africa / Low income
    row('WLD', 'World', 2020, 4242),        // aggregate — must be excluded
  ];

  it('groups by region, ranked by median, with per-group extremes', () => {
    const b = breakdown(rows, 'region', { year: 2020 })!;
    expect(b.dimension).toBe('region');
    expect(b.aggregatesExcluded).toBe(1);
    expect(b.groups[0].group).toBe('North America'); // highest median
    expect(b.groups[0].stats.median).toBe(95);
    expect(b.groups[0].top.country).toBe('United States');
    expect(b.groups[0].bottom.country).toBe('Canada');
    expect(b.groups[b.groups.length - 1].group).toBe('Sub-Saharan Africa');
  });

  it('groups by income group', () => {
    const b = breakdown(rows, 'income', { year: 2020 })!;
    const names = b.groups.map((g) => g.group);
    expect(names).toContain('High income');
    expect(names).toContain('Low income');
    expect(b.groups[0].group).toBe('High income');
  });

  it('defaults to the latest well-reported year instead of the last one', () => {
    const withSparseTail = [...rows, row('USA', 'United States', 2021, 500)];
    const b = breakdown(withSparseTail, 'region')!;
    expect(b.year).toBe(2020);
  });

  it('returns null when nothing can be grouped', () => {
    expect(breakdown([], 'region')).toBeNull();
    expect(breakdown([row('WLD', 'World', 2020, 1)], 'region')).toBeNull();
  });

  it('produces chart-ready points, one per group', () => {
    const b = breakdown(rows, 'region', { year: 2020 })!;
    const data = breakdownChartData(b);
    expect(data).toHaveLength(b.groups.length);
    expect(data[0]).toEqual(['North America', 95]);
  });
});

describe('the text handed to the model', () => {
  const rows: DataRow[] = [
    row('USA', 'United States', 2020, 100), row('CAN', 'Canada', 2020, 90),
    row('IND', 'India', 2020, 20), row('NGA', 'Nigeria', 2020, 10),
    row('WLD', 'World', 2020, 4242),
  ];

  it('discloses excluded aggregates rather than silently dropping them', () => {
    expect(formatProfile(profileSeries(rows)!)).toMatch(/1 aggregate rows.*excluded/);
    expect(formatBreakdown(breakdown(rows, 'region', { year: 2020 })!)).toMatch(/1 aggregate rows excluded/);
  });

  it('states the gap between the top and bottom group', () => {
    const text = formatBreakdown(breakdown(rows, 'region', { year: 2020 })!);
    expect(text).toMatch(/Gap:/);
    expect(text).toMatch(/median/);
  });

  it('always reports missingness, so patchy data cannot pass as complete', () => {
    expect(formatProfile(profileSeries(rows)!)).toMatch(/Missing: \d+%/);
  });
});

describe('pairCoverage', () => {
  // 20 real countries, both indicators, every year 2015–2020 — except that in
  // 2021 only three of them have filed the spending series yet. That last year
  // is the shape World Bank data actually has, and the one `correlate`'s
  // default would pick.
  const ISO = ['IND', 'CHN', 'BRA', 'USA', 'CAN', 'NGA', 'ETH', 'BGD', 'PAK', 'MEX',
               'ZAF', 'KEN', 'EGY', 'IDN', 'PHL', 'VNM', 'THA', 'TUR', 'POL', 'ESP'];
  const pair = (indicator: string, iso3: string, year: number, value: number): DataRow =>
    ({ country: iso3, iso3, year, value, indicator });

  const rows: DataRow[] = [];
  for (const iso3 of ISO) {
    for (let y = 2015; y <= 2020; y++) {
      rows.push(pair('SPEND', iso3, y, 100 + ISO.indexOf(iso3) * 10));
      rows.push(pair('MORT', iso3, y, 90 - ISO.indexOf(iso3) * 2));
    }
  }
  // The partial final year: mortality filed broadly, spending barely at all.
  for (const iso3 of ISO) rows.push(pair('MORT', iso3, 2021, 40));
  for (const iso3 of ISO.slice(0, 3)) rows.push(pair('SPEND', iso3, 2021, 999));

  it('counts only countries reporting both, per year', () => {
    const c = pairCoverage(rows, 'SPEND', 'MORT');
    expect(c.universe).toBe(20);
    expect(c.byYear.find((y) => y.year === 2020)!.n).toBe(20);
    expect(c.byYear.find((y) => y.year === 2021)!.n).toBe(3);
  });

  it('skips the partial final year that correlate would have chosen', () => {
    // The regression this exists for. `correlate`'s default lands on 2021 and
    // reports an r drawn from three countries; the coverage rule lands on 2020.
    expect(correlate(rows, 'SPEND', 'MORT').year).toBe(2021);
    expect(correlate(rows, 'SPEND', 'MORT').n).toBe(3);
    const year = pairCoverage(rows, 'SPEND', 'MORT').latestWellPaired;
    expect(year).toBe(2020);
    expect(correlate(rows, 'SPEND', 'MORT', year!).n).toBe(20);
  });

  it('excludes aggregates from both the universe and the per-year counts', () => {
    const withAgg = [...rows, pair('SPEND', 'WLD', 2020, 1), pair('MORT', 'WLD', 2020, 1)];
    const c = pairCoverage(withAgg, 'SPEND', 'MORT');
    expect(c.universe).toBe(20);
    expect(c.byYear.find((y) => y.year === 2020)!.n).toBe(20);
  });

  it('ignores a country that reports only one of the two', () => {
    const half = [...rows, pair('SPEND', 'FRA', 2020, 500)];
    expect(pairCoverage(half, 'SPEND', 'MORT').universe).toBe(20);
  });

  it('refuses rather than picking a year when none is well reported', () => {
    // A wide universe smeared thin: all 20 countries report both series at some
    // point, but never many in the same year — each files in its own year. No
    // year clears the floor, so there is no honest choice and the caller must be
    // told so rather than handed the least-bad one.
    const smeared: DataRow[] = [];
    ISO.forEach((iso3, i) => {
      smeared.push(pair('SPEND', iso3, 2000 + i, 100), pair('MORT', iso3, 2000 + i, 50));
    });
    const c = pairCoverage(smeared, 'SPEND', 'MORT');
    expect(c.universe).toBe(20);
    expect(Math.max(...c.byYear.map((y) => y.n))).toBe(1); // never more than one at a time
    expect(c.latestWellPaired).toBeNull();
    // …whereas correlate, left to its default, would happily report on that
    // single-country year rather than decline.
    expect(correlate(smeared, 'SPEND', 'MORT').year).toBe(2019);
  });

  it('is empty, not undefined, when neither indicator is present', () => {
    const c = pairCoverage(rows, 'NOPE', 'ALSO_NOPE');
    expect(c.universe).toBe(0);
    expect(c.byYear).toEqual([]);
    expect(c.latestWellPaired).toBeNull();
  });

  it('never reports a yearly count above the universe', () => {
    const c = pairCoverage(rows, 'SPEND', 'MORT');
    for (const y of c.byYear) expect(y.n).toBeLessThanOrEqual(c.universe);
  });

  it('uses the same 60% floor as latestUsableYear', () => {
    expect(JOINT_COVERAGE).toBe(0.6);
    // 12 of 20 is exactly the floor and must clear it; 11 must not.
    const at = (k: number) => {
      const r = rows.filter((x) => x.year <= 2020);
      for (const iso3 of ISO.slice(0, k)) r.push(pair('SPEND', iso3, 2022, 1), pair('MORT', iso3, 2022, 1));
      return pairCoverage(r, 'SPEND', 'MORT').latestWellPaired;
    };
    expect(at(12)).toBe(2022);
    expect(at(11)).toBe(2020);
  });
});
