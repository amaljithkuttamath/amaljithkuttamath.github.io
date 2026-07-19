import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOOL_SCHEMAS,
  EXECUTE_JS_RLM_PARAGRAPH,
  schemasForSources,
  resolveSources,
  datasetSourcesFor,
  findSeries,
  findSeriesWithReceipt,
  scoreSeries,
  explainMatch,
  parseImfIndicators,
  DEFAULT_SOURCE_IDS,
} from './tools';

describe('finish_explanation tool schema', () => {
  it('is registered with an explanation string parameter', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'finish_explanation');
    expect(schema).toBeDefined();
    expect(schema!.parameters.required).toContain('explanation');
    expect(schema!.parameters.properties.explanation).toBeDefined();
  });
});

describe('source hard filter', () => {
  const names = (ids?: string[]) => schemasForSources(ids).map((s) => s.name);

  it('World-Bank-only sessions cannot see OWID/IMF fetch tools', () => {
    const n = names(['worldbank']);
    expect(n).toContain('fetch_worldbank');
    expect(n).not.toContain('fetch_owid');
    expect(n).not.toContain('fetch_imf');
  });

  it('OWID-only sessions get only their fetch tool', () => {
    const n = names(['owid']);
    expect(n).toContain('fetch_owid');
    expect(n).not.toContain('fetch_imf');
    expect(n).not.toContain('fetch_worldbank');
    // The shared catalog is filtered to OWID datasets only.
    expect(datasetSourcesFor(['owid'])).toEqual(['owid']);
  });

  it('find_series is a core tool present for every selection', () => {
    for (const sel of [['worldbank'], ['owid'], ['imf'], undefined]) {
      expect(names(sel)).toContain('find_series');
    }
  });

  it('the per-source search tools are gone, replaced by find_series', () => {
    const all = names(undefined);
    expect(all).not.toContain('search_indicators');
    expect(all).not.toContain('search_datasets');
    expect(all).toContain('find_series');
  });

  it('always includes the source-agnostic core tools', () => {
    for (const core of ['execute_js', 'render_chart', 'finish', 'finish_explanation']) {
      expect(names(['worldbank'])).toContain(core);
    }
  });

  it('empty or unknown selection falls back to all sources', () => {
    expect(resolveSources([]).map((s) => s.id)).toEqual(DEFAULT_SOURCE_IDS);
    expect(resolveSources(['nope']).map((s) => s.id)).toEqual(DEFAULT_SOURCE_IDS);
    expect(schemasForSources(undefined).length).toBe(TOOL_SCHEMAS.length);
  });
});

describe('scoreSeries — relevance', () => {
  it('matches via synonyms — "carbon" finds a CO2/emissions series', () => {
    // Plain substring scoring returned 0 here (no literal "carbon"); the
    // synonym expansion is what makes this a hit.
    expect(scoreSeries('carbon', 'co-emissions-per-capita', 'CO2 emissions per capita (tonnes)')).toBeGreaterThan(0);
  });

  it('an exact-phrase name outranks incidental overlap', () => {
    const exact = scoreSeries('gdp per capita', 'NY.GDP.PCAP.CD', 'GDP per capita (current US$)');
    const incidental = scoreSeries('gdp per capita', 'SP.POP.TOTL', 'Population, total');
    expect(exact).toBeGreaterThan(incidental);
  });

  it('normalizes punctuation ("co2" vs "co-emissions")', () => {
    expect(scoreSeries('co2 emissions', 'annual-co2-emissions-per-country', 'Annual CO2 emissions (tonnes)')).toBeGreaterThan(0);
  });

  it('returns 0 for an empty query', () => {
    expect(scoreSeries('', 'X', 'Y')).toBe(0);
  });
});

