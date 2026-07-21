import { describe, it, expect } from 'vitest';
import {
  buildDashSharePayload,
  encodeDashShare,
  decodeDashShare,
  materializeSharedDashboard,
  parseImportedDashboard,
  importTitle,
  prepareImportedDashboard,
  DASH_SHARE_VERSION,
  MAX_DASH_SHARE_BYTES,
} from './dashboard-share';
import {
  createDashboard,
  addTile,
  makeTile,
  markTileStale,
  touchTileData,
  serializeDashboard,
  DASHBOARD_VERSION,
  DASHBOARD_SOFT_CAP_BYTES,
  type Dashboard,
} from './dashboard';
import type { ChartSpec, DataRow, Citation } from './tools';

// ── Fixtures ──────────────────────────────────────────────────────────────────
function spec(title: string): ChartSpec {
  return {
    type: 'line',
    title,
    x_axis: 'Year',
    y_axis: 'years',
    series: [
      { name: 'France', data: [[2000, 79.2], [2010, 81.7], [2020, 82.3]] },
      { name: 'Germany', data: [[2000, 78.1], [2010, 80.1], [2020, 81.0]] },
    ],
  };
}

function rows(indicator: string): DataRow[] {
  return [
    { country: 'France', iso3: 'FRA', year: 2000, value: 79.2, indicator },
    { country: 'France', iso3: 'FRA', year: 2020, value: 82.3, indicator },
    { country: 'Germany', iso3: 'DEU', year: 2000, value: 78.1, indicator },
    { country: 'Germany', iso3: 'DEU', year: 2020, value: 81.0, indicator },
  ];
}

function citation(indicator: string): Citation {
  return {
    id: `wb:${indicator}:FRA,DEU:2000-2020`,
    source: 'worldbank',
    sourceLabel: 'World Bank Open Data',
    indicatorId: indicator,
    indicatorName: 'Life expectancy at birth, total (years)',
    url: `https://data.worldbank.org/indicator/${indicator}`,
    requestUrl: `https://api.worldbank.org/v2/country/FRA;DEU/indicator/${indicator}`,
    countries: ['FRA', 'DEU'],
    yearRange: { start: 2000, end: 2020 },
    fetchedAt: '2026-07-21T11:03:00.000Z',
    sourceUpdated: '2026-06-28',
    rowCount: 4,
    cached: false,
  };
}

function twoTileDashboard(): Dashboard {
  let d = createDashboard('Life & health');
  d = addTile(
    d,
    makeTile({ title: 'Life expectancy', spec: spec('Life expectancy'), rows: rows('SP.DYN.LE00.IN'), citations: [citation('SP.DYN.LE00.IN')] })
  );
  d = addTile(
    d,
    makeTile({ title: 'Mortality', spec: spec('Mortality'), rows: rows('SP.DYN.IMRT.IN'), citations: [citation('SP.DYN.IMRT.IN')] })
  );
  return d;
}

// ── Payload build (whitelist) ──────────────────────────────────────────────────
describe('buildDashSharePayload', () => {
  it('projects tiles to the versioned compact shape', () => {
    const p = buildDashSharePayload(twoTileDashboard());
    expect(p.v).toBe(DASH_SHARE_VERSION);
    expect(p.title).toBe('Life & health');
    expect(p.tiles.length).toBe(2);
    expect(p.tiles[0].title).toBe('Life expectancy');
    expect(p.tiles[0].spec.series.length).toBe(2);
    expect(p.tiles[0].rows.length).toBe(4);
    expect(p.tiles[0].citations.length).toBe(1);
    // No document id / storage tile id leaks into the compact shape.
    expect('id' in (p.tiles[0] as any)).toBe(false);
  });
});

