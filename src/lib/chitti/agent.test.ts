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
  parseWorldBankError,
  fetchWho,
  fetchWorldbank,
  worldbankDateParam,
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

// ── World Bank error-body parser (router-validation increment) ─────────────
// Egress is blocked here, so the REAL World Bank rejection can't be reproduced;
// these stubbed error-body shapes ARE the contract the parser is written to.
// The reported live message ("The provided parameter value is not valid") is
// included verbatim as the primary row.
describe('parseWorldBankError — WB JSON error envelope', () => {
  it('parses the reported "provided parameter value is not valid" shape', () => {
    const body = [
      { message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] },
    ];
    const r = parseWorldBankError(body);
    expect(r).not.toBeNull();
    expect(r!.message).toBe('The provided parameter value is not valid');
    expect(r!.invalidParameter).toBe(true);
  });

  it('treats an "Invalid value" key as an invalid-parameter rejection even without the value text', () => {
    const r = parseWorldBankError([{ message: [{ id: '120', key: 'Invalid value' }] }]);
    expect(r).not.toBeNull();
    expect(r!.invalidParameter).toBe(true);
    expect(r!.message).toBe('Invalid value');
  });

  it('surfaces a non-parameter WB message without the invalid-parameter flag', () => {
    const r = parseWorldBankError([{ message: [{ id: '175', key: 'API', value: 'Something else went wrong' }] }]);
    expect(r).not.toBeNull();
    expect(r!.message).toBe('Something else went wrong');
    expect(r!.invalidParameter).toBe(false);
  });

  it('returns null for a normal (non-error) WB response and for junk', () => {
    // A real data response: [header, [rows...]] — not an error envelope.
    expect(parseWorldBankError([{ page: 1, pages: 1 }, [{ value: 1 }]])).toBeNull();
    // Empty / malformed bodies.
    expect(parseWorldBankError([])).toBeNull();
    expect(parseWorldBankError(null)).toBeNull();
    expect(parseWorldBankError([{ message: [] }])).toBeNull();
    expect(parseWorldBankError([{ message: [{}] }])).toBeNull();
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

describe('worldbankDateParam — open/closed year ranges never leak NaN/undefined', () => {
  const YEAR = new Date().getFullYear();
  it('both bounds → date=YS:YE', () => {
    expect(worldbankDateParam(2000, 2010)).toBe('&date=2000:2010');
  });
  it('only a start ("since 1990") → date=YS:<current year>', () => {
    expect(worldbankDateParam(1990, undefined)).toBe(`&date=1990:${YEAR}`);
  });
  it('only an end → date=1960:YE', () => {
    expect(worldbankDateParam(undefined, 2010)).toBe('&date=1960:2010');
  });
  it('neither → the date param is omitted entirely', () => {
    expect(worldbankDateParam(undefined, undefined)).toBe('');
  });
  it('a same-year single range is left as-is', () => {
    expect(worldbankDateParam(2020, 2020)).toBe('&date=2020:2020');
  });
  it('NaN bounds (the live bug: Number(undefined)) are treated as ABSENT, never "NaN"', () => {
    // The exact pathology that broke the live app: a bare Number(undefined).
    expect(worldbankDateParam(1990, Number(undefined))).toBe(`&date=1990:${YEAR}`);
    expect(worldbankDateParam(Number(undefined), Number(undefined))).toBe('');
    // Nothing the builder emits ever contains these poison strings.
    for (const out of [
      worldbankDateParam(1990, Number(undefined)),
      worldbankDateParam(Number(undefined), 2010),
      worldbankDateParam(Number(undefined), Number(undefined)),
    ]) {
      expect(out).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('fetchWorldbank — built URL for open ranges + "since 1990" live-bug repro', () => {
  afterEach(() => vi.unstubAllGlobals());
  const YEAR = new Date().getFullYear();
  // A minimal well-formed World Bank JSON body: [header, rows].
  const wbOk = (rows: unknown[] = []) => ({
    ok: true,
    status: 200,
    json: async () => [{ lastupdated: '2024-12-16' }, rows],
  });

  it('year_start only ("since 1990") → date=1990:<current year> and the fetch SUCCEEDS (no rejection)', async () => {
    // This is the exact live sequence: the model passed year_start (1990) with
    // no year_end. Before the fix this built `date=1990:NaN`, which the World
    // Bank rejected with "The provided parameter value is not valid".
    let seen = '';
    const wbRows = [
      { country: { value: 'India' }, countryiso3code: 'IND', date: '1990', value: 100 },
      { country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 200 },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen = String(url);
      return wbOk(wbRows);
    }));
    const r = await fetchWorldbank('NY.GDP.PCAP.CD', ['IND'], 1990, undefined);
    expect(seen).toContain(`&date=1990:${YEAR}`);
    expect(seen).not.toMatch(/NaN|undefined/); // the poison strings never reach the URL
    expect(r.requestUrl).toBe(seen);
    // The stubbed WB answered normally — the success path, not a rejection.
    expect(r.rows.length).toBe(2);
    expect(r.sourceUpdated).toBe('2024-12-16');
  });

  it('both bounds → date=YS:YE', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen = String(url); return wbOk(); }));
    await fetchWorldbank('X', ['USA'], 2000, 2010);
    expect(seen).toContain('&date=2000:2010');
  });

  it('year_end only → date=1960:YE', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen = String(url); return wbOk(); }));
    await fetchWorldbank('X', ['USA'], undefined, 2010);
    expect(seen).toContain('&date=1960:2010');
  });

  it('no bounds → no date param at all', async () => {
    let seen = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen = String(url); return wbOk(); }));
    await fetchWorldbank('X', ['USA']);
    expect(seen).not.toContain('date=');
    expect(seen).not.toMatch(/NaN|undefined/);
  });
});

describe('worldbank adapter — empty countries + exact indicator code', () => {
  afterEach(() => vi.unstubAllGlobals());
  const wbOk = (rows: unknown[] = []) => ({
    ok: true,
    status: 200,
    json: async () => [{ lastupdated: '2024-12-16' }, rows],
  });
  const wb = SOURCES.find((s) => s.id === 'worldbank')!;

  it('treats an empty countries array as "all countries" (no malformed /country// URL)', async () => {
    // Before the fix `[]` took the specific-country path and built
    // `.../country//indicator/<id>` (double slash), which WB does not read as
    // "all" — every other source already treats [] as every-country.
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(String(url)); return wbOk(); }));
    await wb.fetchSeries('NY.GDP.PCAP.CD', [], undefined, undefined);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => !u.includes('country//'))).toBe(true);
    // The every-country path batches real ISO3 codes into the country segment.
    expect(urls[0]).toMatch(/country\/[A-Z]{3}/);
  });

  it('resolves an exact WB indicator code to THAT series, not a fuzzy token match', async () => {
    // Querying the bare code NY.GDP.PCAP.KD (constant GDP/cap — not curated)
    // used to short-circuit on ≥3 fuzzy token matches (ny/gdp/kd) and return
    // "GDP growth (annual %)". Now the exact code is resolved and, re-ranked by
    // scoreSeries, floats to the top.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/indicator/NY.GDP.PCAP.KD')) {
        return { ok: true, status: 200, json: async () => [{ page: 1 }, [{ id: 'NY.GDP.PCAP.KD', name: 'GDP per capita (constant 2015 US$)' }]] };
      }
      return { ok: false, status: 404, json: async () => [] };
    }));
    const hits = await findSeries('NY.GDP.PCAP.KD', ['worldbank']);
    expect(hits[0].id).toBe('NY.GDP.PCAP.KD');
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

import { complete, ClassifiedError } from './providers';
import {
  createSession,
  buildSystemPrompt,
  buildSubAgentPrompt,
  parseVerifierVerdict,
  normalizeSpec,
  salvageToolCall,
  resolveFetchArgs,
  needsPlan,
  countCountryMentions,
  parsePlanBrief,
  matchStepToEvent,
  buildRejectionSteer,
  defaultDashboardTitle,
  resolveTileRef,
  refreshTile,
  refreshDashboard,
  type PlanStep,
} from './agent';
import {
  listDashboards,
  loadDashboard,
  createDashboard,
  addTile,
  makeTile,
  saveDashboard,
  type StorageLike,
  type Dashboard,
  type Tile,
} from './dashboard';
import type { ChartSpec, Citation } from './tools';

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