describe('explainMatch — which terms/synonyms fired', () => {
  it('reports the score identically to scoreSeries (single source of truth)', () => {
    const cases: [string, string, string][] = [
      ['carbon', 'co-emissions-per-capita', 'CO2 emissions per capita (tonnes)'],
      ['gdp per capita', 'NY.GDP.PCAP.CD', 'GDP per capita (current US$)'],
      ['co2 emissions', 'annual-co2-emissions-per-country', 'Annual CO2 emissions (tonnes)'],
      ['', 'X', 'Y'],
    ];
    for (const [q, id, name] of cases) {
      expect(explainMatch(q, id, name).score).toBe(scoreSeries(q, id, name));
    }
  });

  it('records a base-term hit when the query word appears verbatim', () => {
    const ex = explainMatch('gdp', 'NY.GDP.PCAP.CD', 'GDP per capita (current US$)');
    expect(ex.matchedBase).toContain('gdp');
    // "gdp" is present literally, so no synonym had to fire for it.
    expect(ex.matchedSynonyms.find((s) => s.term === 'gdp')).toBeUndefined();
  });

  it('records the synonym expansion that fired — "carbon" → co2/emissions', () => {
    // The name has no literal "carbon"; the hit comes purely from synonyms.
    const ex = explainMatch('carbon', 'co-emissions-per-capita', 'CO2 emissions per capita (tonnes)');
    expect(ex.matchedBase).not.toContain('carbon');
    const vias = ex.matchedSynonyms.filter((s) => s.term === 'carbon').map((s) => s.synonym);
    expect(vias).toContain('co2');
    expect(vias).toContain('emissions');
  });

  it('reports nothing matched for an unrelated series', () => {
    const ex = explainMatch('gdp', 'SP.POP.TOTL', 'Population, total');
    expect(ex.score).toBe(0);
    expect(ex.matchedBase).toEqual([]);
    expect(ex.matchedSynonyms).toEqual([]);
  });

  it('attributes a shared synonym word to a single base term (stable, no double count)', () => {
    // "co2" and "carbon" both expand to "emissions"; it must be counted once.
    const ex = explainMatch('co2 carbon', 'x', 'Annual emissions series');
    const emissionsHits = ex.matchedSynonyms.filter((s) => s.synonym === 'emissions');
    expect(emissionsHits.length).toBe(1);
  });
});

describe('parseImfIndicators — live IMF catalog', () => {
  it('maps the DataMapper /indicators shape to namespaced series', () => {
    const parsed = parseImfIndicators({
      indicators: {
        NGDP_RPCH: { label: 'Real GDP growth (annual percent change)' },
        LUR: { label: 'Unemployment rate' },
      },
    });
    expect(parsed).toContainEqual({ id: 'imf:NGDP_RPCH', name: 'Real GDP growth (annual percent change)' });
    expect(parsed.find((p) => p.id === 'imf:LUR')?.name).toBe('Unemployment rate');
  });

  it('is defensive against a malformed payload', () => {
    expect(parseImfIndicators(null)).toEqual([]);
    expect(parseImfIndicators({})).toEqual([]);
    expect(parseImfIndicators({ indicators: 'nope' })).toEqual([]);
  });

  it('falls back to the code when a label is missing', () => {
    expect(parseImfIndicators({ indicators: { XYZ: {} } })).toEqual([{ id: 'imf:XYZ', name: 'XYZ' }]);
  });
});

describe('findSeries — cross-source search', () => {
  // The IMF live-catalog fallback calls fetch(); stub it to reject so these
  // stay offline and deterministic — which also exercises graceful degradation.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finds CO2 datasets from the synonym "carbon" (OWID active)', async () => {
    const hits = await findSeries('carbon emissions', ['owid']);
    expect(hits.some((h) => h.source === 'owid' && h.id.includes('co'))).toBe(true);
  });

  it('still returns curated IMF hits when the live catalog is unreachable', async () => {
    // fetch rejects → imfCatalog() throws → searchImfCatalog() returns []
    // → curated IMF hits must still come through (graceful degradation).
    const hits = await findSeries('inflation', ['imf']);
    expect(hits.some((h) => h.source === 'imf' && h.id.startsWith('imf:'))).toBe(true);
  });

  it('returns only OWID/IMF hits when World Bank is inactive (no network)', async () => {
    // OWID+IMF search is a pure catalog filter (no fetch), so this is offline.
    const hits = await findSeries('co2 emissions', ['owid']);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.source === 'owid')).toBe(true);
    expect(hits.every((h) => h.id.startsWith('owid:'))).toBe(true);
  });

  it('finds IMF forecast series and namespaces the id', async () => {
    const hits = await findSeries('inflation', ['imf']);
    expect(hits.some((h) => h.source === 'imf' && h.id.startsWith('imf:'))).toBe(true);
  });
});

