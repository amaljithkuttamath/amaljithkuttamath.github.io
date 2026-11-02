import { describe, expect, it } from 'vitest';
import { normalizeChart, prepareChart, chartIssues } from './chart-contract';
import { buildSharePayload, cleanShareState } from './share';
import { editView } from './workspace/steering';
import type { ChartSpec, Citation, DataRow } from './core';
const spec: ChartSpec = {
  type: 'line', title: 'Life expectancy', x_axis: 'Year', unit: 'years',
  series: [
    { id: 'country:IND', name: 'India', unit: 'years', data: [[2000, 63], [2020, 70]], evidence: { mode: 'observed', citationIds: ['wb:life'], indicatorId: 'life', iso3: 'IND' } },
    { id: 'country:CHN', name: 'China', unit: 'years', data: [[2000, 72], [2020, 78]] },
  ], highlight: ['country:IND'], annotations: [{ seriesId: 'country:IND', x: 2020, label: 'Latest observation' }],
};
const rows: DataRow[] = [
  { iso3: 'IND', country: 'India', indicator: 'life', year: 2000, value: 63 },
  { iso3: 'IND', country: 'India', indicator: 'life', year: 2020, value: 70 },
];
const citations = [{ id: 'wb:life', indicatorId: 'life' }] as Citation[];
describe('chart contract', () => {
  it('keeps stable colors after reorder, rename, addition and focusing', () => {
    const initial = prepareChart(spec);
    const changed = prepareChart({ ...spec, series: [spec.series[1], { ...spec.series[0], name: 'India renamed' }, { id: 'JPN', name: 'Japan', data: [] }] }, initial);
    expect(changed.series[1].colorIndex).toBe(initial.series[0].colorIndex);
    expect(changed.series[0].colorIndex).toBe(initial.series[1].colorIndex);
    expect(new Set(changed.series.map(s => s.colorIndex)).size).toBe(3);
    const state = buildSharePayload({ question: 'q', answer: 'a', spec: initial, rows, citations, verification: null });
    const focused = editView(state, { kind: 'series', name: 'India' })!;
    expect(focused.spec!.series[0].colorIndex).toBe(initial.series[0].colorIndex);
  });
  it('round trips all declarative fields and excludes executable or secret fields', () => {
    const chart = prepareChart(spec);
    const input = { v: 1, spec: { ...chart, formatter: 'evil', apiKey: 'secret' }, rows: [], citations: [] };
    expect(cleanShareState(input)?.spec).toEqual(chart);
    expect(JSON.stringify(cleanShareState(input))).not.toMatch(/secret|evil/);
  });
  it('rejects false source bindings, mixed units, unknown IDs and invented annotations', () => {
    expect(chartIssues(spec, rows, citations)).toEqual([]);
    const bad = structuredClone(spec);
    bad.series[0].data[0][1] = 999;
    bad.series[1].unit = 'USD';
    bad.highlight = ['missing'];
    bad.annotations![0].x = 2050;
    const errors = chartIssues(bad, rows, citations).join(' ');
    expect(errors).toMatch(/absent/);
    expect(errors).toMatch(/different units/);
    expect(errors).toMatch(/Unknown highlighted/);
    expect(errors).toMatch(/existing point/);
    expect(chartIssues(spec, rows, []).join(' ')).toMatch(/citation IDs/);
  });
  it('requires a method for derived data without pretending to verify the calculation', () => {
    const derived = structuredClone(spec);
    derived.series[0].evidence!.mode = 'derived';
    expect(chartIssues(derived, rows, citations).join(' ')).toMatch(/calculation/);
    derived.series[0].evidence!.method = '(end - start) / start * 100';
    expect(chartIssues(derived, rows, citations)).toEqual([]);
  });
  it('drops invalid coordinates and missing/non-finite values rather than inventing zeros', () => {
    const out = normalizeChart({ series: [{ name: 'A', data: [[{}, 5], [2020, null], [2021, false], [2022, ' '], [2023, Infinity], [2024, 0]] }] });
    expect(out.series[0].data).toEqual([[2024, 0]]);
    expect(() => normalizeChart({ series: [null, 7, false] })).not.toThrow();
  });
});
it('validates observed bindings against the cited country/year coverage', () => {
  const narrowed = [{ ...citations[0], countries: ['CHN'], yearRange: { start: 2020, end: 2024 } }] as Citation[];
  expect(chartIssues(spec, rows, narrowed).join(' ')).toMatch(/absent/);
  const chart = structuredClone(spec);
  delete chart.series[0].evidence!.iso3;
  expect(chartIssues(chart, rows, citations).join(' ')).toMatch(/ISO3/);
  chart.series[0].data = [['India', 70]];
  expect(chartIssues(chart, rows, citations).join(' ')).toMatch(/year binding/);
  chart.series[0].evidence!.year = 2020;
  expect(chartIssues(chart, rows, citations).filter(x => !x.includes('Annotation'))).toEqual([]);
});