// ── Router validation: country drops, id guard, API-rejection steers ─────────
// The reported symptom: an invalid indicator id / unresolvable country reached
// the World Bank API and the failure surfaced raw instead of triggering
// recovery. Egress is blocked here, so the REAL WB rejection can't be
// reproduced — every fetch is a STUB, and the stubbed WB error-body shape (the
// reported "provided parameter value is not valid" envelope) IS the contract.
describe('router validation + recovery (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };
  // ask() trims long tool-result messages to a marker at the END of a turn (so
  // the post-hoc mock.calls read shows the marker, not the steer). To assert on
  // the FULL tool text a steer handed the model, snapshot each tool message when
  // complete() actually receives it — before end-of-turn trimming. `turns` is
  // the queue of model responses; a follow-up turn is what triggers the
  // complete() call that observes the previous turn's (untrimmed) tool result.
  const driveCapture = (turns: any[]) => {
    const seen: Record<string, string> = {};
    let i = 0;
    mockComplete.mockImplementation(async (_c: any, msgs: any[]) => {
      if (Array.isArray(msgs)) for (const m of msgs) if (m.role === 'tool') seen[m.tool_call_id] = m.content;
      return turns[i++] ?? verifyPass();
    });
    return seen;
  };
  // WB fetch stub: an indicator id containing "BADIND" returns the WB error
  // envelope (HTTP 200 + [{message:[…]}]); everything else returns one India row.
  // Also answers the live WB indicator-search fallback harmlessly.
  const wbFetch = () => {
    const urls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/indicator?')) return { ok: true, json: async () => [{ page: 1 }, []] };
      if (u.includes('BADIND'))
        return {
          ok: true,
          json: async () => [
            { message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] },
          ],
        };
      if (u.includes('api.worldbank.org'))
        return { ok: true, json: async () => [{ page: 1, pages: 1 }, [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }]] };
      if (u.includes('ourworldindata.org'))
        return { ok: true, text: async () => 'Entity,Code,Year,V\nIndia,IND,2020,7\n' };
      throw new Error('unexpected url ' + u);
    });
    return { fn, urls };
  };

  it('DROPS an unresolvable country, fetches only what resolved, and discloses it', async () => {
    const { fn, urls } = wbFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND', 'Scandinavia'], year_start: 2020, year_end: 2020 }, 'f'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb, trace } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);

    // The junk token never reached the API; only the resolved country did.
    expect(urls.some((u) => u.includes('/country/IND/'))).toBe(true);
    expect(urls.some((u) => u.toLowerCase().includes('scandinavia'))).toBe(false);
    // Disclosed in the model's tool result AND on the receipt.
    expect(toolMsgById('f')).toContain('Could not resolve "Scandinavia"');
    const ev = trace().find((e) => e.tool === 'fetch_series');
    expect(ev?.detail).toContain('dropped Scandinavia');
    expect(out.rows.length).toBe(1);
  });

  it('NOTHING resolves → tool error with no API call at all', async () => {
    const { fn, urls } = wbFetch();
    vi.stubGlobal('fetch', fn);
    // Two turns: the bad fetch, then a finish — the finish's complete() call is
    // what observes the (untrimmed) tool result the steer produced.
    const seen = driveCapture([
      modelTurn([tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['Scandinavia'], year_start: 2020, year_end: 2020 }, 'f')]),
      modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]),
    ]);
    const { cb, trace } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);

    // No World Bank data call happened — junk never left the router.
    expect(urls.some((u) => u.includes('/country/'))).toBe(false);
    expect(seen['f']).toMatch(/none of the requested countries could be resolved/);
    expect(out.rows.length).toBe(0);
    const ev = trace().find((e) => e.tool === 'fetch_series');
    expect(ev?.detail).toBe('no countries resolved');
  });

  it('nothing-resolves error carries nearest suggestions when the resolver has any', async () => {
    const { fn } = wbFetch();
    vi.stubGlobal('fetch', fn);
    // "Germ" does not resolve to a country but is close to "Germany" — a suggestion.
    const seen = driveCapture([
      modelTurn([tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['Germ'], year_start: 2020, year_end: 2020 }, 'f')]),
      modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]),
    ]);
    const { cb } = capture();
    await newSession(['worldbank']).ask('q', cb);
    expect(seen['f']).toContain('Did you mean');
    expect(seen['f']).toContain('Germany');
  });

  it('curated-source unknown id → steer to find_series, no fetch', async () => {
    const { fn, urls } = wbFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'owid:totally-made-up-slug', countries: ['IND'] }, 'f'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession(['owid']).ask('q', cb);
    expect(urls.some((u) => u.includes('ourworldindata.org'))).toBe(false);
    expect(toolMsgById('f')).toMatch(/unknown OWID slug/);
    expect(toolMsgById('f')).toMatch(/find_series/);
    expect(out.rows.length).toBe(0);
  });

  it('unknown WORLD BANK id → proceeds (huge id space) but the receipt is marked "unverified id"', async () => {
    const { fn, urls } = wbFetch();
    vi.stubGlobal('fetch', fn);
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'XX.MADE.UP', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'f'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb, trace } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);
    // It DID fetch (WB ids beyond our catalog are legitimate)…
    expect(urls.some((u) => u.includes('XX.MADE.UP'))).toBe(true);
    // …but the receipt flags it as unverified.
    const ev = trace().find((e) => e.tool === 'fetch_series');
    expect(ev?.detail).toContain('unverified id');
    expect(out.rows.length).toBe(1);
  });

  it('driven recovery: bad WB fetch → API-rejection steer → find_series → good fetch → answer', async () => {
    const { fn } = wbFetch();
    vi.stubGlobal('fetch', fn);
    // Turn 1: model fetches a bad (unverified) WB id → API rejects → steer.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_series', { id: 'BADIND', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'bad')])
    );
    // Turn 2: model recovers by searching.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('find_series', { query: 'child mortality' }, 'fs')]));
    // Turn 3: model fetches a real id, charts, finishes.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_series', { id: 'SH.DYN.MORT', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'good'),
        tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'IND', data: [[2020, 100]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'recovered.' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    const out = await newSession(['worldbank']).ask('q', cb);

    // The bad fetch's tool result steered to find_series (recoverable, not raw).
    expect(toolMsgById('bad')).toMatch(/World Bank rejected/);
    expect(toolMsgById('bad')).toMatch(/find_series/);
    // The receipts, in order: fetch(error) → find_series → fetch(ok) → chart → finish.
    const seq = trace()
      .filter((e) => ['fetch_series', 'find_series', 'render_chart', 'finish'].includes(e.tool))
      .map((e) => `${e.tool}:${e.status}`);
    expect(seq).toEqual([
      'fetch_series:error',
      'find_series:ok',
      'fetch_series:ok',
      'render_chart:ok',
      'finish:ok',
    ]);
    expect(out.finding).toBe('recovered.');
    expect(out.rows.length).toBe(1);
  });

  it('caps identical rejected fetches: a second rejection of the same id says STOP retrying', async () => {
    const { fn } = wbFetch();
    vi.stubGlobal('fetch', fn);
    const seen = driveCapture([
      modelTurn([
        tc('fetch_series', { id: 'BADIND', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'a'),
        tc('fetch_series', { id: 'BADIND', countries: ['IND'], year_start: 2020, year_end: 2020 }, 'b'),
      ]),
      modelTurn([tc('finish_explanation', { explanation: 'gave up' }, 'fe')]),
    ]);
    const { cb, trace } = capture();
    await newSession(['worldbank']).ask('q', cb);

    // First rejection: a gentle "don't retry"; second identical rejection: hard STOP.
    expect(seen['a']).not.toMatch(/AGAIN/);
    expect(seen['a']).toMatch(/find_series/);
    expect(seen['b']).toMatch(/AGAIN/);
    expect(seen['b']).toMatch(/STOP retrying/);
    // The escalation is also honest on the receipts (both error, second says stop).
    const evs = trace().filter((e) => e.tool === 'fetch_series');
    expect(evs.map((e) => e.status)).toEqual(['error', 'error']);
    expect(evs[0].detail).toBe('API rejected id (unverified id)');
    expect(evs[1].detail).toBe('rejected again — stop retrying (unverified id)');
  });
});

// buildRejectionSteer — the pure steer builder behind the driven recovery above.
describe('buildRejectionSteer', () => {
  it('names the source + id and steers to find_series on the first rejection', () => {
    const s = buildRejectionSteer('worldbank', 'BAD.ID', 1);
    expect(s).toMatch(/World Bank rejected World Bank indicator "BAD.ID"/);
    expect(s).toMatch(/find_series/);
    expect(s).not.toMatch(/AGAIN/);
  });
  it('escalates to a hard STOP on a repeat rejection of the same id', () => {
    const s = buildRejectionSteer('owid', 'owid:x', 2);
    expect(s).toMatch(/AGAIN/);
    expect(s).toMatch(/STOP retrying/);
  });
  it('uses source-appropriate labels', () => {
    expect(buildRejectionSteer('imf', 'imf:X', 1)).toMatch(/IMF code/);
    expect(buildRejectionSteer('who', 'who:X', 1)).toMatch(/WHO IndicatorCode/);
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

// ── Classified-error inheritance (backlog #17) ─────────────────────────────
// complete() now throws a ClassifiedError whose .message is the user-actionable
// line. Every caller surfaces err.message, so verify()'s 'unavailable' report
// and the nested llm()'s catchable error must both carry the SPECIFIC reason —
// no special-cased raw errors left. complete() is mocked here (the classifier
// itself is unit-tested in providers.test.ts); these prove the propagation.
describe('classified error inheritance through agent paths', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  const cfg = { provider: 'openrouter' as const, model: 'test-model', apiKey: 'x' };
  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });

  beforeEach(() => {
    mockComplete.mockReset();
    // Minimal World Bank response so fetch_worldbank seeds state.rows (execute_js
    // refuses to run without rows).
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

  it("verify() provider error → 'unavailable' verdict carrying the classified reason", async () => {
    // A chart turn, then the verify complete() rejects with a ClassifiedError.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'A finding.' }, 'fin'),
      ],
      usage: { input: 10, output: 5 },
    });
    const classified = new ClassifiedError({
      errorClass: 'rate_limit',
      provider: 'openrouter',
      message: 'OpenRouter is rate limiting requests — try again shortly.',
      retryable: true,
      fallbackEligible: true,
    });
    mockComplete.mockRejectedValueOnce(classified);

    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const out = await createSession(cfg).ask('q', cb);

    expect(out.verification!.status).toBe('unavailable');
    expect(out.verification!.pass).toBe(false); // never defaulted to verified
    // The 'unavailable' report names the SPECIFIC provider reason, not a generic one.
    expect(out.verification!.report).toContain('rate limiting');
  });

  it('a nested llm() provider error is catchable in user code with the classified message', async () => {
    // Model turn: fetch (seeds rows) + execute_js whose code catches llm().
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('execute_js', { code: 'try { await llm("classify", rows); return "no-throw"; } catch (e) { return "caught:" + e.message; }' }, 'ej'),
      ],
      usage: { input: 10, output: 5 },
    });
    // The nested llm() completion rejects with a classified provider error.
    mockComplete.mockRejectedValueOnce(
      new ClassifiedError({
        errorClass: 'insufficient_credits',
        provider: 'openrouter',
        message: 'OpenRouter reports insufficient credits — add credits or switch to a free model.',
        retryable: false,
        fallbackEligible: true,
      })
    );
    // Finish with an explanation so no verifier turn is needed.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [tc('finish_explanation', { explanation: 'done' }, 'fe')],
      usage: { input: 5, output: 2 },
    });

    let lastTrace: any[] = [];
    const cb = { onTrace: (ev: any[]) => (lastTrace = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await createSession(cfg, { rlm: true }).ask('q', cb);

    // The execute_js result the model saw is the caught message — carrying the
    // specific classified reason, wrapped by makeLlm's "llm() failed:" prefix.
    const ejResult = mockComplete.mock.calls
      .flatMap((c) => (Array.isArray(c[1]) ? c[1] : []))
      .find((m: any) => m.role === 'tool' && m.name === 'execute_js');
    expect(ejResult).toBeDefined();
    expect(String(ejResult.content)).toContain('caught:');
    expect(String(ejResult.content)).toContain('insufficient credits');
    // And the nested llm receipt recorded the failure with the same reason.
    const llmEv = lastTrace.find((e) => e.tool === 'llm');
    expect(llmEv?.status).toBe('error');
    expect(String(llmEv?.detail)).toContain('insufficient credits');
  });
});

// ── normalizeSpec: defensive chart-spec guarding (backlog #16) ─────────────
// The model occasionally returns a malformed chart spec (a string type, a
// non-array series, string-numeric or non-numeric points). normalizeSpec must
// coerce every shape into a valid ChartSpec and NEVER throw — a bad spec should
// degrade to a safe default, not crash the render_chart dispatch. Pure and
// exported, so these are direct unit tests.
describe('normalizeSpec — defensive chart-spec guarding', () => {
  it('defaults an unknown/missing type to "line", keeps the four valid types', () => {
    expect(normalizeSpec({ series: [] }).type).toBe('line'); // missing
    expect(normalizeSpec({ type: 'pie', series: [] }).type).toBe('line'); // unsupported
    expect(normalizeSpec({ type: 123, series: [] }).type).toBe('line'); // non-string
    for (const t of ['line', 'bar', 'scatter', 'grouped-bar']) {
      expect(normalizeSpec({ type: t, series: [] }).type).toBe(t);
    }
  });

  it('never throws on a non-object raw — null / string / number all yield a safe default', () => {
    for (const raw of [null, undefined, 'hello', 42, true, []]) {
      const spec = normalizeSpec(raw);
      expect(spec.type).toBe('line');
      expect(spec.title).toBe('Chart');
      expect(spec.series).toEqual([]);
    }
  });

  it('defaults a missing title to "Chart" and a nameless series to "series"', () => {
    expect(normalizeSpec({ series: [] }).title).toBe('Chart');
    expect(normalizeSpec({ title: 'GDP', series: [] }).title).toBe('GDP');
    const s = normalizeSpec({ series: [{ data: [[2000, 1]] }] });
    expect(s.series[0].name).toBe('series');
  });

  it('coerces a non-array series to an empty array (no throw)', () => {
    expect(normalizeSpec({ type: 'bar', series: 'nope' }).series).toEqual([]);
    expect(normalizeSpec({ type: 'bar', series: 42 }).series).toEqual([]);
    expect(normalizeSpec({ type: 'bar' }).series).toEqual([]);
  });

  it('coerces string-numeric x to a number but keeps a category (non-numeric) x as-is', () => {
    // A time value the model sent as a string is coerced to a real number.
    expect(normalizeSpec({ series: [{ name: 'A', data: [['2020', '5']] }] }).series[0].data).toEqual([[2020, 5]]);
    // A bar-chart category label stays a string x.
    expect(normalizeSpec({ series: [{ name: 'A', data: [['France', 5]] }] }).series[0].data).toEqual([['France', 5]]);
  });

  it('drops a point whose y is non-numeric, and one shorter than [x, y]', () => {
    // NaN y dropped; the good point survives.
    expect(normalizeSpec({ series: [{ name: 'A', data: [[2000, 'abc'], [2001, 5]] }] }).series[0].data).toEqual([[2001, 5]]);
    // A length-1 point (missing y) dropped.
    expect(normalizeSpec({ series: [{ name: 'A', data: [[2000], [2001, 5]] }] }).series[0].data).toEqual([[2001, 5]]);
    // A non-array point is dropped entirely.
    expect(normalizeSpec({ series: [{ name: 'A', data: ['x', [2000, 1]] }] }).series[0].data).toEqual([[2000, 1]]);
    // data itself not an array → empty.
    expect(normalizeSpec({ series: [{ name: 'A', data: 'nope' }] }).series[0].data).toEqual([]);
  });

  it('drops a gap point (null/empty/boolean y) instead of plotting a false zero', () => {
    // Number(null) === 0, Number('') === 0, Number(false) === 0 all sail past an
    // isNaN guard — a missing y must become a gap, not a crash-to-zero line.
    expect(
      normalizeSpec({ series: [{ name: 'GDP', data: [[2020, 100], [2021, null], [2022, 120]] }] }).series[0].data
    ).toEqual([[2020, 100], [2022, 120]]);
    expect(
      normalizeSpec({ series: [{ name: 'A', data: [[2020, ''], [2021, 5]] }] }).series[0].data
    ).toEqual([[2021, 5]]);
    expect(
      normalizeSpec({ series: [{ name: 'A', data: [[2020, false], [2021, 5]] }] }).series[0].data
    ).toEqual([[2021, 5]]);
    // A genuine zero is still a real value and must be kept.
    expect(
      normalizeSpec({ series: [{ name: 'A', data: [[2020, 0], [2021, 5]] }] }).series[0].data
    ).toEqual([[2020, 0], [2021, 5]]);
  });

  it('passes x_axis/y_axis through when present and omits them when blank/absent', () => {
    const withAxes = normalizeSpec({ title: 'T', x_axis: 'Year', y_axis: 'GDP', series: [] });
    expect(withAxes.x_axis).toBe('Year');
    expect(withAxes.y_axis).toBe('GDP');
    const noAxes = normalizeSpec({ series: [] });
    expect(noAxes.x_axis).toBeUndefined();
    expect(noAxes.y_axis).toBeUndefined();
    // An empty-string axis label is treated as absent (falsy → undefined).
    expect(normalizeSpec({ x_axis: '', series: [] }).x_axis).toBeUndefined();
  });

  it('keeps absurd but numeric year values verbatim (no range validation — documents the contract)', () => {
    const spec = normalizeSpec({ series: [{ name: 'A', data: [[999999, 1], [-5000, 2]] }] });
    expect(spec.series[0].data).toEqual([[999999, 1], [-5000, 2]]);
  });

  it('does NOT dedupe duplicate series names (documents current behavior)', () => {
    const spec = normalizeSpec({ series: [{ name: 'X', data: [[2000, 1]] }, { name: 'X', data: [[2001, 2]] }] });
    expect(spec.series.map((s) => s.name)).toEqual(['X', 'X']);
  });

  it('turns junk series elements into empty named series rather than crashing', () => {
    const spec = normalizeSpec({ series: [null, 'foo', 42, { name: 'ok', data: [[2000, 1]] }] });
    expect(spec.series).toHaveLength(4);
    expect(spec.series[3]).toEqual({ name: 'ok', data: [[2000, 1]] });
    expect(spec.series.slice(0, 3).every((s) => s.name === 'series' && s.data.length === 0)).toBe(true);
  });
});