describe('findSeriesWithReceipt — search-receipt payload', () => {
  // Stub fetch offline so the receipt is built purely from the curated catalog
  // (also proves the card degrades gracefully with no network).
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports databases searched, candidate/hit counts, and hits unchanged from findSeries', async () => {
    const { hits, receipt } = await findSeriesWithReceipt('carbon emissions', ['owid']);
    expect(receipt.query).toBe('carbon emissions');
    // One active database (OWID) → its friendly label, not the id.
    expect(receipt.sourcesSearched).toEqual(['Our World in Data']);
    expect(receipt.candidateCount).toBeGreaterThan(0);
    expect(receipt.hitCount).toBe(hits.length);
    // The receipt must not change the hits the model receives.
    expect(hits).toEqual(await findSeries('carbon emissions', ['owid']));
  });

  it('top match carries its source label and the synonym expansion that fired', async () => {
    const { receipt } = await findSeriesWithReceipt('carbon', ['owid']);
    expect(receipt.topMatch).toBeDefined();
    const tm = receipt.topMatch!;
    expect(tm.sourceLabel).toBe('Our World in Data');
    // "carbon" is not literal in the OWID CO2 names — it must surface as a
    // synonym expansion (carbon → co2 / emissions) in the receipt.
    const vias = tm.matchedSynonyms.filter((s) => s.term === 'carbon').map((s) => s.synonym);
    expect(vias.length).toBeGreaterThan(0);
    expect(['co2', 'emissions'].some((w) => vias.includes(w))).toBe(true);
  });

  it('counts every active database as searched, even multi-source selections', async () => {
    const { receipt } = await findSeriesWithReceipt('gdp', ['owid', 'imf']);
    expect(receipt.sourcesSearched.length).toBe(2);
    expect(receipt.sourcesSearched).toContain('Our World in Data');
    expect(receipt.sourcesSearched).toContain('IMF');
  });

  it('has no topMatch when nothing scores', async () => {
    const { hits, receipt } = await findSeriesWithReceipt('zzzznotarealmetric', ['owid']);
    expect(hits.length).toBe(0);
    expect(receipt.topMatch).toBeUndefined();
    expect(receipt.candidateCount).toBe(0);
  });
});

vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>();
  return {
    ...actual,
    complete: vi.fn(),
  };
});

import { complete } from './providers';
import { createSession } from './agent';

describe('createSession', () => {
  it('persists conversation history across two ask() calls', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    // Turn 1: model immediately finishes with a finding, no tool calls beyond finish.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 't1', name: 'finish', arguments: { one_line_finding: 'First finding.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verifier call for turn 1 (pass, since chartSpec is null the pass condition needs
    // literal PASS text from the mock. See agent.ts's verify()).
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('First question', cb);

    // Second ask() call should see the FIRST question's messages still present.
    // We can't inspect `messages` directly (private to the closure), so assert
    // indirectly: the second complete() call's messages argument includes the
    // first turn's user message.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 't2', name: 'finish', arguments: { one_line_finding: 'Second finding.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    await session.ask('Second question', cb);

    const secondCallArgs = mockComplete.mock.calls[2]; // 0,1 = turn1 pass+verify; 2 = turn2 pass
    const messagesArg = secondCallArgs[1] as { role: string; content: string }[];
    const hasFirstQuestion = messagesArg.some(
      (m) => m.role === 'user' && m.content === 'First question'
    );
    expect(hasFirstQuestion).toBe(true);
  });
});

describe('explanation turns', () => {
  it('skips verification and returns kind "explanation" when the model calls finish_explanation', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // Turn 1: a normal chart turn, so state.rows/chartSpec are non-empty going into turn 2.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'r1', name: 'render_chart', arguments: { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'First finding.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const first = await session.ask('Chart this data', cb);
    expect(first.kind).toBe('chart');

    // Turn 2: model calls finish_explanation instead of any chart tool.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Here is what the data shows.' } }],
      usage: { input: 8, output: 4 },
    });
    // NOTE: no verifier-call mock is queued for turn 2. If the implementation
    // calls the verifier anyway, this test fails with "no more mocked values",
    // proving the skip actually happened rather than merely asserting the field.

    const second = await session.ask('Explain this data', cb);
    expect(second.kind).toBe('explanation');
    expect(second.finding).toBe('Here is what the data shows.');
    // chartSpec is per-turn: a turn that renders no chart returns null, so
    // the UI never re-displays the previous turn's chart on a follow-up.
    expect(second.chartSpec).toBeNull();
  });
});

