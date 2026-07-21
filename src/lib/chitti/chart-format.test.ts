import { describe, it, expect } from 'vitest';
import {
  formatAxisValue,
  isPercentUnit,
  needsDataZoom,
  legendMode,
  titleSlug,
  DATAZOOM_THRESHOLD,
  LEGEND_SCROLL_THRESHOLD,
} from './chart-format';
import type { ChartSpec } from './tools';

describe('isPercentUnit', () => {
  it('detects the % glyph and the word percent', () => {
    expect(isPercentUnit('%')).toBe(true);
    expect(isPercentUnit('% of GDP')).toBe(true);
    expect(isPercentUnit('percent')).toBe(true);
    expect(isPercentUnit('Percentage of population')).toBe(true);
    expect(isPercentUnit('per cent')).toBe(true);
  });
  it('is false for non-percent and empty units', () => {
    expect(isPercentUnit('US$')).toBe(false);
    expect(isPercentUnit('deaths per 1,000 live births')).toBe(false);
    expect(isPercentUnit('')).toBe(false);
    expect(isPercentUnit(undefined)).toBe(false);
    expect(isPercentUnit(null)).toBe(false);
  });
});

describe('formatAxisValue — large magnitudes (k/M/B/T)', () => {
  it('suffixes thousands, millions, billions, trillions', () => {
    expect(formatAxisValue(1234)).toBe('1.2k');
    expect(formatAxisValue(12345)).toBe('12.3k');
    expect(formatAxisValue(1200000)).toBe('1.2M');
    expect(formatAxisValue(3400000000)).toBe('3.4B');
    expect(formatAxisValue(1e12)).toBe('1T');
    expect(formatAxisValue(2.5e12)).toBe('2.5T');
  });
  it('drops trailing zeros in the mantissa', () => {
    expect(formatAxisValue(1000)).toBe('1k');
    expect(formatAxisValue(3000000)).toBe('3M');
    expect(formatAxisValue(1000000000)).toBe('1B');
  });
  it('handles boundaries', () => {
    expect(formatAxisValue(999)).toBe('999');
    expect(formatAxisValue(1000)).toBe('1k');
    expect(formatAxisValue(999999)).toBe('1000k'); // just under 1M, still k-scaled
    expect(formatAxisValue(1000000)).toBe('1M');
  });
});

describe('formatAxisValue — negatives', () => {
  it('preserves sign across every magnitude', () => {
    expect(formatAxisValue(-1200000)).toBe('-1.2M');
    expect(formatAxisValue(-42)).toBe('-42');
    expect(formatAxisValue(-0.5, '%')).toBe('-0.5%');
    expect(formatAxisValue(-3400000000)).toBe('-3.4B');
  });
});

describe('formatAxisValue — small floats and precision', () => {
  it('keeps sensible precision under 1', () => {
    expect(formatAxisValue(0.5)).toBe('0.5');
    expect(formatAxisValue(0.05)).toBe('0.05');
    expect(formatAxisValue(0.005)).toBe('0.005');
    expect(formatAxisValue(0.12345)).toBe('0.12');
  });
  it('one decimal in [1,100), integer above', () => {
    expect(formatAxisValue(1.234)).toBe('1.2');
    expect(formatAxisValue(45.67)).toBe('45.7');
    expect(formatAxisValue(123.4)).toBe('123');
    expect(formatAxisValue(79)).toBe('79');
  });
});

describe('formatAxisValue — percent units', () => {
  it('appends % for percent units', () => {
    expect(formatAxisValue(45.2, '%')).toBe('45.2%');
    expect(formatAxisValue(0.5, 'percent')).toBe('0.5%');
    expect(formatAxisValue(100, '% of GDP')).toBe('100%');
    expect(formatAxisValue(0, '%')).toBe('0%');
  });
  it('does not append % for non-percent units', () => {
    expect(formatAxisValue(45.2, 'years')).toBe('45.2');
    expect(formatAxisValue(1200000, 'US$')).toBe('1.2M');
  });
});