// ── salvageToolCall: recover a tool call a model wrote as JSON text ─────────
// Some models (observed: OpenRouter NVIDIA free models) print the tool call as
// JSON in content instead of emitting a native tool_call. salvageToolCall pulls
// it back so the tool runs instead of the raw JSON leaking into the answer.
describe('salvageToolCall — recover a text-embedded tool call', () => {
  const valid = new Set(['find_series', 'fetch_series', 'render_chart', 'finish']);

  it('recovers the live failure: {"tool":"fetch_data",...} → fetch_series', () => {
    const text = '{"tool": "fetch_data", "arguments": {"indicator": "NY.GDP.PCAP.CD", "countries": ["IND"], "start_year": 2000, "end_year": 2024}}';
    const tc = salvageToolCall(text, valid);
    expect(tc?.name).toBe('fetch_series');
    expect(tc?.arguments).toEqual({ indicator: 'NY.GDP.PCAP.CD', countries: ['IND'], start_year: 2000, end_year: 2024 });
  });

  it('accepts a valid name verbatim and tolerates surrounding prose/fences', () => {
    const tc = salvageToolCall('Sure, let me do that:\n```json\n{"tool":"find_series","arguments":{"query":"gdp"}}\n```', valid);
    expect(tc?.name).toBe('find_series');
    expect(tc?.arguments).toEqual({ query: 'gdp' });
  });

  it('reads the OpenAI {"function":{"name","arguments"}} shape with string arguments', () => {
    const tc = salvageToolCall('{"function":{"name":"fetch_series","arguments":"{\\"id\\":\\"SP.POP.TOTL\\"}"}}', valid);
    expect(tc?.name).toBe('fetch_series');
    expect(tc?.arguments).toEqual({ id: 'SP.POP.TOTL' });
  });

  it('accepts the {name, args} spelling and defaults missing arguments to {}', () => {
    const tc = salvageToolCall('{"name":"finish","args":null}', valid);
    expect(tc?.name).toBe('finish');
    expect(tc?.arguments).toEqual({});
  });

  it('returns null for genuine prose, an unknown tool, or a non-tool JSON object', () => {
    expect(salvageToolCall('I could not find that series, sorry.', valid)).toBeNull();
    expect(salvageToolCall('{"tool":"delete_everything","arguments":{}}', valid)).toBeNull();
    expect(salvageToolCall('{"insight":"gdp rose","confidence":"high"}', valid)).toBeNull();
  });
});

// ── resolveFetchArgs: accept the fetch argument-key synonyms models emit ────
// The schema is id/countries/year_start/year_end, but weak models key the
// series as `indicator`/`series`/`code` and the range as `start_year`/`end_year`
// — leaving `id` undefined, routing an empty id into World Bank, and looping on
// "API rejected id". resolveFetchArgs maps the synonyms so the call runs.
describe('resolveFetchArgs — fetch argument-key synonyms', () => {
  it('canonical keys pass straight through', () => {
    expect(resolveFetchArgs({ id: 'NY.GDP.PCAP.CD', countries: ['IND'], year_start: 2000, year_end: 2024 }))
      .toEqual({ id: 'NY.GDP.PCAP.CD', countries: ['IND'], ys: 2000, ye: 2024 });
  });

  it('recovers the live failure: {indicator, countries, start_year, end_year}', () => {
    expect(resolveFetchArgs({ indicator: 'NY.GDP.PCAP.CD', countries: ['IND'], start_year: 2000, end_year: 2024 }))
      .toEqual({ id: 'NY.GDP.PCAP.CD', countries: ['IND'], ys: 2000, ye: 2024 });
  });

  it('accepts indicator_id / series / code / slug for the id, and from/to for the range', () => {
    expect(resolveFetchArgs({ series: 'owid:co2', from: 1990, to: 2020 }).id).toBe('owid:co2');
    expect(resolveFetchArgs({ code: 'imf:NGDP_RPCH' }).id).toBe('imf:NGDP_RPCH');
    expect(resolveFetchArgs({ slug: 'life-expectancy' }).id).toBe('life-expectancy');
    const r = resolveFetchArgs({ id: 'X', from: 1990, to: 2020 });
    expect([r.ys, r.ye]).toEqual([1990, 2020]);
  });

  it('wraps a single country string into an array; accepts country/country_ids/iso3', () => {
    expect(resolveFetchArgs({ id: 'X', country: 'IND' }).countries).toEqual(['IND']);
    expect(resolveFetchArgs({ id: 'X', country_ids: ['USA', 'CHN'] }).countries).toEqual(['USA', 'CHN']);
    expect(resolveFetchArgs({ id: 'X', iso3: ['GBR'] }).countries).toEqual(['GBR']);
    // No country key at all → undefined ("all countries").
    expect(resolveFetchArgs({ id: 'X' }).countries).toBeUndefined();
  });

  it('yields an empty id when no id-like key is present (so routeFetch can steer, not loop)', () => {
    expect(resolveFetchArgs({ countries: ['IND'] }).id).toBe('');
    expect(resolveFetchArgs({}).id).toBe('');
  });
});

// ── executeJs: error, serialization and mutation edges (backlog #16) ───────
// executeJs runs model-written JS over the fetched rows. It must (1) catch every
// failure — syntax errors, non-serializable returns — into a clean {ok:false}
// rather than throwing, and (2) round-trip the result through JSON so only plain
// data reaches the model. These are pure, offline unit tests.
describe('executeJs — error and serialization edges', () => {
  const rows: DataRow[] = [
    { country: 'India', iso3: 'IND', year: 2020, value: 100 },
    { country: 'India', iso3: 'IND', year: 2021, value: 110 },
  ];

  it('a syntax error becomes ok:false with a readable message (never throws)', async () => {
    const out = await executeJs('return (((;', rows);
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
    expect(out.error!.length).toBeGreaterThan(0);
  });

  it('a runtime throw in the code is caught into ok:false', async () => {
    const out = await executeJs('throw new Error("kaboom"); return 1;', rows);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('kaboom');
  });

  it('a non-serializable return (function) is rejected as ok:false, not surfaced as a value', async () => {
    const out = await executeJs('return () => 1;', rows);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('valid JSON');
  });

  it('a BigInt return is rejected as ok:false (JSON cannot serialize it)', async () => {
    const out = await executeJs('return 5n;', rows);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('BigInt');
  });

  it('a circular structure is rejected as ok:false rather than hanging or throwing uncaught', async () => {
    const out = await executeJs('const o = {}; o.self = o; return o;', rows);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('circular');
  });

  it('NaN and Infinity results serialize to null (JSON semantics — documents the contract)', async () => {
    expect(await executeJs('return NaN;', rows)).toEqual({ ok: true, result: null });
    expect(await executeJs('return Infinity;', rows)).toEqual({ ok: true, result: null });
  });

  it('code with no return yields ok:true with a null result (the "add a return" nudge case)', async () => {
    const out = await executeJs('const x = 1 + 1;', rows);
    expect(out).toEqual({ ok: true, result: null });
  });

  it('a Date result is serialized to its ISO string, not left as a live object', async () => {
    const out = await executeJs('return new Date(0);', rows);
    expect(out).toEqual({ ok: true, result: '1970-01-01T00:00:00.000Z' });
  });
});

