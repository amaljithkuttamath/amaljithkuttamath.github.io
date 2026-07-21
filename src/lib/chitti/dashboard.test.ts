import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDashboard,
  addTile,
  removeTile,
  renameTile,
  renameDashboard,
  moveTile,
  replaceTile,
  touchTileData,
  markTileStale,
  makeTile,
  deriveSourceNote,
  serializeDashboard,
  parseDashboard,
  cleanDashboard,
  dashboardBytes,
  DashboardCapError,
  DASHBOARD_VERSION,
  DASHBOARD_SOFT_CAP_BYTES,
  DASHBOARD_NS,
  listDashboards,
  listDashboardSummaries,
  loadDashboard,
  saveDashboard,
  deleteDashboard,
  findDashboardByTitle,
  type Dashboard,
  type Tile,
  type StorageLike,
} from './dashboard';
import type { ChartSpec, DataRow, Citation } from './tools';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const spec: ChartSpec = {
  type: 'line',
  title: 'Child mortality since 2000',
  x_axis: 'Year',
  y_axis: 'deaths per 1,000 live births',
  series: [
    { name: 'India', data: [[2000, 66.6], [2020, 27.3]] },
    { name: 'Nigeria', data: [[2000, 111.5], [2020, 71.2]] },
  ],
};

const rows: DataRow[] = [
  { country: 'India', iso3: 'IND', year: 2000, value: 66.6, indicator: 'SP.DYN.IMRT.IN' },
  { country: 'India', iso3: 'IND', year: 2020, value: 27.3, indicator: 'SP.DYN.IMRT.IN' },
  { country: 'Nigeria', iso3: 'NGA', year: 2000, value: 111.5, indicator: 'SP.DYN.IMRT.IN' },
  { country: 'Nigeria', iso3: 'NGA', year: 2020, value: 71.2, indicator: 'SP.DYN.IMRT.IN' },
];

const citations: Citation[] = [
  {
    id: 'wb:SP.DYN.IMRT.IN|IND,NGA|2000:2020',
    source: 'worldbank',
    sourceLabel: 'World Bank Open Data',
    indicatorId: 'SP.DYN.IMRT.IN',
    indicatorName: 'Mortality rate, infant (per 1,000 live births)',
    url: 'https://data.worldbank.org/indicator/SP.DYN.IMRT.IN',
    requestUrl: 'https://api.worldbank.org/v2/country/IND;NGA/indicator/SP.DYN.IMRT.IN',
    countries: ['IND', 'NGA'],
    yearRange: { start: 2000, end: 2020 },
    fetchedAt: '2026-07-21T09:03:00.000Z',
    sourceUpdated: '2024-12-16',
    rowCount: 4,
    cached: false,
  },
];

function sampleTile(over?: Partial<Parameters<typeof makeTile>[0]>): Tile {
  return makeTile({ title: 'Child mortality', spec, rows, citations, ...over });
}

