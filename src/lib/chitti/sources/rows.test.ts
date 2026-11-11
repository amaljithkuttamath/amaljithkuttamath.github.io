import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchOwid } from './owid';
import { fetchWho, whoRows } from './who';

afterEach(() => vi.unstubAllGlobals());

describe('whoRows — one observation per country-year', () => {
  const row = (iso: string, year: number, v: number | null, Dim1?: string, Dim2?: string) =>
    ({ SpatialDim: iso, TimeDim: year, NumericValue: v, Dim1: Dim1 ?? null, Dim2: Dim2 ?? null });

  it('takes the both-sexes total when GHO returns a sex breakdown', () => {
    expect(
      whoRows([row('MEX', 2016, 24.3, 'SEX_MLE'), row('MEX', 2016, 28.9, 'SEX_BTSX'), row('MEX', 2016, 32.8, 'SEX_FMLE')])
    ).toEqual([{ iso3: 'MEX', year: 2016, value: 28.9 }]);
  });
  it('prefers an undisaggregated row over any breakdown', () => {
    expect(whoRows([row('IND', 2019, 1, 'SEX_BTSX'), row('IND', 2019, 2)])).toEqual([{ iso3: 'IND', year: 2019, value: 2 }]);
  });
  it('drops a country-year whose breakdown it cannot resolve, and keeps a lone row', () => {
    expect(whoRows([row('IND', 2019, 1, 'SEX_MLE'), row('IND', 2019, 2, 'SEX_FMLE'), row('USA', 2019, 7, 'SEX_FMLE')])).toEqual([
      { iso3: 'USA', year: 2019, value: 7 },
    ]);
    // A second dimension on the both-sexes row is still a breakdown.
    expect(whoRows([row('IND', 2019, 1, 'SEX_BTSX', 'AGE_A'), row('IND', 2019, 2, 'SEX_BTSX', 'AGE_B')])).toEqual([]);
  });
  it('skips null, non-numeric and malformed rows without throwing', () => {
    expect(whoRows([row('IND', 2019, null), { SpatialDim: 'IND', TimeDim: 'x', NumericValue: 1 }, null, 3, row('IND', 2020, 'n/a' as any)])).toEqual([]);
    expect(whoRows(undefined)).toEqual([]);
  });
  it('feeds fetchWho', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ value: [row('MEX', 2016, 24.3, 'SEX_MLE'), row('MEX', 2016, 28.9, 'SEX_BTSX'), row('MEX', 2016, 32.8, 'SEX_FMLE')] }),
    })));
    const { rows } = await fetchWho('who:NCD_BMI_30A', ['MEX']);
    expect(rows).toEqual([{ country: 'Mexico', iso3: 'MEX', year: 2016, value: 28.9, indicator: 'who:NCD_BMI_30A' }]);
  });
});

describe('fetchOwid — only a finite number is a value', () => {
  it('reads blank, whitespace and text cells as missing, never 0 or NaN', async () => {
    const csv = [
      'Entity,Code,Year,Regime',
      'India,IND,2019,2',
      'India,IND,2020,electoral democracy',
      'India,IND,2021, ',
      'India,IND,2022,',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => csv })));
    const { rows } = await fetchOwid('owid:political-regime');
    expect(rows.map((r) => r.value)).toEqual([2, null, null, null]);
  });
});
