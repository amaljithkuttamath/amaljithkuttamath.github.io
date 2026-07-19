import { describe, it, expect } from 'vitest';
import { chartCategories, matchPointToRow, matchRowToPoint } from './chart-link';
import type { ChartSpec, DataRow } from './tools';

// A multi-series line chart: two countries over three years. Series names are
// the countries, x is the year.
const lineSpec: ChartSpec = {
  type: 'line',
  title: 'Life expectancy',
  series: [
    { name: 'France', data: [[2000, 79], [2010, 81], [2020, 82]] },
    { name: 'Germany', data: [[2000, 78], [2010, 80], [2020, 81]] },
  ],
};
const lineRows: DataRow[] = [
  { country: 'France', iso3: 'FRA', year: 2000, value: 79 },
  { country: 'France', iso3: 'FRA', year: 2010, value: 81 },
  { country: 'France', iso3: 'FRA', year: 2020, value: 82 },
  { country: 'Germany', iso3: 'DEU', year: 2000, value: 78 },
  { country: 'Germany', iso3: 'DEU', year: 2010, value: 80 },
  { country: 'Germany', iso3: 'DEU', year: 2020, value: 81 },
];

// A single-series ranking bar: one metric, x is the country.
const barSpec: ChartSpec = {
  type: 'bar',
  title: 'GDP per capita 2020',
  series: [{ name: 'GDP per capita', data: [['India', 2100], ['China', 10500], ['Brazil', 6800]] }],
};
const barRows: DataRow[] = [
  { country: 'India', iso3: 'IND', year: 2020, value: 2100 },
  { country: 'China', iso3: 'CHN', year: 2020, value: 10500 },
  { country: 'Brazil', iso3: 'BRA', year: 2020, value: 6800 },
];

describe('chartCategories mirrors buildOption', () => {
  it('sorts line categories numerically', () => {
    const spec: ChartSpec = {
      type: 'line',
      title: 't',
      series: [
        { name: 'A', data: [[2020, 1], [2000, 2]] },
        { name: 'B', data: [[2010, 3]] },
      ],
    };
    expect(chartCategories(spec)).toEqual([2000, 2010, 2020]);
  });
  it('keeps bar categories in first-seen order (no sort)', () => {
    expect(chartCategories(barSpec)).toEqual(['India', 'China', 'Brazil']);
  });
  it('returns empty for scatter', () => {
    const spec: ChartSpec = { type: 'scatter', title: 't', series: [{ name: 'A', data: [[1, 2]] }] };
    expect(chartCategories(spec)).toEqual([]);
  });
});

describe('matchPointToRow — multi-series line', () => {
  it('maps Germany @ 2010 to the Germany 2010 row', () => {
    // dataIndex 1 = category 2010 (sorted), seriesIndex 1 = Germany
    const row = matchPointToRow(lineSpec, 1, 1, lineRows);
    expect(row).toEqual({ country: 'Germany', iso3: 'DEU', year: 2010, value: 80 });
  });
  it('maps France @ 2020 to the France 2020 row', () => {
    const row = matchPointToRow(lineSpec, 0, 2, lineRows);
    expect(row?.iso3).toBe('FRA');
    expect(row?.year).toBe(2020);
  });
  it('returns null for an out-of-range dataIndex', () => {
    expect(matchPointToRow(lineSpec, 0, 9, lineRows)).toBeNull();
  });
  it('returns null for an out-of-range seriesIndex', () => {
    expect(matchPointToRow(lineSpec, 5, 0, lineRows)).toBeNull();
  });
});

describe('matchPointToRow — single-series bar (category is country)', () => {
  it('maps the China bar to the China row', () => {
    const row = matchPointToRow(barSpec, 0, 1, barRows);
    expect(row).toEqual({ country: 'China', iso3: 'CHN', year: 2020, value: 10500 });
  });
  it('disambiguates by value when a country has multiple years', () => {
    const rows: DataRow[] = [
      { country: 'India', iso3: 'IND', year: 2010, value: 1400 },
      { country: 'India', iso3: 'IND', year: 2020, value: 2100 },
    ];
    const row = matchPointToRow(barSpec, 0, 0, rows); // India bar = 2100
    expect(row?.year).toBe(2020);
  });
});

