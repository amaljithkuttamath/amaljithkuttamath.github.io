import { describe, it, expect } from 'vitest';
import {
  parseFastPath,
  parseYears,
  buildFastSpec,
  buildFastSummary,
  pickLabel,
  pickKbHit,
  MIN_MATCH_SCORE,
  type FastPathPlan,
} from './fastpath';
import { scoreSeries, unmatchedTerms } from './scoring';
import { searchKb } from './kb';
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
    expect(s).toContain('+363.8%');
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
it('keeps sub-unit endpoint changes visible in the direct summary', () => {
 const plan=parse('Chart life expectancy in Japan since 2015')!;
 const rows: DataRow[]=[{country:'Japan',iso3:'JPN',year:2015,value:83.79},{country:'Japan',iso3:'JPN',year:2024,value:84.04}];
 const summary=buildFastSummary(plan,rows,'Life expectancy');
 expect(summary).toContain('83.79 in 2015'); expect(summary).toContain('84.04 in 2024');
});

// ── "Would we handle it wrong?" ──────────────────────────────────────────────
// Every case below once produced a confident chart of the wrong thing with no
// model in the loop. Each is pinned to the specific way it went wrong.
describe('parseFastPath — refuses rather than dropping part of the question', () => {
  it.each([
    // A bare numeric token the year parser did not use was silently discarded.
    ['population of India ages 0-14', 'charted the 65-and-over series'],
    ['population of India in 2050', 'a future year became a full history'],
    ['India GDP 2010 2020', 'two years became a single-year bar'],
    ['GDP of India from 2020 to 2010', 'a reversed range became "since 2020"'],
    ['GDP per capita India 1990, 2000 and 2010', 'three years became 2000–2010'],
    ['poverty at $2.15 a day in India', 'the threshold was dropped'],
    // "&" has no letters, so the two-indicator gate never saw a conjunction.
    ['GDP & inflation in India', 'charted inflation only'],
    ['GDP as well as inflation in India', 'charted inflation only'],
    ['GDP or GNI of India', 'charted one of the two'],
    // A lowercase "us" that is plainly the country was dropped as a pronoun.
    ['gdp of the us and china', 'charted China alone'],
  ])('%s  (%s)', (q) => {
    expect(parse(q)).toBeNull();
  });

  it('still takes the year forms it understands', () => {
    expect(parse('GDP of India 1990-2020')).toMatchObject({ yearStart: 1990, yearEnd: 2020 });
    expect(parse('GDP of India between 1990 and 2020')).toMatchObject({ yearStart: 1990, yearEnd: 2020 });
    expect(parse('GDP of India in 2019?')).toMatchObject({ yearStart: 2019, yearEnd: 2019, chartType: 'bar' });
    expect(parse('GDP growth in Germany over the last 20 years')).toMatchObject({ yearStart: YEAR - 20 });
    // Digits inside a word are part of the indicator, not a stray number.
    expect(parse('CO2 emissions in China since 2000')).toMatchObject({ indicatorQuery: 'CO2 emissions', yearStart: 2000 });
  });

  it('reads US and UK as countries, and "&" between countries as a list', () => {
    expect(parse('GDP of the US and China')!.countries).toEqual(['USA', 'CHN']);
    expect(parse('unemployment in U.S. and Canada')!.countries).toEqual(['USA', 'CAN']);
    expect(parse('life expectancy in UK and France')!.countries).toEqual(['GBR', 'FRA']);
    expect(parse('gdp of the uk and france')!.countries).toEqual(['GBR', 'FRA']);
    expect(parse('GDP of Japan & Korea')!.countries).toEqual(['JPN', 'KOR']);
    // …while the pronoun stays a pronoun.
    expect(parse('show us gdp of India')!.countries).toEqual(['IND']);
    expect(parse('SHOW US GDP OF INDIA')!.countries).toEqual(['IND']);
  });

  it('keeps a hyphenated term searchable', () => {
    const p = parse('under-5 mortality in India since 2000')!;
    expect(p.indicatorQuery).toBe('under-5 mortality');
    expect(pickKbHit(searchKb(p.indicatorQuery))).toMatchObject({ seriesId: 'SH.DYN.MORT' });
  });
});

describe('pickKbHit — commits only when the match is not a guess', () => {
  const pick = (q: string) => pickKbHit(searchKb(parse(q)!.indicatorQuery));

  it.each([
    ['life expectancy in Japan', 'SP.DYN.LE00.IN'],
    ['GDP per capita of India', 'NY.GDP.PCAP.CD'],
    ['GDP of India', 'NY.GDP.MKTP.CD'],
    ['literacy rate in India', 'SE.ADT.LITR.ZS'],
    ['child mortality in Kenya since 1990', 'SH.DYN.MORT'],
    ['internet users in Brazil', 'IT.NET.USER.ZS'],
    ['inflation in Brazil since 2000', 'FP.CPI.TOTL.ZG'],
    ['population of Nigeria', 'SP.POP.TOTL'],
    ['health spending in France', 'SH.XPD.CHEX.GD.ZS'],
    ['fertility rate in Niger', 'SP.DYN.TFRT.IN'],
  ])('commits: %s → %s', (q, id) => {
    expect(pick(q)).toMatchObject({ seriesId: id });
  });

  it.each([
    // A word of the question the chosen series says nothing about.
    ['adult mortality in India', 'cleared the bar on the infant series'],
    ['neonatal mortality in India', 'cleared the bar on the infant series'],
    ['life expectancy of women in Japan', 'charted the total'],
    ['population of Mexico city', 'charted the national population'],
    // A tie between long-tail series, broken only by catalogue order.
    ['rural population of India', 'charted rural population below 5m elevation'],
    ['remittances in India', 'charted paid, tied with received'],
    ['male literacy in India', 'youth and adult male tied'],
    ['youth unemployment in Spain', 'charted the female series'],
    ['tourism in Thailand', 'arrivals tied with departures'],
  ])('refuses: %s  (%s)', (q) => {
    expect(pick(q)).toBe('ambiguous');
  });

  it('defers to the flat search when the KB has no confident match', () => {
    expect(pickKbHit(searchKb('banana exports'))).toBeNull();
    expect(pickKbHit([])).toBeNull();
  });
});

