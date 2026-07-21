import { describe, it, expect } from 'vitest';
import {
  buildSharePayload,
  encodeShareState,
  decodeShareState,
  SHARE_VERSION,
  MAX_SHARE_BYTES,
  type ShareInput,
} from './share';
import type { ChartSpec, DataRow, Citation } from './tools';

const spec: ChartSpec = {
  type: 'line',
  title: 'Life expectancy at birth',
  x_axis: 'Year',
  y_axis: 'years',
  series: [
    { name: 'France', data: [[2000, 79.2], [2010, 81.7], [2020, 82.3]] },
    { name: 'Germany', data: [[2000, 78.1], [2010, 80.1], [2020, 81.0]] },
  ],
};

const rows: DataRow[] = [
  { country: 'France', iso3: 'FRA', year: 2000, value: 79.2, indicator: 'SP.DYN.LE00.IN' },
  { country: 'France', iso3: 'FRA', year: 2010, value: 81.7, indicator: 'SP.DYN.LE00.IN' },
  { country: 'France', iso3: 'FRA', year: 2020, value: 82.3, indicator: 'SP.DYN.LE00.IN' },
  { country: 'Germany', iso3: 'DEU', year: 2000, value: 78.1, indicator: 'SP.DYN.LE00.IN' },
  { country: 'Germany', iso3: 'DEU', year: 2010, value: null, indicator: 'SP.DYN.LE00.IN' },
  { country: 'Germany', iso3: 'DEU', year: 2020, value: 81.0, indicator: 'SP.DYN.LE00.IN' },
];

const citations: Citation[] = [
  {
    id: 'wb:SP.DYN.LE00.IN:FRA,DEU:2000-2020',
    source: 'worldbank',
    sourceLabel: 'World Bank Open Data',
    indicatorId: 'SP.DYN.LE00.IN',
    indicatorName: 'Life expectancy at birth, total (years)',
    url: 'https://data.worldbank.org/indicator/SP.DYN.LE00.IN',
    requestUrl: 'https://api.worldbank.org/v2/country/FRA;DEU/indicator/SP.DYN.LE00.IN',
    countries: ['FRA', 'DEU'],
    yearRange: { start: 2000, end: 2020 },
    fetchedAt: '2026-07-21T11:03:00.000Z',
    sourceUpdated: '2026-06-28',
    rowCount: 6,
    cached: false,
  },
];

const verification = { status: 'verified' as const, confidence: 'high' as const, issues: [] };

const baseInput: ShareInput = {
  question: 'How has life expectancy changed in France and Germany?',
  answer: 'Life expectancy in both France and Germany rose steadily from 2000 to 2020, with France ahead throughout.',
  spec,
  rows,
  citations,
  verification,
  ts: '2026-07-21T11:05:00.000Z',
};

describe('buildSharePayload', () => {
  it('copies only whitelisted fields', () => {
    const p = buildSharePayload(baseInput);
    expect(p.v).toBe(SHARE_VERSION);
    expect(p.q).toBe(baseInput.question);
    expect(p.answer).toBe(baseInput.answer);
    expect(p.spec?.series.length).toBe(2);
    expect(p.rows.length).toBe(6);
    expect(p.citations.length).toBe(1);
    expect(p.verification).toEqual(verification);
    expect(p.ts).toBe(baseInput.ts);
  });

  it('defaults ts to now when absent/invalid', () => {
    const p = buildSharePayload({ ...baseInput, ts: 'not-a-date' });
    expect(Number.isNaN(Date.parse(p.ts))).toBe(false);
  });
});

describe('roundtrip fidelity (compressed)', () => {
  it('spec / rows / citations / verification survive exactly', async () => {
    const r = await encodeShareState(baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lossy).toBe(false);
    expect(r.payload[0]).toBe('C');
    const back = await decodeShareState(r.payload);
    expect(back).not.toBeNull();
    expect(back!.q).toBe(baseInput.question);
    expect(back!.answer).toBe(baseInput.answer);
    expect(back!.spec).toEqual(spec);
    expect(back!.rows).toEqual(rows);
    expect(back!.citations).toEqual(citations);
    expect(back!.verification).toEqual(verification);
    expect(back!.ts).toBe(baseInput.ts);
    expect(back!.lossy).toBeUndefined();
  });
});