describe('verifier-fail retry', () => {
  it('appends only the critique on retry, not a duplicate of the question', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // First pass: render a chart, then finish.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'r1', name: 'render_chart', arguments: { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'First attempt.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verify #1 FAILs, which triggers agentPass(critique) a second time.
    mockComplete.mockResolvedValueOnce({
      text: 'FAIL: chart type mismatched to the question.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    // Retry pass: model finishes again.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f2', name: 'finish', arguments: { one_line_finding: 'Second attempt.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verify #2 passes.
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: fixed.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('Only question', cb);

    // The retry model call is mock index 3 (0=render, 1=finish, 2=verify-fail, 3=retry).
    const retryCallArgs = mockComplete.mock.calls[3];
    const messagesArg = retryCallArgs[1] as { role: string; content: string }[];
    const questionCopies = messagesArg.filter(
      (m) => m.role === 'user' && m.content === 'Only question'
    ).length;
    // Before the dedup fix, the retry pass re-pushed the question, so it appeared twice.
    expect(questionCopies).toBe(1);
    // The critique from the failed verifier IS appended on retry.
    const hasCritique = messagesArg.some(
      (m) => m.role === 'user' && m.content.startsWith('A previous attempt was judged insufficient.')
    );
    expect(hasCritique).toBe(true);
  });
});

describe('message trimming', () => {
  it('replaces a completed turn\'s tool-result messages with a short marker', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // find_series returns a JSON list of catalog hits — a deterministic,
    // network-free way to force a >200-char tool-result payload. Scoped to the
    // OWID/IMF catalog sources so the search is a pure in-memory filter (World
    // Bank's search can fall back to a live API call). (execute_js can no
    // longer serve this role: it short-circuits with a small error when no
    // rows have been fetched, which is the empty-dataset guard, not a trim
    // subject.)
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'e0', name: 'find_series', arguments: { query: 'co2 energy happiness gdp inflation poverty literacy unemployment debt' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'Done.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession(
      { provider: 'openrouter', model: 'test-model', apiKey: 'x' },
      { sources: ['owid', 'imf'] }
    );
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('Fetch data', cb);

    // Second turn, to inspect what turn 1's tool messages look like by the time
    // they're sent again.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f2', name: 'finish_explanation', arguments: { explanation: 'ok' } }],
      usage: { input: 10, output: 5 },
    });
    await session.ask('Explain', cb);

    const secondCallArgs = mockComplete.mock.calls[3]; // index 3 = the finish_explanation-producing call
    const messagesArg = secondCallArgs[1] as { role: string; content?: string }[];
    const toolMessages = messagesArg.filter((m) => m.role === 'tool');
    // Scoped to tool messages specifically. The system prompt and the
    // turn-2 "you already have data" reminder are legitimately long and are
    // not the trimming target; only completed turns' tool-result payloads are.
    const anyToolMessageHasFullRowDump = toolMessages.some(
      (m) => typeof m.content === 'string' && m.content.length > 500
    );
    expect(anyToolMessageHasFullRowDump).toBe(false);
    expect(toolMessages.length).toBeGreaterThan(0); // trimmed, not deleted. A short marker remains
    expect(toolMessages.some((m) => m.content?.includes('trimmed'))).toBe(true);
  });
});

