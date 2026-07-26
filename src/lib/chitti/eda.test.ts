import { describe, it, expect } from 'vitest';
import {
  quantile, describe as describeStats, profileSeries, breakdown,
  formatProfile, formatBreakdown, breakdownChartData, isRealCountry,
} from './eda';
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
