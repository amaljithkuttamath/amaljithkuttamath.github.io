import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOOL_SCHEMAS,
  schemasForSources,
  resolveSources,
  datasetSourcesFor,
  findSeries,
  scoreSeries,
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
