import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TOOL_SCHEMAS,
  schemasForSources,
  subAgentSchemasFor,
  resolveSources,
  datasetSourcesFor,
  SOURCES,
  sourcesByCategory,
  findSeries,
  findSeriesWithReceipt,
  scoreSeries,
  explainMatch,
  parseImfIndicators,
  parseOwidCatalog,
  parseWhoIndicators,
  fetchWho,
  DEFAULT_SOURCE_IDS,
  VFS,
  executeJs,
  type DataRow,
  type LlmFn,
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

  // Fetching is now the source-agnostic router `fetch_series` (backlog #7): the
  // per-source fetch tools are retired from the model's schema surface entirely,
  // so the hard filter is enforced at the router (it refuses out-of-namespace
  // ids), not by withholding a per-source tool from the schema set.
  it('every session exposes fetch_series and none of the retired per-source fetch tools', () => {
    for (const sel of [['worldbank'], ['owid'], ['imf'], ['owid', 'imf'], undefined]) {
      const n = names(sel);
      expect(n).toContain('fetch_series');
      expect(n).not.toContain('fetch_worldbank');
      expect(n).not.toContain('fetch_worldbank_all');
      expect(n).not.toContain('fetch_owid');
      expect(n).not.toContain('fetch_imf');
    }
    // The shared dataset catalog is still filtered by active source.
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

describe('WHO GHO source registration (registry-driven picker + routing)', () => {
  it('is present in the SOURCES registry with a Health category and who datasetSource', () => {
    const who = SOURCES.find((s) => s.id === 'who');
    expect(who).toBeDefined();
    expect(who!.label).toBe('WHO Global Health Observatory');
    expect(who!.category).toBe('Health');
    expect(who!.datasetSource).toBe('who');
    expect(who!.blurb.length).toBeGreaterThan(0);
    expect(who!.promptSnippet).toMatch(/health/i);
    expect(who!.cite.url).toContain('who.int');
  });

  it('the registry-driven picker groups WHO under a Health category header', () => {
    const groups = sourcesByCategory();
    const health = groups.find((g) => g.category === 'Health');
    expect(health).toBeDefined();
    expect(health!.sources.map((s) => s.id)).toContain('who');
  });

  it('WHO participates in the shared dataset-catalog filter and default source set', () => {
    expect(DEFAULT_SOURCE_IDS).toContain('who');
    expect(datasetSourcesFor(['who'])).toEqual(['who']);
    // A hard filter keeps WHO out when it is not selected.
    expect(datasetSourcesFor(['owid'])).not.toContain('who');
  });

  it('a WHO-scoped sub-agent gets the depth-1 router toolset (scoping accepts who)', () => {
    const n = subAgentSchemasFor('who').map((s) => s.name);
    expect(n).toEqual(expect.arrayContaining(['find_series', 'fetch_series', 'execute_js', 'return_findings']));
    expect(n).not.toContain('delegate_source');
  });
});

describe('delegate_source gating + depth-1 (schema level)', () => {
  const names = (ids?: string[]) => schemasForSources(ids).map((s) => s.name);

  it('delegate_source is absent from single-source schemas, present when >1 active', () => {
    // Gating: a session with one active database never even sees the tool.
    expect(names(['worldbank'])).not.toContain('delegate_source');
    expect(names(['owid'])).not.toContain('delegate_source');
    expect(names(['imf'])).not.toContain('delegate_source');
    // >1 active database → the tool appears in the main-loop schema set.
    expect(names(['owid', 'imf'])).toContain('delegate_source');
    expect(names(['worldbank', 'owid'])).toContain('delegate_source');
    expect(names(undefined)).toContain('delegate_source'); // all sources = >1
  });

  it('sub-agent schema set is depth-1: no delegate_source, only the router + core', () => {
    for (const id of ['worldbank', 'owid', 'imf', 'who']) {
      const n = subAgentSchemasFor(id).map((s) => s.name);
      // Depth-1 enforced STRUCTURALLY: a sub-agent literally cannot delegate.
      expect(n).not.toContain('delegate_source');
      // Its allowed toolset: source-scoped find_series, the fetch_series router
      // (restricted to this source at dispatch), execute_js (with llm()), and
      // the terminal return_findings.
      expect(n).toContain('find_series');
      expect(n).toContain('fetch_series');
      expect(n).toContain('execute_js');
      expect(n).toContain('return_findings');
      // No main-loop-only tools leak into a sub-agent.
      expect(n).not.toContain('render_chart');
      expect(n).not.toContain('finish');
      expect(n).not.toContain('finish_explanation');
      // The retired per-source fetch tools are gone; the router replaces them.
      // (Cross-source refusal is a runtime check, exercised in the driven tests.)
      expect(n).not.toContain('fetch_worldbank');
      expect(n).not.toContain('fetch_worldbank_all');
      expect(n).not.toContain('fetch_owid');
      expect(n).not.toContain('fetch_imf');
    }
  });

  it('return_findings is never exposed to the main loop', () => {
    for (const sel of [['worldbank'], ['owid', 'imf'], undefined]) {
      expect(names(sel)).not.toContain('return_findings');
    }
    expect(TOOL_SCHEMAS.map((s) => s.name)).not.toContain('return_findings');
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

describe('parseOwidCatalog — live OWID grapher catalog', () => {
  it('maps a bare array of grapher charts to namespaced series', () => {
    const parsed = parseOwidCatalog([
      { slug: 'life-expectancy', title: 'Life expectancy' },
      { slug: 'co-emissions-per-capita', title: 'CO₂ emissions per capita' },
    ]);
    expect(parsed).toContainEqual({ id: 'owid:life-expectancy', name: 'Life expectancy' });
    expect(parsed.find((p) => p.id === 'owid:co-emissions-per-capita')?.name).toBe('CO₂ emissions per capita');
  });

  it('unwraps { charts | items | results } and reads title/name/chartName', () => {
    expect(parseOwidCatalog({ charts: [{ slug: 'population', name: 'Population' }] }))
      .toEqual([{ id: 'owid:population', name: 'Population' }]);
    expect(parseOwidCatalog({ results: [{ slug: 'median-age', chartName: 'Median age' }] }))
      .toEqual([{ id: 'owid:median-age', name: 'Median age' }]);
  });

  it('strips an existing owid: prefix, dedupes, and is defensive against junk', () => {
    expect(parseOwidCatalog(null)).toEqual([]);
    expect(parseOwidCatalog({})).toEqual([]);
    expect(parseOwidCatalog({ charts: 'nope' })).toEqual([]);
    // owid: prefix stripped, blank/duplicate/non-object entries dropped, title
    // missing → slug becomes the name.
    expect(
      parseOwidCatalog([
        { slug: 'owid:gdp-per-capita-worldbank' },
        { slug: 'gdp-per-capita-worldbank', title: 'dup' },
        { id: '' },
        null,
        'string',
      ])
    ).toEqual([{ id: 'owid:gdp-per-capita-worldbank', name: 'gdp-per-capita-worldbank' }]);
  });
});

describe('parseWhoIndicators — live WHO GHO catalog', () => {
  it('maps the GHO /Indicator shape to namespaced series', () => {
    const parsed = parseWhoIndicators({
      value: [
        { IndicatorCode: 'WHOSIS_000001', IndicatorName: 'Life expectancy at birth (years)' },
        { IndicatorCode: 'WHS4_544', IndicatorName: 'Measles (MCV1) immunization coverage among 1-year-olds (%)' },
      ],
    });
    expect(parsed).toContainEqual({ id: 'who:WHOSIS_000001', name: 'Life expectancy at birth (years)' });
    expect(parsed.find((p) => p.id === 'who:WHS4_544')?.name).toContain('Measles');
  });

  it('is defensive against a malformed payload and dedupes', () => {
    expect(parseWhoIndicators(null)).toEqual([]);
    expect(parseWhoIndicators({})).toEqual([]);
    expect(parseWhoIndicators({ value: 'nope' })).toEqual([]);
    // duplicate code kept once (first wins), non-object/blank entries dropped,
    // missing name falls back to the code.
    expect(
      parseWhoIndicators({
        value: [
          { IndicatorCode: 'WHOSIS_000001', IndicatorName: 'first' },
          { IndicatorCode: 'WHOSIS_000001', IndicatorName: 'dup' },
          { IndicatorCode: '' },
          null,
          'string',
          { IndicatorCode: 'NCDMORT3070' },
        ],
      })
    ).toEqual([
      { id: 'who:WHOSIS_000001', name: 'first' },
      { id: 'who:NCDMORT3070', name: 'NCDMORT3070' },
    ]);
  });
});

describe('fetchWho — GHO OData URL + row parsing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds the OData $filter (country-level + countries + year window) and preserves code case', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen = String(url);
      return { ok: true, json: async () => ({ value: [] }) };
    }));
    await fetchWho('who:TB_e_inc_100k', ['ind', 'CHN'], 2000, 2010);
    // Endpoint carries the exact IndicatorCode, case preserved (never upper-cased).
    expect(seen).toContain('ghoapi.azureedge.net/api/TB_e_inc_100k');
    // Decode the $filter to assert its clauses.
    const filter = decodeURIComponent(seen.split('$filter=')[1] ?? '');
    expect(filter).toContain("SpatialDimType eq 'COUNTRY'");
    expect(filter).toContain("SpatialDim in ('IND','CHN')");
    expect(filter).toContain('TimeDim ge 2000');
    expect(filter).toContain('TimeDim le 2010');
    expect(filter).toContain(' and ');
  });

  it('omits the country and year clauses when not given', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen = String(url);
      return { ok: true, json: async () => ({ value: [] }) };
    }));
    await fetchWho('WHOSIS_000001');
    const filter = decodeURIComponent(seen.split('$filter=')[1] ?? '');
    expect(filter).toBe("SpatialDimType eq 'COUNTRY'");
    expect(filter).not.toContain('SpatialDim in');
    expect(filter).not.toContain('TimeDim');
  });

  it('parses rows and SKIPS rows with a null NumericValue (no fabricated values)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        value: [
          { SpatialDim: 'IND', TimeDim: 2019, NumericValue: 69.7 },
          { SpatialDim: 'IND', TimeDim: 2020, NumericValue: null },
          { SpatialDim: 'USA', TimeDim: 2019, NumericValue: 78.5 },
          { SpatialDim: '', TimeDim: 2019, NumericValue: 1 },
        ],
      }),
    })));
    const { rows, requestUrl } = await fetchWho('who:WHOSIS_000001');
    expect(requestUrl).toContain('ghoapi.azureedge.net/api/WHOSIS_000001');
    // null-value row dropped, blank-code row dropped → 2 rows.
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.value !== null)).toBe(true);
    expect(rows.every((r) => r.indicator === 'who:WHOSIS_000001')).toBe(true);
    // ISO3 resolves to a display name where known.
    expect(rows.find((r) => r.iso3 === 'IND')?.country).toBe('India');
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

  it('still returns curated OWID hits when the live grapher catalog is unreachable', async () => {
    // fetch rejects → owidCatalog() throws → searchOwidCatalog() returns []
    // → expanded curated OWID hits must still come through (graceful degradation).
    const hits = await findSeries('temperature anomaly', ['owid']);
    expect(hits.some((h) => h.source === 'owid' && h.id === 'owid:temperature-anomaly')).toBe(true);
  });

  it('surfaces newly-curated OWID topics that the old thin list lacked', async () => {
    for (const [q, id] of [
      ['plastic waste per capita', 'owid:plastic-waste-per-capita'],
      ['political regime', 'owid:political-regime'],
      ['median age', 'owid:median-age'],
    ] as const) {
      const hits = await findSeries(q, ['owid']);
      expect(hits[0]).toMatchObject({ source: 'owid', id });
    }
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

describe('VFS provenance marker', () => {
  it('records { derived, via } on a marked write and clears it on a plain re-write', () => {
    const vfs = new VFS();
    vfs.write('themes.json', '["rising","falling"]', { derived: true, via: 'llm' });
    expect(vfs.files['themes.json']).toBe('["rising","falling"]');
    expect(vfs.meta['themes.json']).toEqual({ derived: true, via: 'llm' });
    // A subsequent plain write (no meta) must not leave a stale derived marker.
    vfs.write('themes.json', 'fetched-later');
    expect(vfs.meta['themes.json']).toBeUndefined();
  });

  it('leaves no meta entry for an ordinary fetched-data file', () => {
    const vfs = new VFS();
    vfs.write('plan.md', '# plan');
    expect(vfs.meta['plan.md']).toBeUndefined();
  });
});

describe('executeJs — RLM llm() primitive wiring', () => {
  const rows: DataRow[] = [{ country: 'India', iso3: 'IND', year: 2020, value: 100 }];

  it('awaits an injected llm() and returns its text through the result', async () => {
    const llm: LlmFn = async (prompt) => 'LABEL:' + prompt;
    const out = await executeJs('return await llm("hi");', rows, llm);
    expect(out.ok).toBe(true);
    expect(out.result).toBe('LABEL:hi');
  });

  it('a thrown llm() is catchable inside the sandboxed code', async () => {
    const llm: LlmFn = async () => {
      throw new Error('boom');
    };
    const out = await executeJs(
      'try { await llm("x"); return "no"; } catch (e) { return "caught:" + e.message; }',
      rows,
      llm
    );
    expect(out.ok).toBe(true);
    expect(out.result).toBe('caught:boom');
  });

  it('an uncaught llm() rejection surfaces as ok:false (error-receipt path)', async () => {
    const llm: LlmFn = async () => {
      throw new Error('provider down');
    };
    const out = await executeJs('await llm("x"); return 1;', rows, llm);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('provider down');
  });

  it('calling llm() with no session-provided primitive is a clear, catchable error', async () => {
    const out = await executeJs(
      'try { await llm("x"); return "no"; } catch (e) { return e.message; }',
      rows
    );
    expect(out.ok).toBe(true);
    expect(String(out.result)).toContain('not available');
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
import { createSession, buildSystemPrompt, buildSubAgentPrompt, parseVerifierVerdict } from './agent';

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

// ── Structured verifier verdict parsing (pure helper) ─────────────────────
describe('parseVerifierVerdict — structured verdict parsing', () => {
  it('parses a well-formed JSON pass verdict with high confidence and no issues', () => {
    const v = parseVerifierVerdict('{"pass": true, "confidence": "high", "issues": []}');
    expect(v).toEqual({ pass: true, confidence: 'high', issues: [] });
  });

  it('parses a medium-confidence fail verdict, keeping the concrete issues', () => {
    const v = parseVerifierVerdict(
      '{"pass": false, "confidence": "medium", "issues": ["The 1.9% figure is not in the fetched rows.", "GDP is uncited."]}'
    );
    expect(v).toEqual({
      pass: false,
      confidence: 'medium',
      issues: ['The 1.9% figure is not in the fetched rows.', 'GDP is uncited.'],
    });
  });

  it('parses a low-confidence verdict and tolerates code fences + surrounding prose', () => {
    const raw = 'Here is my verdict:\n```json\n{"pass": false, "confidence": "low", "issues": ["Chart type mismatched."]}\n```\nThanks.';
    const v = parseVerifierVerdict(raw);
    expect(v).toEqual({ pass: false, confidence: 'low', issues: ['Chart type mismatched.'] });
  });

  it('drops blank/non-string issue entries without fabricating any', () => {
    const v = parseVerifierVerdict('{"pass": false, "confidence": "low", "issues": ["real one", "", 42, null, "  "]}');
    expect(v).toEqual({ pass: false, confidence: 'low', issues: ['real one'] });
  });

  it('still parses the legacy "PASS:" / "FAIL:" line format', () => {
    expect(parseVerifierVerdict('PASS: chart rendered.')).toEqual({ pass: true, confidence: 'high', issues: [] });
    const fail = parseVerifierVerdict('FAIL: chart type mismatched to the question.');
    expect(fail).toEqual({ pass: false, confidence: 'low', issues: ['chart type mismatched to the question.'] });
  });

  it('malformed / partial JSON → null (could-not-verify), never a guessed pass', () => {
    // Missing confidence.
    expect(parseVerifierVerdict('{"pass": true, "issues": []}')).toBeNull();
    // Bad confidence value.
    expect(parseVerifierVerdict('{"pass": false, "confidence": "meh", "issues": []}')).toBeNull();
    // pass not a boolean.
    expect(parseVerifierVerdict('{"pass": "yes", "confidence": "high", "issues": []}')).toBeNull();
    // issues not an array.
    expect(parseVerifierVerdict('{"pass": true, "confidence": "high", "issues": "none"}')).toBeNull();
    // Not JSON, and no PASS/FAIL prefix.
    expect(parseVerifierVerdict('the model rambled without a verdict')).toBeNull();
    // Empty.
    expect(parseVerifierVerdict('')).toBeNull();
    expect(parseVerifierVerdict('   ')).toBeNull();
  });
});

// ── Verification outcomes, driven end-to-end through createSession ─────────
// complete() is mocked; a chart turn is finished, then the verifier's mocked
// return decides the state. Asserts on both the TraceEvent (receipt) and the
// AgentOutput.verification (answer-level treatment).
describe('verification outcomes (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const chartTurn = () =>
    ({
      text: '',
      toolCalls: [
        tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'A finding.' }, 'fin'),
      ],
      usage: { input: 10, output: 5 },
    });
  const newSession = () => createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  const verifyEvent = (events: any[]) => events.filter((e) => e.tool === 'verify');

  it('a JSON pass verdict → verified state: pass=true, stamp-eligible, tokens on the receipt', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce({
      text: '{"pass": true, "confidence": "high", "issues": []}',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    expect(out.verification).not.toBeNull();
    expect(out.verification!.status).toBe('verified');
    expect(out.verification!.pass).toBe(true);
    expect(out.verification!.confidence).toBe('high');
    expect(out.confidence).toBe('ok');
    expect(out.retried).toBe(false);

    const [v] = verifyEvent(trace());
    expect(v.pass).toBe(true);
    expect(v.verifyStatus).toBe('verified');
    expect(v.status).toBe('ok'); // 'ok' receipt → the UI stamps it
    // Cost transparency: the verify call's tokens ride on its receipt.
    expect(v.tokens).toBe(7);
  });

  it('a JSON fail verdict (after one retry that also fails) → unverified with issues, low confidence', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    // Verify #1 fails with concrete issues → triggers ONE retry.
    mockComplete.mockResolvedValueOnce({
      text: '{"pass": false, "confidence": "medium", "issues": ["The 1.9% figure is not in the fetched rows."]}',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    // Retry pass (agentPass) → finish again.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish', { one_line_finding: 'Second attempt.' }, 'fin2')],
      usage: { input: 8, output: 4 },
    });
    // Verify #2 also fails.
    mockComplete.mockResolvedValueOnce({
      text: '{"pass": false, "confidence": "low", "issues": ["Chart still does not answer the question."]}',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    expect(out.retried).toBe(true);
    expect(out.verification!.status).toBe('unverified');
    expect(out.verification!.pass).toBe(false);
    expect(out.verification!.issues).toEqual(['Chart still does not answer the question.']);
    expect(out.confidence).toBe('low');

    const vs = verifyEvent(trace());
    expect(vs.length).toBe(2); // first (retried) + final
    const finalV = vs[1];
    expect(finalV.verifyStatus).toBe('unverified');
    expect(finalV.pass).toBe(false);
    expect(finalV.status).toBe('error'); // non-pass reads as an error receipt
    expect(finalV.confidence).toBe('low');
    expect(finalV.issues).toEqual(['Chart still does not answer the question.']);
  });

  it('a provider error in the verify call → unavailable state, error receipt, NO retry, never verified', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    // The verify complete() itself rejects — a network/provider failure.
    mockComplete.mockRejectedValueOnce(new Error('502 upstream'));
    // NOTE: no retry mocks queued. If the implementation retried on an
    // unavailable verdict, the next complete() would throw "no more mocked
    // values" and fail this test — proving unavailable does NOT retry.

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    expect(out.retried).toBe(false);
    expect(out.verification!.status).toBe('unavailable');
    expect(out.verification!.pass).toBe(false); // never defaulted to verified
    expect(out.verification!.confidence).toBe('none');
    expect(out.verification!.report).toContain('verification unavailable');
    expect(out.confidence).toBe('low');

    const [v] = verifyEvent(trace());
    expect(v.verifyStatus).toBe('unavailable');
    expect(v.pass).toBe(false);
    expect(v.status).toBe('error'); // failed verify shows as an error receipt
    expect(v.tokens).toBeUndefined(); // the call threw — no tokens to report
  });

  it('an unparseable verifier verdict → could-not-verify (unverified), never verified, no fabricated issues', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    // Verify #1: unreadable → treated as unverified → triggers a retry.
    mockComplete.mockResolvedValueOnce({
      text: 'I think it is probably fine but I am not totally sure honestly',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    // Retry pass.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish', { one_line_finding: 'Retry finding.' }, 'fin2')],
      usage: { input: 8, output: 4 },
    });
    // Verify #2: also unreadable.
    mockComplete.mockResolvedValueOnce({
      text: 'still rambling, no verdict here',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    expect(out.verification!.status).toBe('unverified');
    expect(out.verification!.pass).toBe(false);
    expect(out.verification!.issues).toEqual([]); // never fabricated
    const finalV = verifyEvent(trace())[1];
    expect(finalV.verifyStatus).toBe('unverified');
    expect(finalV.issues).toEqual([]);
  });

  it('an explanation turn runs no verifier and returns verification=null', async () => {
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish_explanation', { explanation: 'Prose answer.' }, 'fe')],
      usage: { input: 8, output: 4 },
    });
    // No verifier mock queued — a verify call would throw "no more mocked values".
    const { cb } = capture();
    const out = await newSession().ask('explain', cb);
    expect(out.kind).toBe('explanation');
    expect(out.verification).toBeNull();
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

// ── RLM: bounded recursive llm() inside execute_js ────────────────────────
// Drive real turns through createSession with complete() mocked. A stubbed
// fetch seeds state.rows (execute_js refuses to run with none), then the
// model's code makes llm() calls whose completions are the SAME mocked
// complete() — so caps, receipts, provenance, and the error path are all
// exercised without any network or live model.
describe('RLM llm() inside execute_js', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockComplete.mockReset();
    // A minimal, valid World Bank response so fetch_worldbank yields rows.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { page: 1, pages: 1, total: 2 },
          [
            { country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 },
            { country: { value: 'India' }, countryiso3code: 'IND', date: '2021', value: 110 },
          ],
        ],
      }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const llmReply = (text: string) => ({ text, toolCalls: [], usage: { input: 3, output: 2 } });
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
  const fetchCall = (id = 'fetch1') =>
    tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, id);

  // All execute_js tool-results the model saw, parsed, deduped by call id.
  function execResults(): any[] {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (m.role === 'tool' && m.name === 'execute_js' && !seen.has(m.tool_call_id)) {
          seen.add(m.tool_call_id);
          try {
            out.push(JSON.parse(m.content));
          } catch {
            out.push(m.content);
          }
        }
      }
    }
    return out;
  }

  // These tests exercise the llm() capability, which is now opt-in and OFF by
  // default (see the gating tests below), so this block enables it explicitly.
  const newSession = () =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { rlm: true });
  const capture = () => {
    let last: any[] = [];
    const cb = {
      onTrace: (ev: any[]) => (last = ev),
      onFiles: () => {},
      onChart: () => {},
      onStatus: () => {},
    };
    return { cb, trace: () => last };
  };

  it('caps at 4 llm() calls per execute_js run; the 5th rejects catchably, and only 4 nested receipts are emitted', async () => {
    const code =
      'let ok = 0; let caught = ""; ' +
      'for (let i = 0; i < 5; i++) { try { await llm("classify " + i, rows[0]); ok++; } catch (e) { caught = e.message; } } ' +
      'return { ok, caught };';
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code }, 'ej1')]));
    for (let i = 0; i < 4; i++) mockComplete.mockResolvedValueOnce(llmReply('label' + i));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask('q', cb);

    const llmEvents = trace().filter((e) => e.tool === 'llm');
    expect(llmEvents.length).toBe(4); // the 5th never ran, so no 5th receipt
    expect(llmEvents.every((e) => e.status === 'ok')).toBe(true);

    const res = execResults()[0];
    expect(res.ok).toBe(4);
    expect(res.caught).toMatch(/per execute_js run/);
  });

  it('emits nested llm() receipts with prompt summary, data size, duration and tokens, ordered under their execute_js parent', async () => {
    const code = 'await llm("summarize the slice", rows); return "ok";';
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code }, 'ej1')]));
    mockComplete.mockResolvedValueOnce(llmReply('a summary'));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask('q', cb);

    const events = trace();
    const ejIdx = events.findIndex((e) => e.tool === 'execute_js');
    const llmIdx = events.findIndex((e) => e.tool === 'llm');
    expect(ejIdx).toBeGreaterThanOrEqual(0);
    // The child receipt is nested and ordered AFTER its execute_js parent.
    expect(llmIdx).toBeGreaterThan(ejIdx);
    const llmEv = events[llmIdx];
    expect(llmEv.nested).toBe(true);
    expect(llmEv.argSummary).toBe('summarize the slice');
    expect(llmEv.argSummary.length).toBeLessThanOrEqual(80);
    expect(typeof llmEv.dataBytes).toBe('number');
    expect(llmEv.dataBytes).toBeGreaterThan(0);
    expect(typeof llmEv.durationMs).toBe('number');
    expect(typeof llmEv.tokens).toBe('number');
    expect(llmEv.tokens).toBeGreaterThan(0);
  });

  it('shares an 8-call budget across execute_js runs in one turn; the 9th rejects with a per-turn error', async () => {
    const loop = (n: number, catchIt = false) =>
      `let ok = 0; let caught = ""; for (let i = 0; i < ${n}; i++) { ` +
      (catchIt
        ? 'try { await llm("c" + i, rows[0]); ok++; } catch (e) { caught = e.message; }'
        : 'await llm("c" + i, rows[0]); ok++;') +
      ' } return { ok, caught };';
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        fetchCall(),
        tc('execute_js', { code: loop(4) }, 'ejA'), // 4 → turn total 4
        tc('execute_js', { code: loop(3) }, 'ejB'), // 3 → turn total 7
        tc('execute_js', { code: loop(2, true) }, 'ejC'), // 1 ok (→8), 2nd rejected
      ])
    );
    for (let i = 0; i < 8; i++) mockComplete.mockResolvedValueOnce(llmReply('l' + i)); // 4 + 3 + 1
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask('q', cb);

    // Exactly 8 successful llm() calls across the three runs; the 9th made no receipt.
    expect(trace().filter((e) => e.tool === 'llm').length).toBe(8);
    const [a, b, c] = execResults();
    expect(a.ok).toBe(4);
    expect(b.ok).toBe(3);
    expect(c.ok).toBe(1);
    expect(c.caught).toMatch(/per turn/);
  });

  it('rejects an over-size data slice before any model call or receipt', async () => {
    const code =
      'const big = []; for (let i = 0; i < 6000; i++) big.push({ i, s: "xxxxxxxxxx" }); ' +
      'let caught = ""; try { await llm("summarize", big); } catch (e) { caught = e.message; } ' +
      'return { caught };';
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code }, 'ej1')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask('q', cb);

    // No llm receipt, and complete() was only called for the two model turns +
    // verify — never for a recursive llm() call (the size guard fired first).
    expect(trace().filter((e) => e.tool === 'llm').length).toBe(0);
    expect(execResults()[0].caught).toMatch(/too large/);
  });

  it('an uncaught llm() failure produces an error receipt and the main loop continues', async () => {
    const code = 'await llm("x", rows[0]); return 1;';
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code }, 'ej1')]));
    // The recursive llm()'s complete() rejects — uncaught in the model's code.
    mockComplete.mockRejectedValueOnce(new Error('provider exploded'));
    // A SECOND model turn proves the loop continued past the failed run.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Recovered.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    const llmEv = trace().find((e) => e.tool === 'llm');
    expect(llmEv?.status).toBe('error');
    expect(llmEv?.detail).toContain('provider exploded');
    const ejEv = trace().find((e) => e.tool === 'execute_js');
    expect(ejEv?.detail).toMatch(/^error:/);
    expect(ejEv?.detail).toContain('provider exploded');
    // Loop continued and reached finish.
    expect(out.finding).toBe('Recovered.');
  });

  it('marks a model-derived write_file with the provenance flag on its trace event', async () => {
    let files: Record<string, string> = {};
    const cb = {
      onTrace: () => {},
      onFiles: (f: Record<string, string>) => (files = f),
      onChart: () => {},
      onStatus: () => {},
    };
    let last: any[] = [];
    const cb2 = { ...cb, onTrace: (ev: any[]) => (last = ev) };
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('write_file', { path: 'themes.json', content: '["rising","falling"]', derived: true }, 'w1'),
        tc('write_file', { path: 'plan.md', content: '# plan' }, 'w2'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    await newSession().ask('q', cb2);

    const writes = last.filter((e) => e.tool === 'write_file');
    const derivedWrite = writes.find((e) => e.argSummary === 'themes.json');
    const plainWrite = writes.find((e) => e.argSummary === 'plan.md');
    expect(derivedWrite?.derived).toBe(true);
    // A plain (fetched) artifact carries no derived marker.
    expect(plainWrite?.derived).toBeFalsy();
    expect(files['themes.json']).toBe('["rising","falling"]');
  });
});

