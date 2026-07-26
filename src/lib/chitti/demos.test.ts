import { describe, it, expect } from 'vitest';
import { cleanDemo, cleanDemos, DEMOS } from './demos';
import demosData from '../../data/chitti/demos.json';
import { SHARE_VERSION } from './share';

// A minimal but complete demo state, in the shape the generator emits.
const state = {
  v: SHARE_VERSION,
  q: 'Which countries cut child mortality the fastest since 2000?',
  answer: 'Malawi cut under-5 mortality 71% between 2000 and 2023.',
  spec: {
    type: 'bar',
    title: 'Steepest falls in under-5 mortality',
    x_axis: 'Country',
    y_axis: '% change',
    series: [{ name: '% change', data: [['Malawi', -71.2], ['Rwanda', -70.1]] }],
  },
  rows: [{ country: 'Malawi', iso3: 'MWI', year: 2000, value: 174.2, indicator: 'SH.DYN.MORT' }],
  citations: [
    {
      id: 'wb:SH.DYN.MORT::2000-',
      source: 'worldbank',
      sourceLabel: 'World Bank Open Data',
      indicatorId: 'SH.DYN.MORT',
      indicatorName: 'Mortality rate, under-5',
      url: 'https://data.worldbank.org/indicator/SH.DYN.MORT',
      countries: [],
      yearRange: { start: 2000 },
      fetchedAt: '2026-07-01T00:00:00.000Z',
      rowCount: 1,
      cached: false,
    },
  ],
  verification: null,
  ts: '2026-07-01T00:00:00.000Z',
};

const demo = {
  id: 'child-mortality-fastest-fall',
  question: 'Which countries cut child mortality the fastest since 2000?',
  blurb: 'Ranked across every country in the world.',
  sources: ['World Bank Open Data'],
  state,
};

describe('cleanDemo', () => {
  it('accepts a well-formed demo and preserves its card copy', () => {
    const out = cleanDemo(demo);
    expect(out).not.toBeNull();
    expect(out!.id).toBe('child-mortality-fastest-fall');
    expect(out!.blurb).toBe('Ranked across every country in the world.');
    expect(out!.sources).toEqual(['World Bank Open Data']);
    expect(out!.state.spec?.series[0].data).toHaveLength(2);
    expect(out!.state.rows).toHaveLength(1);
  });

  it('rejects entries that cannot be rendered', () => {
    expect(cleanDemo(null)).toBeNull();
    expect(cleanDemo('nope')).toBeNull();
    expect(cleanDemo({ ...demo, id: '   ' })).toBeNull();
    expect(cleanDemo({ ...demo, question: '' })).toBeNull();
    expect(cleanDemo({ ...demo, state: undefined })).toBeNull();
    // Version gate — the same one the #share= decoder applies.
    expect(cleanDemo({ ...demo, state: { ...state, v: 99 } })).toBeNull();
    // Nothing to show: no chart AND no answer text.
    expect(cleanDemo({ ...demo, state: { ...state, spec: null, answer: '  ' } })).toBeNull();
  });

  it('keeps a chartless demo that still carries an answer', () => {
    const out = cleanDemo({ ...demo, state: { ...state, spec: null } });
    expect(out).not.toBeNull();
    expect(out!.state.spec).toBeNull();
  });

  it('strips fields outside the share whitelist', () => {
    const tainted = {
      ...demo,
      evil: 'x',
      state: { ...state, apiKey: 'sk-should-never-survive', trace: [{ tool: 'fetch' }] },
    };
    const out = cleanDemo(tainted) as any;
    expect(out).not.toBeNull();
    expect(out.evil).toBeUndefined();
    expect(out.state.apiKey).toBeUndefined();
    expect(out.state.trace).toBeUndefined();
  });
});

describe('cleanDemos', () => {
  it('drops invalid entries without losing the valid ones', () => {
    const out = cleanDemos({ generated: '2026-07-01T00:00:00.000Z', demos: [demo, { id: 'bad' }, null] });
    expect(out.demos).toHaveLength(1);
    expect(out.generated).toBe('2026-07-01T00:00:00.000Z');
  });

  it('de-duplicates by id, keeping the first', () => {
    const out = cleanDemos({ demos: [demo, { ...demo, blurb: 'second' }] });
    expect(out.demos).toHaveLength(1);
    expect(out.demos[0].blurb).toBe('Ranked across every country in the world.');
  });

  it('tolerates a missing/garbage file shape', () => {
    expect(cleanDemos(undefined).demos).toEqual([]);
    expect(cleanDemos({ demos: 'nope' }).demos).toEqual([]);
    expect(cleanDemos({ generated: 'not-a-date', demos: [] }).generated).toBeNull();
  });
});

// The safety net over whatever `npm run demos:refresh` last wrote. These pass
// trivially while demos.json is the empty placeholder, and become meaningful the
// moment the generator populates it.
describe('the shipped demos.json', () => {
  const raw = (demosData as { demos?: unknown[] }).demos ?? [];

  it('loses no entry to validation (a dropped demo means a malformed file)', () => {
    expect(DEMOS).toHaveLength(raw.length);
  });

  it('carries provenance on every demo — a demo with no citation is not evidence', () => {
    for (const d of DEMOS) {
      expect(d.state.citations.length, `${d.id} has no citations`).toBeGreaterThan(0);
      for (const c of d.state.citations) {
        expect(c.url, `${d.id} citation ${c.indicatorId} has no source URL`).toMatch(/^https?:\/\//);
        expect(c.indicatorId, `${d.id} citation has no indicator id`).not.toBe('');
      }
    }
  });

  it('never claims a verifier ran (no model checked a pre-baked answer)', () => {
    for (const d of DEMOS) {
      expect(d.state.verification, `${d.id} claims a verification verdict`).toBeNull();
    }
  });

  it('has a chart and an answer to show', () => {
    for (const d of DEMOS) {
      expect(d.state.answer.trim(), `${d.id} has no answer text`).not.toBe('');
      expect(d.state.spec, `${d.id} has no chart spec`).not.toBeNull();
      expect(d.state.spec!.series.length, `${d.id} has an empty chart`).toBeGreaterThan(0);
    }
  });
});