// ── dispatch edges, driven through createSession (backlog #16) ─────────────
// A tool call the model can plausibly emit that exercises a rarely-hit dispatch
// branch: an unknown tool name, a read of a missing VFS file, a whitespace
// search, code that errors. Every one must return a tool result to the model
// and let the loop continue — never crash the turn.
describe('dispatch edges (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };
  const wbStub = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 1 },
        [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }],
      ],
    }));

  it('an unknown tool name returns "unknown tool" to the model and the loop continues', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('teleport', { x: 1 }, 'u1'), tc('finish_explanation', { explanation: 'recovered' }, 'fe')])
    );
    const { cb } = capture();
    const out = await newSession().ask('q', cb);
    expect(toolMsgById('u1')).toBe('unknown tool');
    expect(out.finding).toBe('recovered');
  });

  it('read_file of a missing path returns "(empty)", not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('read_file', { path: 'does-not-exist.json' }, 'r1'), tc('finish_explanation', { explanation: 'done' }, 'fe')])
    );
    const { cb } = capture();
    await newSession().ask('q', cb);
    expect(toolMsgById('r1')).toBe('(empty)');
  });

  it('write_file then read_file round-trips the content through the VFS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('write_file', { path: 'note.md', content: 'hello world' }, 'w1'),
        tc('read_file', { path: 'note.md' }, 'r1'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const { cb } = capture();
    await newSession().ask('q', cb);
    expect(toolMsgById('w1')).toBe('written');
    expect(toolMsgById('r1')).toBe('hello world');
  });

  it('find_series with a whitespace-only query returns the no-match message (score 0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('find_series', { query: '   ' }, 's1'), tc('finish_explanation', { explanation: 'done' }, 'fe')])
    );
    const { cb, trace } = capture();
    await newSession(['owid']).ask('q', cb);
    expect(toolMsgById('s1')).toMatch(/No matching series/);
    const ev = trace().find((e) => e.tool === 'find_series');
    expect(ev?.detail).toBe('0 hits');
  });

  it('an execute_js syntax error surfaces as an ERROR tool result + error receipt; the loop continues', async () => {
    vi.stubGlobal('fetch', wbStub());
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('execute_js', { code: 'return (((;' }, 'ej'),
        tc('finish_explanation', { explanation: 'recovered' }, 'fe'),
      ])
    );
    const { cb, trace } = capture();
    const out = await newSession().ask('q', cb);
    expect(toolMsgById('ej')).toMatch(/^ERROR: /);
    const ev = trace().find((e) => e.tool === 'execute_js');
    expect(ev?.status).toBe('ok'); // dispatch caught it into a normal tool result
    expect(ev?.detail).toMatch(/^error:/);
    expect(out.finding).toBe('recovered');
  });

  it('execute_js returning a non-serializable value surfaces as an ERROR result, not a crash', async () => {
    vi.stubGlobal('fetch', wbStub());
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('execute_js', { code: 'return () => rows;' }, 'ej'),
        tc('finish_explanation', { explanation: 'recovered' }, 'fe'),
      ])
    );
    const { cb } = capture();
    const out = await newSession().ask('q', cb);
    expect(toolMsgById('ej')).toMatch(/^ERROR: /);
    expect(out.finding).toBe('recovered');
  });

  it('execute_js before any fetch short-circuits with the empty-dataset guard (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('execute_js', { code: 'return rows.length;' }, 'ej'), tc('finish_explanation', { explanation: 'done' }, 'fe')])
    );
    const { cb, trace } = capture();
    await newSession().ask('q', cb);
    expect(toolMsgById('ej')).toMatch(/no rows fetched yet/);
    expect(trace().find((e) => e.tool === 'execute_js')?.detail).toBe('no data');
  });

  it('render_chart called twice in one turn keeps the LAST spec', async () => {
    vi.stubGlobal('fetch', wbStub());
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('render_chart', { type: 'line', title: 'First', series: [{ name: 'A', data: [[2020, 1]] }] }, 'rc1'),
        tc('render_chart', { type: 'bar', title: 'Second', series: [{ name: 'B', data: [[2020, 2]] }] }, 'rc2'),
        tc('finish', { one_line_finding: 'done' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce(verifyPass());
    let charts: any[] = [];
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: (s: any) => charts.push(s), onStatus: () => {} };
    const out = await newSession().ask('q', cb);
    // Both render calls fired onChart, but the returned/persisted spec is the last.
    expect(charts.length).toBe(2);
    expect(out.chartSpec?.title).toBe('Second');
    expect(out.chartSpec?.type).toBe('bar');
  });
});

// ── ask() loop & multi-turn state (backlog #16) ────────────────────────────
// The loop's control-flow edges: the tool-call budget cap, a model that never
// calls a tool, and what carries over vs resets between ask() calls on one
// session. Driven through createSession with complete() mocked.
describe('ask() loop & multi-turn state (driven)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const noTools = (text = '') => ({ text, toolCalls: [], usage: { input: 3, output: 2 } });
  const verifyJsonPass = () => ({ text: '{"pass": true, "confidence": "high", "issues": []}', toolCalls: [], usage: { input: 2, output: 1 } });
  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);
  const cb = () => ({ onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} });
  const userMsgs = (callIndex: number): string[] => {
    const msgs = mockComplete.mock.calls[callIndex]?.[1] as any[];
    return (Array.isArray(msgs) ? msgs : []).filter((m) => m.role === 'user').map((m) => m.content as string);
  };
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };
  const wbStub = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 1 },
        [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }],
      ],
    }));

  it('exhausting the tool-call budget without finish falls back to a one-sentence summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // 12 non-finishing tool calls in one assistant turn → the loop hits
    // MAX_TOOL_CALLS (12) with no state.finding, and runs the summariser.
    const calls = Array.from({ length: 12 }, (_, i) => tc('read_file', { path: `f${i}.txt` }, `rf${i}`));
    mockComplete.mockResolvedValueOnce(modelTurn(calls));
    // The budget summariser complete() call.
    mockComplete.mockResolvedValueOnce(noTools('India led with a 42% change.'));
    // turnKind stayed 'chart' (no finish/finish_explanation) so the verifier runs.
    mockComplete.mockResolvedValueOnce(verifyJsonPass());
    const out = await newSession().ask('q', cb());
    expect(out.finding).toBe('India led with a 42% change.');
    // Exactly three completions: the model turn, the summariser, the verifier.
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('a model that never calls a tool stops after the nudge (no infinite loop), and skips verify on the empty run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // Primary is a non-:free model, so no substitution: nudge, then give up.
    mockComplete.mockResolvedValueOnce(noTools('')); // no-op #1 → corrective nudge
    mockComplete.mockResolvedValueOnce(noTools('')); // no-op #2 → give up (not free → no substitute)
    const out = await newSession().ask('q', cb());
    expect(out.finding).toBe('');
    // Exactly 2 completions: the two loop turns. verify() is NEVER called on an
    // empty run (no answer, no chart, no rows) — no LLM spend, no verdict retry.
    expect(mockComplete.mock.calls.length).toBe(2);
    // The verdict reflects the distinct 'skipped' state, never could-not-verify.
    expect(out.verification).not.toBeNull();
    expect(out.verification!.status).toBe('skipped');
  });

  it('state.finding resets each turn — a no-answer turn 2 does NOT inherit turn 1\'s finding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const session = newSession();
    // Turn 1: a real explanation finding.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'First turn finding.' }, 'fe1')]));
    const first = await session.ask('q1', cb());
    expect(first.finding).toBe('First turn finding.');
    // Turn 2: model never answers (two no-ops → empty run, verify skipped). If
    // finding were not reset, out.finding would leak 'First turn finding.'.
    mockComplete.mockResolvedValueOnce(noTools(''));
    mockComplete.mockResolvedValueOnce(noTools(''));
    const second = await session.ask('q2', cb());
    expect(second.finding).toBe('');
    expect(second.verification!.status).toBe('skipped');
  });

  it('a follow-up turn after a fetch-less turn 1 gets the "fresh question" steer, not the rows=0 trap', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const session = newSession();
    // Turn 1: pure explanation, no data fetched.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'Concept explained.' }, 'fe1')]));
    await session.ask('what is gdp', cb());
    // Turn 2.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe2')]));
    await session.ask('now chart it', cb());
    const turn2Users = userMsgs(1).join('\n');
    expect(turn2Users).toMatch(/No data has been fetched yet/);
    expect(turn2Users).toMatch(/fresh question/);
    // The misleading "data already fetched (rows=0)" reuse addendum must NOT appear.
    expect(turn2Users).not.toMatch(/Data already fetched this conversation/);
  });

  it('a follow-up turn after a DATA turn gets the reuse addendum with the (a)/(b)/(c) options', async () => {
    vi.stubGlobal('fetch', wbStub());
    const session = newSession();
    // Turn 1: fetch + chart + finish.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2020, 100]] }] }, 'rc'),
        tc('finish', { one_line_finding: 'First.' }, 'fin'),
      ])
    );
    mockComplete.mockResolvedValueOnce(verifyJsonPass());
    await session.ask('chart it', cb());
    // Turn 2: model answers with prose.
    mockComplete.mockResolvedValueOnce(modelTurn([tc('finish_explanation', { explanation: 'done' }, 'fe')]));
    await session.ask('what does it mean', cb());
    // Turn 2 is completion index 2 (0=turn1, 1=verify, 2=turn2).
    const turn2Users = userMsgs(2).join('\n');
    expect(turn2Users).toMatch(/Data already fetched this conversation/);
    expect(turn2Users).toMatch(/\(a\)/);
    expect(turn2Users).toMatch(/\(c\)/);
  });

  it('state.rows persists across ask() calls — turn 2 computes on turn 1\'s rows without re-fetching', async () => {
    const fetchFn = wbStub();
    vi.stubGlobal('fetch', fetchFn);
    const session = newSession();
    // Turn 1: fetch one row, then finish (explanation, no verifier).
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
        tc('finish_explanation', { explanation: 'fetched' }, 'fe1'),
      ])
    );
    const first = await session.ask('fetch it', cb());
    expect(first.rows.length).toBe(1);
    const callsAfterTurn1 = fetchFn.mock.calls.length;
    // Turn 2: execute_js runs on the carried-over rows (would hit the
    // empty-dataset guard if state.rows had not persisted).
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('execute_js', { code: 'return rows.length;' }, 'ej'), tc('finish_explanation', { explanation: 'reused' }, 'fe2')])
    );
    await session.ask('how many rows', cb());
    expect(toolMsgById('ej')).toBe('1'); // saw the persisted row, not the empty guard
    // No new network fetch happened in turn 2.
    expect(fetchFn.mock.calls.length).toBe(callsAfterTurn1);
  });
});

