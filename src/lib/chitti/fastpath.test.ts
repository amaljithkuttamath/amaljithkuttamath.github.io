import { describe, it, expect } from 'vitest';
import {
  parseFastPath,
  parseYears,
  buildFastSpec,
  buildFastSummary,
  pickLabel,
  MIN_MATCH_SCORE,
  type FastPathPlan,
} from './fastpath';
import { scoreSeries } from './scoring';
import { INDICATORS, type DataRow } from './tools';

// Pinned so the relative-year forms ("last 20 years") are deterministic.
const YEAR = 2026;
const parse = (q: string) => parseFastPath(q, YEAR);

describe('parseFastPath — questions it takes', () => {
  it('reads indicator, country, start year and chart type', () => {
    const p = parse('Chart GDP per capita for India since 2000')!;
    expect(p).not.toBeNull();
    expect(p.indicatorQuery).toBe('GDP per capita');
    expect(p.countries).toEqual(['IND']);
    expect(p.yearStart).toBe(2000);
    expect(p.yearEnd).toBeUndefined();
    expect(p.chartType).toBe('line');
  });

  it('keeps several countries as one series-per-country question', () => {
    const p = parse('life expectancy in Japan and Korea since 1990')!;
    expect(p.countries).toEqual(['JPN', 'KOR']);
    expect(p.indicatorQuery).toBe('life expectancy');
    // "and" here joins two COUNTRIES, not two indicators — must not disqualify.
    expect(p.chartType).toBe('line');
  });

  it('preserves digits in the indicator phrase', () => {
    // Regression: the country scanner strips non-letters, which turned the
    // search query for this question into "CO emissions per capita".
    expect(parse('CO2 emissions per capita for Germany')!.indicatorQuery).toBe(
      'CO2 emissions per capita'
    );
  });

  it('treats a single named year as a bar snapshot', () => {
    const p = parse('CO2 emissions per capita for Germany in 2019')!;
    expect(p.chartType).toBe('bar');
    expect(p.yearStart).toBe(2019);
    expect(p.yearEnd).toBe(2019);
  });

  it('resolves multi-word country names in one piece', () => {
    const p = parse('population of the United States since 1960')!;
    expect(p.countries).toEqual(['USA']);
    // "united"/"states" must not leak into the search query.
    expect(p.indicatorQuery).toBe('population');
  });

  it('handles a relative year window', () => {
    expect(parse('inflation in Argentina over the last 20 years')!.yearStart).toBe(YEAR - 20);
  });
});

describe('parseFastPath — questions it refuses (each escalates to the agent)', () => {
  const refused: [string, string][] = [
    ['Which countries reduced child mortality the most since 2000?', 'ranking across countries'],
    ['Rank the 10 countries where child mortality fell fastest', 'ranking'],
    ['Does higher health spending buy lower child mortality?', 'relationship between series'],
    ['Compare CO2 per capita against GDP per capita for the G7', 'two series'],
    ['What does GDP per capita actually measure?', 'conceptual'],
    ['Why is inflation high in Argentina?', 'conceptual'],
    ['Which economies does the IMF project to grow fastest through 2030?', 'projection'],
    ['Chart India GDP per capita since 2000 and pin it to a dashboard', 'action'],
    ['GDP and population in India', 'two indicators'],
    ['show me India', 'no indicator'],
    ['GDP per capita', 'no country'],
    ['hi', 'too short'],
  ];
  for (const [q, why] of refused) {
    it(`refuses "${q}" (${why})`, () => {
      expect(parse(q)).toBeNull();
    });
  }

  it('refuses a question naming more countries than a chart can carry', () => {
    expect(
      parse('population in France Germany Italy Spain Portugal Belgium Netherlands since 2000')
    ).toBeNull();
  });
});

describe('parseYears', () => {
  it('reads explicit ranges in several phrasings', () => {
    for (const q of ['from 1990 to 2020', 'between 1990 and 2020', 'over 1990-2020']) {
      expect(parseYears(q, YEAR)).toMatchObject({ yearStart: 1990, yearEnd: 2020 });
    }
  });

  it('reads open-ended and single-year forms', () => {
    expect(parseYears('since 2000', YEAR)).toMatchObject({ yearStart: 2000 });
    expect(parseYears('before 2010', YEAR)).toMatchObject({ yearEnd: 2010 });
    expect(parseYears('in 2019', YEAR)).toMatchObject({ yearStart: 2019, yearEnd: 2019, single: 2019 });
  });

  it('ignores implausible years rather than guessing', () => {
    expect(parseYears('since 1200', YEAR).yearStart).toBeUndefined();
    expect(parseYears('since 2999', YEAR).yearStart).toBeUndefined();
    expect(parseYears('no years here', YEAR)).toEqual({ used: [] });
  });
});

