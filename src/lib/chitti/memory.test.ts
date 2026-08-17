// memory.test.ts — the memory layer, provenance and gates first.
//
// The ordering is deliberate and follows the rule the context-variables design
// sets for anything that carries data forward: "the tests for this feature
// should be provenance tests first and ergonomics tests second." A memory layer
// is the easiest place in this app to launder an unproven number into a cited
// answer, so what is pinned here is mostly what memory REFUSES to do.
import { describe, it, expect } from 'vitest';
import type { Citation, DataRow } from './tools';
import type { StorageLike } from './dashboard';
import {
  MEMORY_ENABLED_KEY,
  MEMORY_MAX_FACTS,
  MEMORY_MAX_NOTES,
  MEMORY_NS,
  MEMORY_STALE_DAYS,
  MEMORY_VERSION,
  buildNote,
  buildRecallBlock,
  clearMemory,
  compareFacts,
  factsFromRows,
  listNotes,
  memoryEnabled,
  parseNote,
  questionYears,
  recall,
  recallBlockFor,
  rememberTurn,
  saveNote,
  serializeNote,
  setMemoryEnabled,
  type MemoryNote,
} from './memory';

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A Map-backed StorageLike, the same fake shape dashboard.test.ts uses.
function fakeStore(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

function cite(over: Partial<Citation> = {}): Citation {
  return {
    id: 'sp.dyn.le00.in|IND|2000:2023',
    source: 'worldbank',
    sourceLabel: 'World Bank Open Data',
    indicatorId: 'SP.DYN.LE00.IN',
    indicatorName: 'Life expectancy at birth, total (years)',
    url: 'https://data.worldbank.org/indicator/SP.DYN.LE00.IN',
    countries: ['IND'],
    yearRange: { start: 2000, end: 2023 },
    fetchedAt: '2026-07-02T10:00:00.000Z',
    sourceUpdated: '2024-12-16',
    rowCount: 24,
    cached: false,
    ...over,
  };
}

function row(over: Partial<DataRow> = {}): DataRow {
  return { country: 'India', iso3: 'IND', year: 2000, value: 62.5, indicator: 'SP.DYN.LE00.IN', ...over };
}

function note(over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    v: MEMORY_VERSION,
    id: 'mem_1',
    question: 'life expectancy in India since 2000',
    finding: 'Life expectancy in India rose from 62.5 to 70.4.',
    facts: [
      { nid: 'sp.dyn.le00.in', iso3: 'IND', year: 2000, value: 62.5, source: 'worldbank' },
      { nid: 'sp.dyn.le00.in', iso3: 'IND', year: 2023, value: 70.4, source: 'worldbank' },
    ],
    factsTruncated: false,
    citations: [cite()],
    verified: true,
    createdAt: '2026-07-02T10:00:00.000Z',
    asOf: '2024-12-16',
    ...over,
  };
}

const NOW = new Date('2026-07-09T00:00:00.000Z'); // 7 days after the fixture note

// ── 1. What is allowed to become a memory at all ─────────────────────────────
// The single rule the whole provenance story rests on: a note is written only
// when the turn produced citations. Everything else follows from it.