// ── Corrective nudge + free-model fallback for the narrate-instead-of-act
// failure (the live Nemotron "let me check the available skills" run) ─────────
// A completion with NO tool calls and no usable answer is the model narrating a
// plan instead of acting. The executor injects ONE corrective nudge; if a :free
// primary still won't act, it substitutes ONE fallback model; only then does the
// run surface "no result". An empty run skips verify() entirely. Driven through
// createSession with complete() mocked.
describe('corrective nudge + fallback (driven through createSession)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const noTools = (text = '') => ({ text, toolCalls: [], usage: { input: 3, output: 2 } });
  const verifyJsonPass = () => ({ text: '{"pass": true, "confidence": "high", "issues": []}', toolCalls: [], usage: { input: 2, output: 1 } });
  const wbStub = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 1 },
        [{ country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 }],
      ],
    }));
  // A turn that fetches, charts, and finishes — a complete, non-empty run.
  const actTurn = () =>
    modelTurn([
      tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2020 }, 'wf'),
      tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2020, 100]] }] }, 'rc'),
      tc('finish', { one_line_finding: 'India: 100 in 2020.' }, 'fin'),
    ]);
  // A cb that keeps the latest full trace + any substituted model.
  const capturingCb = () => {
    const captured: { trace: any[]; models: string[] } = { trace: [], models: [] };
    return {
      captured,
      cb: {
        onTrace: (e: any[]) => { captured.trace = e; },
        onFiles: () => {},
        onChart: () => {},
        onStatus: () => {},
        onModel: (m: string) => captured.models.push(m),
      },
    };
  };
  const freeCfg = { provider: 'openrouter' as const, model: 'primary-model:free', apiKey: 'x' };
  const paidCfg = { provider: 'openrouter' as const, model: 'test-model', apiKey: 'x' };

  it('turn-1 no-op injects a corrective nudge receipt + system message before the next attempt', async () => {
    vi.stubGlobal('fetch', wbStub());
    const { captured, cb } = capturingCb();
    mockComplete.mockResolvedValueOnce(noTools('Let me find the relevant skill for fetching World Bank data…'));
    mockComplete.mockResolvedValueOnce(actTurn()); // acts after the nudge
    mockComplete.mockResolvedValueOnce(verifyJsonPass());
    const out = await createSession(paidCfg).ask('life expectancy by region', cb);
    // A muted nudge receipt (status ok, not error-red).
    const nudge = captured.trace.find((e) => e.tool === 'nudge');
    expect(nudge).toBeTruthy();
    expect(nudge.status).toBe('ok');
    expect(nudge.detail).toMatch(/narrated instead of acting/);
    // The corrective SYSTEM message is present in the SECOND request's messages.
    const secondMsgs = mockComplete.mock.calls[1][1] as any[];
    const corrective = secondMsgs.find(
      (m) => m.role === 'system' && /function TOOLS/.test(m.content) && /no "skills"/.test(m.content)
    );
    expect(corrective).toBeTruthy();
    expect(corrective.content).toMatch(/find_series/);
    // The nudge did its job: the turn completed normally.
    expect(out.finding).toBe('India: 100 in 2020.');
  });

  it('nudge-then-success completes normally with exactly one nudge (no blind re-nudging)', async () => {
    vi.stubGlobal('fetch', wbStub());
    const { captured, cb } = capturingCb();
    mockComplete.mockResolvedValueOnce(noTools('narrating a plan'));
    mockComplete.mockResolvedValueOnce(actTurn());
    mockComplete.mockResolvedValueOnce(verifyJsonPass());
    const out = await createSession(paidCfg).ask('q', cb);
    expect(out.finding).toBe('India: 100 in 2020.');
    expect(out.verification!.status).toBe('verified');
    // Exactly ONE nudge receipt this turn.
    expect(captured.trace.filter((e) => e.tool === 'nudge')).toHaveLength(1);
    // 3 completions: narration, act, verify.
    expect(mockComplete.mock.calls.length).toBe(3);
  });

  it('nudge fails on a :free primary → substitutes a fallback model, whose success completes the turn', async () => {
    vi.stubGlobal('fetch', wbStub());
    const { captured, cb } = capturingCb();
    mockComplete.mockResolvedValueOnce(noTools('narration #1')); // → nudge
    mockComplete.mockResolvedValueOnce(noTools('narration #2')); // post-nudge still nothing → substitute
    mockComplete.mockResolvedValueOnce(actTurn()); // the substitute model acts
    mockComplete.mockResolvedValueOnce(verifyJsonPass());
    const out = await createSession(freeCfg).ask('q', cb);
    // A visible substitution receipt naming the substitute model.
    const fb = captured.trace.find((e) => e.tool === 'fallback');
    expect(fb).toBeTruthy();
    expect(fb.detail).toMatch(/narrated instead of calling tools/);
    const substitute = fb.argSummary as string;
    expect(substitute).not.toBe(freeCfg.model);
    expect(captured.models).toContain(substitute);
    // The SECOND-model attempt (the 3rd completion) actually used the substitute.
    expect((mockComplete.mock.calls[2][0] as any).model).toBe(substitute);
    // Its success completed the turn.
    expect(out.finding).toBe('India: 100 in 2020.');
    expect(out.verification!.status).toBe('verified');
  });

  it('both the nudge AND the fallback fail → empty run: no verify call, skipped verdict, "no result" evidence', async () => {
    vi.stubGlobal('fetch', wbStub());
    const { captured, cb } = capturingCb();
    mockComplete.mockResolvedValueOnce(noTools('narration #1')); // → nudge
    mockComplete.mockResolvedValueOnce(noTools('narration #2')); // → substitute
    mockComplete.mockResolvedValueOnce(noTools('narration #3')); // substitute still nothing → give up
    const out = await createSession(freeCfg).ask('q', cb);
    // Both recovery attempts are visible in the trace (retry + fallback).
    expect(captured.trace.find((e) => e.tool === 'nudge')).toBeTruthy();
    expect(captured.trace.find((e) => e.tool === 'fallback')).toBeTruthy();
    // verify() was NEVER called: exactly the 3 loop completions, no 4th.
    expect(mockComplete.mock.calls.length).toBe(3);
    // A muted "nothing to verify" line, and a distinct 'skipped' verdict.
    const skip = captured.trace.find((e) => e.tool === 'verify' && e.verifyStatus === 'skipped');
    expect(skip).toBeTruthy();
    expect(skip.status).toBe('ok'); // muted, never error-red
    expect(skip.detail).toMatch(/nothing to verify/);
    expect(out.finding).toBe('');
    expect(out.verification!.status).toBe('skipped');
  });

  it('empty run on a non-:free primary skips verify after the nudge (no substitution attempted)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { captured, cb } = capturingCb();
    mockComplete.mockResolvedValueOnce(noTools('narration')); // → nudge
    mockComplete.mockResolvedValueOnce(noTools('narration')); // give up (not :free → no substitute)
    const out = await createSession(paidCfg).ask('q', cb);
    // Nudge yes, fallback NO (paid primary).
    expect(captured.trace.find((e) => e.tool === 'nudge')).toBeTruthy();
    expect(captured.trace.find((e) => e.tool === 'fallback')).toBeFalsy();
    // 2 completions only — verify skipped, no substitute.
    expect(mockComplete.mock.calls.length).toBe(2);
    expect(out.verification!.status).toBe('skipped');
  });
});

// ── dispatch robustness to malformed tool arguments (backlog #16 fix) ──────
// The provider's safeParse returns {} only on a THROWN JSON error; a model
// emitting arguments that parse to a bare `null`, an array, or a primitive
// yields a non-object that still satisfies the Record<> type. summarizeArgs
// runs before dispatch's try/catch, so a null argument used to dereference and
// reject the whole ask(). dispatch must coerce any non-object args to {} and
// return a clean tool error instead of crashing the turn.
describe('dispatch — malformed (non-object) tool arguments do not crash the turn', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const newSession = (sources?: string[]) =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, sources ? { sources } : undefined);
  const cb = () => ({ onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} });
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };

  it('a find_series call with null arguments dispatches (empty query) instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    // arguments===null is exactly what safeParse('null') produces.
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        { id: 'n1', name: 'find_series', arguments: null },
        { id: 'fe', name: 'finish_explanation', arguments: { explanation: 'recovered' } },
      ])
    );
    const out = await newSession(['owid']).ask('q', cb());
    // Coerced to {} → empty query → the no-match message, and the loop continued.
    expect(toolMsgById('n1')).toMatch(/No matching series/);
    expect(out.finding).toBe('recovered');
  });

  it('array / primitive arguments are coerced to {} across several tools (no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        { id: 'a1', name: 'read_file', arguments: [] }, // array
        { id: 'a2', name: 'write_file', arguments: 42 }, // primitive
        { id: 'a3', name: 'render_chart', arguments: null }, // null → default spec
        { id: 'fin', name: 'finish', arguments: { one_line_finding: 'survived' } },
      ])
    );
    mockComplete.mockResolvedValueOnce({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
    let chart: any = null;
    const out = await newSession().ask('q', {
      onTrace: () => {},
      onFiles: () => {},
      onChart: (s: any) => (chart = s),
      onStatus: () => {},
    });
    // read_file {} → path "undefined" missing → "(empty)"; nothing threw.
    expect(toolMsgById('a1')).toBe('(empty)');
    expect(toolMsgById('a2')).toBe('written');
    // render_chart with coerced-{} args → the safe default spec.
    expect(chart).not.toBeNull();
    expect(chart.type).toBe('line');
    expect(chart.series).toEqual([]);
    expect(out.finding).toBe('survived');
  });
});

// ── execute_js must not corrupt the canonical row set (backlog #16 fix) ────
// executeJs used to receive state.rows by reference, so model code doing an
// in-place mutation (rows.push to inject a fabricated row, rows.sort/reverse to
// reorder, rows[i].value = … to alter a fetched number) silently corrupted the
// session's source-of-truth dataset behind every chart, citation and CSV. The
// sandbox now runs on a per-row copy: the model's computation is unaffected but
// state.rows is protected.
describe('execute_js row-set isolation', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const modelTurn = (calls: unknown[]) => ({ text: '', toolCalls: calls, usage: { input: 10, output: 5 } });
  const cb = () => ({ onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} });
  const toolMsgById = (id: string): string => {
    for (const call of mockComplete.mock.calls) {
      const msgs = call[1] as any[];
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) if (m.role === 'tool' && m.tool_call_id === id) return m.content as string;
    }
    return '';
  };
  const wbTwoRows = () =>
    vi.fn(async () => ({
      ok: true,
      json: async () => [
        { page: 1, pages: 1, total: 2 },
        [
          { country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 100 },
          { country: { value: 'India' }, countryiso3code: 'IND', date: '2021', value: 110 },
        ],
      ],
    }));

  it('rows.push / value tamper inside execute_js do NOT reach state.rows (out.rows)', async () => {
    vi.stubGlobal('fetch', wbTwoRows());
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, 'wf'),
        // Mutate every way that matters: inject a fabricated row and tamper a value.
        tc('execute_js', { code: 'rows.push({ country: "FAKE", iso3: "XXX", year: 2099, value: 0 }); rows[0].value = 999; return rows.map(r => r.value);' }, 'ej'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] });
    const out = await session.ask('q', cb());

    // The model's own copy WAS mutable — its computation reflects the mutation
    // (two real rows → [100,110], value[0]→999, plus the appended FAKE's 0).
    expect(toolMsgById('ej')).toBe(JSON.stringify([999, 110, 0]));
    // But the canonical dataset is untouched: no fabricated row, no altered value.
    expect(out.rows.length).toBe(2);
    expect(out.rows.some((r) => r.iso3 === 'XXX')).toBe(false);
    expect(out.rows[0].value).toBe(100);
    expect(out.rows.map((r) => r.value)).toEqual([100, 110]);
  });

  it('an in-place rows.sort inside execute_js does NOT reorder state.rows', async () => {
    vi.stubGlobal('fetch', wbTwoRows());
    mockComplete.mockResolvedValueOnce(
      modelTurn([
        tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, 'wf'),
        // Array.prototype.sort mutates in place; a naive "sort by value desc"
        // would have permanently reordered the exported dataset.
        tc('execute_js', { code: 'return rows.sort((a, b) => b.value - a.value).map(r => r.year);' }, 'ej'),
        tc('finish_explanation', { explanation: 'done' }, 'fe'),
      ])
    );
    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] });
    const out = await session.ask('q', cb());
    // The model saw its sorted view (2021 first).
    expect(toolMsgById('ej')).toBe(JSON.stringify([2021, 2020]));
    // Canonical order preserved (fetch order: 2020 then 2021).
    expect(out.rows.map((r) => r.year)).toEqual([2020, 2021]);
  });
});