describe('uncompressed fallback path', () => {
  it('roundtrips with the U flag', async () => {
    const r = await encodeShareState(baseInput, { compress: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload[0]).toBe('U');
    const back = await decodeShareState(r.payload);
    expect(back).not.toBeNull();
    expect(back!.spec).toEqual(spec);
    expect(back!.rows).toEqual(rows);
    expect(back!.citations).toEqual(citations);
  });
});

describe('version gate', () => {
  it('unknown version → null', async () => {
    const r = await encodeShareState(baseInput, { compress: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Decode, bump the version, re-encode by hand through the same base64url the
    // module uses — simplest is to craft a U payload directly.
    const json = JSON.stringify({ ...buildSharePayload(baseInput), v: 999 });
    const b64 = Buffer.from(json, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const back = await decodeShareState('U' + b64);
    expect(back).toBeNull();
  });
});

describe('malformed input', () => {
  it('empty / too-short → null', async () => {
    expect(await decodeShareState('')).toBeNull();
    expect(await decodeShareState('C')).toBeNull();
  });
  it('unknown flag char → null', async () => {
    expect(await decodeShareState('Xabcdef')).toBeNull();
  });
  it('truncated / non-base64 body → null', async () => {
    const r = await encodeShareState(baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const truncated = r.payload.slice(0, Math.floor(r.payload.length / 2));
    expect(await decodeShareState(truncated)).toBeNull();
    expect(await decodeShareState('U@@@not base64@@@')).toBeNull();
  });
  it('valid base64 of non-JSON → null', async () => {
    const b64 = Buffer.from('this is not json', 'utf8').toString('base64url');
    expect(await decodeShareState('U' + b64)).toBeNull();
  });
});

describe('size budget', () => {
  function bigRows(n: number): DataRow[] {
    const out: DataRow[] = [];
    for (let i = 0; i < n; i++) {
      out.push({ country: 'Country ' + i, iso3: 'C' + i, year: 1960 + (i % 60), value: i * 1.5, indicator: 'SP.DYN.LE00.IN' });
    }
    return out;
  }

  it('drops rows (lossy) when over budget, keeping spec + answer', async () => {
    const input: ShareInput = { ...baseInput, rows: bigRows(4000) };
    // A small budget forces the row-drop branch deterministically.
    const r = await encodeShareState(input, { maxBytes: 1200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lossy).toBe(true);
    const back = await decodeShareState(r.payload);
    expect(back).not.toBeNull();
    expect(back!.lossy).toBe(true);
    expect(back!.rows.length).toBe(0); // rows dropped
    expect(back!.answer).toBe(baseInput.answer); // answer never truncated
    expect(back!.spec).toEqual(spec); // chart survives
  });

  it('refuses (too-large) when even row-less payload exceeds budget', async () => {
    // A very small budget that even the answer+spec cannot fit under.
    const r = await encodeShareState(baseInput, { maxBytes: 40 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('too-large');
  });

  it('a typical answer fits well under the 8KB budget', async () => {
    const r = await encodeShareState(baseInput);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes).toBeLessThan(MAX_SHARE_BYTES);
    expect(r.lossy).toBe(false);
  });
});

describe('key is never serialized', () => {
  it('a stray apiKey (top-level or nested) never reaches the encoded output', async () => {
    const KEY = 'sk-super-secret-key-1234567890';
    // Accidentally include the key in several shapes the state might carry.
    const dirty: any = {
      ...baseInput,
      apiKey: KEY,
      key: KEY,
      config: { apiKey: KEY },
      spec: { ...spec, apiKey: KEY, __proto__: { polluted: true } },
      rows: rows.map((r) => ({ ...r, apiKey: KEY })),
      citations: citations.map((c) => ({ ...c, apiKey: KEY })),
      verification: { ...verification, apiKey: KEY },
    };

    const payload = buildSharePayload(dirty);
    expect(JSON.stringify(payload)).not.toContain(KEY);

    const r = await encodeShareState(dirty);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).not.toContain(KEY);
    // And the base64url decodes to JSON that also lacks it.
    const b64 = r.payload.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    // (compressed payload — decode via the module and re-stringify)
    const back = await decodeShareState(r.payload);
    expect(JSON.stringify(back)).not.toContain(KEY);
    void b64;
  });
});