// A Map-backed Web Storage-like fake. Faithful to the getItem/setItem/removeItem/
// length/key(i) surface the module actually uses.
class FakeStorage implements StorageLike {
  private m = new Map<string, string>();
  private failOnSet = false;
  setFailOnSet(v: boolean) {
    this.failOnSet = v;
  }
  get length() {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    if (this.failOnSet) {
      const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e;
    }
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  // test helper
  rawSet(k: string, v: string) { this.m.set(k, v); }
}

// ── Document ops ─────────────────────────────────────────────────────────────
describe('createDashboard', () => {
  it('builds a v1 document with a unique id and empty tiles', () => {
    const d = createDashboard('My board');
    expect(d.v).toBe(DASHBOARD_VERSION);
    expect(d.title).toBe('My board');
    expect(d.tiles).toEqual([]);
    expect(d.id).toMatch(/^dash_/);
    expect(d.created).toBe(d.updated);
    expect(createDashboard('a').id).not.toBe(createDashboard('a').id);
  });
  it('falls back to a default title when blank', () => {
    expect(createDashboard('   ').title).toBe('Untitled dashboard');
  });
});

describe('immutability + updated bump', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('addTile returns a NEW object, does not mutate input, bumps updated', () => {
    const d0 = createDashboard('board');
    vi.setSystemTime(new Date('2026-07-21T00:05:00.000Z'));
    const d1 = addTile(d0, sampleTile());
    expect(d1).not.toBe(d0);
    expect(d0.tiles).toHaveLength(0); // input untouched
    expect(d1.tiles).toHaveLength(1);
    expect(d1.updated > d0.updated).toBe(true);
    expect(d1.created).toBe(d0.created); // created is stable
  });

  it('removeTile / renameTile / renameDashboard return new objects and bump updated', () => {
    let d = createDashboard('board');
    const t = sampleTile();
    d = addTile(d, t);
    const beforeUpdated = d.updated;
    vi.setSystemTime(new Date('2026-07-21T01:00:00.000Z'));

    const renamed = renameDashboard(d, 'New name');
    expect(renamed).not.toBe(d);
    expect(renamed.title).toBe('New name');
    expect(renamed.updated > beforeUpdated).toBe(true);
    expect(d.title).toBe('board'); // original untouched

    const rt = renameTile(d, t.id, 'Retitled tile');
    expect(rt).not.toBe(d);
    expect(rt.tiles[0].title).toBe('Retitled tile');
    expect(d.tiles[0].title).not.toBe('Retitled tile');

    const removed = removeTile(d, t.id);
    expect(removed).not.toBe(d);
    expect(removed.tiles).toHaveLength(0);
    expect(d.tiles).toHaveLength(1);
  });

  it('renameDashboard is a no-op (same ref) for an unchanged/blank title', () => {
    const d = createDashboard('board');
    expect(renameDashboard(d, 'board')).toBe(d);
    expect(renameDashboard(d, '   ')).toBe(d);
  });

  it('removeTile of an unknown tile is a no-op returning the same object', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    expect(removeTile(d, 'nope')).toBe(d);
  });
});

describe('moveTile bounds', () => {
  function threeTileBoard(): { d: Dashboard; ids: string[] } {
    let d = createDashboard('board');
    const t1 = sampleTile({ title: 'A' });
    const t2 = sampleTile({ title: 'B' });
    const t3 = sampleTile({ title: 'C' });
    d = addTile(d, t1); d = addTile(d, t2); d = addTile(d, t3);
    return { d, ids: [t1.id, t2.id, t3.id] };
  }

  it('moves a tile up and down, returning new objects', () => {
    const { d, ids } = threeTileBoard();
    const up = moveTile(d, ids[1], 'up'); // B up → B,A,C
    expect(up).not.toBe(d);
    expect(up.tiles.map((t) => t.title)).toEqual(['B', 'A', 'C']);
    const down = moveTile(d, ids[1], 'down'); // B down → A,C,B
    expect(down.tiles.map((t) => t.title)).toEqual(['A', 'C', 'B']);
    expect(d.tiles.map((t) => t.title)).toEqual(['A', 'B', 'C']); // original intact
  });

  it('is a no-op at the boundaries (first up, last down) and for unknown ids', () => {
    const { d, ids } = threeTileBoard();
    expect(moveTile(d, ids[0], 'up')).toBe(d);
    expect(moveTile(d, ids[2], 'down')).toBe(d);
    expect(moveTile(d, 'unknown', 'up')).toBe(d);
  });
});

