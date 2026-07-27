// Offline pre-flight for the demo recipes.
//
// WHY THIS EXISTS. The generator only ever runs on a CI runner, because the
// sandbox it is written in cannot reach the source APIs. That made the runner
// the first place any recipe logic executed, and a mistake there costs a full
// workflow round-trip to discover. Two shipped that way: a correlation floor
// (`n >= 50`) that was authored rather than measured and failed the first live
// run it saw, and an aggregate filter that checked membership in COUNTRIES —
// a table that includes all 78 World Bank aggregates — while its comment
// claimed it excluded them.
//
// Both are analysis bugs, and analysis needs no network. The recipes reach the
// outside world through exactly one seam, `lib.adapterOfId`, so a fake lib runs
// the real recipe code against a synthetic series whose SHAPE is the one World
// Bank data actually has: a broadly reported history, a partial final year, and
// aggregate rows mixed in with the countries.
import { describe, it, expect } from 'vitest';
import { RECIPES } from './gen-chitti-demos.mjs';
import { COUNTRIES, correlate, growthStats, type DataRow } from '../src/lib/chitti/tools';
import { isRealCountry, pairCoverage, JOINT_COVERAGE } from '../src/lib/chitti/eda';

const REAL = COUNTRIES.filter((c) => c.region !== 'Aggregates' && c.region !== '').slice(0, 120);
const AGGREGATES = COUNTRIES.filter((c) => c.region === 'Aggregates').slice(0, 10);

interface Shape {
  // Years every country reports.
  broad: number[];
  // A final year only these many countries have filed — the partial release.
  partialYear?: number;
  partialCount?: number;
  value: (iso3: string, year: number, i: number) => number;
  includeAggregates?: boolean;
}

function makeRows(id: string, shape: Shape): DataRow[] {
  const rows: DataRow[] = [];
  const emit = (list: typeof REAL, years: number[]) => {
    list.forEach((c, i) => {
      for (const year of years) {
        rows.push({ country: c.name, iso3: c.id, year, value: shape.value(c.id, year, i), indicator: id });
      }
    });
  };
  emit(REAL, shape.broad);
  if (shape.includeAggregates) emit(AGGREGATES as typeof REAL, shape.broad);
  if (shape.partialYear !== undefined && shape.partialCount) {
    emit(REAL.slice(0, shape.partialCount), [shape.partialYear]);
  }
  return rows;
}

// A stand-in for the source adapters. Returns whatever rows the test registered
// for an id, in the same envelope `adapter.fetchSeries` produces.
function fakeLib(series: Record<string, DataRow[]>) {
  const calls: string[] = [];
  return {
    calls,
    lib: {
      COUNTRIES,
      correlate,
      growthStats,
      isRealCountry,
      pairCoverage,
      JOINT_COVERAGE,
      resolveCountryList: (codes: string[]) => ({ codes }),
      buildCitation: (id: string) => ({ id, rowCount: 0 }),
      adapterOfId: (id: string) => {
        if (!(id in series)) return null;
        return {
          normalizeId: (x: string) => x,
          citationSource: 'World Bank',
          sourceLabel: 'World Bank',
          fetchSeries: async () => {
            calls.push(id);
            // The adapter strips the indicator tag; the generator re-adds it.
            return { rows: series[id].map(({ indicator, ...r }) => r), requestUrl: 'https://example.test' };
          },
        };
      },
    },
  };
}

const recipe = (id: string) => {
  const r = RECIPES.find((x: { id: string }) => x.id === id);
  if (!r) throw new Error(`no recipe ${id}`);
  return r;
};

describe('child-mortality-fastest-fall', () => {
  const rows = makeRows('SH.DYN.MORT', {
    broad: [2000, 2010, 2022],
    includeAggregates: true,
    // Every country falls; the aggregates fall FASTEST, so if they leak into
    // the ranking they take the top slots and the failure is unmissable.
    value: (iso3, year, i) => {
      const base = 100 - i * 0.5;
      const drop = AGGREGATES.some((a) => a.id === iso3) ? 0.9 : 0.3 + (i % 10) * 0.05;
      return year === 2000 ? base : base * (1 - drop * ((year - 2000) / 22));
    },
  });

  it('ranks countries only — no regions or income groups', async () => {
    const { lib } = fakeLib({ 'SH.DYN.MORT': rows });
    const out = await recipe('child-mortality-fastest-fall').build(lib);
    const ranked = out.spec.series[0].data.map(([country]: [string, number]) => country);
    const aggNames = new Set(AGGREGATES.map((a) => a.name));
    // The regression: the aggregates were built to fall fastest, so a filter
    // that admits them puts them at the top of a "which countries" answer.
    expect(ranked.filter((c: string) => aggNames.has(c))).toEqual([]);
    expect(ranked).toHaveLength(10);
  });

  it('counts how many leaders halved rather than asserting all ten did', async () => {
    // These fall by 30–75%, so some clear 50% and some do not; the fixed text
    // this replaces would have claimed all ten did.
    const { lib } = fakeLib({ 'SH.DYN.MORT': rows });
    const out = await recipe('child-mortality-fastest-fall').build(lib);
    const plotted: number[] = out.spec.series[0].data.map(([, v]: [string, number]) => v);
    const halved = plotted.filter((v) => v <= -50).length;
    expect(out.answer).toContain(
      halved === 10 ? 'All ten leaders more than halved' : `${halved} of the ten more than halved`
    );
  });

  it('carries an evidence row for every endpoint it plots', async () => {
    const { lib } = fakeLib({ 'SH.DYN.MORT': rows });
    const out = await recipe('child-mortality-fastest-fall').build(lib);
    const countries = new Set(out.rows.map((r: DataRow) => r.iso3));
    // Two endpoints per ranked country, and nothing plotted without evidence.
    expect(countries.size).toBe(10);
    expect(out.rows.every((r: DataRow) => r.value !== null)).toBe(true);
  });
});