// ── The RLM (judgment-call) flag ────────────────────────────────────────
// The capability spends the user's own key on every nested call, so it ships
// off and the user opts in. Enforcement is by WITHHOLDING: when off, the
// model is never told `llm()` exists, so it cannot burn a tool call finding
// out that it is disabled. These tests pin both halves of that: the schema
// the model sees, and the caller the sandbox is (not) handed.
describe('rlm flag: the execute_js description', () => {
  const execFor = (rlm?: boolean) =>
    schemasForSources(undefined, rlm).find((s) => s.name === 'execute_js')!;

  it('omits the llm() paragraph by default', () => {
    const d = execFor().description;
    expect(d).not.toContain('llm(');
    expect(d).not.toContain('second argument');
    expect(d).not.toContain('model_derived');
  });

  it('omits it when explicitly off', () => {
    expect(execFor(false).description).not.toContain('llm(');
  });

  it('reads naturally with no dangling reference to a second argument', () => {
    const d = execFor(false).description;
    // The base still documents the one argument the code always gets.
    expect(d).toContain('one argument, `rows`');
    expect(d.trimEnd()).toBe(d.trim());
  });

  it('appends the paragraph verbatim when on, and only to execute_js', () => {
    const off = execFor(false).description;
    const on = execFor(true).description;
    expect(on).toBe(off + EXECUTE_JS_RLM_PARAGRAPH);
    expect(on).toContain('model_derived');
    expect(on).toContain('4 calls per run, 8 per turn');

    const otherOff = schemasForSources(undefined, false).filter((s) => s.name !== 'execute_js');
    const otherOn = schemasForSources(undefined, true).filter((s) => s.name !== 'execute_js');
    expect(otherOn.map((s) => s.description)).toEqual(otherOff.map((s) => s.description));
  });

  it('never mutates the shared TOOL_SCHEMAS const', () => {
    const base = TOOL_SCHEMAS.find((s) => s.name === 'execute_js')!.description;
    schemasForSources(undefined, true);
    schemasForSources(['owid'], true);
    expect(TOOL_SCHEMAS.find((s) => s.name === 'execute_js')!.description).toBe(base);
    // ...so a later off-session is still clean after an on-session ran.
    expect(execFor(false).description).not.toContain('llm(');
  });

  it('leaves the source hard filter untouched', () => {
    const n = schemasForSources(['worldbank'], true).map((s) => s.name);
    expect(n).toContain('fetch_worldbank');
    expect(n).not.toContain('fetch_owid');
    expect(schemasForSources(undefined, true).length).toBe(TOOL_SCHEMAS.length);
  });
});