// ── delegate_source: depth-1 per-source sub-agents, on the RLM plumbing ───────
// Drive real turns through createSession with complete() mocked. Each sub-agent
// turn is just another queued mockComplete value; its fetches merge into the
// shared parent state, and its receipts stream nested under the delegate step —
// all without any network or live model.
describe('delegate_source sub-agents (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const llmReply = (text: string) => ({ text, toolCalls: [], usage: { input: 3, output: 2 } });
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });

  // `rlm` defaults off (the shipping default); only the llm()-budget test opts
  // in, since the capability is now off by default and withheld otherwise.
  const newSession = (sources?: string[], rlm?: boolean) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources, rlm });
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  // Every tool-result message of a given name the model was shown, deduped by id.
  const toolMsgs = (name: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (m.role === 'tool' && m.name === name && !seen.has(m.tool_call_id)) {
          seen.add(m.tool_call_id);
          out.push(m.content);
        }
      }
    }
    return out;
  };

  it('a single-source session refuses delegate_source at dispatch (runtime guard)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // The mock forces the call even though it is absent from a one-source
    // schema — proving the dispatch itself refuses, not just the schema filter.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('delegate_source', { source: 'World Bank', question: 'x' }, 'd1'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb, trace } = capture();
    await newSession(['worldbank']).ask('q', cb);

    const res = toolMsgs('delegate_source');
    expect(res.length).toBe(1);
    expect(res[0]).toContain('unavailable');
    const ev = trace().find((e) => e.tool === 'delegate_source');
    expect(ev?.detail).toBe('unavailable');
  });

  it('caps at 3 delegations per turn; the 4th is refused, the first 3 run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('delegate_source', { source: 'owid', question: 'q1' }, 'd1'),
        tc('delegate_source', { source: 'imf', question: 'q2' }, 'd2'),
        tc('delegate_source', { source: 'owid', question: 'q3' }, 'd3'),
        tc('delegate_source', { source: 'imf', question: 'q4' }, 'd4'),
      ])
    );
    // Three sub-agents that each return immediately.
    for (let i = 0; i < 3; i++)
      mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'sum' + i }, 'r' + i)]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));

    const { cb, trace } = capture();
    await newSession(['owid', 'imf']).ask('q', cb);

    const res = toolMsgs('delegate_source');
    expect(res.length).toBe(4);
    // First 3 succeeded (distilled summaries, source-labelled); 4th hit the cap.
    expect(res.slice(0, 3).every((r) => r.startsWith('['))).toBe(true);
    expect(res[3]).toMatch(/delegation budget spent/);
    const dels = trace().filter((e) => e.tool === 'delegate_source');
    expect(dels.length).toBe(4);
    expect(dels[3].status).toBe('ok'); // a cap refusal is a normal result, not an error
    expect(dels[3].detail).toBe('cap reached');
  });

  it('a sub-agent that never returns findings stops at its 6-step cap; parent continues', async () => {
    // find_series over OWID is a pure in-memory catalog filter (offline).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'owid', question: 'gdp' }, 'd1')]));
    // Six sub-agent turns that keep searching and never return_findings.
    for (let i = 0; i < 6; i++)
      mockComplete.mockResolvedValueOnce(modelTurn([tc('find_series', { query: 'gdp' }, 'f' + i)]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));

    const { cb, trace } = capture();
    const out = await newSession(['owid', 'imf']).ask('q', cb);

    // Exactly six nested sub-agent steps; the 7th turn never ran.
    const nested = trace().filter((e) => e.nested && e.tool === 'find_series');
    expect(nested.length).toBe(6);
    const res = toolMsgs('delegate_source');
    expect(res[0]).toMatch(/6-step limit/);
    const ev = trace().find((e) => e.tool === 'delegate_source');
    expect(ev?.status).toBe('error');
    expect(ev?.detail).toBe('cap reached');
    // The main loop continued past the failed delegation.
    expect(out.finding).toBe('done');
  });

  it('merges two sub-agents\' fetched rows + indicators into parent state, citations intact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('api.worldbank.org'))
          return {
            ok: true,
            json: async () => [
              { page: 1, pages: 1 },
              [
                { country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 70 },
                { country: { value: 'India' }, countryiso3code: 'IND', date: '2021', value: 71 },
              ],
            ],
          };
        if (u.includes('ourworldindata.org'))
          return { ok: true, text: async () => 'Entity,Code,Year,Life\nIndia,IND,2020,69\nIndia,IND,2021,69.5\n' };
        throw new Error('unexpected url ' + u);
      })
    );

    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('delegate_source', { source: 'World Bank', question: 'life expectancy IND' }, 'd1'),
        tc('delegate_source', { source: 'owid', question: 'life expectancy IND' }, 'd2'),
      ])
    );
    // Sub-agent 1 (World Bank): fetch then return.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_worldbank', { indicator_id: 'SP.DYN.LE00.IN', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, 'wf')])
    );
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'WB life exp ~71' }, 'r1')]));
    // Sub-agent 2 (OWID): fetch then return.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_owid', { dataset_id: 'owid:life-expectancy', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, 'of')])
    );
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'OWID life exp ~69.5' }, 'r2')]));
    // Parent combines: chart + finish.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('render_chart', { type: 'line', title: 'LE', series: [{ name: 'IND', data: [[2020, 70]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'combined' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb } = capture();
    const out = await newSession(['worldbank', 'owid']).ask('life expectancy', cb);

    // Rows from BOTH sources merged, each carrying its own citation (indicator).
    expect(out.rows.length).toBe(4);
    const inds = new Set(out.rows.map((r) => r.indicator));
    expect(inds.has('SP.DYN.LE00.IN')).toBe(true);
    expect(inds.has('owid:life-expectancy')).toBe(true);
    // Indicator registry (drives the evidence table + chart↔evidence linking).
    const indIds = out.indicators.map((i) => i.id);
    expect(indIds).toContain('SP.DYN.LE00.IN');
    expect(indIds).toContain('owid:life-expectancy');
    // The parent model never saw the raw rows — only the distilled summaries.
    const res = toolMsgs('delegate_source');
    expect(res.some((r) => r.includes('WB life exp'))).toBe(true);
    expect(res.some((r) => r.includes('OWID life exp'))).toBe(true);
  });

  it('sub-agent llm() calls draw from the SAME per-turn llm budget as the main loop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.worldbank.org'))
          return { ok: true, json: async () => [{ page: 1 }, [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }]] };
        throw new Error('unexpected ' + url);
      })
    );

    // Main turn: seed rows, then two execute_js runs spending 6 of the 8 llm()
    // calls (4 + 2 — the per-run cap is 4, so a single 6-call run would trip it;
    // this exercises the shared PER-TURN budget instead).
    const runCode = (n: number) => `for (let i = 0; i < ${n}; i++) { await llm("m" + i, rows[0]); } return ${n};`;
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('execute_js', { code: runCode(4) }, 'ejA'),
        tc('execute_js', { code: runCode(2) }, 'ejB'),
      ])
    );
    for (let i = 0; i < 6; i++) mockComplete.mockResolvedValueOnce(llmReply('l' + i));
    // Main delegates to World Bank; the sub-agent's execute_js tries 4 more
    // llm() calls but only 2 fit (6 + 2 = 8), the 3rd/4th reject per-turn.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'World Bank', question: 'more' }, 'd1')]));
    const subCode =
      'let ok = 0; let caught = ""; for (let i = 0; i < 4; i++) { try { await llm("s" + i, rows[0]); ok++; } catch (e) { caught = e.message; } } return { ok, caught };';
    mockComplete.mockResolvedValueOnce(modelTurn([tc('execute_js', { code: subCode }, 'sej')]));
    for (let i = 0; i < 2; i++) mockComplete.mockResolvedValueOnce(llmReply('sl' + i));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'sub done' }, 'r1')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));

    const { cb, trace } = capture();
    await newSession(['worldbank', 'owid'], true).ask('q', cb);

    // 6 main + 2 sub = exactly the 8-per-turn cap of llm() receipts.
    expect(trace().filter((e) => e.tool === 'llm').length).toBe(8);
    // The sub-agent's 3rd/4th calls rejected with the PER-TURN error, proving a
    // shared budget (a fresh per-run budget would have allowed 4).
    const subEjResult = (() => {
      for (const call of mockComplete.mock.calls) {
        const msgs = call[1] as any[];
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs)
          if (m.role === 'tool' && m.name === 'execute_js' && m.tool_call_id === 'sej') return JSON.parse(m.content);
      }
      return null;
    })();
    expect(subEjResult?.ok).toBe(2);
    expect(subEjResult?.caught).toMatch(/per turn/);
  });

  it('a sub-agent whose model call fails yields an error receipt; the main loop continues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'owid', question: 'q' }, 'd1')]));
    // The sub-agent's first model call rejects.
    mockComplete.mockRejectedValueOnce(new Error('provider exploded'));
    // A later parent turn proves the loop continued past the failed delegation.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'Recovered.' }, 'fe')]));

    const { cb, trace } = capture();
    const out = await newSession(['owid', 'imf']).ask('q', cb);

    const ev = trace().find((e) => e.tool === 'delegate_source');
    expect(ev?.status).toBe('error');
    expect(ev?.detail).toBe('error');
    const res = toolMsgs('delegate_source');
    expect(res[0]).toContain('failed');
    expect(res[0]).toContain('provider exploded');
    // Never a crash, never fabricated filler — the loop reached a real finish.
    expect(out.finding).toBe('Recovered.');
  });
});