// ── Roundtrip fidelity ─────────────────────────────────────────────────────────
describe('roundtrip fidelity (compressed)', () => {
  it('tiles / citations / stale / refreshedAt survive exactly', async () => {
    let d = twoTileDashboard();
    // Give tile 0 a successful refresh vintage, tile 1 a stale marker.
    d = touchTileData(d, d.tiles[0].id, rows('SP.DYN.LE00.IN'), [citation('SP.DYN.LE00.IN')], '2026-07-20T00:00:00.000Z');
    d = markTileStale(d, d.tiles[1].id, 'network error', '2026-07-19T00:00:00.000Z');

    const r = await encodeDashShare(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lossy).toBe(false);
    expect(r.payload[0]).toBe('C');

    const back = await decodeDashShare(r.payload);
    expect(back).not.toBeNull();
    expect(back!.title).toBe('Life & health');
    expect(back!.tiles.length).toBe(2);
    expect(back!.tiles[0].refreshedAt).toBe('2026-07-20T00:00:00.000Z');
    expect(back!.tiles[0].rows.length).toBe(4);
    expect(back!.tiles[0].citations).toEqual(d.tiles[0].citations);
    expect(back!.tiles[1].stale).toEqual({ failedAt: '2026-07-19T00:00:00.000Z', reason: 'network error' });
    expect(back!.tiles[0].spec).toEqual(d.tiles[0].spec);
    expect(back!.tiles.every((t) => t.lossy !== true)).toBe(true);
  });

  it('roundtrips uncompressed (U flag)', async () => {
    const r = await encodeDashShare(twoTileDashboard(), { compress: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload[0]).toBe('U');
    const back = await decodeDashShare(r.payload);
    expect(back!.tiles.length).toBe(2);
    expect(back!.tiles[0].rows.length).toBe(4);
  });
});

// ── Size ladder ────────────────────────────────────────────────────────────────
describe('size ladder', () => {
  function bigRows(n: number, indicator: string): DataRow[] {
    const out: DataRow[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ country: 'Country ' + i, iso3: 'C' + i, year: 1960 + (i % 60), value: i * 1.5, indicator });
    }
    return out;
  }

  it('full when under budget (no lossy)', async () => {
    const r = await encodeDashShare(twoTileDashboard());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lossy).toBe(false);
    expect(r.bytes).toBeLessThan(MAX_DASH_SHARE_BYTES);
  });

  it('drops rows largest-first (lossy) when over budget, keeping specs', async () => {
    let d = createDashboard('Big board');
    // Tile A: small rows. Tile B: large rows — should be dropped first. Row
    // counts stay well under the 200KB per-dashboard cap while overflowing the
    // small share budget below.
    d = addTile(d, makeTile({ title: 'Small', spec: spec('Small'), rows: bigRows(6, 'A'), citations: [citation('A')] }));
    d = addTile(d, makeTile({ title: 'Huge', spec: spec('Huge'), rows: bigRows(500, 'B'), citations: [citation('B')] }));

    // A budget small enough that dropping the huge tile's rows is required, but
    // the small tile's rows still fit.
    const r = await encodeDashShare(d, { maxBytes: 1500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lossy).toBe(true);
    const back = await decodeDashShare(r.payload);
    expect(back).not.toBeNull();
    const huge = back!.tiles.find((t) => t.title === 'Huge')!;
    const small = back!.tiles.find((t) => t.title === 'Small')!;
    expect(huge.lossy).toBe(true);
    expect(huge.rows.length).toBe(0); // dropped
    expect(huge.spec.series.length).toBe(2); // chart survives
    expect(small.lossy).toBeUndefined();
    expect(small.rows.length).toBe(6); // smaller tile kept its rows
  });

  it('refuses (too-large) when even a row-less payload overflows', async () => {
    let d = createDashboard('Overflow');
    d = addTile(d, makeTile({ title: 'T', spec: spec('T'), rows: bigRows(50, 'X'), citations: [citation('X')] }));
    // A budget so small even the spec+title+citation cannot fit.
    const r = await encodeDashShare(d, { maxBytes: 30 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too-large');
  });
});

// ── Version gate + malformed ────────────────────────────────────────────────────
describe('decode gate + malformed', () => {
  it('unknown version → null', async () => {
    const payload = { ...buildDashSharePayload(twoTileDashboard()), v: 999 };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(await decodeDashShare('U' + b64)).toBeNull();
  });
  it('empty / too-short / unknown flag → null', async () => {
    expect(await decodeDashShare('')).toBeNull();
    expect(await decodeDashShare('C')).toBeNull();
    expect(await decodeDashShare('Zabcdef')).toBeNull();
  });
  it('truncated / non-base64 → null', async () => {
    const r = await encodeDashShare(twoTileDashboard());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await decodeDashShare(r.payload.slice(0, Math.floor(r.payload.length / 2)))).toBeNull();
    expect(await decodeDashShare('U@@@not base64@@@')).toBeNull();
  });
  it('valid base64 of non-JSON → null', async () => {
    const b64 = Buffer.from('not json at all', 'utf8').toString('base64url');
    expect(await decodeDashShare('U' + b64)).toBeNull();
  });
});

// ── Planted key never survives (fragment) ────────────────────────────────────────
describe('key is never serialized (fragment)', () => {
  it('a stray apiKey (top-level or nested) never reaches the encoded output', async () => {
    const KEY = 'sk-super-secret-dash-key-1234567890';
    const d = twoTileDashboard();
    const dirty: any = {
      ...d,
      apiKey: KEY,
      __proto__: { polluted: true },
      tiles: d.tiles.map((t) => ({
        ...t,
        apiKey: KEY,
        spec: { ...t.spec, apiKey: KEY, series: t.spec.series.map((s) => ({ ...s, apiKey: KEY })) },
        rows: t.rows.map((r) => ({ ...r, apiKey: KEY })),
        citations: t.citations.map((c) => ({ ...c, apiKey: KEY })),
        stale: { failedAt: 'x', reason: 'y', apiKey: KEY },
      })),
    };

    const built = buildDashSharePayload(dirty);
    expect(JSON.stringify(built)).not.toContain(KEY);

    const r = await encodeDashShare(dirty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).not.toContain(KEY);
    const back = await decodeDashShare(r.payload);
    expect(JSON.stringify(back)).not.toContain(KEY);
  });
});