describe('replaceTile', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('swaps a tile in place, keeping position, returning a new object, bumping updated', () => {
    let d = createDashboard('board');
    const a = sampleTile({ title: 'A' });
    const b = sampleTile({ title: 'B' });
    const c = sampleTile({ title: 'C' });
    d = addTile(d, a); d = addTile(d, b); d = addTile(d, c);
    const before = d.updated;
    vi.setSystemTime(new Date('2026-07-21T02:00:00.000Z'));

    const fresh = sampleTile({ title: 'B-replaced' });
    const out = replaceTile(d, b.id, fresh);
    expect(out).not.toBe(d);
    expect(out.tiles.map((t) => t.title)).toEqual(['A', 'B-replaced', 'C']); // position kept
    expect(out.tiles[1].id).toBe(fresh.id);
    expect(out.updated > before).toBe(true);
    expect(d.tiles.map((t) => t.title)).toEqual(['A', 'B', 'C']); // input untouched
  });

  it('is a no-op (same ref) for an unknown tile id', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    expect(replaceTile(d, 'nope', sampleTile())).toBe(d);
  });

  it('enforces the soft cap on the swapped-in tile', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    const heavyRows: DataRow[] = [];
    for (let i = 0; i < 6000; i++) {
      heavyRows.push({ country: 'Countryland', iso3: 'CLD', year: 1900 + i, value: i * 1.5, indicator: 'SP.DYN.IMRT.IN' });
    }
    const heavy = makeTile({ title: 'Heavy', spec, rows: heavyRows, citations });
    expect(() => replaceTile(d, d.tiles[0].id, heavy)).toThrow(DashboardCapError);
  });
});

describe('touchTileData (refresh success)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-21T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  const newRows: DataRow[] = [
    { country: 'India', iso3: 'IND', year: 2000, value: 60.1, indicator: 'SP.DYN.IMRT.IN' },
    { country: 'India', iso3: 'IND', year: 2022, value: 25.0, indicator: 'SP.DYN.IMRT.IN' },
  ];
  const newCites: Citation[] = [
    { ...citations[0], fetchedAt: '2026-08-01T00:00:00.000Z', sourceUpdated: '2025-06-30', rowCount: 2 },
  ];

  it('replaces rows + citations, re-derives sourceNote/vintage, stamps refreshedAt, keeps id/title/spec/pinnedAt/position', () => {
    let d = createDashboard('board');
    const a = sampleTile({ title: 'A' });
    const b = sampleTile({ title: 'B' });
    d = addTile(d, a); d = addTile(d, b);
    const before = d.updated;
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));

    const out = touchTileData(d, b.id, newRows, newCites, '2026-08-01T00:00:00.000Z');
    expect(out).not.toBe(d);
    const t = out.tiles[1];
    expect(out.tiles.map((x) => x.title)).toEqual(['A', 'B']); // position + titles kept
    expect(t.id).toBe(b.id);
    expect(t.title).toBe('B');
    expect(t.pinnedAt).toBe(b.pinnedAt); // pinnedAt preserved
    expect(t.spec).toEqual(b.spec); // chart spec preserved as-is
    expect(t.rows).toEqual(newRows); // rows replaced
    expect(t.citations[0].sourceUpdated).toBe('2025-06-30'); // vintage replaced
    expect(t.refreshedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(t.sourceNote).toContain('2025-06-30'); // sourceNote re-derived to new vintage
    expect(out.updated > before).toBe(true);
    // Input untouched.
    expect(d.tiles[1].rows).toEqual(b.rows);
    expect(d.tiles[1].refreshedAt).toBeUndefined();
  });

  it('clears a prior stale marker on success', () => {
    let d = addTile(createDashboard('board'), sampleTile());
    const id = d.tiles[0].id;
    d = markTileStale(d, id, 'network error');
    expect(d.tiles[0].stale).toBeTruthy();
    const out = touchTileData(d, id, newRows, newCites, '2026-08-01T00:00:00.000Z');
    expect(out.tiles[0].stale).toBeUndefined();
  });

  it('whitelist-cleans incoming rows/citations (a planted field never lands on the tile)', () => {
    let d = addTile(createDashboard('board'), sampleTile());
    const id = d.tiles[0].id;
    const dirtyRows = [{ country: 'X', iso3: 'X', year: 1, value: 2, apiKey: 'sk-refresh' } as any];
    const dirtyCites = [{ ...citations[0], apiKey: 'sk-cite' } as any];
    const out = touchTileData(d, id, dirtyRows, dirtyCites, '2026-08-01T00:00:00.000Z');
    expect('apiKey' in out.tiles[0].rows[0]).toBe(false);
    expect('apiKey' in out.tiles[0].citations[0]).toBe(false);
  });

  it('is a no-op (same ref) for an unknown tile id', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    expect(touchTileData(d, 'nope', newRows, newCites, '2026-08-01T00:00:00.000Z')).toBe(d);
  });
});