// ── Fuzzy country resolution wired into the fetch tools ───────────────────────
// A driven turn where the model requests a loose country code ("UK"). The
// dispatch must resolve it to the WB ISO3 ("GBR") before the fetch, hit the API
// with the resolved code, and surface the rewrite on the trace receipt.
describe('country resolution in fetch dispatch (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });

  it('resolves "UK" → GBR before the fetch and shows it on the receipt', async () => {
    // Capture the URL fetch() was called with, and return a minimal WB payload.
    let fetchedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchedUrl = String(url);
        return {
          ok: true,
          json: async () => [
            { page: 1, pages: 1 },
            [{ country: { value: 'United Kingdom' }, countryiso3code: 'GBR', date: '2020', value: 80 }],
          ],
        };
      })
    );

    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'SP.DYN.LE00.IN', country_ids: ['UK'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('render_chart', { type: 'line', title: 'LE', series: [{ name: 'GBR', data: [[2020, 80]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'done' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce(verifyPass());

    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const out = await createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] })
      .ask('life expectancy in the UK', cb);

    // The API was hit with the RESOLVED code, not the raw "UK".
    expect(fetchedUrl).toContain('/country/GBR/');
    expect(fetchedUrl).not.toContain('/country/UK/');

    // The trace receipt for the fetch surfaces the resolution.
    const fetchEv = last.find((e) => e.tool === 'fetch_worldbank');
    expect(fetchEv?.detail).toContain('UK → GBR (United Kingdom)');

    // The model's tool result also carries the resolution note.
    const wbMsg = (() => {
      for (const call of mockComplete.mock.calls) {
        const msgs = call[1] as any[];
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === 'wf') return m.content as string;
      }
      return '';
    })();
    expect(wbMsg).toContain('UK → GBR (United Kingdom)');

    // Rows still merged normally.
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].iso3).toBe('GBR');
  });
});