// ── Turn abort (the "stop" control) ────────────────────────────────────────
// The user can stop a running turn. ask() threads the caller's AbortSignal to
// every provider/data fetch and checks it at each tool-loop boundary. A stop
// resolves ask() with an HONEST aborted output (aborted:true) — never a
// rejection, never a provider error class. Partial rows/citations survive, no
// verifier runs, and the session stays reusable for the next question.
describe('turn abort (stop control)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockComplete.mockReset();
    // A minimal valid World Bank response so a fetch step yields real rows.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { page: 1, pages: 1, total: 2, lastupdated: '2024-01-01' },
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
  const verifyPass = () => ({ text: 'PASS: ok.', toolCalls: [], usage: { input: 2, output: 1 } });
  const cb = () => ({ onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} });
  const chartFinish = () =>
    modelTurn([
      tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] }, 'rc'),
      tc('finish', { one_line_finding: 'A finding.' }, 'fin'),
    ]);
  const newSession = () =>
    createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] });

  it('an already-aborted signal → resolves aborted before any model call, no verifier', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await newSession().ask('q', cb(), ctrl.signal);
    expect(out.aborted).toBe(true);
    expect(out.verification).toBeNull(); // no VERIFIED stamp on a stopped turn
    expect(out.confidence).toBe('low');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('abort while the first completion is in flight → aborted, not a provider error, no retry/verify', async () => {
    const ctrl = new AbortController();
    // The stop fires mid-request: the fetch rejects with a provider-style error,
    // but the signal is already aborted — ask() must map this to aborted, NOT
    // surface the provider error, and must NOT retry or verify.
    mockComplete.mockImplementationOnce(async () => {
      ctrl.abort();
      throw new Error('the provider request timed out');
    });
    const out = await newSession().ask('q', cb(), ctrl.signal);
    expect(out.aborted).toBe(true);
    expect(out.verification).toBeNull();
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('abort between tool-loop iterations → stops at the next boundary check', async () => {
    const ctrl = new AbortController();
    // A no-tool "thinking" reply that aborts as a side effect; the loop's next
    // boundary check must end the turn before another model call is made.
    mockComplete.mockImplementationOnce(async () => {
      ctrl.abort();
      return { text: 'thinking', toolCalls: [], usage: { input: 1, output: 1 } };
    });
    const out = await newSession().ask('q', cb(), ctrl.signal);
    expect(out.aborted).toBe(true);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('partial fetched rows and citations are preserved through an abort', async () => {
    const ctrl = new AbortController();
    // Turn 1: fetch real WB rows. Turn 2 (the next completion) aborts mid-flight.
    mockComplete.mockResolvedValueOnce(
      modelTurn([tc('fetch_worldbank', { indicator_id: 'X', country_ids: ['IND'], year_start: 2020, year_end: 2021 }, 'wf')])
    );
    mockComplete.mockImplementationOnce(async () => {
      ctrl.abort();
      throw new Error('stopped mid-fetch');
    });
    const out = await newSession().ask('q', cb(), ctrl.signal);
    expect(out.aborted).toBe(true);
    // The rows fetched before the stop are real data and ride out on the output.
    expect(out.rows.map((r) => r.year)).toEqual([2020, 2021]);
    expect(out.citations.length).toBeGreaterThan(0);
    // And the export still carries the provenance comment lines + data.
    expect(out.csv).toContain('2020');
  });

  it('the session is reusable after an abort → the next ask() completes and verifies', async () => {
    const session = newSession();
    const ctrl = new AbortController();
    ctrl.abort();
    const stopped = await session.ask('first', cb(), ctrl.signal);
    expect(stopped.aborted).toBe(true);

    // A fresh, un-aborted ask on the SAME session runs to a verified finish.
    mockComplete.mockResolvedValueOnce(chartFinish());
    mockComplete.mockResolvedValueOnce(verifyPass());
    const out = await session.ask('second', cb());
    expect(out.aborted).toBe(false);
    expect(out.finding).toBe('A finding.');
    expect(out.verification).not.toBeNull();
    expect(out.verification!.status).toBe('verified');
  });

  it('passing an untriggered signal does not mark a clean run aborted', async () => {
    // aborted is driven by an ACTUAL mid-run stop, not merely by the presence of
    // a signal: a clean run with a never-fired signal returns aborted:false.
    const ctrl = new AbortController();
    mockComplete.mockResolvedValueOnce(chartFinish());
    mockComplete.mockResolvedValueOnce(verifyPass());
    const out = await newSession().ask('q', cb(), ctrl.signal);
    expect(out.aborted).toBe(false);
    expect(out.verification!.status).toBe('verified');
  });

  it('the caller\'s signal is forwarded to complete() via deps', async () => {
    const ctrl = new AbortController();
    mockComplete.mockResolvedValueOnce(chartFinish());
    mockComplete.mockResolvedValueOnce(verifyPass());
    await newSession().ask('q', cb(), ctrl.signal);
    // The 4th positional arg to complete() is the deps object; it must carry the
    // same signal so an in-flight provider fetch can be aborted.
    const deps = mockComplete.mock.calls[0][3];
    expect(deps).toBeDefined();
    expect(deps.signal).toBe(ctrl.signal);
  });
});

// ── Gated plan mode (backlog #10) ──────────────────────────────────────────

// The gating heuristic is pure and cheap: a table of ~20 questions across both
// classes. Conservative by design — a simple lookup must NEVER be gated (it
// would cost the user an extra LLM call for nothing), while genuinely multi-step
// shapes (comparisons, causality over several series, cross-source, long
// conjunctive prompts, explicit "plan first") must be.
describe('needsPlan — gating heuristic', () => {
  // Each row: [question, activeSourceCount, expectedGated].
  const cases: [string, number, boolean][] = [
    // ── Should PLAN ──────────────────────────────────────────────────────
    ['Compare GDP per capita of India and China since 2000', 1, true],
    ['How does life expectancy in Japan compare to the United States?', 1, true],
    ['Nigeria vs Kenya vs Ghana: which grew fastest?', 1, true],
    ['Why has inflation risen in Argentina and Turkey?', 2, true],
    ['What is the relationship between CO2 emissions and GDP?', 1, true],
    ['How has poverty changed in Brazil since 1990 alongside inequality?', 2, true],
    ['Rank the top 10 countries by unemployment', 1, true],
    ['Show me the difference between Germany and France in trade', 1, true],
    ['Plan first, then chart CO2 emissions for the G7', 1, true],
    ['Compare inflation and unemployment across the United States, Japan, and Germany over the last two decades and note any divergence', 2, true],
    ['What drove the divergence in electricity access between India and Nigeria?', 2, true],
    ['Correlate GDP growth with life expectancy for African countries', 1, true],
    // ── Should NOT plan (simple / conservative) ──────────────────────────
    ['What is the population of France?', 5, false],
    ['GDP of Japan in 2020', 5, false],
    ['Show me literacy rate in Kenya', 5, false],
    ['What was inflation in Brazil last year?', 5, false],
    ['List countries in South America', 5, false],
    ['How many people live in Nigeria?', 5, false],
    ['What does GDP mean?', 5, false],
    ['Life expectancy in Canada', 5, false],
    ['Fetch unemployment for Spain', 5, false],
    ['', 5, false],
  ];

  for (const [q, n, expected] of cases) {
    it(`${expected ? 'plans' : 'skips'}: "${q.slice(0, 60)}"`, () => {
      expect(needsPlan(q, n)).toBe(expected);
    });
  }

  it('explicit "show your plan" forces a plan even on a simple lookup', () => {
    expect(needsPlan('Population of France', 1)).toBe(false);
    expect(needsPlan('Show your plan for the population of France', 1)).toBe(true);
  });

  it('counts distinct country mentions without short-code false positives', () => {
    // "in", "is", "us" (as words) must NOT be miscounted as countries.
    expect(countCountryMentions('what is the trend in inflation')).toBe(0);
    expect(countCountryMentions('India and China')).toBe(2);
    expect(countCountryMentions('the United States versus the United Kingdom')).toBe(2);
    // Explicit ISO3 codes count; a 3-letter non-country all-caps token does not.
    expect(countCountryMentions('compare USA and CHN GDP')).toBe(2);
  });
});

// parsePlanBrief mirrors parseVerifierVerdict's defensive discipline: a valid
// brief needs a non-empty insight AND ≥1 usable step; anything else → null
// (which the runtime treats as "no plan", proceeding exactly as today).
describe('parsePlanBrief — defensive brief parsing', () => {
  it('parses a well-formed brief with steps, tool hints, chart intent and sources', () => {
    const raw = JSON.stringify({
      insight: 'China overtook India on GDP per capita around 2010 and pulled away.',
      steps: [
        { what: 'find the GDP per capita series', tool_hint: 'find_series' },
        { what: 'fetch it for IND and CHN', tool_hint: 'fetch_series' },
        { what: 'compute the crossover year', tool_hint: 'execute_js' },
      ],
      chart_intent: 'a line chart of both series',
      sources_expected: ['World Bank'],
    });
    const b = parsePlanBrief(raw);
    expect(b).not.toBeNull();
    expect(b!.insight).toMatch(/China overtook/);
    expect(b!.steps).toHaveLength(3);
    expect(b!.steps[0].tool_hint).toBe('find_series');
    expect(b!.chart_intent).toBe('a line chart of both series');
    expect(b!.sources_expected).toEqual(['World Bank']);
  });

  it('tolerates code fences + surrounding prose (same as the verdict parser)', () => {
    const raw = 'Here is the plan:\n```json\n{"insight":"X diverges from Y","steps":[{"what":"fetch both"}]}\n```\nThanks.';
    const b = parsePlanBrief(raw);
    expect(b).not.toBeNull();
    expect(b!.steps).toHaveLength(1);
    expect(b!.steps[0].tool_hint).toBeUndefined();
  });

  it('drops steps without a `what`, and invalid tool hints, without fabricating', () => {
    const raw = JSON.stringify({
      insight: 'ok',
      steps: [{ what: 'real step', tool_hint: 'not_a_tool' }, { what: '' }, { note: 'no what' }, 'nope'],
    });
    const b = parsePlanBrief(raw);
    expect(b).not.toBeNull();
    expect(b!.steps).toHaveLength(1);
    expect(b!.steps[0].what).toBe('real step');
    expect(b!.steps[0].tool_hint).toBeUndefined(); // bad hint dropped, not kept
  });

  it('malformed → null (never a faked plan)', () => {
    expect(parsePlanBrief('')).toBeNull();
    expect(parsePlanBrief('   ')).toBeNull();
    expect(parsePlanBrief('the model rambled with no JSON')).toBeNull();
    expect(parsePlanBrief('{"insight":"","steps":[{"what":"x"}]}')).toBeNull(); // empty insight
    expect(parsePlanBrief('{"insight":"ok","steps":[]}')).toBeNull(); // no steps
    expect(parsePlanBrief('{"insight":"ok"}')).toBeNull(); // steps missing
    expect(parsePlanBrief('{"steps":[{"what":"x"}]}')).toBeNull(); // insight missing
    expect(parsePlanBrief('{"insight":"ok","steps":[{"what":""}]}')).toBeNull(); // all steps empty
  });
});

// The check-off matcher decides whether a trace event is plausibly the execution
// of a plan step. Cheap + imperfect on purpose (a progress cue, not a contract):
// a matching tool_hint family checks a step off outright, else a single shared
// distinctive keyword suffices. Non-executor events never match.
describe('matchStepToEvent — step check-off matcher', () => {
  const step = (what: string, tool_hint?: PlanStep['tool_hint']): PlanStep =>
    tool_hint ? { what, tool_hint } : { what };

  it('checks off on a matching tool_hint family (incl. legacy fetch + compute families)', () => {
    expect(matchStepToEvent(step('get the series', 'fetch_series'), { tool: 'fetch_series', argSummary: 'X' })).toBe(true);
    // Legacy per-source fetch name maps to the fetch family.
    expect(matchStepToEvent(step('get the series', 'fetch_series'), { tool: 'fetch_worldbank', argSummary: 'X' })).toBe(true);
    // growth_stats / correlate belong to the execute_js (compute) family.
    expect(matchStepToEvent(step('rank them', 'execute_js'), { tool: 'growth_stats', argSummary: '' })).toBe(true);
    expect(matchStepToEvent(step('correlate', 'execute_js'), { tool: 'correlate', argSummary: '' })).toBe(true);
  });

  it('checks off on a shared distinctive keyword when there is no hint', () => {
    expect(
      matchStepToEvent(step('fetch GDP for India and China'), { tool: 'fetch_series', argSummary: 'NY.GDP.MKTP.CD · IND,CHN' })
    ).toBe(true); // "gdp" overlaps
    expect(
      matchStepToEvent(step('search for the inflation series'), { tool: 'find_series', argSummary: 'inflation rate' })
    ).toBe(true); // "inflation" overlaps
  });

  it('does NOT match on tool family alone when the hint disagrees and no keyword overlaps', () => {
    expect(matchStepToEvent(step('compute the crossover', 'execute_js'), { tool: 'find_series', argSummary: 'population' })).toBe(false);
  });

  it('an off-plan tool event matches none of the plan steps', () => {
    const steps = [step('fetch GDP', 'fetch_series'), step('rank countries', 'execute_js')];
    const offPlanEvent = { tool: 'correlate', argSummary: 'emissions vs temperature', detail: '' };
    // correlate is the compute family → the execute_js step DOES claim it; make
    // an event with no family/keyword tie to prove non-matching is real.
    const trulyOff = { tool: 'find_series', argSummary: 'coastline length' };
    expect(steps.some((s) => matchStepToEvent(s, trulyOff))).toBe(false);
    // And the compute-family event is legitimately claimed by the compute step.
    expect(steps.some((s) => matchStepToEvent(s, offPlanEvent))).toBe(true);
  });

  it('never matches non-executor events (plan / reasoning / verify / fallback / llm)', () => {
    const s = step('fetch GDP', 'fetch_series');
    for (const tool of ['plan', 'reasoning', 'verify', 'fallback', 'llm']) {
      expect(matchStepToEvent(s, { tool, argSummary: 'gdp fetch' })).toBe(false);
    }
    expect(matchStepToEvent(s, { tool: '' })).toBe(false);
  });

  it('an unmatched step stays unchecked (drives the "not needed" strike at run-end)', () => {
    const s = step('delegate to IMF for forecasts', 'delegate_source');
    const events = [
      { tool: 'find_series', argSummary: 'gdp' },
      { tool: 'fetch_series', argSummary: 'NY.GDP.MKTP.CD' },
      { tool: 'execute_js', argSummary: 'rank' },
    ];
    expect(events.some((ev) => matchStepToEvent(s, ev))).toBe(false);
  });
});

// End-to-end through createSession (complete() mocked). The planning turn is at
// most ONE extra complete() call, only when gated in; a malformed brief leaves
// the run identical to today; a simple question makes NO planning call.
describe('plan mode, driven through createSession', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => mockComplete.mockReset());

  const tc = (name: string, args: Record<string, unknown>, id: string) => ({ id, name, arguments: args });
  const chartTurn = () => ({
    text: '',
    toolCalls: [
      tc('render_chart', { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] }, 'rc'),
      tc('finish', { one_line_finding: 'A finding.' }, 'fin'),
    ],
    usage: { input: 10, output: 5 },
  });
  const verifyPass = () => ({ text: '{"pass":true,"confidence":"high","issues":[]}', toolCalls: [], usage: { input: 5, output: 2 } });
  const planTurn = (brief: unknown) => ({ text: JSON.stringify(brief), toolCalls: [], usage: { input: 6, output: 3 } });
  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };
  const newSession = () => createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] });
  const GATED = 'Compare GDP per capita of India and China since 2000';
  const SIMPLE = 'What is the population of France?';

  it('a gated question makes exactly ONE planning call, pushes a plan receipt, and injects the insight note', async () => {
    const brief = {
      insight: 'China pulled ahead of India on GDP per capita after 2010.',
      steps: [{ what: 'fetch GDP per capita for IND and CHN', tool_hint: 'fetch_series' }],
      chart_intent: 'line chart',
    };
    mockComplete.mockResolvedValueOnce(planTurn(brief));
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    const out = await newSession().ask(GATED, cb);
    expect(out.aborted).toBe(false);

    // call 0 = plan, call 1 = agentPass, call 2 = verify.
    expect(mockComplete).toHaveBeenCalledTimes(3);

    // A plan receipt event, first in the trace, carrying the brief + its tokens.
    const planEvents = trace().filter((e) => e.tool === 'plan');
    expect(planEvents).toHaveLength(1);
    expect(trace()[0].tool).toBe('plan');
    expect(planEvents[0].plan.insight).toMatch(/China pulled ahead/);
    expect(planEvents[0].tokens).toBe(9);

    // The executor turn received the plan as a system-side note.
    const execMessages = mockComplete.mock.calls[1][1] as { role: string; content: string }[];
    const note = execMessages.find((m) => m.role === 'system' && m.content.includes('Insight to surface:'));
    expect(note).toBeDefined();
    expect(note!.content).toMatch(/China pulled ahead/);
    expect(note!.content).toMatch(/Deviate if the data demands it/);
  });

  it('passes the intended insight to the verifier', async () => {
    const brief = { insight: 'Divergence after 2010.', steps: [{ what: 'fetch both' }] };
    mockComplete.mockResolvedValueOnce(planTurn(brief));
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb } = capture();
    await newSession().ask(GATED, cb);

    const verifyMessages = mockComplete.mock.calls[2][1] as { role: string; content: string }[];
    const userMsg = verifyMessages.find((m) => m.role === 'user');
    expect(userMsg!.content).toMatch(/Intended insight: Divergence after 2010\./);
  });

  it('a malformed brief → muted plan-skipped receipt (never a faked card), no injected note, run proceeds', async () => {
    // The planning call still fires (the gate opened), but its output is junk.
    mockComplete.mockResolvedValueOnce({ text: 'the model forgot to answer in JSON', toolCalls: [], usage: { input: 6, output: 3 } });
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    const out = await newSession().ask(GATED, cb);
    expect(out.aborted).toBe(false);
    expect(out.verification!.status).toBe('verified'); // run completed normally

    // No plan CARD was faked — a card is a 'plan' event carrying a `.plan` brief.
    expect(trace().some((e) => e.tool === 'plan' && e.plan)).toBe(false);
    // But the gated-yet-unusable plan is EXPLAINED, not silent: a muted one-line
    // receipt (a 'plan' event with NO `.plan`) sits where the card would be.
    const skipped = trace().filter((e) => e.tool === 'plan' && !e.plan);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].status).toBe('ok'); // muted, not an error dot
    expect(skipped[0].detail).toMatch(/plan skipped — model returned no usable brief/);
    // No plan note leaked into the executor context.
    const execMessages = mockComplete.mock.calls[1][1] as { role: string; content: string }[];
    expect(execMessages.some((m) => m.role === 'system' && m.content.includes('Insight to surface:'))).toBe(false);
    // The verifier saw no intended insight either.
    const verifyMessages = mockComplete.mock.calls[2][1] as { role: string; content: string }[];
    expect(verifyMessages.find((m) => m.role === 'user')!.content).not.toMatch(/Intended insight:/);
  });

  it('an ungated (simple) question emits NO plan-skipped receipt — planning never ran', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask(SIMPLE, cb);

    // Neither a plan card nor a plan-skipped receipt: the gate never opened.
    expect(trace().some((e) => e.tool === 'plan')).toBe(false);
  });

  it('a simple question makes NO planning call (zero extra cost)', async () => {
    mockComplete.mockResolvedValueOnce(chartTurn());
    mockComplete.mockResolvedValueOnce(verifyPass());

    const { cb, trace } = capture();
    await newSession().ask(SIMPLE, cb);

    // Only agentPass + verify — no planning call prepended.
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(trace().some((e) => e.tool === 'plan')).toBe(false);
    // The first call is the executor, not a planner (no insight note present).
    const firstMessages = mockComplete.mock.calls[0][1] as { role: string; content: string }[];
    expect(firstMessages.some((m) => m.role === 'system' && m.content.includes('Insight to surface:'))).toBe(false);
  });

  it('abort DURING planning → aborted output, no plan card, no executor/verify calls', async () => {
    const ctrl = new AbortController();
    // The stop fires while the planning call is in flight.
    mockComplete.mockImplementationOnce(async () => {
      ctrl.abort();
      throw new Error('the provider request timed out');
    });

    const { cb, trace } = capture();
    const out = await newSession().ask(GATED, cb, ctrl.signal);
    expect(out.aborted).toBe(true);
    expect(out.verification).toBeNull(); // no stamp on a stopped turn
    // Only the planning call was attempted; no executor pass, no verifier.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    // The plan card is absent — a brief was never parsed/pushed.
    expect(trace().some((e) => e.tool === 'plan')).toBe(false);
  });
});