// The threshold is a product decision, so pin the behaviour it buys: the common
// phrasings must clear it, and a query the catalog cannot really serve must not.
describe('MIN_MATCH_SCORE against the curated catalog', () => {
  const best = (q: string) =>
    Math.max(...INDICATORS.map((i) => scoreSeries(q, i.id, i.name)));

  it('admits the common phrasings', () => {
    for (const q of [
      'GDP per capita', 'life expectancy', 'population', 'inflation',
      'literacy rate', 'CO2 emissions per capita', 'unemployment rate',
    ]) {
      expect(best(q), `"${q}" should clear the bar`).toBeGreaterThanOrEqual(MIN_MATCH_SCORE);
    }
  });

  it('refuses a query the catalog cannot serve', () => {
    for (const q of ['banana exports', 'olympic medals', 'coffee consumption']) {
      expect(best(q), `"${q}" should fall below the bar`).toBeLessThan(MIN_MATCH_SCORE);
    }
  });
});

describe('pickLabel', () => {
  it('prefers the catalog name over a raw indicator code', () => {
    // Regression: World Bank's adapter label is `(nid) => nid` by design, which
    // produced answers reading "India: NY.GDP.PCAP.CD rose from 442…".
    expect(pickLabel('GDP per capita (current US$)', 'NY.GDP.PCAP.CD', 'NY.GDP.PCAP.CD')).toBe(
      'GDP per capita (current US$)'
    );
  });

  it('falls back to the adapter label, then the id', () => {
    expect(pickLabel('', 'Annual CO₂ emissions per capita', 'owid:co2')).toBe(
      'Annual CO₂ emissions per capita'
    );
    expect(pickLabel('NY.GDP.PCAP.CD', 'NY.GDP.PCAP.CD', 'NY.GDP.PCAP.CD')).toBe('NY.GDP.PCAP.CD');
    expect(pickLabel('', '', 'SH.DYN.MORT')).toBe('SH.DYN.MORT');
  });
});

const rows = (spec: [string, string, number, number][]): DataRow[] =>
  spec.map(([country, iso3, year, value]) => ({ country, iso3, year, value, indicator: 'X' }));

describe('buildFastSpec', () => {
  const linePlan: FastPathPlan = {
    indicatorQuery: 'gdp per capita',
    countries: ['IND', 'CHN'],
    countryNames: ['India', 'China'],
    yearStart: 2000,
    chartType: 'line',
  };

  it('builds one line per country, years ascending', () => {
    const spec = buildFastSpec(
      linePlan,
      rows([
        ['India', 'IND', 2010, 1358], ['India', 'IND', 2000, 442],
        ['China', 'CHN', 2000, 959], ['China', 'CHN', 2010, 4550],
      ]),
      'GDP per capita (current US$)'
    );
    expect(spec.type).toBe('line');
    expect(spec.series.map((s) => s.name)).toEqual(['India', 'China']);
    expect(spec.series[0].data).toEqual([[2000, 442], [2010, 1358]]);
    expect(spec.title).toContain('2000–2010');
  });

  it('drops a requested country the source returned nothing for', () => {
    const spec = buildFastSpec(linePlan, rows([['India', 'IND', 2000, 442]]), 'GDP');
    expect(spec.series).toHaveLength(1);
  });

  it('builds one bar per country for a single-year snapshot', () => {
    const spec = buildFastSpec(
      { ...linePlan, chartType: 'bar', yearStart: 2019, yearEnd: 2019 },
      rows([['China', 'CHN', 2019, 10143], ['India', 'IND', 2019, 2050]]),
      'GDP per capita'
    );
    expect(spec.type).toBe('bar');
    // Country order follows the question, not the data.
    expect(spec.series[0].data).toEqual([['India', 2050], ['China', 10143]]);
  });
});

describe('buildFastSummary — states the data, never interprets it', () => {
  const plan: FastPathPlan = {
    indicatorQuery: 'gdp per capita', countries: ['IND'], countryNames: ['India'],
    chartType: 'line',
  };

  it('reports direction, endpoints and percent change for one country', () => {
    const s = buildFastSummary(
      plan,
      rows([['India', 'IND', 2000, 442], ['India', 'IND', 2020, 2050]]),
      'GDP per capita'
    );
    expect(s).toContain('India');
    expect(s).toContain('rose');
    expect(s).toContain('442');
    expect(s).toContain('2,050');
    expect(s).toMatch(/\+36[0-9]%/);
  });

  it('says "fell" when the series declines', () => {
    const s = buildFastSummary(
      plan,
      rows([['India', 'IND', 2000, 90], ['India', 'IND', 2020, 30]]),
      'Under-5 mortality'
    );
    expect(s).toContain('fell');
  });

  it('names the extremes for a single-year comparison without ranking language', () => {
    const s = buildFastSummary(
      { ...plan, chartType: 'bar', countries: ['IND', 'CHN'] },
      rows([['India', 'IND', 2019, 2050], ['China', 'CHN', 2019, 10143]]),
      'GDP per capita'
    );
    expect(s).toContain('China is highest');
    expect(s).toContain('India lowest');
    expect(s).toContain('2019');
  });

  it('returns empty rather than inventing a story from a single point', () => {
    expect(buildFastSummary(plan, rows([['India', 'IND', 2000, 442]]), 'GDP')).toBe('');
  });
});