// ── fetch_series router + session cache (backlog #7 + #9) ─────────────────────
// Driven turns through createSession with complete() mocked and fetch() stubbed
// (egress is blocked in this environment — live routing against the real APIs is
// NOT testable, so every fetch here is a stub; the stub's URL and call count are
// what prove routing and caching). No network, no live model.
describe('fetch_series router + session cache (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });

  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };

  // A fetch stub that records every URL and answers WB / OWID / IMF shapes.
  const recordingFetch = () => {
    const urls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('api.worldbank.org'))
        return { ok: true, json: async () => [{ page: 1, pages: 1 }, [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }]] };
      if (u.includes('ourworldindata.org'))
        return { ok: true, text: async () => 'Entity,Code,Year,Life\nIndia,IND,2020,69\n' };
      if (u.includes('imf.org'))
        return { ok: true, json: async () => ({ values: { NGDP_RPCH: { IND: { '2020': 5 } } } }) };
      if (u.includes('ghoapi.azureedge.net'))
        return { ok: true, json: async () => ({ value: [{ SpatialDim: 'IND', TimeDim: 2020, NumericValue: 70 }] }) };
      throw new Error('unexpected url ' + u);
    });
    return { fn, urls };
  };

  // The tool-result string the model saw for a given tool_call_id.
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };

  it('routes an id to its source by namespace (World Bank / OWID / IMF)', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'wb'),
        tc('fetch_series', { id: 'owid:life-expectancy', countries: ['IND'] }, 'ow'),
        tc('fetch_series', { id: 'imf:NGDP_RPCH', countries: ['IND'] }, 'im'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb } = capture();
    const out = await newSession().ask('q', cb);

    // Each id reached the correct host, carrying its resolved country.
    expect(urls.some((u) => u.includes('api.worldbank.org') && u.includes('/country/IND/') && u.includes('SH.DYN.MORT'))).toBe(true);
    expect(urls.some((u) => u.includes('ourworldindata.org/grapher/life-expectancy.csv'))).toBe(true);
    expect(urls.some((u) => u.includes('imf.org') && u.includes('NGDP_RPCH'))).toBe(true);
    // Rows merged with each source's citation intact.
    const inds = new Set(out.rows.map((r) => r.indicator));
    expect(inds.has('SH.DYN.MORT')).toBe(true);
    expect(inds.has('owid:life-expectancy')).toBe(true);
    expect(inds.has('imf:NGDP_RPCH')).toBe(true);
  });

  it('round-trips a newly-curated OWID slug: find_series id fetches via the OWID branch', async () => {
    // A catalog hit's id must be fetchable by the existing OWID fetcher. Take a
    // slug added in this increment, confirm search surfaces it, then fetch that
    // exact id and confirm it reaches the grapher CSV endpoint for that slug.
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    // recordingFetch answers OWID URLs with CSV (no .json), so the live-catalog
    // fallback throws → curated hits stand; the new slug must be among them.
    const hits = await findSeries('temperature anomaly', ['owid']);
    const id = hits.find((h) => h.id === 'owid:temperature-anomaly')!.id;
    expect(id).toBe('owid:temperature-anomaly');

    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id, countries: ['IND'], year_start: 2020, year_end: 2020 }, 'ta'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['owid']).ask('q', cb);
    expect(urls.some((u) => u.includes('ourworldindata.org/grapher/temperature-anomaly.csv'))).toBe(true);
    expect(new Set(out.rows.map((r) => r.indicator)).has('owid:temperature-anomaly')).toBe(true);
  });

  it('round-trips a curated WHO indicator: find_series id fetches via the WHO branch', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    // recordingFetch answers the live GHO /Indicator catalog fetch too (it 200s
    // with a single unrelated row and no matching code), so the live fallback
    // contributes nothing here and the curated hit must stand.
    const hits = await findSeries('healthy life expectancy', ['who']);
    const id = hits.find((h) => h.id === 'who:WHOSIS_000015')!.id;
    expect(id).toBe('who:WHOSIS_000015');

    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id, countries: ['IND'], year_start: 2015, year_end: 2020 }, 'wh'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['who']).ask('q', cb);
    expect(urls.some((u) => u.includes('ghoapi.azureedge.net/api/WHOSIS_000015'))).toBe(true);
    expect(new Set(out.rows.map((r) => r.indicator)).has('who:WHOSIS_000015')).toBe(true);
    // Citation: correct source/label, links to the stable GHO portal, keeps the
    // exact OData request URL, and invents NO vintage (GHO provides none).
    const c = out.citations.find((x) => x.indicatorId === 'who:WHOSIS_000015')!;
    expect(c.source).toBe('who');
    expect(c.sourceLabel).toBe('WHO Global Health Observatory');
    expect(c.url).toBe('https://www.who.int/data/gho');
    expect(c.requestUrl).toContain('ghoapi.azureedge.net/api/WHOSIS_000015');
    expect('sourceUpdated' in c).toBe(false);
  });

  it('a WHO id is refused in a session where WHO is not active (out-of-source guard)', async () => {
    const { fn } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'who:WHOSIS_000001', countries: ['IND'] }, 'no'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);
    expect(toolMsgById('no')).toMatch(/who series, not available/);
    expect(out.rows.length).toBe(0);
  });

  it('an unrecognized namespace is a clear routing error, not a crash or a stray fetch', async () => {
    const { fn } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'foo:bar', countries: ['IND'] }, 'bad'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    expect(toolMsgById('bad')).toMatch(/not recognized/);
    expect(fn).not.toHaveBeenCalled(); // refused before any network call
    expect(out.rows.length).toBe(0);
    const ev = trace().find((e) => e.tool === 'fetch_series');
    expect(ev?.status).toBe('ok'); // a clean refusal, not an error receipt
    expect(ev?.detail).toBe('unknown source');
  });

  it('a legacy per-source tool name (fetch_imf) still dispatches through the router', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_imf', { dataset_id: 'imf:NGDP_RPCH', country_ids: ['IND'] }, 'lg'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb } = capture();
    const out = await newSession().ask('q', cb);

    expect(urls.some((u) => u.includes('imf.org') && u.includes('NGDP_RPCH'))).toBe(true);
    expect(out.rows.some((r) => r.indicator === 'imf:NGDP_RPCH')).toBe(true);
  });

  it('resolves a loose country ("UK" → GBR) through the router and shows it on the receipt', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['UK'], year_start: 2020, year_end: 2020 }, 'f'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb, trace } = capture();
    await newSession(['worldbank']).ask('q', cb);

    expect(urls.some((u) => u.includes('/country/GBR/'))).toBe(true);
    expect(urls.some((u) => u.includes('/country/UK/'))).toBe(false);
    expect(toolMsgById('f')).toContain('UK → GBR (United Kingdom)');
    const ev = trace().find((e) => e.tool === 'fetch_series');
    expect(ev?.detail).toContain('UK → GBR (United Kingdom)');
  });

  it('refuses an out-of-source id inside a source-scoped sub-agent (runtime hard filter)', async () => {
    const { fn } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'owid', question: 'q' }, 'd1')]));
    // The OWID sub-agent reaches for a World Bank id — outside its one source.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'sf')])
    );
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'nothing usable' }, 'r')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));

    const { cb, trace } = capture();
    const out = await newSession(['worldbank', 'owid']).ask('q', cb);

    const msg = toolMsgById('sf');
    expect(msg).toMatch(/not available/);
    expect(msg).toContain('SH.DYN.MORT');
    // Refused before any network call — a World Bank fetch never happened.
    expect(fn.mock.calls.some((c) => String(c[0]).includes('api.worldbank.org'))).toBe(false);
    const ev = trace().find((e) => e.nested && e.tool === 'fetch_series');
    expect(ev?.detail).toBe('refused: out-of-source id');
    expect(out.finding).toBe('done');
  });

  it('serves a repeat identical fetch from the session cache — no second network call, receipt says cached', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    // Two IDENTICAL fetch_series calls in the same session.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'a'),
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'b'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);

    // Exactly one real World Bank fetch; the second was served from cache.
    expect(urls.filter((u) => u.includes('api.worldbank.org')).length).toBe(1);
    expect(toolMsgById('a')).not.toContain('cached');
    expect(toolMsgById('b')).toContain('cached');
    // Rows are NOT doubled — the cache hit does not re-append.
    expect(out.rows.length).toBe(1);
    const evs = trace().filter((e) => e.tool === 'fetch_series');
    expect(evs.length).toBe(2);
    expect(evs[1].detail?.startsWith('cached')).toBe(true);
  });

  it('keys the cache on countries and range — a different country or range really re-fetches', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'a'),
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['CHN'], year_start: 2020, year_end: 2020 }, 'b'), // diff country
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2000, year_end: 2000 }, 'c'), // diff range
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb } = capture();
    await newSession().ask('q', cb);

    // Three distinct keys → three real World Bank fetches, none cached.
    expect(urls.filter((u) => u.includes('api.worldbank.org')).length).toBe(3);
    for (const id of ['a', 'b', 'c']) expect(toolMsgById(id)).not.toContain('cached');
  });

  it('a sub-agent fetch populates the shared cache; the main loop then hits it', async () => {
    const { fn, urls } = recordingFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'World Bank', question: 'le' }, 'd1')]));
    // Sub-agent fetches the series, then returns.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'sf')])
    );
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'sub done' }, 'r')]));
    // Main loop asks for the SAME series/countries/range → must hit the cache.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'mf'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb } = capture();
    const out = await newSession(['worldbank', 'owid']).ask('q', cb);

    // Exactly one real fetch total — the sub-agent's; the main loop's was cached.
    expect(urls.filter((u) => u.includes('api.worldbank.org')).length).toBe(1);
    expect(toolMsgById('mf')).toContain('cached');
    // The sub-agent appended once; the cache hit did not re-append.
    expect(out.rows.length).toBe(1);
    expect(out.rows[0].indicator).toBe('SP.DYN.LE00.IN');
  });
});