// ── save_to_dashboard dispatch (backlog: dashboards, increment 1) ──────────
// Driven end-to-end through createSession with complete() mocked and a Map-
// backed dashboard store injected — the same discipline as the other dispatch
// tests. Egress is never touched: the World Bank fetch is stubbed so the tile
// pins real rows + a real citation, all offline.
describe('save_to_dashboard dispatch', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => { mockComplete.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  // A Map-backed Web Storage fake (getItem/setItem/removeItem/length/key).
  class FakeStorage implements StorageLike {
    private m = new Map<string, string>();
    get length() { return this.m.size; }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
    setItem(k: string, v: string) { this.m.set(k, v); }
    removeItem(k: string) { this.m.delete(k); }
  }

  // World Bank JSON: [header(lastupdated), rows].
  const wbBody = () => [
    { lastupdated: '2024-12-16' },
    [
      { country: { value: 'India' }, countryiso3code: 'IND', date: '2000', value: 66.6 },
      { country: { value: 'India' }, countryiso3code: 'IND', date: '2020', value: 27.3 },
    ],
  ];

  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };

  it('chart exists → creates the dashboard with the tile + its citations attached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => wbBody() })));
    const store = new FakeStorage();

    // One assistant turn: fetch (populates rows + citation) → render → pin → finish.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        { id: 'f', name: 'fetch_series', arguments: { id: 'SP.DYN.IMRT.IN', countries: ['IND'], year_start: 2000, year_end: 2020 } },
        { id: 'r', name: 'render_chart', arguments: { type: 'line', title: 'Infant mortality, India', y_axis: 'per 1,000', series: [{ name: 'India', data: [[2000, 66.6], [2020, 27.3]] }] } },
        { id: 's', name: 'save_to_dashboard', arguments: { dashboard_title: 'Health board', tile_title: 'India infant mortality' } },
        { id: 'd', name: 'finish', arguments: { one_line_finding: "India's infant mortality more than halved 2000→2020." } },
      ],
      usage: { input: 20, output: 10 },
    });
    // Verifier PASS (no retry).
    mockComplete.mockResolvedValueOnce({ text: 'PASS: answers the question.', toolCalls: [], usage: { input: 5, output: 2 } });

    const session = createSession(
      { provider: 'openrouter', model: 'test-model', apiKey: 'x' },
      { sources: ['worldbank'], dashboardStore: store }
    );
    const { cb, trace } = capture();
    await session.ask('How has infant mortality changed in India?', cb);

    const boards = listDashboards(store);
    expect(boards).toHaveLength(1);
    const board = boards[0];
    expect(board.title).toBe('Health board');
    expect(board.tiles).toHaveLength(1);
    const tile = board.tiles[0];
    expect(tile.title).toBe('India infant mortality');
    expect(tile.spec.title).toBe('Infant mortality, India');
    expect(tile.rows.length).toBeGreaterThan(0);
    // The citation ledger from the live fetch rode along onto the tile.
    expect(tile.citations).toHaveLength(1);
    expect(tile.citations[0].source).toBe('worldbank');
    expect(tile.citations[0].sourceUpdated).toBe('2024-12-16');
    // The tile's source note surfaces the vintage.
    expect(tile.sourceNote).toContain('2024-12-16');

    // The pin step's receipt confirms the destination.
    const pin = trace().find((e: any) => e.tool === 'save_to_dashboard');
    expect(pin.status).toBe('ok');
    expect(pin.detail).toContain('Health board');
  });

  it('no chart this turn → clean refusal, nothing persisted', async () => {
    const store = new FakeStorage();

    // The model pins without ever rendering a chart.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [
        { id: 's', name: 'save_to_dashboard', arguments: { dashboard_title: 'Health board' } },
        { id: 'd', name: 'finish', arguments: { one_line_finding: 'Nothing charted.' } },
      ],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({ text: 'PASS.', toolCalls: [], usage: { input: 5, output: 2 } });

    const session = createSession(
      { provider: 'openrouter', model: 'test-model', apiKey: 'x' },
      { sources: ['worldbank'], dashboardStore: store }
    );
    const { cb, trace } = capture();
    await session.ask('Save this', cb);

    // No dashboard was created.
    expect(listDashboards(store)).toHaveLength(0);
    // The refusal is clean (an ok receipt with a "no chart" detail, not a crash).
    const pin = trace().find((e: any) => e.tool === 'save_to_dashboard');
    expect(pin.status).toBe('ok');
    expect(pin.detail).toMatch(/no chart/i);
  });

  it('defaultDashboardTitle derives from the question and truncates long ones', () => {
    expect(defaultDashboardTitle('  How has GDP grown?  ')).toBe('How has GDP grown?');
    expect(defaultDashboardTitle('')).toBe('My dashboard');
    const long = 'a'.repeat(100);
    expect(defaultDashboardTitle(long).length).toBeLessThanOrEqual(60);
    expect(defaultDashboardTitle(long).endsWith('…')).toBe(true);
  });
});

