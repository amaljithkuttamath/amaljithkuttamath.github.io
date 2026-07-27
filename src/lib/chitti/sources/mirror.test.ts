import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseMirrorFile, rowsFromMirror, type MirrorFile } from './mirror';
import { citationsHeadline, citationsToCsvComments, type Citation } from '../tools';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.resetModules(); });

const file: MirrorFile = {
  indicator: 'SH.DYN.MORT',
  upstreamUrl: 'https://api.worldbank.org/v2/country/all/indicator/SH.DYN.MORT?format=json',
  mirroredAt: '2026-07-27T00:00:00.000Z',
  sourceUpdated: '2024-12-16',
  precision: 6,
  yearStart: 2000,
  yearEnd: 2004,
  countries: {
    IND: [90, 80, 70, 60, 50],
    USA: [8, 7.5, 7, null, 6.5],
    WLD: [77, 76, 75, 74, 73],
  },
};

describe('parseMirrorFile', () => {
  it('accepts a well-formed payload', () => {
    const f = parseMirrorFile(JSON.parse(JSON.stringify(file)))!;
    expect(f.indicator).toBe('SH.DYN.MORT');
    expect(f.countries.IND).toHaveLength(5);
    expect(f.sourceUpdated).toBe('2024-12-16');
  });

  it('drops a country whose row length does not match the year span', () => {
    // The failure this prevents is the worst kind for a time series: a short or
    // long row shifts every subsequent year by one, so 2003's value would be
    // reported under 2002 with nothing to indicate it. Dropping the country is
    // recoverable — the live path fills the gap. Shifting it is not.
    const f = parseMirrorFile({ ...file, countries: { IND: [1, 2, 3], USA: [1, 2, 3, 4, 5] } })!;
    expect(f.countries.IND).toBeUndefined();
    expect(f.countries.USA).toHaveLength(5);
  });

  it('coerces anything non-numeric to null rather than into a value', () => {
    const f = parseMirrorFile({ ...file, countries: { IND: ['9', null, NaN, Infinity, 5] } })!;
    expect(f.countries.IND).toEqual([null, null, null, null, 5]);
  });

  it.each([
    ['not an object', 'nonsense'],
    ['null', null],
    ['missing indicator', { ...file, indicator: '' }],
    ['missing mirroredAt', { ...file, mirroredAt: '' }],
    ['inverted year range', { ...file, yearStart: 2004, yearEnd: 2000 }],
    ['non-numeric years', { ...file, yearStart: 'x' }],
    ['countries is an array', { ...file, countries: [] }],
    ['no usable countries', { ...file, countries: { IND: [1] } }],
  ])('rejects %s', (_label, body) => {
    expect(parseMirrorFile(body)).toBeNull();
  });
});