describe('health-spending-vs-child-mortality', () => {
  // The shape that broke the live run: mortality reported broadly through 2023,
  // spending broadly only to 2021 with a thin 2022 that a handful have filed.
  // The latest SHARED year is therefore 2022, with a sample of 22.
  const build = (partialCount: number) => ({
    'SH.XPD.CHEX.PC.CD': makeRows('SH.XPD.CHEX.PC.CD', {
      broad: [2018, 2019, 2020, 2021],
      partialYear: 2022,
      partialCount,
      includeAggregates: true,
      value: (_iso3, _year, i) => 50 + i * 60,
    }),
    'SH.DYN.MORT': makeRows('SH.DYN.MORT', {
      broad: [2018, 2019, 2020, 2021, 2022],
      includeAggregates: true,
      // Mortality falls as spending rises, and harder at the bottom — so the
      // log fit is genuinely better, as the answer text will claim.
      value: (_iso3, _year, i) => 120 / Math.log10(10 + i * 6),
    }),
  });

  it('correlates on a well-reported year, not the latest shared one', async () => {
    const series = build(22);
    const { lib } = fakeLib(series);
    const out = await recipe('health-spending-vs-child-mortality').build(lib);
    // The exact regression. correlate's own default lands on the partial year.
    const all = [...series['SH.XPD.CHEX.PC.CD'], ...series['SH.DYN.MORT']]
      .filter((r) => isRealCountry(r.iso3));
    expect(correlate(all, 'SH.XPD.CHEX.PC.CD', 'SH.DYN.MORT').year).toBe(2022);
    expect(correlate(all, 'SH.XPD.CHEX.PC.CD', 'SH.DYN.MORT').n).toBe(22);
    // The recipe declines that year and uses the last broadly reported one.
    expect(out.spec.title).toMatch(/2021/);
    expect(out.spec.series[0].data).toHaveLength(120);
  });

  it('plots exactly the countries the coefficient was computed from', async () => {
    const { lib } = fakeLib(build(22));
    const out = await recipe('health-spending-vs-child-mortality').build(lib);
    const n = Number(out.answer.match(/Across (\d+) countries/)![1]);
    expect(out.spec.series[0].data).toHaveLength(n);
    // Two evidence rows per plotted country, at the one correlated year.
    expect(out.rows).toHaveLength(n * 2);
    expect(new Set(out.rows.map((r: DataRow) => r.year)).size).toBe(1);
  });

  it('never states a strength the coefficient does not support', async () => {
    const { lib } = fakeLib(build(22));
    const out = await recipe('health-spending-vs-child-mortality').build(lib);
    const r = Number(out.answer.match(/is (-?\d\.\d\d)/)![1]);
    const word = out.answer.match(/— (strong|moderate|modest|weak) and negative/)![1];
    const expected =
      Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.5 ? 'moderate' : Math.abs(r) >= 0.3 ? 'modest' : 'weak';
    // The bug this replaces: the prose said "strongly negative" in fixed text,
    // which would have printed unchanged above an r of -0.35.
    expect(word).toBe(expected);
  });

  it('excludes aggregates from the correlation', async () => {
    const { lib } = fakeLib(build(22));
    const out = await recipe('health-spending-vs-child-mortality').build(lib);
    const aggIds = new Set(AGGREGATES.map((a) => a.id));
    expect(out.rows.filter((r: DataRow) => aggIds.has(r.iso3))).toEqual([]);
  });

  it('refuses when no year is well reported rather than correlating anyway', async () => {
    // Spending filed by nobody after 2018, and only a sliver even then.
    const series = {
      'SH.XPD.CHEX.PC.CD': makeRows('SH.XPD.CHEX.PC.CD', {
        broad: [], partialYear: 2018, partialCount: 5,
        value: (_i, _y, i) => 50 + i * 60,
      }),
      'SH.DYN.MORT': makeRows('SH.DYN.MORT', {
        broad: [2018, 2019, 2020, 2021, 2022],
        value: (_i, _y, i) => 120 - i,
      }),
    };
    const { lib } = fakeLib(series);
    await expect(recipe('health-spending-vs-child-mortality').build(lib))
      .rejects.toThrow(/not intact|no year has/);
  });

  it('fails loudly when a fetch comes back empty', async () => {
    const { lib } = fakeLib({ 'SH.XPD.CHEX.PC.CD': [], 'SH.DYN.MORT': [] });
    await expect(recipe('health-spending-vs-child-mortality').build(lib)).rejects.toThrow();
  });
});
