import { describe, it, expect } from 'vitest';
import { buildFindingOkf } from './okf';
import type { Citation } from './tools';

const cite = (over: Partial<Citation> = {}): Citation => ({
  id: 'NY.GDP.PCAP.CD|IND|2000-2024',
  source: 'worldbank',
  sourceLabel: 'World Bank Open Data',
  indicatorId: 'NY.GDP.PCAP.CD',
  indicatorName: 'GDP per capita (current US$)',
  url: 'https://data.worldbank.org/indicator/NY.GDP.PCAP.CD',
  countries: ['IND'],
  yearRange: { start: 2000, end: 2024 },
  fetchedAt: '2026-07-22T10:00:00.000Z',
  sourceUpdated: '2024-12-16',
  rowCount: 25,
  cached: false,
  ...over,
});

describe('buildFindingOkf — OKF v0.1 concept export', () => {
  it('emits front matter with okf_version, a non-empty type, title, producer, sources, and verified flag', () => {
    const md = buildFindingOkf({
      question: "India's GDP per capita",
      finding: 'India’s GDP per capita rose from ~$443 in 2000 to ~$2,480 in 2024.',
      spec: { type: 'line', title: 'India GDP per capita', series: [{ name: 'India', data: [[2000, 443]] }] },
      citations: [cite()],
      verification: { status: 'verified', pass: true, confidence: 'high', issues: [], report: 'PASS' },
      createdAt: '2026-07-22T10:05:00.000Z',
    });
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('okf_version: "0.1"');
    expect(md).toContain('type: "finding"');
    expect(md).toContain('title: "India\'s GDP per capita"');
    expect(md).toContain('producer: "chitti"');
    expect(md).toContain('sources:\n  - "World Bank Open Data"');
    expect(md).toContain('verified: true');
    // Body: H1, finding, chart, a citation rendered as a Markdown link.
    expect(md).toContain("# India's GDP per capita");
    expect(md).toContain('## Chart');
    expect(md).toContain('line chart');
    expect(md).toContain('## Data sources');
    expect(md).toContain('[GDP per capita (current US$) (NY.GDP.PCAP.CD)](https://data.worldbank.org/indicator/NY.GDP.PCAP.CD)');
    expect(md).toContain('IND; 2000–2024; source updated 2024-12-16');
    expect(md).toContain('## Verification');
    expect(md).toContain('Verified · verifier confidence: high');
    expect(md.endsWith('\n')).toBe(true);
  });

  it('omits Chart and Data sources on a prose/explanation turn (no spec, no citations)', () => {
    const md = buildFindingOkf({
      question: 'What is GDP?',
      finding: 'GDP is the total market value of goods and services produced.',
      spec: null,
      citations: [],
      verification: null,
      createdAt: '2026-07-22T10:05:00.000Z',
    });
    expect(md).not.toContain('## Chart');
    expect(md).not.toContain('## Data sources');
    expect(md).not.toContain('## Verification');
    // No sources → no sources key in the front matter.
    expect(md).not.toContain('sources:');
    expect(md).toContain('# What is GDP?');
  });

  it('marks an unverified verdict honestly and never claims a pass', () => {
    const md = buildFindingOkf({
      question: 'q',
      finding: 'f',
      spec: null,
      citations: [],
      verification: { status: 'unverified', pass: false, confidence: 'low', issues: ['number not found in source'], report: 'FAIL' },
      createdAt: '2026-07-22T10:05:00.000Z',
    });
    expect(md).toContain('verified: false');
    expect(md).toContain('Not verified · verifier confidence: low');
    expect(md).toContain('- number not found in source');
    expect(md).not.toContain('verified: true');
  });

  it('escapes quotes/newlines in the title and keeps the front matter single-line', () => {
    const md = buildFindingOkf({
      question: 'GDP of "India"\nand China',
      finding: 'x',
      spec: null,
      citations: [],
      verification: null,
      createdAt: '2026-07-22T10:05:00.000Z',
    });
    expect(md).toContain('title: "GDP of \\"India\\" and China"');
    // The front-matter block must be exactly the lines between the two fences.
    const fm = md.slice(0, md.indexOf('\n---\n', 4));
    expect(fm.split('\n').every((l) => !l.includes('\n'))).toBe(true);
  });

  it('formats country and year-range facets, defaulting empties to "all countries"/"all years"', () => {
    const md = buildFindingOkf({
      question: 'world co2',
      finding: 'x',
      spec: null,
      citations: [cite({ countries: [], yearRange: null, sourceUpdated: undefined, indicatorName: '' })],
      verification: null,
      createdAt: '2026-07-22T10:05:00.000Z',
    });
    // No indicatorName → falls back to the id; no countries/range → the defaults.
    expect(md).toContain('[NY.GDP.PCAP.CD (NY.GDP.PCAP.CD)]');
    expect(md).toContain('all countries; all years');
  });

  it('falls back to a finding-derived title, then a generic one, when the question is blank', () => {
    expect(buildFindingOkf({ question: '', finding: 'Solar overtook coal in 2023.', spec: null, citations: [], verification: null, createdAt: 't' }))
      .toContain('# Solar overtook coal in 2023.');
    expect(buildFindingOkf({ question: '  ', finding: '', spec: null, citations: [], verification: null, createdAt: 't' }))
      .toContain('# Chitti finding');
  });
});