describe('formatAxisValue — zero, no unit, and degenerate input', () => {
  it('renders zero cleanly', () => {
    expect(formatAxisValue(0)).toBe('0');
    expect(formatAxisValue(-0)).toBe('0');
  });
  it('formats with no unit', () => {
    expect(formatAxisValue(2100)).toBe('2.1k');
    expect(formatAxisValue(7)).toBe('7');
  });
  it('returns empty string for non-finite / nullish (never throws)', () => {
    expect(formatAxisValue(NaN)).toBe('');
    expect(formatAxisValue(Infinity)).toBe('');
    expect(formatAxisValue(-Infinity)).toBe('');
    expect(formatAxisValue(null)).toBe('');
    expect(formatAxisValue(undefined)).toBe('');
  });
});

// Helpers to build line specs with N distinct x points.
function lineSpecWithPoints(n: number): ChartSpec {
  const data: [number, number][] = [];
  for (let i = 0; i < n; i++) data.push([2000 + i, i]);
  return { type: 'line', title: 't', series: [{ name: 'A', data }] };
}

describe('needsDataZoom — threshold boundary (strict >40)', () => {
  it('no zoom at or below 40 points', () => {
    expect(needsDataZoom(lineSpecWithPoints(40))).toBe(false);
    expect(needsDataZoom(lineSpecWithPoints(10))).toBe(false);
    expect(DATAZOOM_THRESHOLD).toBe(40);
  });
  it('zoom above 40 points', () => {
    expect(needsDataZoom(lineSpecWithPoints(41))).toBe(true);
    expect(needsDataZoom(lineSpecWithPoints(120))).toBe(true);
  });
  it('counts the union of x across series, not per-series length', () => {
    // Two series sharing the same 30 years -> 30 distinct categories, no zoom.
    const shared = lineSpecWithPoints(30).series[0].data;
    const spec: ChartSpec = {
      type: 'line',
      title: 't',
      series: [
        { name: 'A', data: shared },
        { name: 'B', data: shared.map(([x, y]) => [x, y + 1]) as [number, number][] },
      ],
    };
    expect(needsDataZoom(spec)).toBe(false);
  });
  it('never zooms bars or scatter, however long', () => {
    const bar: ChartSpec = { ...lineSpecWithPoints(100), type: 'bar' };
    const scatter: ChartSpec = { ...lineSpecWithPoints(100), type: 'scatter' };
    expect(needsDataZoom(bar)).toBe(false);
    expect(needsDataZoom(scatter)).toBe(false);
  });
  it('guards null/empty specs', () => {
    expect(needsDataZoom(null)).toBe(false);
    expect(needsDataZoom(undefined)).toBe(false);
    expect(needsDataZoom({ type: 'line', title: 't', series: [] })).toBe(false);
  });
});

function specWithSeries(n: number): ChartSpec {
  const series = [];
  for (let i = 0; i < n; i++) series.push({ name: 'S' + i, data: [[2000, i]] as [number, number][] });
  return { type: 'line', title: 't', series };
}

describe('legendMode — threshold boundary (strict >6)', () => {
  it('plain at or below 6 series', () => {
    expect(legendMode(specWithSeries(1))).toBe('plain');
    expect(legendMode(specWithSeries(6))).toBe('plain');
    expect(LEGEND_SCROLL_THRESHOLD).toBe(6);
  });
  it('scroll above 6 series', () => {
    expect(legendMode(specWithSeries(7))).toBe('scroll');
    expect(legendMode(specWithSeries(20))).toBe('scroll');
  });
  it('guards null specs', () => {
    expect(legendMode(null)).toBe('plain');
    expect(legendMode(undefined)).toBe('plain');
  });
});

describe('titleSlug', () => {
  it('slugifies titles for filenames', () => {
    expect(titleSlug('GDP per capita, 2020')).toBe('gdp-per-capita-2020');
    expect(titleSlug('Life expectancy (years)')).toBe('life-expectancy-years');
    expect(titleSlug('  Trailing & leading!  ')).toBe('trailing-leading');
  });
  it('falls back to "chart" for empty/symbol-only titles', () => {
    expect(titleSlug('')).toBe('chart');
    expect(titleSlug('   ')).toBe('chart');
    expect(titleSlug('!!!')).toBe('chart');
    expect(titleSlug(undefined)).toBe('chart');
    expect(titleSlug(null)).toBe('chart');
  });
});