describe('what memory is allowed to hold', () => {
  it('records a turn that produced citations', () => {
    const n = buildNote({
      id: 'mem_x',
      question: 'life expectancy in India',
      finding: 'It rose.',
      rows: [row(), row({ year: 2023, value: 70.4 })],
      citations: [cite()],
      verification: { status: 'verified', confidence: 'high', issues: [] } as any,
      createdAt: NOW.toISOString(),
    });
    expect(n).not.toBeNull();
    expect(n!.facts).toHaveLength(2);
    expect(n!.verified).toBe(true);
  });

  it('records NOTHING for an explanation turn — no citations, no note', () => {
    const n = buildNote({
      id: 'mem_x',
      question: 'what does life expectancy at birth mean?',
      finding: 'It is the average number of years a newborn would live…',
      rows: [],
      citations: [],
      verification: null,
      createdAt: NOW.toISOString(),
    });
    expect(n).toBeNull();
  });

  it('drops a row whose series no citation vouches for — no receipt, no memory', () => {
    // The model wrote a value into rows for a series that was never fetched.
    // It has no ledger entry, so it cannot become a remembered fact.
    const { facts } = factsFromRows(
      [row(), row({ indicator: 'MADE.UP.SERIES', value: 999, year: 2023 })],
      [cite()]
    );
    expect(facts.map((f) => f.nid)).toEqual(['sp.dyn.le00.in']);
    expect(facts.some((f) => f.value === 999)).toBe(false);
  });

  it('never turns a null value into a fact', () => {
    // A null is a reporting gap, not a measurement. Remembering it as 0 would
    // be the same lie as charting it as 0.
    const { facts } = factsFromRows(
      [row({ year: 2001, value: null }), row({ year: 2002, value: 63.1 })],
      [cite()]
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ year: 2002, value: 63.1 });
  });

  it('keeps the first and last reported year per series x country', () => {
    const rows = [
      row({ year: 2000, value: 62.5 }),
      row({ year: 2010, value: 66.9 }),
      row({ year: 2023, value: 70.4 }),
      row({ iso3: 'CHN', country: 'China', year: 2000, value: 71.6 }),
      row({ iso3: 'CHN', country: 'China', year: 2023, value: 78.6 }),
    ];
    const { facts, truncated } = factsFromRows(rows, [cite({ countries: ['IND', 'CHN'] })]);
    expect(truncated).toBe(false);
    expect(facts).toEqual([
      { nid: 'sp.dyn.le00.in', iso3: 'IND', year: 2000, value: 62.5, source: 'worldbank' },
      { nid: 'sp.dyn.le00.in', iso3: 'IND', year: 2023, value: 70.4, source: 'worldbank' },
      { nid: 'sp.dyn.le00.in', iso3: 'CHN', year: 2000, value: 71.6, source: 'worldbank' },
      { nid: 'sp.dyn.le00.in', iso3: 'CHN', year: 2023, value: 78.6, source: 'worldbank' },
    ]);
  });

  it('caps facts and SAYS SO rather than reading as a complete record', () => {
    const rows: DataRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(row({ iso3: `C${i}`, country: `Country ${i}`, year: 2000, value: 60 + i }));
      rows.push(row({ iso3: `C${i}`, country: `Country ${i}`, year: 2023, value: 70 + i }));
    }
    const { facts, truncated } = factsFromRows(rows, [cite({ countries: [] })]);
    expect(facts.length).toBeLessThanOrEqual(MEMORY_MAX_FACTS);
    expect(truncated).toBe(true);
    // Endpoints are never split: a lone endpoint would read as the whole series.
    expect(facts.length % 2).toBe(0);
  });
});

// ── 2. The storage boundary ──────────────────────────────────────────────────
// Same discipline as dashboard.ts / share.ts: a whitelist REBUILD, so an
// unlisted field is structurally incapable of surviving. Never a blacklist.