// ── edit_dashboard + refresh (increment 2) ─────────────────────────────────
// Shared fixtures for the conversational-edit + refresh suites.
class FakeStore implements StorageLike {
  private m = new Map<string, string>();
  private failSet = false;
  setFail(v: boolean) { this.failSet = v; }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { if (this.failSet) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const edSpec: ChartSpec = {
  type: 'line', title: 'Infant mortality, India', y_axis: 'per 1,000',
  series: [{ name: 'India', data: [[2000, 66.6], [2020, 27.3]] }],
};
const edRows: DataRow[] = [
  { country: 'India', iso3: 'IND', year: 2000, value: 66.6, indicator: 'SP.DYN.IMRT.IN' },
  { country: 'India', iso3: 'IND', year: 2020, value: 27.3, indicator: 'SP.DYN.IMRT.IN' },
];
function edCite(id: string, over?: Partial<Citation>): Citation {
  return {
    id: `wb:${id}|IND|2000:2020`, source: 'worldbank', sourceLabel: 'World Bank Open Data',
    indicatorId: id, indicatorName: id, url: `https://data.worldbank.org/indicator/${id}`,
    countries: ['IND'], yearRange: { start: 2000, end: 2020 },
    fetchedAt: '2026-07-01T00:00:00.000Z', sourceUpdated: '2024-12-16', rowCount: 2, cached: false, ...over,
  };
}
// World Bank JSON envelope: [header(lastupdated), rows].
const wbJson = (lastupdated: string, pts: [number, number][]) => [
  { lastupdated },
  pts.map(([year, value]) => ({ country: { value: 'India' }, countryiso3code: 'IND', date: String(year), value })),
];

describe('resolveTileRef', () => {
  function board(titles: string[]): Dashboard {
    let d = createDashboard('Board');
    for (const t of titles) d = addTile(d, makeTile({ title: t, spec: edSpec, rows: edRows, citations: [edCite('SP.DYN.IMRT.IN')] }));
    return d;
  }
  it('resolves by exact title first', () => {
    const d = board(['GDP', 'Life expectancy']);
    const r = resolveTileRef(d, { title: 'Life expectancy' });
    expect(r.ok && r.tile.title).toBe('Life expectancy');
  });
  it('falls back to case-insensitive title', () => {
    const d = board(['GDP', 'Life Expectancy']);
    const r = resolveTileRef(d, { title: 'life expectancy' });
    expect(r.ok && r.tile.title).toBe('Life Expectancy');
  });
  it('resolves by 1-based index when no title given', () => {
    const d = board(['GDP', 'Life expectancy', 'CO2']);
    const r = resolveTileRef(d, { index: 2 });
    expect(r.ok && r.tile.title).toBe('Life expectancy');
  });
  it('prefers an exact title over an index collision (title wins)', () => {
    const d = board(['GDP', 'Life expectancy']);
    const r = resolveTileRef(d, { title: 'GDP', index: 2 });
    expect(r.ok && r.tile.title).toBe('GDP');
  });
  it('errors (listing tiles) when two tiles share the exact title', () => {
    const d = board(['GDP', 'GDP']);
    const r = resolveTileRef(d, { title: 'GDP' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toMatch(/more than one/i); expect(r.error).toMatch(/1\. "GDP", 2\. "GDP"/); }
  });
  it('errors (listing tiles) for a missing title or out-of-range index', () => {
    const d = board(['GDP', 'Life expectancy']);
    const miss = resolveTileRef(d, { title: 'Nope' });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toMatch(/no tile titled "Nope"/i);
    const oob = resolveTileRef(d, { index: 9 });
    expect(oob.ok).toBe(false);
    if (!oob.ok) expect(oob.error).toMatch(/no tile at position 9/i);
  });
});

describe('refreshTile / refreshDashboard (stubbed fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function tile(title: string, id = 'SP.DYN.IMRT.IN'): Tile {
    return makeTile({ title, spec: edSpec, rows: edRows, citations: [edCite(id)] });
  }

  it('all-success: replaces rows + citations, refreshes vintage, resolves country codes identically (router semantics)', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { seen.push(url); return { ok: true, json: async () => wbJson('2025-06-30', [[2000, 60.1], [2020, 25.0]]) }; }));
    const t = tile('India infant mortality');
    const res = await refreshTile(t);
    expect(res.ok).toBe(true);
    expect(res.rows!.map((r) => r.value)).toEqual([60.1, 25.0]); // fresh rows
    expect(res.citations![0].sourceUpdated).toBe('2025-06-30'); // vintage updated (was 2024-12-16)
    expect(res.citations![0].countries).toEqual(['IND']); // resolveCountryList fixpoint on stored codes
    expect(res.detail).toMatch(/2 rows · WB · source updated 2025-06-30/);
    // The fetch went through the SAME World Bank URL a live run builds (country IND, indicator id in path).
    expect(seen[0]).toContain('/country/IND/indicator/SP.DYN.IMRT.IN');
  });

  it('failure: refreshTile reports stale reason and does NOT touch the tile', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const t = tile('Life expectancy');
    const res = await refreshTile(t);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('network error');
    expect(res.detail).toMatch(/network error, kept previous data/);
  });

  it('a tile with no citations is a clean failure (never blanked)', async () => {
    const t = makeTile({ title: 'No source', spec: edSpec, rows: edRows, citations: [] });
    const res = await refreshTile(t);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no citations to refresh from/);
  });

  it('refreshDashboard partial failure: one tile touched (fresh rows + vintage), the other stale with UNCHANGED rows, persisted', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('SP.DYN.LE00.IN')) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => wbJson('2025-06-30', [[2000, 60.1], [2020, 25.0]]) };
    }));
    const store = new FakeStore();
    let d = createDashboard('Health board');
    d = addTile(d, tile('India infant mortality', 'SP.DYN.IMRT.IN'));
    d = addTile(d, tile('Life expectancy', 'SP.DYN.LE00.IN'));
    saveDashboard(store, d);
    const bStaleRowsBefore = d.tiles[1].rows;

    const out = await refreshDashboard(store, d.id);
    expect(out.aborted).toBe(false);
    expect(out.results.map((r) => r.ok)).toEqual([true, false]);

    // Persisted: reload and inspect.
    const saved = loadDashboard(store, d.id)!;
    // Tile A: refreshed rows + new vintage + refreshedAt, no stale marker.
    expect(saved.tiles[0].rows.map((r) => r.value)).toEqual([60.1, 25.0]);
    expect(saved.tiles[0].citations[0].sourceUpdated).toBe('2025-06-30');
    expect(saved.tiles[0].refreshedAt).toBeTruthy();
    expect(saved.tiles[0].stale).toBeUndefined();
    // Tile B: UNCHANGED rows, stale marker present (honest, never blank).
    expect(saved.tiles[1].rows).toEqual(bStaleRowsBefore);
    expect(saved.tiles[1].stale?.reason).toBe('network error');
  });

  it('abort mid-refresh: remaining tiles untouched', async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) controller.abort(); // abort right after the first tile fetches
      return { ok: true, json: async () => wbJson('2025-06-30', [[2000, 60.1], [2020, 25.0]]) };
    }));
    const store = new FakeStore();
    let d = createDashboard('Board');
    d = addTile(d, tile('A', 'SP.DYN.IMRT.IN'));
    d = addTile(d, tile('B', 'NY.GDP.MKTP.CD'));
    saveDashboard(store, d);
    const bBefore = d.tiles[1];

    const out = await refreshDashboard(store, d.id, { signal: controller.signal });
    expect(out.aborted).toBe(true);
    expect(out.results).toHaveLength(1); // only tile A processed
    const saved = loadDashboard(store, d.id)!;
    expect(saved.tiles[0].refreshedAt).toBeTruthy(); // A was refreshed + saved
    expect(saved.tiles[1].refreshedAt).toBeUndefined(); // B untouched
    expect(saved.tiles[1].rows).toEqual(bBefore.rows);
    expect(saved.tiles[1].stale).toBeUndefined();
    expect(calls).toBe(1); // B never fetched
  });
});

describe('edit_dashboard dispatch (driven through createSession)', () => {
  const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => { mockComplete.mockReset(); });
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    let last: any[] = [];
    const cb = { onTrace: (ev: any[]) => (last = ev), onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    return { cb, trace: () => last };
  };

  function seed(store: StorageLike, titles = ['India infant mortality', 'Life expectancy']) {
    let d = createDashboard('Health board');
    for (const t of titles) d = addTile(d, makeTile({ title: t, spec: edSpec, rows: edRows, citations: [edCite('SP.DYN.IMRT.IN')] }));
    saveDashboard(store, d);
    return d;
  }

  // Drive one assistant turn that calls edit_dashboard then finish, then a PASS verifier.
  async function runEdit(store: StorageLike, args: Record<string, unknown>) {
    mockComplete.mockResolvedValueOnce({
      text: '', usage: { input: 10, output: 5 },
      toolCalls: [
        { id: 'e', name: 'edit_dashboard', arguments: args },
        { id: 'd', name: 'finish', arguments: { one_line_finding: 'Edited the dashboard.' } },
      ],
    });
    mockComplete.mockResolvedValueOnce({ text: 'PASS.', toolCalls: [], usage: { input: 5, output: 2 } });
    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'], dashboardStore: store });
    const { cb, trace } = capture();
    await session.ask('edit my dashboard', cb);
    return trace().find((e: any) => e.tool === 'edit_dashboard');
  }

  it('rename_dashboard: applies through the pure op, persists, receipt text', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'rename_dashboard', new_title: 'Vital signs' });
    expect(ev.status).toBe('ok');
    expect(ev.detail).toBe('dashboard "Health board": renamed to "Vital signs"');
    expect(listDashboards(store).map((d) => d.title)).toEqual(['Vital signs']);
  });

  it('rename_tile by title: persists the new tile title', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'rename_tile', tile_title: 'Life expectancy', new_title: 'Life expectancy at birth' });
    expect(ev.detail).toContain('renamed tile "Life expectancy"');
    const d = listDashboards(store)[0];
    expect(d.tiles.map((t) => t.title)).toContain('Life expectancy at birth');
  });

  it('remove_tile by title: drops the tile and persists', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'remove_tile', tile_title: 'Life expectancy' });
    expect(ev.detail).toBe('dashboard "Health board": removed tile "Life expectancy"');
    const d = listDashboards(store)[0];
    expect(d.tiles.map((t) => t.title)).toEqual(['India infant mortality']);
  });

  it('remove_tile by 1-based index: resolves position when no title given', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'remove_tile', tile_index: 1 });
    expect(ev.detail).toContain('removed tile "India infant mortality"');
    expect(listDashboards(store)[0].tiles.map((t) => t.title)).toEqual(['Life expectancy']);
  });

  it('move_tile down: reorders and persists', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'move_tile', tile_index: 1, direction: 'down' });
    expect(ev.detail).toContain('moved tile "India infant mortality" down');
    expect(listDashboards(store)[0].tiles.map((t) => t.title)).toEqual(['Life expectancy', 'India infant mortality']);
  });

  it('ambiguous tile reference → clean tool error listing the tiles, nothing persisted', async () => {
    const store = new FakeStore();
    seed(store, ['GDP', 'GDP']);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'remove_tile', tile_title: 'GDP' });
    expect(ev.status).toBe('ok'); // a tool-level error is returned as the result, receipt stays ok
    expect(ev.detail).toBe('tile not resolved');
    expect(listDashboards(store)[0].tiles).toHaveLength(2); // unchanged
  });

  it('missing dashboard → error naming the saved dashboards', async () => {
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Nonexistent', action: 'rename_dashboard', new_title: 'X' });
    expect(ev.detail).toBe('no such dashboard');
    expect(listDashboards(store).map((d) => d.title)).toEqual(['Health board']); // untouched
  });

  it('refresh_dashboard: re-fetches every tile through routeFetch semantics, persists fresh vintage + refreshedAt, receipt summarises', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => wbJson('2025-06-30', [[2000, 60.1], [2020, 25.0]]) })));
    const store = new FakeStore();
    seed(store);
    const ev = await runEdit(store, { dashboard_title: 'Health board', action: 'refresh_dashboard' });
    expect(ev.status).toBe('ok');
    expect(ev.detail).toBe('dashboard "Health board": refreshed 2 tiles · 2 ok, 0 stale');
    const d = listDashboards(store)[0];
    expect(d.tiles.every((t) => t.refreshedAt && t.citations[0].sourceUpdated === '2025-06-30')).toBe(true);
    expect(d.tiles.every((t) => t.rows.map((r) => r.value).join() === '60.1,25')).toBe(true);
  });

  it('refuses cleanly when no dashboard store is available', async () => {
    // No dashboardStore injected AND no global localStorage in the node test env.
    mockComplete.mockResolvedValueOnce({
      text: '', usage: { input: 10, output: 5 },
      toolCalls: [
        { id: 'e', name: 'edit_dashboard', arguments: { dashboard_title: 'x', action: 'rename_dashboard', new_title: 'y' } },
        { id: 'd', name: 'finish', arguments: { one_line_finding: 'n/a' } },
      ],
    });
    mockComplete.mockResolvedValueOnce({ text: 'PASS.', toolCalls: [], usage: { input: 5, output: 2 } });
    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' }, { sources: ['worldbank'] });
    const { cb, trace } = capture();
    await session.ask('edit', cb);
    const ev = trace().find((e: any) => e.tool === 'edit_dashboard');
    expect(ev.detail).toBe('no storage');
  });
});