describe('rowsFromMirror', () => {
  it('expands to the same shape the live fetcher returns, names included', () => {
    const rows = rowsFromMirror(file, 'SH.DYN.MORT', ['IND'], undefined, undefined);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      country: 'India', iso3: 'IND', year: 2000, value: 90, indicator: 'SH.DYN.MORT',
    });
  });

  it('keeps nulls as nulls, so a gap in the source stays a gap', () => {
    const rows = rowsFromMirror(file, 'SH.DYN.MORT', ['USA'], undefined, undefined);
    expect(rows.map((r) => r.value)).toEqual([8, 7.5, 7, null, 6.5]);
  });

  it('honours the year window and clamps it to what the snapshot holds', () => {
    const rows = rowsFromMirror(file, 'SH.DYN.MORT', ['IND'], 2002, 2099);
    expect(rows.map((r) => r.year)).toEqual([2002, 2003, 2004]);
  });

  it('returns every entity when no countries are named, aggregates included', () => {
    // WLD and the regional aggregates are legitimate things to ask for, so the
    // snapshot carries them exactly as the API does; it is the CALLER's job to
    // exclude them from a "which countries" answer (see eda.isRealCountry).
    const rows = rowsFromMirror(file, 'SH.DYN.MORT', [], undefined, undefined);
    expect(new Set(rows.map((r) => r.iso3))).toEqual(new Set(['IND', 'USA', 'WLD']));
  });

  it('is case-insensitive about country codes', () => {
    expect(rowsFromMirror(file, 'SH.DYN.MORT', ['ind'], 2000, 2000)).toHaveLength(1);
  });

  it('sorts by country then year, matching the live fetcher', () => {
    const rows = rowsFromMirror(file, 'SH.DYN.MORT', [], undefined, undefined);
    const keys = rows.map((r) => `${r.iso3}:${r.year}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('fetchFromMirror falls through instead of failing', () => {
  // Every "not here" must return null so the World Bank adapter goes live. The
  // mirror is only ever allowed to make an answer FASTER, never different, and
  // never a refusal the live path would not also give.
  async function withManifest(indicators: Record<string, unknown>, fetchImpl: unknown) {
    vi.resetModules();
    vi.doMock('../../../data/chitti/mirror-manifest.json', () => ({
      default: { generated: '2026-07-27T00:00:00.000Z', indicators },
    }));
    globalThis.fetch = fetchImpl as typeof fetch;
    return await import('./mirror');
  }
  const present = { 'SH.DYN.MORT': { yearStart: 2000, yearEnd: 2004 } };
  const serve = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }) as unknown as Response);

  it('serves a hit, and reports the UPSTREAM url plus the snapshot date', async () => {
    const m = await withManifest(present, serve(file));
    const r = await m.fetchFromMirror('SH.DYN.MORT', ['IND'], undefined, undefined);
    expect(r!.rows).toHaveLength(5);
    // A reader following the citation must reach the World Bank, not our copy.
    expect(r!.requestUrl).toMatch(/api\.worldbank\.org/);
    expect(r!.mirroredAt).toBe('2026-07-27T00:00:00.000Z');
    expect(r!.sourceUpdated).toBe('2024-12-16');
  });

  it('returns null for an indicator that is not mirrored, without a request', async () => {
    const f = serve(file);
    const m = await withManifest(present, f);
    expect(await m.fetchFromMirror('NY.GDP.PCAP.CD', [], undefined, undefined)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('returns null when the file 404s', async () => {
    const m = await withManifest(present, serve('', false));
    expect(await m.fetchFromMirror('SH.DYN.MORT', [], undefined, undefined)).toBeNull();
  });

  it('returns null when the payload is malformed', async () => {
    const m = await withManifest(present, serve({ indicator: 'X' }));
    expect(await m.fetchFromMirror('SH.DYN.MORT', [], undefined, undefined)).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const m = await withManifest(present, vi.fn(async () => { throw new Error('offline'); }));
    expect(await m.fetchFromMirror('SH.DYN.MORT', [], undefined, undefined)).toBeNull();
  });

  it('returns null when the requested window is outside the snapshot', async () => {
    // Answering "no data" from a partial snapshot would be a wrong answer; the
    // live API may well have those years.
    const m = await withManifest(present, serve(file));
    expect(await m.fetchFromMirror('SH.DYN.MORT', ['IND'], 2030, 2040)).toBeNull();
  });

  it('returns null for a country the snapshot does not carry', async () => {
    const m = await withManifest(present, serve(file));
    expect(await m.fetchFromMirror('SH.DYN.MORT', ['ZWE'], undefined, undefined)).toBeNull();
  });

  it('is inert when the manifest is the empty placeholder', async () => {
    const f = serve(file);
    const m = await withManifest({}, f);
    expect(m.mirrorHas('SH.DYN.MORT')).toBe(false);
    expect(await m.fetchFromMirror('SH.DYN.MORT', [], undefined, undefined)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('a snapshot is never presented as a live fetch', () => {
  const cite = (over: Partial<Citation> = {}): Citation => ({
    id: 'c', source: 'worldbank', sourceLabel: 'World Bank Open Data',
    indicatorId: 'SH.DYN.MORT', indicatorName: 'Under-5 mortality',
    url: 'https://data.worldbank.org/indicator/SH.DYN.MORT',
    countries: [], yearRange: null, fetchedAt: '2026-07-27T10:00:00.000Z',
    rowCount: 5, cached: false, ...over,
  });

  it('keeps the live wording when nothing is mirrored', () => {
    expect(citationsHeadline([cite()])).toMatch(/fetched live/);
    expect(citationsToCsvComments([cite()])).toMatch(/fetched live and cited/);
  });

  it('drops the "live" claim as soon as one citation is a snapshot', () => {
    // The regression: this heading was a fixed string asserting every number was
    // fetched live. A provenance tool must not carry a claim it does not check.
    const mixed = [cite(), cite({ id: 'd', mirroredAt: '2026-07-01T00:00:00.000Z' })];
    expect(citationsHeadline(mixed)).not.toMatch(/fetched live/);
    expect(citationsHeadline(mixed)).toMatch(/1 of 2 from a dated snapshot/);
    expect(citationsToCsvComments(mixed)).not.toMatch(/fetched live/);
  });

  it('dates the snapshot in the CSV, which outlives the session', () => {
    const csv = citationsToCsvComments([cite({ mirroredAt: '2026-07-01T00:00:00.000Z' })]);
    expect(csv).toMatch(/from snapshot taken 2026-07-01/);
    expect(csv).not.toMatch(/— fetched 2026-07-27/);
  });
});

describe('the World Bank adapter prefers the snapshot', () => {
  // The integration the whole thing exists for: when an indicator is mirrored,
  // a fetch must not touch api.worldbank.org at all.
  const file2 = { ...file, countries: { IND: [90, 80, 70, 60, 50] } };

  async function load(indicators: Record<string, unknown>, fetchImpl: unknown) {
    vi.resetModules();
    vi.doMock('../../../data/chitti/mirror-manifest.json', () => ({
      default: { generated: '2026-07-27T00:00:00.000Z', indicators },
    }));
    globalThis.fetch = fetchImpl as typeof fetch;
    // Entered through the REGISTRY, not by importing ./worldbank directly.
    // tools.ts re-exports ./sources, so worldbank.ts sits in a pre-existing
    // import loop that only resolves when the registry is the entry point —
    // importing the adapter file first yields a half-initialised module.
    return (await import('./index')).adapterById('worldbank')!;
  }

  it('answers from the snapshot without a request to the API', async () => {
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes('api.worldbank.org')) throw new Error('must not hit the live API');
      return { ok: true, status: 200, json: async () => file2 } as unknown as Response;
    });
    const adapter = await load({ 'SH.DYN.MORT': { yearStart: 2000, yearEnd: 2004 } }, spy);
    const r = await adapter.fetchSeries('SH.DYN.MORT', ['IND'], undefined, undefined);
    expect(r.rows).toHaveLength(5);
    expect(r.mirroredAt).toBe('2026-07-27T00:00:00.000Z');
    expect(spy.mock.calls.every((c) => !String(c[0]).includes('api.worldbank.org'))).toBe(true);
  });

  it('goes live for an indicator the snapshot does not hold', async () => {
    let hitLive = false;
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes('api.worldbank.org')) {
        hitLive = true;
        return { ok: true, status: 200, json: async () => [
          { page: 1, pages: 1 },
          [{ countryiso3code: 'IND', country: { value: 'India' }, date: '2020', value: 5 }],
        ] } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    const adapter = await load({ 'SH.DYN.MORT': { yearStart: 2000, yearEnd: 2004 } }, spy);
    const r = await adapter.fetchSeries('NY.GDP.PCAP.CD', ['IND'], undefined, undefined);
    expect(hitLive).toBe(true);
    expect(r.rows).toHaveLength(1);
    // A live answer carries no snapshot date, so "absent" always means live.
    expect(r.mirroredAt).toBeUndefined();
  });

  it('falls through to the live API when the snapshot file is unreachable', async () => {
    let hitLive = false;
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes('api.worldbank.org')) {
        hitLive = true;
        return { ok: true, status: 200, json: async () => [
          { page: 1, pages: 1 },
          [{ countryiso3code: 'IND', country: { value: 'India' }, date: '2020', value: 5 }],
        ] } as unknown as Response;
      }
      throw new Error('snapshot unreachable');
    });
    const adapter = await load({ 'SH.DYN.MORT': { yearStart: 2000, yearEnd: 2004 } }, spy);
    const r = await adapter.fetchSeries('SH.DYN.MORT', ['IND'], undefined, undefined);
    expect(hitLive).toBe(true);
    expect(r.rows).toHaveLength(1);
  });
});