describe('scoring — terms match at the start of a word, not anywhere in it', () => {
  it('does not find "male" in "female" or "age" in "percentage"', () => {
    expect(scoreSeries('male', '', 'Literacy rate, youth female')).toBe(0);
    expect(scoreSeries('age', '', 'percentage of total')).toBe(0);
    expect(scoreSeries('male', '', 'Literacy rate, youth male')).toBeGreaterThan(0);
  });
  it('still lets a word run on, so singular finds plural', () => {
    expect(scoreSeries('export', '', 'Exports of goods and services')).toBeGreaterThan(0);
    expect(scoreSeries('gdp', 'NY.GDP.PCAP.CD', 'Income per person')).toBeGreaterThan(0);
  });
  it('reports the terms a series leaves unanswered', () => {
    expect(unmatchedTerms('adult mortality', 'SP.DYN.IMRT.IN', 'Mortality rate, infant')).toEqual(['adult']);
    expect(unmatchedTerms('infant mortality rate', 'SP.DYN.IMRT.IN', 'Mortality rate, infant')).toEqual([]);
    expect(unmatchedTerms('', 'x', 'y')).toEqual([]);
  });
});

describe('buildFastSummary — each change carries its own years', () => {
  const plan: FastPathPlan = {
    indicatorQuery: 'life expectancy', countries: ['IND', 'SSD'], countryNames: ['India', 'South Sudan'],
    chartType: 'line',
  };
  it('does not stamp one country\'s span on another', () => {
    const s = buildFastSummary(
      plan,
      rows([['India', 'IND', 1960, 45], ['India', 'IND', 2023, 72], ['South Sudan', 'SSD', 2011, 55], ['South Sudan', 'SSD', 2019, 58]]),
      'Life expectancy'
    );
    expect(s).toContain('India from 45 to 72 (+60%) between 1960 and 2023');
    expect(s).toContain('South Sudan from 55 to 58 (+5.5%) between 2011 and 2019');
  });
  it('keeps the single shared heading when every country spans the same years', () => {
    const s = buildFastSummary(
      plan,
      rows([['India', 'IND', 1960, 45], ['India', 'IND', 2023, 72], ['South Sudan', 'SSD', 1960, 40], ['South Sudan', 'SSD', 2023, 58]]),
      'Life expectancy'
    );
    expect(s).toBe(
      'Life expectancy rose in both countries between 1960 and 2023: India from 45 to 72 (+60%) and South Sudan from 40 to 58 (+45%).'
    );
  });
});

describe('buildFastSummary — reads as a sentence, and every word is computed', () => {
  const plan: FastPathPlan = {
    indicatorQuery: 'life expectancy', countries: ['JPN', 'ITA', 'ESP'], countryNames: ['Japan', 'Italy', 'Spain'],
    chartType: 'line',
  };
  const three = (it: number, es: number) =>
    rows([
      ['Spain', 'ESP', 1960, 69], ['Spain', 'ESP', 2023, es],
      ['Japan', 'JPN', 1960, 68], ['Japan', 'JPN', 2023, 84],
      ['Italy', 'ITA', 1960, 70], ['Italy', 'ITA', 2023, it],
    ]);

  it('says "rose in all three" only when all three rose, in the order they were asked', () => {
    expect(buildFastSummary(plan, three(83, 83.5), 'Life expectancy (years)')).toBe(
      'Life expectancy (years) rose in all three countries between 1960 and 2023: Japan from 68 to 84 (+23.5%), Italy from 70 to 83 (+18.6%) and Spain from 69 to 83.5 (+21%).'
    );
  });

  it('drops the summary verb when directions differ, and states each one', () => {
    const s = buildFastSummary(plan, three(66, 69), 'Life expectancy (years)');
    expect(s).toBe(
      'Life expectancy (years), 1960 to 2023: Japan rose from 68 to 84 (+23.5%); Italy fell from 70 to 66 (−5.7%); Spain was unchanged at 69.'
    );
    expect(s).not.toMatch(/all three|both/);
  });

  it('quotes a percent series in percentage points, not a percent of a percent', () => {
    const s = buildFastSummary(
      { ...plan, countries: ['ESP'], countryNames: ['Spain'] },
      rows([['Spain', 'ESP', 2000, 4], ['Spain', 'ESP', 2020, 5]]),
      'Unemployment, total (% of total labor force)'
    );
    expect(s).toBe(
      'Unemployment, total (% of total labor force) in Spain rose from 4 in 2000 to 5 in 2020 (+1 percentage point).'
    );
  });

  it('names a single-year value and the extremes plainly', () => {
    const bar = { ...plan, chartType: 'bar' as const };
    expect(buildFastSummary(bar, rows([['Japan', 'JPN', 2019, 84.4]]), 'Life expectancy (years)')).toBe(
      'Life expectancy (years) in Japan was 84.4 in 2019.'
    );
    expect(
      buildFastSummary(bar, rows([['Japan', 'JPN', 2019, 84.4], ['Italy', 'ITA', 2019, 83.5]]), 'Life expectancy (years)')
    ).toBe('Life expectancy (years) in 2019: Japan is highest at 84.4 and Italy lowest at 83.5.');
  });
});