describe('markTileStale (refresh failure)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('adds a stale marker WITHOUT touching rows/citations/spec, bumps updated', () => {
    let d = addTile(createDashboard('board'), sampleTile());
    const id = d.tiles[0].id;
    const before = d.tiles[0];
    const out = markTileStale(d, id, 'network error', '2026-08-01T00:00:00.000Z');
    expect(out).not.toBe(d);
    expect(out.tiles[0].stale).toEqual({ failedAt: '2026-08-01T00:00:00.000Z', reason: 'network error' });
    expect(out.tiles[0].rows).toEqual(before.rows); // rows untouched
    expect(out.tiles[0].citations).toEqual(before.citations); // citations untouched
    expect(out.tiles[0].spec).toEqual(before.spec); // spec untouched
    expect(d.tiles[0].stale).toBeUndefined(); // input untouched
  });

  it('defaults failedAt to now and reason to a sane fallback', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    const out = markTileStale(d, d.tiles[0].id, '   ');
    expect(out.tiles[0].stale?.reason).toBe('refresh failed');
    expect(out.tiles[0].stale?.failedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('is a no-op (same ref) for an unknown tile id', () => {
    const d = addTile(createDashboard('b'), sampleTile());
    expect(markTileStale(d, 'nope', 'x')).toBe(d);
  });
});