describe('matchPointToRow — string vs number years', () => {
  it('matches when the spec x is a numeric string and the row year is a number', () => {
    const spec: ChartSpec = {
      type: 'line',
      title: 't',
      series: [{ name: 'France', data: [['2000', 79], ['2010', 81]] as any }],
    };
    const row = matchPointToRow(spec, 0, 1, lineRows); // cats sorted: ['2000','2010'] -> di1 = 2010
    expect(row?.country).toBe('France');
    expect(row?.year).toBe(2010);
  });
});

describe('matchPointToRow — unmatched / edge cases', () => {
  it('returns null when no row matches', () => {
    expect(matchPointToRow(lineSpec, 0, 0, [])).toBeNull();
  });
  it('returns null for scatter (cannot map to a single row)', () => {
    const spec: ChartSpec = { type: 'scatter', title: 't', series: [{ name: 'A', data: [[1, 2]] }] };
    expect(matchPointToRow(spec, 0, 0, barRows)).toBeNull();
  });
  it('returns null for a null spec', () => {
    expect(matchPointToRow(null, 0, 0, barRows)).toBeNull();
  });
  it('returns null when a grouped series has no point in that category cell', () => {
    // 'Germany' series has no 1990 point; category union includes France's 1990.
    const spec: ChartSpec = {
      type: 'grouped-bar',
      title: 't',
      series: [
        { name: 'France', data: [['1990', 5], ['2000', 6]] as any },
        { name: 'Germany', data: [['2000', 7]] as any },
      ],
    };
    // cats = ['1990','2000']; Germany @ dataIndex 0 ('1990') = absent -> null
    expect(matchPointToRow(spec, 1, 0, [])).toBeNull();
  });
});

describe('matchRowToPoint — inverse of matchPointToRow', () => {
  it('maps a line row back to its series/data index', () => {
    expect(matchRowToPoint(lineSpec, lineRows[4])).toEqual({ seriesIndex: 1, dataIndex: 1 }); // Germany 2010
  });
  it('round-trips every line point', () => {
    const cats = chartCategories(lineSpec);
    for (let si = 0; si < lineSpec.series.length; si++) {
      for (let di = 0; di < cats.length; di++) {
        const row = matchPointToRow(lineSpec, si, di, lineRows);
        expect(row).not.toBeNull();
        expect(matchRowToPoint(lineSpec, row!)).toEqual({ seriesIndex: si, dataIndex: di });
      }
    }
  });
  it('maps a ranking-bar row to its category cell', () => {
    expect(matchRowToPoint(barSpec, barRows[2])).toEqual({ seriesIndex: 0, dataIndex: 2 }); // Brazil
  });
  it('returns null for a row not shown in the chart', () => {
    const orphan: DataRow = { country: 'Japan', iso3: 'JPN', year: 2010, value: 84 };
    expect(matchRowToPoint(lineSpec, orphan)).toBeNull();
  });
  it('returns null for scatter and null spec', () => {
    const spec: ChartSpec = { type: 'scatter', title: 't', series: [{ name: 'A', data: [[1, 2]] }] };
    expect(matchRowToPoint(spec, barRows[0])).toBeNull();
    expect(matchRowToPoint(null, barRows[0])).toBeNull();
  });
  it('picks the right series in a grouped-bar by matching value', () => {
    const spec: ChartSpec = {
      type: 'grouped-bar',
      title: 't',
      series: [
        { name: '2000', data: [['France', 79], ['Germany', 78]] as any },
        { name: '2020', data: [['France', 82], ['Germany', 81]] as any },
      ],
    };
    // A Germany/2020/81 row should map to series 1 (the '2020' series), Germany cell.
    const row: DataRow = { country: 'Germany', iso3: 'DEU', year: 2020, value: 81 };
    expect(matchRowToPoint(spec, row)).toEqual({ seriesIndex: 1, dataIndex: 1 });
  });
});