// ── VFS as citation ledger (backlog #11) ─────────────────────────────────────
// Every number traceable: each live fetch writes a structured citation record
// into state (surfaced as out.citations) AND mirrors the whole ledger into the
// VFS as citations.json (via:'fetch'). Egress is blocked here, so live source
// headers (the real World Bank `lastupdated`) are NOT verifiable — every fetch
// below is a STUB. The WB `lastupdated` vintage is proven with a stubbed header
// standing in for the real one; that substitution is called out honestly.
describe('citation ledger (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);

  // Capture BOTH the trace and the latest VFS files snapshot (so citations.json
  // — written through the real VFS onChange path — can be read back and parsed).
  const capture = () => {
    let trace: any[] = [];
    let files: Record<string, string> = {};
    const cb = {
      onTrace: (ev: any[]) => (trace = ev),
      onFiles: (f: Record<string, string>) => (files = f),
      onChart: () => {},
      onStatus: () => {},
    };
    return { cb, trace: () => trace, files: () => files };
  };

  // A WB stub whose response header carries `lastupdated` — a stand-in for the
  // real World Bank vintage field (egress is blocked; the live header can't be
  // reached). Records every URL it is called with.
  const wbFetchWithVintage = (lastupdated?: string) => {
    const urls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => [
          { page: 1, pages: 1, ...(lastupdated ? { lastupdated } : {}) },
          [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 42 }],
        ],
      };
    });
    return { fn, urls };
  };

  it('records a ledger entry on a successful fetch with the resolved country, URL, row count and fetched-at', async () => {
    const { fn } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        // "UK" must be resolved to GBR before it lands in the citation.
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['UK'], year_start: 2019, year_end: 2020 }, 'f'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );

    const { cb } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);

    expect(out.citations.length).toBe(1);
    const c = out.citations[0];
    expect(c.source).toBe('worldbank');
    expect(c.sourceLabel).toBe('World Bank Open Data');
    expect(c.indicatorId).toBe('SP.DYN.LE00.IN');
    // Resolved country code, not the raw "UK".
    expect(c.countries).toEqual(['GBR']);
    expect(c.yearRange).toEqual({ start: 2019, end: 2020 });
    expect(c.rowCount).toBe(1);
    // Human-visitable page is what renders; the API URL is kept separately.
    expect(c.url).toBe('https://data.worldbank.org/indicator/SP.DYN.LE00.IN');
    expect(c.requestUrl).toContain('api.worldbank.org');
    // fetchedAt is a real ISO timestamp; the record is not marked cached.
    expect(() => new Date(c.fetchedAt).toISOString()).not.toThrow();
    expect(c.fetchedAt).toBe(new Date(c.fetchedAt).toISOString());
    expect(c.cached).toBe(false);
  });

  it('captures sourceUpdated from a WB-style lastupdated header, and omits it when absent', async () => {
    // With vintage.
    {
      const { fn } = wbFetchWithVintage('2024-12-16');
      vi.stubGlobal('fetch', fn);
      mockComplete.mockResolvedValueOnce(
        modelTurn([
          tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
          tc('finish_explanation', { explanation: 'done' }, 'fe'),
        ])
      );
      const { cb } = capture();
      const out = await newSession(['worldbank']).ask('q', cb);
      expect(out.citations[0].sourceUpdated).toBe('2024-12-16');
    }
    mockComplete.mockReset();
    vi.unstubAllGlobals();
    // Without vintage — the field is OMITTED, never invented.
    {
      const { fn } = wbFetchWithVintage(undefined);
      vi.stubGlobal('fetch', fn);
      mockComplete.mockResolvedValueOnce(
        modelTurn([
          tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
          tc('finish_explanation', { explanation: 'done' }, 'fe'),
        ])
      );
      const { cb } = capture();
      const out = await newSession(['worldbank']).ask('q', cb);
      expect('sourceUpdated' in out.citations[0]).toBe(false);
    }
  });

  it('a cache hit does NOT duplicate the ledger entry — same citation, cited once', async () => {
    const { fn, urls } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'a'),
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'b'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);
    // One real network call, and exactly ONE ledger entry.
    expect(urls.length).toBe(1);
    expect(out.citations.length).toBe(1);
  });

  it('sub-agent fetches land in the SAME ledger as the main loop', async () => {
    const { fn } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'World Bank', question: 'le' }, 'd1')]));
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'sf')])
    );
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'sub done' }, 'r')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));

    const { cb } = capture();
    const out = await newSession(['worldbank', 'owid']).ask('q', cb);
    // The sub-agent's fetch produced the citation in the shared session ledger.
    expect(out.citations.length).toBe(1);
    expect(out.citations[0].indicatorId).toBe('SP.DYN.LE00.IN');
  });

  it('model-derived (via:llm) files never appear in the citation ledger', async () => {
    const { fn } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
        // A model-derived artifact — must be marked via:'llm' in the VFS and must
        // NOT enter the citation ledger.
        tc('write_file', { path: 'themes.json', content: '["rising"]', derived: true }, 'w'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb, files } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);
    // Exactly one citation — the fetch — and nothing referencing the derived file.
    expect(out.citations.length).toBe(1);
    expect(out.citations.some((c) => c.indicatorId === 'themes.json')).toBe(false);
    // The derived file exists in the VFS alongside the fetched ledger.
    expect(files()['themes.json']).toBe('["rising"]');
    expect(files()['citations.json']).toBeTruthy();
  });

  it('mirrors the ledger into a readable, well-formed citations.json (via:fetch)', async () => {
    const { fn } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
        // Read the ledger back through the model's own file tool.
        tc('read_file', { path: 'citations.json' }, 'rf'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb, files } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);

    const raw = files()['citations.json'];
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].indicatorId).toBe('SP.DYN.LE00.IN');
    expect(parsed[0].url).toBe('https://data.worldbank.org/indicator/SP.DYN.LE00.IN');
    expect(parsed[0].sourceUpdated).toBe('2024-12-16');
    // The whole ledger matches out.citations exactly.
    expect(parsed).toEqual(out.citations);
  });

  it('CSV export carries the provenance lines at the top', async () => {
    const { fn } = wbFetchWithVintage('2024-12-16');
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SP.DYN.LE00.IN', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
        tc('render_chart', { type: 'line', title: 'LE', series: [{ name: 'IND', data: [[2020, 42]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'done' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });

    const { cb } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);
    // Provenance rides at the top as `#` comment lines, above the data header.
    expect(out.csv).toContain('# Source: World Bank Open Data');
    expect(out.csv).toContain('SP.DYN.LE00.IN');
    expect(out.csv).toContain('source updated 2024-12-16');
    const headerIdx = out.csv.indexOf('country,iso3,year,value');
    expect(headerIdx).toBeGreaterThan(0);
    // Every provenance line precedes the CSV data header.
    expect(out.csv.slice(0, headerIdx).split('\n').filter((l) => l.startsWith('# Source:')).length).toBe(1);
  });

  it('records OWID / IMF citations too, without inventing a vintage they do not provide', async () => {
    const urls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('ourworldindata.org'))
        return { ok: true, text: async () => 'Entity,Code,Year,Life\nIndia,IND,2020,69\n' };
      if (u.includes('imf.org'))
        return { ok: true, json: async () => ({ values: { NGDP_RPCH: { IND: { '2020': 5 } } } }) };
      throw new Error('unexpected ' + u);
    });
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'owid:life-expectancy', countries: ['IND'] }, 'ow'),
        tc('fetch_series', { id: 'imf:NGDP_RPCH', countries: ['IND'] }, 'im'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['owid', 'imf']).ask('q', cb);
    const byId = Object.fromEntries(out.citations.map((c) => [c.indicatorId, c]));
    expect(byId['owid:life-expectancy'].url).toBe('https://ourworldindata.org/grapher/life-expectancy');
    expect('sourceUpdated' in byId['owid:life-expectancy']).toBe(false);
    expect(byId['imf:NGDP_RPCH'].url).toBe('https://www.imf.org/external/datamapper/NGDP_RPCH');
    expect('sourceUpdated' in byId['imf:NGDP_RPCH']).toBe(false);
  });
});