describe('the storage boundary refuses what it was not told to keep', () => {
  it('cannot carry an apiKey planted at note, fact or citation level', () => {
    const poisoned = {
      ...note(),
      apiKey: 'sk-leak',
      facts: [{ ...note().facts[0], apiKey: 'sk-leak' }],
      citations: [{ ...cite(), apiKey: 'sk-leak' } as any],
    };
    const round = parseNote(serializeNote(poisoned as any))!;
    const json = JSON.stringify(round);
    expect(json).not.toContain('sk-leak');
    expect(json).not.toContain('apiKey');
  });

  it('drops a __proto__ key rather than letting it through', () => {
    const round = parseNote('{"v":1,"id":"mem_1","__proto__":{"polluted":true},"question":"q"}');
    expect(round).not.toBeNull();
    expect(({} as any).polluted).toBeUndefined();
  });

  it('refuses an unknown version — a note we will not guess at', () => {
    expect(parseNote(JSON.stringify({ ...note(), v: 2 }))).toBeNull();
    expect(parseNote(JSON.stringify({ ...note(), v: undefined }))).toBeNull();
  });

  it('returns null on malformed input instead of throwing', () => {
    expect(parseNote('not json')).toBeNull();
    expect(parseNote('[]')).toBeNull();
    expect(parseNote('null')).toBeNull();
  });

  it('keeps mirroredAt — a snapshot must never round-trip into a live fetch', () => {
    const round = parseNote(
      serializeNote(note({ citations: [cite({ mirroredAt: '2026-06-01T00:00:00.000Z' })] }))
    )!;
    expect(round.citations[0].mirroredAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('skips one unreadable entry rather than losing the whole list', () => {
    const store = fakeStore();
    store.setItem(MEMORY_NS + 'good', serializeNote(note()));
    store.setItem(MEMORY_NS + 'bad', '{{{ not json');
    store.setItem('unrelated:key', 'ignored');
    expect(listNotes(store).map((n) => n.id)).toEqual(['mem_1']);
  });

  it('yields [] from a store that throws, never a crash', () => {
    const hostile: StorageLike = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {},
      get length(): number {
        throw new Error('blocked');
      },
      key() {
        return null;
      },
    };
    expect(listNotes(hostile)).toEqual([]);
    expect(memoryEnabled(hostile)).toBe(false); // unreadable store = never written
  });

  it('reports a quota failure as a result, never a throw', () => {
    const store = fakeStore();
    store.setItem = () => {
      const e: any = new Error('full');
      e.name = 'QuotaExceededError';
      throw e;
    };
    const res = saveNote(store, note());
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/storage/i);
  });

  it('evicts the oldest note past the cap', () => {
    const store = fakeStore();
    for (let i = 0; i < MEMORY_MAX_NOTES; i++) {
      const day = String(i + 1).padStart(3, '0');
      saveNote(store, note({ id: `mem_${i}`, createdAt: `2020-01-01T00:00:${day}.000Z` }));
    }
    expect(listNotes(store)).toHaveLength(MEMORY_MAX_NOTES);
    saveNote(store, note({ id: 'mem_new', createdAt: '2026-08-17T00:00:00.000Z' }));
    const ids = listNotes(store).map((n) => n.id);
    expect(ids).toHaveLength(MEMORY_MAX_NOTES);
    expect(ids).toContain('mem_new');
    expect(ids).not.toContain('mem_0'); // the oldest went
  });

  it('clears everything on request, and leaves foreign keys alone', () => {
    const store = fakeStore();
    saveNote(store, note({ id: 'a' }));
    saveNote(store, note({ id: 'b' }));
    store.setItem('chitti:dash:keepme', '{}');
    expect(clearMemory(store)).toBe(2);
    expect(listNotes(store)).toEqual([]);
    expect(store.getItem('chitti:dash:keepme')).toBe('{}');
  });

  it('keeps the enable flag out of the note namespace', () => {
    const store = fakeStore();
    setMemoryEnabled(store, false);
    expect(memoryEnabled(store)).toBe(false);
    // The flag must not be scanned as a (broken) note.
    expect(listNotes(store)).toEqual([]);
    expect(MEMORY_ENABLED_KEY.startsWith(MEMORY_NS)).toBe(false);
  });
});

// ── 3. The contradiction gate ────────────────────────────────────────────────
// The load-bearing behaviour: two sources of equal authority disagree, and
// Chitti returns both and picks neither.

describe('contradiction gate: equal authority means no answer', () => {
  const wbNote = note({
    id: 'mem_wb',
    createdAt: '2026-05-11T00:00:00.000Z',
    facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 67.2, source: 'worldbank' }],
    citations: [cite({ indicatorId: 'life.exp' })],
  });
  const whoNote = note({
    id: 'mem_who',
    createdAt: '2026-06-02T00:00:00.000Z',
    facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 70.1, source: 'who' }],
    citations: [cite({ indicatorId: 'life.exp', source: 'who', sourceLabel: 'WHO Global Health Observatory' })],
  });

  it('flags a cross-source disagreement and carries BOTH sides', () => {
    const { conflicts, revisions } = compareFacts([wbNote, whoNote]);
    expect(revisions).toEqual([]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ nid: 'life.exp', iso3: 'IND', year: 2021 });
    expect(conflicts[0].sides.map((s) => s.value).sort()).toEqual([67.2, 70.1]);
    expect(conflicts[0].sides.map((s) => s.source).sort()).toEqual(['who', 'worldbank']);
  });

  it('names both sources in the block and never picks a winner', () => {
    const r = recall([wbNote, whoNote], 'life expectancy in India', NOW);
    expect(r.code).toBe('MEM_CONFLICT');
    const block = buildRecallBlock(r)!;
    expect(block).toContain('UNRESOLVED CONFLICT (MEM_CONFLICT)');
    expect(block).toContain('World Bank Open Data recorded 67.2');
    expect(block).toContain('WHO Global Health Observatory recorded 70.1');
    expect(block).toContain('Do NOT pick one');
    // The newer reading must not be presented as the resolution.
    expect(block).not.toMatch(/in force|supersedes the older|the answer is/i);
  });

  it('treats a SAME-source change as a revision, not a contradiction', () => {
    // The World Bank restated 2021. That is an upstream revision: newer is in
    // force, and blocking on it would fire on every routine restatement.
    const older = note({
      id: 'mem_old',
      createdAt: '2026-01-01T00:00:00.000Z',
      facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 67.2, source: 'worldbank' }],
      citations: [cite({ indicatorId: 'life.exp' })],
    });
    const newer = note({
      id: 'mem_new',
      createdAt: '2026-06-01T00:00:00.000Z',
      facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 67.9, source: 'worldbank' }],
      citations: [cite({ indicatorId: 'life.exp' })],
    });
    const { conflicts, revisions } = compareFacts([older, newer]);
    expect(conflicts).toEqual([]);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].older.value).toBe(67.2);
    expect(revisions[0].newer.value).toBe(67.9);
    expect(buildRecallBlock(recall([older, newer], 'life expectancy in India', NOW))).toContain(
      'REVISED SINCE YOU RECORDED IT'
    );
  });

  it('does not fire on float noise', () => {
    const a = note({
      id: 'a',
      facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 67.2, source: 'worldbank' }],
      citations: [cite({ indicatorId: 'life.exp' })],
    });
    const b = note({
      id: 'b',
      createdAt: '2026-06-01T00:00:00.000Z',
      facts: [{ nid: 'life.exp', iso3: 'IND', year: 2021, value: 67.2000001, source: 'who' }],
      citations: [cite({ indicatorId: 'life.exp', source: 'who' })],
    });
    expect(compareFacts([a, b]).conflicts).toEqual([]);
  });
});

