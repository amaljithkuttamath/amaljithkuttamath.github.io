// The snapshot generator's transforms, tested offline — and, more importantly,
// tested as a ROUND TRIP against the reader the app actually uses. The two
// halves are written in different languages of the same format (a .mjs writer,
// a .ts reader), which is exactly the arrangement where a layout drifts and
// every value silently shifts by a year. Only a round trip catches that.
import { describe, it, expect } from 'vitest';
import { toMirrorColumns, observedRange } from './gen-chitti-mirror.mjs';
import { parseMirrorFile, rowsFromMirror } from '../src/lib/chitti/sources/mirror';
import type { DataRow } from '../src/lib/chitti/tools';

const row = (iso3: string, year: number, value: number | null): DataRow =>
  ({ country: iso3, iso3, year, value, indicator: 'X' });

describe('observedRange', () => {
  it('spans the years that actually carry a value', () => {
    expect(observedRange([row('IND', 1960, null), row('IND', 1990, 5), row('IND', 2020, 7), row('IND', 2024, null)]))
      .toEqual({ yearStart: 1990, yearEnd: 2020 });
  });

  it('returns null when nothing is reported, so no file claims an empty span', () => {
    expect(observedRange([row('IND', 2000, null)])).toBeNull();
    expect(observedRange([])).toBeNull();
  });
});

describe('toMirrorColumns', () => {
  it('places each value at its year index', () => {
    const cols = toMirrorColumns([row('IND', 2001, 5), row('IND', 2003, 7)], 2000, 2004);
    expect(cols.IND).toEqual([null, 5, null, 7, null]);
  });

  it('rounds to the declared precision rather than carrying float noise', () => {
    const cols = toMirrorColumns([row('IND', 2000, 2500.1234567890123)], 2000, 2000);
    expect(cols.IND).toEqual([2500.12]);
  });

  it('drops a country that reports nothing instead of paying for its nulls', () => {
    const cols = toMirrorColumns([row('IND', 2000, 5), row('ZZZ', 2000, null)], 2000, 2001);
    expect(Object.keys(cols)).toEqual(['IND']);
  });

  it('ignores rows outside the declared span rather than growing the array', () => {
    const cols = toMirrorColumns([row('IND', 1999, 1), row('IND', 2000, 5), row('IND', 2005, 9)], 2000, 2001);
    expect(cols.IND).toEqual([5, null]);
  });

  it('ignores a row with no country code', () => {
    expect(toMirrorColumns([{ ...row('', 2000, 5) }], 2000, 2000)).toEqual({});
  });
});

describe('round trip: what the generator writes is what the reader reads', () => {
  // Real-ish input: three entities, a gap, an aggregate, and a value at each
  // end of the span so an off-by-one in either half is visible.
  const rows: DataRow[] = [
    row('IND', 2000, 90.5), row('IND', 2001, null), row('IND', 2002, 70.25),
    row('USA', 2000, 8.125), row('USA', 2002, 7),
    row('WLD', 2000, 77), row('WLD', 2001, 76), row('WLD', 2002, 75),
  ];

  const build = () => {
    const range = observedRange(rows)!;
    return {
      indicator: 'SH.DYN.MORT',
      upstreamUrl: 'https://api.worldbank.org/v2/x',
      mirroredAt: '2026-07-27T00:00:00.000Z',
      precision: 6,
      yearStart: range.yearStart,
      yearEnd: range.yearEnd,
      countries: toMirrorColumns(rows, range.yearStart, range.yearEnd),
    };
  };

  it('survives JSON and the reader with every value on its own year', () => {
    const parsed = parseMirrorFile(JSON.parse(JSON.stringify(build())))!;
    expect(parsed).not.toBeNull();
    const out = rowsFromMirror(parsed, 'SH.DYN.MORT', [], undefined, undefined);
    // Compare against the input, restricted to the observed span and with the
    // generator's own rounding applied — anything else would be comparing the
    // reader to a fiction rather than to what was written.
    const want = rows
      .map((r) => ({ ...r, value: r.value === null ? null : Number(r.value.toPrecision(6)) }))
      .sort((a, b) => (a.iso3 === b.iso3 ? a.year - b.year : a.iso3.localeCompare(b.iso3)));
    // USA has no 2001 row at all; the snapshot materialises it as an explicit
    // null, which is what the live API returns too.
    const got = out.filter((r) => !(r.iso3 === 'USA' && r.year === 2001));
    expect(got.map((r) => [r.iso3, r.year, r.value])).toEqual(want.map((r) => [r.iso3, r.year, r.value]));
    expect(out.find((r) => r.iso3 === 'USA' && r.year === 2001)!.value).toBeNull();
  });

  it('puts the first and last year on the right values', () => {
    // The off-by-one canary: an index shift in either half moves these.
    const parsed = parseMirrorFile(JSON.parse(JSON.stringify(build())))!;
    const ind = rowsFromMirror(parsed, 'X', ['IND'], undefined, undefined);
    expect(ind[0]).toMatchObject({ year: 2000, value: 90.5 });
    expect(ind[ind.length - 1]).toMatchObject({ year: 2002, value: 70.25 });
  });

  it('keeps aggregates, because asking for WLD is legitimate', () => {
    const parsed = parseMirrorFile(JSON.parse(JSON.stringify(build())))!;
    expect(rowsFromMirror(parsed, 'X', ['WLD'], undefined, undefined).map((r) => r.value))
      .toEqual([77, 76, 75]);
  });

  it('produces a payload the reader accepts at all', () => {
    // The contract between the two files. If the generator ever emits a shape
    // the reader rejects, every mirrored fetch silently falls through to live
    // and the snapshot becomes dead weight nobody notices.
    expect(parseMirrorFile(JSON.parse(JSON.stringify(build())))).not.toBeNull();
  });
});