describe('serialize/parse of refresh fields', () => {
  it('roundtrips refreshedAt + stale through the whitelist exactly', () => {
    let d = createDashboard('Refreshed');
    d = addTile(d, sampleTile());
    d = touchTileData(
      d,
      d.tiles[0].id,
      [{ country: 'X', iso3: 'X', year: 2, value: 3, indicator: 'I' }],
      citations,
      '2026-08-01T00:00:00.000Z'
    );
    d = markTileStale(d, d.tiles[0].id, 'network error', '2026-08-02T00:00:00.000Z');
    const back = parseDashboard(serializeDashboard(d));
    expect(back).not.toBeNull();
    expect(back!.tiles[0].refreshedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(back!.tiles[0].stale).toEqual({ failedAt: '2026-08-02T00:00:00.000Z', reason: 'network error' });
    expect(back).toEqual(d);
  });

  it('drops a stale marker that carries neither failedAt nor reason', () => {
    let d = addTile(createDashboard('b'), sampleTile());
    const raw = JSON.parse(serializeDashboard(d));
    raw.tiles[0].stale = {}; // empty marker planted
    const back = parseDashboard(JSON.stringify(raw));
    expect(back!.tiles[0].stale).toBeUndefined();
  });
});

describe('makeTile + deriveSourceNote', () => {
  it('stamps id + pinnedAt and derives a source note with the latest vintage', () => {
    const t = sampleTile();
    expect(t.id).toMatch(/^tile_/);
    expect(t.pinnedAt).toBeTruthy();
    expect(t.sourceNote).toBe('World Bank Open Data · source updated 2024-12-16');
  });
  it('deriveSourceNote joins distinct sources and omits vintage when none present', () => {
    const cites: Citation[] = [
      { ...citations[0], sourceUpdated: undefined },
      { ...citations[0], source: 'owid', sourceLabel: 'Our World in Data', sourceUpdated: undefined },
    ];
    expect(deriveSourceNote(cites)).toBe('World Bank Open Data · Our World in Data');
    expect(deriveSourceNote([])).toBe('');
  });
});

// ── Serialize / parse ────────────────────────────────────────────────────────
describe('serialize/parse', () => {
  it('roundtrips a dashboard exactly', () => {
    let d = createDashboard('Round trip');
    d = addTile(d, sampleTile());
    const back = parseDashboard(serializeDashboard(d));
    expect(back).not.toBeNull();
    expect(back).toEqual(d);
  });

  it('rejects malformed input (bad JSON, non-object, array) → null', () => {
    expect(parseDashboard('not json {')).toBeNull();
    expect(parseDashboard('123')).toBeNull();
    expect(parseDashboard('"a string"')).toBeNull();
    expect(parseDashboard('[]')).toBeNull();
    expect(parseDashboard('')).toBeNull();
  });

  it('gates on version: unknown or missing v → null', () => {
    const d = createDashboard('v');
    const bumped = JSON.stringify({ ...cleanDashboard(d), v: 2 });
    expect(parseDashboard(bumped)).toBeNull();
    const noV = JSON.stringify({ ...cleanDashboard(d), v: undefined });
    expect(parseDashboard(noV)).toBeNull();
  });

  it('a planted apiKey (or any unlisted field) NEVER survives serialize/parse', () => {
    // Plant secrets at every level: dashboard, tile, spec, row, citation.
    const dirty: any = {
      v: 1,
      id: 'dash_x',
      title: 'Dirty',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      apiKey: 'sk-SECRET-TOP',
      __proto__: { polluted: true },
      tiles: [
        {
          id: 'tile_x',
          title: 'T',
          apiKey: 'sk-tile-secret',
          pinnedAt: '2026-01-01T00:00:00.000Z',
          spec: { type: 'line', title: 's', apiKey: 'sk-spec', series: [{ name: 'x', data: [[1, 2]], apiKey: 'sk-series' }] },
          rows: [{ country: 'X', iso3: 'X', year: 1, value: 2, apiKey: 'sk-row' }],
          citations: [
            {
              id: 'c', source: 'worldbank', sourceLabel: 'WB', indicatorId: 'I', indicatorName: 'N',
              url: 'u', countries: ['X'], yearRange: null, fetchedAt: 'f', rowCount: 1, cached: false,
              apiKey: 'sk-cite-secret', token: 'nope',
            },
          ],
        },
      ],
    };
    const serialized = serializeDashboard(dirty as Dashboard);
    expect(serialized).not.toContain('sk-SECRET-TOP');
    expect(serialized).not.toContain('sk-tile-secret');
    expect(serialized).not.toContain('sk-spec');
    expect(serialized).not.toContain('sk-series');
    expect(serialized).not.toContain('sk-row');
    expect(serialized).not.toContain('sk-cite-secret');
    expect(serialized).not.toContain('polluted');

    const parsed = parseDashboard(serialized)!;
    expect(parsed).not.toBeNull();
    expect('apiKey' in parsed).toBe(false);
    expect('apiKey' in parsed.tiles[0]).toBe(false);
    expect('apiKey' in parsed.tiles[0].spec).toBe(false);
    expect('apiKey' in (parsed.tiles[0].spec.series[0] as any)).toBe(false);
    expect('apiKey' in parsed.tiles[0].rows[0]).toBe(false);
    expect('apiKey' in parsed.tiles[0].citations[0]).toBe(false);
    expect((parsed as any).polluted).toBeUndefined();
    // The legitimate data still made it through.
    expect(parsed.tiles[0].rows[0]).toEqual({ country: 'X', iso3: 'X', year: 1, value: 2 });
  });
});

// ── Size cap ─────────────────────────────────────────────────────────────────
describe('size cap', () => {
  it('dashboardBytes grows with content', () => {
    const small = createDashboard('s');
    const big = addTile(small, sampleTile());
    expect(dashboardBytes(big)).toBeGreaterThan(dashboardBytes(small));
  });

  it('addTile refuses (DashboardCapError) when the result exceeds the soft cap', () => {
    // A tile with enough rows to blow past the 200KB cap on its own.
    const manyRows: DataRow[] = [];
    for (let i = 0; i < 6000; i++) {
      manyRows.push({ country: 'Countryland', iso3: 'CLD', year: 1900 + i, value: i * 1.5, indicator: 'SP.DYN.IMRT.IN' });
    }
    const heavy = makeTile({ title: 'Heavy', spec, rows: manyRows, citations });
    expect(dashboardBytes(addTileUnchecked(createDashboard('b'), heavy))).toBeGreaterThan(DASHBOARD_SOFT_CAP_BYTES);
    expect(() => addTile(createDashboard('b'), heavy)).toThrow(DashboardCapError);
    try {
      addTile(createDashboard('b'), heavy);
    } catch (e: any) {
      expect(e.message).toMatch(/full/i);
      expect(e.message).toMatch(/limit/i);
    }
  });
});

// Helper mirroring addTile without the cap check, to prove the fixture is over cap.
function addTileUnchecked(dash: Dashboard, tile: Tile): Dashboard {
  return { ...dash, tiles: [...dash.tiles, tile] };
}

// ── Storage wrapper ──────────────────────────────────────────────────────────
describe('storage wrapper (fake storage)', () => {
  let store: FakeStorage;
  beforeEach(() => { store = new FakeStorage(); });

  it('saves, loads, lists and deletes', () => {
    const a = addTile(createDashboard('Alpha'), sampleTile());
    const b = createDashboard('Beta');
    expect(saveDashboard(store, a)).toEqual({ ok: true });
    expect(saveDashboard(store, b)).toEqual({ ok: true });

    expect(store.getItem(DASHBOARD_NS + a.id)).toBeTruthy();
    expect(loadDashboard(store, a.id)).toEqual(a);
    expect(loadDashboard(store, 'missing')).toBeNull();

    const list = listDashboards(store);
    expect(list.map((d) => d.title).sort()).toEqual(['Alpha', 'Beta']);

    const summaries = listDashboardSummaries(store);
    expect(summaries.find((s) => s.id === a.id)).toEqual({ id: a.id, title: 'Alpha', updated: a.updated, tileCount: 1 });

    deleteDashboard(store, a.id);
    expect(loadDashboard(store, a.id)).toBeNull();
    expect(listDashboards(store)).toHaveLength(1);
  });

  it('lists newest-updated first and skips malformed/foreign entries', () => {
    const older = { ...createDashboard('Older'), updated: '2026-01-01T00:00:00.000Z' };
    const newer = { ...createDashboard('Newer'), updated: '2026-07-01T00:00:00.000Z' };
    saveDashboard(store, older);
    saveDashboard(store, newer);
    store.rawSet(DASHBOARD_NS + 'broken', '{not valid json');
    store.rawSet('unrelated:key', 'ignore me');
    const list = listDashboards(store);
    expect(list.map((d) => d.title)).toEqual(['Newer', 'Older']); // sorted, broken skipped
  });

  it('a quota error on save returns { ok:false } with a clear message, never throws', () => {
    store.setFailOnSet(true);
    const res = saveDashboard(store, createDashboard('X'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/storage/i);
  });

  it('findDashboardByTitle matches case-insensitively', () => {
    const a = createDashboard('Health metrics');
    saveDashboard(store, a);
    expect(findDashboardByTitle(store, 'health METRICS')?.id).toBe(a.id);
    expect(findDashboardByTitle(store, 'nope')).toBeNull();
    expect(findDashboardByTitle(store, '  ')).toBeNull();
  });
});