// ── The RLM (judgment-call) flag: off by default ──────────────────────────
// Ported and adapted from main's off-by-default gating (commit 73f554e). The
// branch's llm() plumbing lives INLINE in agent.ts (not a separate rlm.ts) and
// is gated in the SYSTEM PROMPT rather than the execute_js tool-schema where
// main put it — so the prompt assertions target buildSystemPrompt /
// buildSubAgentPrompt. The product semantics are identical to main's: the
// capability ships OFF, the user opts in, and "off" is enforced by
// WITHHOLDING (the model is never told llm() exists), for the main loop AND
// for delegation sub-agents.
describe('rlm flag: the system prompt withholds llm() when off', () => {
  const sources = resolveSources(['worldbank', 'owid']);

  it('omits every llm() mention by default (flag off)', () => {
    const p = buildSystemPrompt(sources);
    expect(p).not.toContain('llm(');
    expect(p).not.toMatch(/model-derived/i);
    // The base guidance the code always gets is still there and reads cleanly.
    expect(p).toContain('execute_js → anything else');
  });

  it('omits it when explicitly off, identical to omitting the flag', () => {
    expect(buildSystemPrompt(sources, false)).toBe(buildSystemPrompt(sources));
  });

  it('includes the bounded llm() guidance and the provenance rule when on', () => {
    const p = buildSystemPrompt(sources, true);
    expect(p).toContain('await llm(');
    expect(p).toContain('model-derived');
    expect(p).toContain('4 llm() calls per execute_js run'); // MAX_LLM_PER_RUN
    expect(p).toContain('8 per turn'); // MAX_LLM_PER_TURN
  });

  it('sub-agent prompts inherit the same toggle', () => {
    expect(buildSubAgentPrompt(sources[0])).not.toContain('llm(');
    expect(buildSubAgentPrompt(sources[0], false)).not.toContain('llm(');
    expect(buildSubAgentPrompt(sources[0], true)).toContain('await llm(');
  });
});