// ── 4. The temporal gate ─────────────────────────────────────────────────────

describe('temporal gate: age is disclosed, never hidden', () => {
  it('stamps a note past the stale window and tells the agent to re-fetch', () => {
    const old = note({ createdAt: '2026-01-01T00:00:00.000Z' }); // ~189 days before NOW
    const r = recall([old], 'life expectancy in India since 2000', NOW);
    expect(r.code).toBe('MEM_STALE');
    expect(r.notes[0].code).toBe('MEM_STALE');
    expect(r.notes[0].ageDays).toBeGreaterThan(MEMORY_STALE_DAYS);
    expect(buildRecallBlock(r)!).toMatch(/STALE, \d+ days old — re-fetch before using/);
  });

  it('treats an undatable note as stale rather than fresh', () => {
    const r = recall([note({ createdAt: 'not a date' })], 'life expectancy in India', NOW);
    expect(r.notes[0].code).toBe('MEM_STALE');
  });

  it('leaves a recent note unstamped', () => {
    const r = recall([note()], 'life expectancy in India since 2000', NOW);
    expect(r.code).toBe('MEM_HIT');
    expect(buildRecallBlock(r)!).not.toContain('STALE');
  });
});

// ── 5. The coverage gate ─────────────────────────────────────────────────────

describe('coverage gate: a note answers only what it measured', () => {
  it('pulls years out of a question', () => {
    expect(questionYears('life expectancy in India in 2025')).toEqual([2025]);
    expect(questionYears('compare 1990 and 2020')).toEqual([1990, 2020]);
    expect(questionYears('life expectancy in India')).toEqual([]);
    expect(questionYears('the top 10 countries')).toEqual([]); // not a year
  });

  it('drops a note whose data ends before the year asked about', () => {
    // Recorded 2000-2023. "in 2025" is not a weaker answer, it is no answer.
    const r = recall([note()], 'life expectancy in India in 2025', NOW);
    expect(r.notes).toEqual([]);
    expect(r.code).toBe('MEM_OUT_OF_SCOPE');
    expect(r.dropped[0].reason).toContain('2000–2023');
    // Crucially, the numbers it holds are not offered to the model at all. A
    // dropped note reaches the UI (so the user knows Chitti has something
    // adjacent) but never the prompt — the agent was going to fetch anyway, so
    // telling it about a note it cannot use is pure context cost.
    expect(buildRecallBlock(r)).toBeNull();
  });

  it('keeps a note when the question names a year it actually covers', () => {
    const r = recall([note()], 'life expectancy in India in 2010', NOW);
    expect(r.notes).toHaveLength(1);
    expect(r.code).toBe('MEM_HIT');
  });

  it('prints the exact scope so the agent can judge the rest itself', () => {
    const block = buildRecallBlock(recall([note()], 'life expectancy in India', NOW))!;
    expect(block).toContain('Scope: SP.DYN.LE00.IN · IND · 2000–2023 (World Bank Open Data, source updated 2024-12-16)');
  });
});

// ── 6. Recall under-fires, and costs nothing when it misses ──────────────────