// ── JSON export / import ──────────────────────────────────────────────────────
describe('JSON import (versioned whitelist)', () => {
  it('a planted apiKey never survives file import', () => {
    const dirty = JSON.stringify({
      v: DASHBOARD_VERSION,
      id: 'dash_x',
      title: 'Imported',
      apiKey: 'sk-file-secret',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      tiles: [
        {
          id: 'tile_x',
          title: 'T',
          apiKey: 'sk-tile',
          spec: { type: 'line', title: 'T', series: [{ name: 'x', data: [[1, 2]], apiKey: 'sk-series' }], apiKey: 'sk-spec' },
          rows: [{ country: 'X', iso3: 'X', year: 1, value: 2, apiKey: 'sk-row' }],
          citations: [{ ...citation('X'), apiKey: 'sk-cite' }],
          pinnedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const parsed = parseImportedDashboard(dirty);
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain('sk-');
    expect('apiKey' in (parsed as any)).toBe(false);
    expect('apiKey' in (parsed as any).tiles[0]).toBe(false);
  });

  it('malformed / oversized → null (never throws)', () => {
    expect(parseImportedDashboard('')).toBeNull();
    expect(parseImportedDashboard('{ not json')).toBeNull();
    expect(parseImportedDashboard(JSON.stringify({ v: 999, tiles: [] }))).toBeNull(); // version gate
    expect(parseImportedDashboard('x'.repeat(DASHBOARD_SOFT_CAP_BYTES * 4 + 1))).toBeNull();
  });

  it('export → import roundtrips through the document whitelist', () => {
    const d = twoTileDashboard();
    const parsed = parseImportedDashboard(serializeDashboard(d));
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe(d.title);
    expect(parsed!.tiles.length).toBe(2);
    expect(parsed!.tiles[0].rows).toEqual(d.tiles[0].rows);
  });
});

describe('import collision naming + never-overwrite', () => {
  it('importTitle appends (imported) then (imported N) on collision', () => {
    expect(importTitle([], 'Board')).toBe('Board');
    expect(importTitle(['Board'], 'Board')).toBe('Board (imported)');
    expect(importTitle(['Board', 'Board (imported)'], 'Board')).toBe('Board (imported 2)');
    expect(importTitle(['board'], 'Board')).toBe('Board (imported)'); // case-insensitive
    expect(importTitle(['Other'], '')).toBe('Imported dashboard');
  });

  it('prepareImportedDashboard mints a fresh id and de-duplicated title', () => {
    const d = twoTileDashboard();
    const prepared = prepareImportedDashboard(d, [d.title]);
    expect(prepared.id).not.toBe(d.id); // fresh id → never overwrites the original key
    expect(prepared.id).toMatch(/^dash_/);
    expect(prepared.title).toBe(`${d.title} (imported)`);
    expect(prepared.tiles.length).toBe(2);
    // Fresh tile ids too (rebuilt through cleanTile).
    expect(prepared.tiles[0].id).not.toBe(d.tiles[0].id);
  });
});

// ── Materialize shared payload → editable dashboard ──────────────────────────────
describe('materializeSharedDashboard', () => {
  it('builds a fresh, editable dashboard from a decoded snapshot', async () => {
    const d = twoTileDashboard();
    const r = await encodeDashShare(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = await decodeDashShare(r.payload);
    expect(state).not.toBeNull();
    const local = materializeSharedDashboard(state!);
    expect(local.v).toBe(DASHBOARD_VERSION);
    expect(local.id).toMatch(/^dash_/);
    expect(local.id).not.toBe(d.id);
    expect(local.title).toBe(d.title);
    expect(local.tiles.length).toBe(2);
    expect(local.tiles[0].rows.length).toBe(4);
    expect(local.tiles[0].id).toMatch(/^tile_/);
  });

  it('a lossy shared tile materializes with an empty rows array (chart from spec)', async () => {
    let d = createDashboard('Big');
    const many: DataRow[] = [];
    for (let i = 0; i < 500; i++) many.push({ country: 'C' + i, iso3: 'C' + i, year: 2000, value: i, indicator: 'X' });
    d = addTile(d, makeTile({ title: 'Huge', spec: spec('Huge'), rows: many, citations: [citation('X')] }));
    const r = await encodeDashShare(d, { maxBytes: 1500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const state = await decodeDashShare(r.payload);
    const local = materializeSharedDashboard(state!);
    expect(local.tiles[0].rows.length).toBe(0);
    expect(local.tiles[0].spec.series.length).toBe(2); // chart intact
  });
});