describe('rlm flag: the llm() primitive in the execute_js sandbox', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  const cfg = { provider: 'openrouter' as const, model: 'test-model', apiKey: 'x' };

  beforeEach(() => {
    mockComplete.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { page: 1, pages: 1, total: 1 },
          [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }],
        ],
      }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const fetchCall = (id = 'wf') =>
    tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, id);
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
  // The probe reports whether llm() ran or refused, so the assertion is
  // behavioural — a check on what the sandbox binding actually did, not on a
  // symbol that always exists.
  const PROBE =
    'try { const r = await llm("classify", rows[0]); return "CALLED:" + r; } ' +
    'catch (e) { return "REFUSED:" + e.message; }';

  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (e: any[]) => (last = e), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  const execResultFor = (id: string) => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs)
        if (m.role === 'tool' && m.name === 'execute_js' && m.tool_call_id === id) {
          try {
            return JSON.parse(m.content);
          } catch {
            return m.content;
          }
        }
    }
    return null;
  };

  it('off by default: llm() is withheld in the sandbox and no nested call is billed', async () => {
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code: PROBE }, 'ej')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());
    const { cb, trace } = capture();
    await createSession(cfg).ask('probe', cb);

    const res = execResultFor('ej');
    expect(String(res)).toContain('REFUSED');
    expect(String(res)).toContain('not available');
    // No nested 'llm' trace event, and exactly three completions (turn, finish,
    // verify) — the nested call never happened.
    expect(trace().some((e) => e.tool === 'llm')).toBe(false);
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('rlm: false behaves identically to omitting the option', async () => {
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code: PROBE }, 'ej')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());
    const { cb } = capture();
    await createSession(cfg, { rlm: false }).ask('probe', cb);
    expect(String(execResultFor('ej'))).toContain('REFUSED');
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('on: llm() runs, emits one nested receipt, and the nested call carries no tools (depth-1)', async () => {
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall(), tc('execute_js', { code: PROBE }, 'ej')]));
    // The nested llm() completion, issued from inside execute_js (stubbed).
    mockComplete.mockResolvedValueOnce({ text: 'coastal', toolCalls: [], usage: { input: 3, output: 1 } });
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish', { one_line_finding: 'Done.' }, 'fin')]));
    mockComplete.mockResolvedValueOnce(verifyPass());
    const { cb, trace } = capture();
    await createSession(cfg, { rlm: true }).ask('probe', cb);

    expect(execResultFor('ej')).toBe('CALLED:coastal');
    const nested = trace().filter((e) => e.tool === 'llm');
    expect(nested.length).toBe(1);
    expect(nested[0].nested).toBe(true);
    // Four completions: the nested one actually happened. It is issued with an
    // EMPTY tool array (depth-1 by construction — the inner model cannot
    // recurse). The nested call is completion index 1.
    expect(mockComplete.mock.calls.length).toBe(4);
    expect(mockComplete.mock.calls[1][2]).toEqual([]);
  });

  it('a delegation sub-agent inherits the off toggle: its execute_js llm() is withheld too', async () => {
    // Two sources so delegate_source exists; rlm off (the default).
    mockComplete.mockResolvedValueOnce(modelTurn([tc('delegate_source', { source: 'World Bank', question: 'probe' }, 'd1')]));
    // Sub-agent: fetch (seeds shared rows), execute_js probe, return_findings.
    mockComplete.mockResolvedValueOnce(modelTurn([fetchCall('wf'), tc('execute_js', { code: PROBE }, 'sej')]));
    mockComplete.mockResolvedValueOnce(modelTurn([tc('return_findings', { summary: 'done' }, 'rf')]));
    // Main finishes with an explanation (no chart, so no verifier turn).
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));
    const { cb, trace } = capture();
    await createSession(cfg, { sources: ['worldbank', 'owid'] }).ask('q', cb);

    const subRes = execResultFor('sej');
    expect(String(subRes)).toContain('REFUSED');
    expect(String(subRes)).toContain('not available');
    // The sub-agent likewise issued no nested llm() call.
    expect(trace().some((e) => e.tool === 'llm')).toBe(false);
  });

  // ── Cost attribution (ported from main's "price against the served model").
  // Non-RLM correctness that must survive the merge: OpenRouter's free-fallback
  // chain can serve a different model than cfg.model, so pricing must read
  // res.servedModel. A :free model prices at zero, so a zero total is the proof.
  it('prices the nested llm() call against the model that served it, not cfg.model', async () => {
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [fetchCall(), tc('execute_js', { code: 'const r = await llm("classify", rows); return r;' }, 'ej')],
      usage: { input: 0, output: 0 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'coastal',
      toolCalls: [],
      usage: { input: 1_000_000, output: 1_000_000 },
      servedModel: 'some/model:free',
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish_explanation', { explanation: 'Done.' }, 'fe')],
      usage: { input: 0, output: 0 },
    });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const out = await createSession(cfg, { rlm: true }).ask('judge', cb);
    expect(out.cost).toBe(0);
  });

  it('prices main-loop turns against the model that actually served them', async () => {
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish_explanation', { explanation: 'Done.' }, 'fe')],
      usage: { input: 1_000_000, output: 1_000_000 },
      servedModel: 'some/model:free',
    });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const out = await createSession(cfg).ask('explain something', cb);
    expect(out.cost).toBe(0);
  });
});