describe('recall under-fires on purpose', () => {
  it('says nothing at all about an unrelated question', () => {
    const r = recall([note()], 'co2 emissions in Brazil', NOW);
    expect(r.code).toBe('MEM_MISS');
    expect(buildRecallBlock(r)).toBeNull(); // zero prompt tokens
  });

  it('says nothing when memory is empty', () => {
    expect(buildRecallBlock(recall([], 'anything', NOW))).toBeNull();
    expect(recallBlockFor(fakeStore(), 'anything', NOW)).toBeNull();
  });

  it('reaches a note through the shared synonym vocabulary', () => {
    // "longevity" is not in the note's question; scoring.ts expands it to
    // "life expectancy", which is. Reusing that table rather than authoring a
    // second one is the point.
    const r = recall([note()], 'longevity in India', NOW);
    expect(r.notes).toHaveLength(1);
  });

  it('caps how many notes reach the prompt, best-scoring first', () => {
    const notes = Array.from({ length: 8 }, (_, i) =>
      note({ id: `mem_${i}`, createdAt: `2026-07-0${(i % 8) + 1}T00:00:00.000Z` })
    );
    expect(recall(notes, 'life expectancy in India since 2000', NOW).notes.length).toBeLessThanOrEqual(3);
  });

  it('is deterministic given the same notes, question and clock', () => {
    const a = buildRecallBlock(recall([note()], 'life expectancy in India', NOW));
    const b = buildRecallBlock(recall([note()], 'life expectancy in India', NOW));
    expect(a).toBe(b);
  });
});

// ── 7. What the block tells the model ────────────────────────────────────────

describe('the recall block leads with the rule', () => {
  it('says memory is not evidence, before it says anything else', () => {
    const block = buildRecallBlock(recall([note()], 'life expectancy in India', NOW))!;
    expect(block.split('\n')[0]).toContain('NOT evidence');
    expect(block).toContain('you may not chart it,');
    expect(block).toContain('cite it, or enter it in the evidence table');
    expect(block).toContain('RE-FETCH and compare');
  });

  it('labels remembered numbers "Recorded", never as a current value', () => {
    const block = buildRecallBlock(recall([note()], 'life expectancy in India', NOW))!;
    expect(block).toContain('Recorded IND 2000: 62.5; IND 2023: 70.4');
  });

  it('reports a verification verdict honestly, and omits one that never ran', () => {
    expect(buildRecallBlock(recall([note({ verified: false })], 'life expectancy in India', NOW))!).toContain(
      'NOT verified'
    );
    const unrun = buildRecallBlock(recall([note({ verified: null })], 'life expectancy in India', NOW))!;
    expect(unrun).not.toContain('verified');
  });

  it('marks a partial record as partial', () => {
    const block = buildRecallBlock(
      recall([note({ factsTruncated: true })], 'life expectancy in India', NOW)
    )!;
    expect(block).toContain('(partial record)');
  });
});

// ── 8. The write path, end to end ────────────────────────────────────────────

describe('rememberTurn', () => {
  const turn = {
    question: 'life expectancy in India since 2000',
    finding: 'It rose from 62.5 to 70.4.',
    rows: [row(), row({ year: 2023, value: 70.4 })],
    citations: [cite()],
    verification: { status: 'verified', confidence: 'high', issues: [] } as any,
    createdAt: '2026-07-02T10:00:00.000Z',
  };

  it('records a grounded turn and reads it back', () => {
    const store = fakeStore();
    const res = rememberTurn(store, { ...turn, id: 'mem_1' });
    expect(res.ok).toBe(true);
    expect(listNotes(store)).toHaveLength(1);
    expect(recallBlockFor(store, 'life expectancy in India', NOW)).toContain('Recorded IND 2000: 62.5');
  });

  it('records nothing for a turn with no citations', () => {
    const store = fakeStore();
    const res = rememberTurn(store, { ...turn, rows: [], citations: [] });
    expect(res).toEqual({ ok: false, reason: 'nothing-to-record' });
    expect(listNotes(store)).toEqual([]);
  });

  it('records nothing when memory is switched off, and recalls nothing either', () => {
    const store = fakeStore();
    setMemoryEnabled(store, false);
    expect(rememberTurn(store, { ...turn, id: 'mem_1' })).toEqual({ ok: false, reason: 'disabled' });
    expect(listNotes(store)).toEqual([]);
    // And an existing memory goes quiet rather than being consulted silently.
    setMemoryEnabled(store, true);
    rememberTurn(store, { ...turn, id: 'mem_1' });
    setMemoryEnabled(store, false);
    expect(recallBlockFor(store, 'life expectancy in India', NOW)).toBeNull();
  });

  it('is a no-op without a store (a privacy mode that blocks localStorage)', () => {
    expect(rememberTurn(null, turn)).toEqual({ ok: false, reason: 'disabled' });
    expect(recallBlockFor(null, 'anything', NOW)).toBeNull();
  });

  it('is on by default — a memory you must find and switch on records nothing', () => {
    expect(memoryEnabled(fakeStore())).toBe(true);
  });
});