describe('rlm flag: the caller handed to execute_js', () => {
  const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
  const cfg = { provider: 'openrouter' as const, model: 'test-model', apiKey: 'x' };

  // A turn that fetches one row, runs execute_js, then finishes. The js body
  // reports what `llm` did when invoked, so the assertion is behavioural
  // rather than a check on a symbol that always exists.
  const PROBE =
    'try { await llm("classify", rows); return "CALLED"; } ' +
    'catch (e) { return "REFUSED: " + e.message; }';

  function queueTurn(mock: ReturnType<typeof vi.fn>, code: string) {
    mock.mockReset();
    // 1. fetch, so state.rows is non-empty (execute_js short-circuits otherwise).
    mock.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        {
          id: 'f1',
          name: 'fetch_worldbank',
          arguments: {
            indicator_id: 'NY.GDP.MKTP.CD',
            country_ids: ['USA'],
            year_start: 2000,
            year_end: 2001,
          },
        },
      ],
      usage: { input: 10, output: 5 },
    });
    // 2. execute_js with the probe body.
    mock.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'x1', name: 'execute_js', arguments: { code } }],
      usage: { input: 10, output: 5 },
    });
    // 3. finish_explanation, which skips the verifier so the mock queue stays
    //    short and any UNEXPECTED extra completion (i.e. a nested llm call)
    //    fails loudly instead of silently consuming a queued value.
    mock.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Done.' } }],
      usage: { input: 8, output: 4 },
    });
  }

  function execTrace(trace: any[]) {
    return trace.find((e) => e.tool === 'execute_js');
  }

  it('passes no caller by default, so llm() is unavailable in the sandbox', async () => {
    const mock = complete as unknown as ReturnType<typeof vi.fn>;
    queueTurn(mock, PROBE);
    let last: any[] = [];
    const session = createSession(cfg);
    await session.ask('probe', { ...cb, onTrace: (t: any[]) => { last = t; } });

    const ev = execTrace(last);
    expect(ev).toBeDefined();
    expect(ev.detail).toBe('ok');
    expect(ev.rlmReceipts).toBeUndefined();
    // Exactly three completions: fetch, execute_js, finish. No nested call.
    expect(mock.mock.calls.length).toBe(3);
  });

  it('rlm: false behaves identically to omitting the option', async () => {
    const mock = complete as unknown as ReturnType<typeof vi.fn>;
    queueTurn(mock, PROBE);
    let last: any[] = [];
    const session = createSession(cfg, { rlm: false });
    await session.ask('probe', { ...cb, onTrace: (t: any[]) => { last = t; } });
    expect(execTrace(last).rlmReceipts).toBeUndefined();
    expect(mock.mock.calls.length).toBe(3);
  });

  it('code that never calls llm() is unaffected when the flag is off', async () => {
    const mock = complete as unknown as ReturnType<typeof vi.fn>;
    queueTurn(mock, 'return rows.length;');
    let last: any[] = [];
    const session = createSession(cfg);
    await session.ask('count', { ...cb, onTrace: (t: any[]) => { last = t; } });
    const ev = execTrace(last);
    expect(ev.detail).toBe('ok');
    expect(ev.rlmReceipts).toBeUndefined();
  });

  it('enabling restores the nested call, its receipt, and the provenance note', async () => {
    const mock = complete as unknown as ReturnType<typeof vi.fn>;
    // Queued by hand rather than via queueTurn: the nested llm() completion
    // is consumed in call order, so it has to sit between execute_js and
    // finish. It is stubbed, so the sandbox never reaches a network.
    mock.mockReset();
    mock
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            id: 'f1',
            name: 'fetch_worldbank',
            arguments: {
              indicator_id: 'NY.GDP.MKTP.CD',
              country_ids: ['USA'],
              year_start: 2000,
              year_end: 2001,
            },
          },
        ],
        usage: { input: 10, output: 5 },
      })
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            id: 'x1',
            name: 'execute_js',
            arguments: { code: 'const r = await llm("classify", rows); return r.text;' },
          },
        ],
        usage: { input: 10, output: 5 },
      })
      // The nested llm() completion, issued from inside execute_js.
      .mockResolvedValueOnce({ text: 'coastal', toolCalls: [], usage: { input: 3, output: 1 } })
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Done.' } }],
        usage: { input: 8, output: 4 },
      });

    let last: any[] = [];
    const session = createSession(cfg, { rlm: true });
    await session.ask('judge', { ...cb, onTrace: (t: any[]) => { last = t; } });

    const ev = execTrace(last);
    expect(ev.rlmReceipts).toBeDefined();
    expect(ev.rlmReceipts.length).toBe(1);
    expect(ev.rlmReceipts[0].ok).toBe(true);
    expect(ev.rlmReceipts[0].depth).toBe(1);
    expect(ev.detail).toContain('1 llm() call');
    // Four completions: the nested one actually happened.
    expect(mock.mock.calls.length).toBe(4);
    // The nested call is issued with an EMPTY tool array (depth-1 by
    // construction), which is what makes recursion impossible.
    expect(mock.mock.calls[2][2]).toEqual([]);
  });

  it('attributes nested cost to the model that served it, not the configured one', async () => {
    const mock = complete as unknown as ReturnType<typeof vi.fn>;
    mock.mockReset();
    mock
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            id: 'f1',
            name: 'fetch_worldbank',
            arguments: {
              indicator_id: 'NY.GDP.MKTP.CD',
              country_ids: ['USA'],
              year_start: 2000,
              year_end: 2001,
            },
          },
        ],
        usage: { input: 0, output: 0 },
      })
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [
          {
            id: 'x1',
            name: 'execute_js',
            arguments: { code: 'const r = await llm("classify", rows); return r.text;' },
          },
        ],
        usage: { input: 0, output: 0 },
      })
      // Served by a :free model, which estimateCost prices at zero. If the
      // cost still referenced cfg.model this nested call would be billed at
      // the default rate, so a zero total is what proves the attribution.
      .mockResolvedValueOnce({
        text: 'coastal',
        toolCalls: [],
        usage: { input: 1_000_000, output: 1_000_000 },
        servedModel: 'some/model:free',
      })
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Done.' } }],
        usage: { input: 0, output: 0 },
      });

    const session = createSession(cfg, { rlm: true });
    const out = await session.ask('judge', cb);
    expect(out.cost).toBe(0);
  });

  // Same attribution rule in the MAIN loop, not just the nested call. This
  // matters in normal use: the free-model fallback chain means OpenRouter can
  // serve a different model than the one picked, and pricing the response
  // against cfg.model would bill the user for a model that never ran.
  it('prices main-loop turns against the model that actually served them', async () => {
    (complete as any)
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Done.' } }],
        usage: { input: 1_000_000, output: 1_000_000 },
        servedModel: 'some/model:free',
      });

    const session = createSession(cfg);
    const out = await session.ask('explain something', cb);
    expect(out.cost).toBe(0);
  });
});
