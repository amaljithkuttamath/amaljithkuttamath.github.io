import { describe, it, expect, vi, beforeEach } from 'vitest';

// The generated tier is loaded from kb.json at module-evaluation time, so each
// case mocks the file and re-imports. `SH.DYN.MORT` and `SP.DYN.LE00.IN` are
// deliberately included in the fake payload: they are already placed by the
// authored core, and the point of these tests is that the core wins.
const fakeEntries = [
  { seriesId: 'SH.DYN.MORT', name: 'GENERATED SHOULD NOT WIN', topic: 'Health', note: 'generated note' },
  { seriesId: 'SP.DYN.LE00.IN', name: 'GENERATED SHOULD NOT WIN EITHER', topic: 'Health' },
  { seriesId: 'AG.PRD.CROP.XD', name: 'Crop production index (2014-2016 = 100)', topic: 'Agriculture & Rural Development',
    note: 'Crop production index shows agricultural production for each year relative to the base period.' },
  { seriesId: 'IS.AIR.PSGR', name: 'Air transport, passengers carried', topic: 'Infrastructure',
    note: 'Air passengers carried include both domestic and international aircraft passengers of air carriers registered in the country.' },
];

async function loadKb(entries: unknown) {
  vi.resetModules();
  vi.doMock('../../data/chitti/kb.json', () => ({
    default: { generated: '2026-07-27T00:00:00Z', entries },
  }));
  return await import('./kb');
}

beforeEach(() => { vi.resetModules(); vi.doUnmock('../../data/chitti/kb.json'); });

describe('the generated tier', () => {
  it('adds indicators the authored core never placed', async () => {
    const kb = await loadKb(fakeEntries);
    const hit = kb.searchKb('crop production', ['worldbank'])[0];
    expect(hit?.seriesId).toBe('AG.PRD.CROP.XD');
    // Filed under the source's own topic, in a group that keeps the split
    // between tuned and generated visible on the route.
    expect(hit.path.join(' > ')).toMatch(/Agriculture & Rural Development/);
    expect(hit.path.join(' > ')).toMatch(/More .* indicators/);
  });

  it('makes a series findable by the publisher\'s own definition', async () => {
    // "aircraft passengers" appears only in the World Bank's sourceNote, never
    // in the indicator name — this is the whole reason notes are carried.
    const kb = await loadKb(fakeEntries);
    const hit = kb.searchKb('aircraft passengers carried', ['worldbank'])[0];
    expect(hit?.seriesId).toBe('IS.AIR.PSGR');
  });

  it('never lets a generated entry displace one the core has placed', async () => {
    const kb = await loadKb(fakeEntries);
    const leaves: string[] = [];
    const walk = (n: any) => n.seriesId ? leaves.push(n.title) : n.children.forEach(walk);
    walk(kb.buildKb(['worldbank']));
    // The fake payload tried to re-file two core series under new names.
    expect(leaves.filter((t) => t.includes('SHOULD NOT WIN'))).toHaveLength(0);
    expect(kb.searchKb('child mortality', ['worldbank'])[0].seriesId).toBe('SH.DYN.MORT');
  });

  it('keeps the eval intact when the long tail is present', async () => {
    // The guard that makes regeneration safe: adding a thousand indicators must
    // not move an answer the eval pins down. CI re-runs this before opening the
    // refresh PR, so a catalogue change that would break retrieval blocks there
    // instead of landing.
    const kb = await loadKb(fakeEntries);
    const cases: [string, string][] = [
      ['child mortality', 'SH.DYN.MORT'],
      ['how long people live', 'SP.DYN.LE00.IN'],
      ['internet users', 'IT.NET.USER.ZS'],
      ['deforestation', 'AG.LND.FRST.ZS'],
    ];
    for (const [q, want] of cases) {
      const h = kb.searchKb(q, ['worldbank'])[0];
      expect(h?.seriesId, `"${q}" resolved to ${h?.seriesId}`).toBe(want);
      expect(h.score).toBeGreaterThanOrEqual(kb.KB_MIN_SCORE);
    }
  });

  it('drops malformed entries instead of trusting the file', async () => {
    const kb = await loadKb([
      null,
      'nonsense',
      { seriesId: 'X.Y.Z' },                       // no name
      { name: 'No id', topic: 'Health' },          // no id
      { seriesId: 'A.B.C', name: 'No topic' },     // nowhere to hang it
      fakeEntries[2],                              // the one good row
    ]);
    const leaves: string[] = [];
    const walk = (n: any) => n.seriesId ? leaves.push(n.seriesId) : n.children.forEach(walk);
    walk(kb.buildKb(['worldbank']));
    expect(leaves).toContain('AG.PRD.CROP.XD');
    expect(leaves).not.toContain('A.B.C');
    expect(leaves).not.toContain('X.Y.Z');
  });

  it('is inert when the file is the empty placeholder', async () => {
    const kb = await loadKb([]);
    expect(kb.searchKb('child mortality', ['worldbank'])[0].seriesId).toBe('SH.DYN.MORT');
    expect(kb.searchKb('crop production', ['worldbank'])[0]?.seriesId).not.toBe('AG.PRD.CROP.XD');
  });
});
