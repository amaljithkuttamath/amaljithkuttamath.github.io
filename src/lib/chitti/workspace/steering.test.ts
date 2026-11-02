import { expect, it } from "vitest";
import { editView, recentStart } from "./steering";
import type { ShareStateV1 } from "../share";
const source: ShareStateV1 = {
  v: 1,
  q: "Compare",
  answer: "Old finding",
  spec: {
    type: "line",
    title: "Values",
    x_axis: "Year",
    series: [
      {
        name: "A",
        data: [
          [2000, 1],
          [2020, 2],
        ],
      },
      {
        name: "B",
        data: [
          [2000, 3],
          [2020, 4],
        ],
      },
    ],
  },
  rows: [{ country: "A", iso3: "AAA", year: 2000, value: 1 }],
  citations: [],
  verification: { status: "verified", confidence: "high", issues: [] },
  ts: "2026-10-24T00:00:00Z",
};
it("focuses only an existing series without retaining a stale finding or verification", () => {
  const next = editView(source, { kind: "series", name: "B" })!;
  expect(next.spec!.series.map((s) => s.name)).toEqual(["B"]);
  expect(next.verification).toBeNull();
  expect(next.answer).not.toBe(source.answer);
  expect(next.rows).toEqual(source.rows);
  expect(next.ts).toBe(source.ts);
  expect(source.spec!.series).toHaveLength(2);
  expect(editView(source, { kind: "series", name: "invented" })).toBeNull();
});
it("limits by calendar years, not ten points, and refuses non-time charts", () => {
  expect(recentStart(source)).toBe(2011);
  expect(editView(source, { kind: "recent" })!.spec!.series[0].data).toEqual([
    [2020, 2],
  ]);
  expect(
    recentStart({ ...source, spec: { ...source.spec!, type: "scatter" } }),
  ).toBeNull();
  expect(
    recentStart({ ...source, spec: { ...source.spec!, x_axis: "GDP" } }),
  ).toBeNull();
});
it('changes chart type, time range and highlight without changing source evidence', () => {
  const bar = editView(source, { kind: 'type', type: 'grouped-bar' })!;
  expect(bar.spec!.type).toBe('grouped-bar');
  expect(bar.rows).toEqual(source.rows);
  const highlighted = editView(bar, { kind: 'highlight', id: 'B' })!;
  expect(highlighted.spec!.highlight).toEqual(['B']);
  expect(highlighted.spec!.series).toHaveLength(2);
  const filtered = editView(highlighted, { kind: 'years', start: 2010, end: 2020 })!;
  expect(filtered.spec!.series[1].data).toEqual([[2020, 4]]);
  expect(filtered.spec!.series[1].colorIndex).toBe(bar.spec!.series[1].colorIndex);
  expect(filtered.verification).toBeNull();
  expect(editView(source, { kind: 'years', start: 2020, end: 2000 })).toBeNull();
  expect(editView(source, { kind: 'years', start: 1900, end: 1910 })).toBeNull();
  expect(editView(source, { kind: 'type', type: 'scatter' })).toBeNull();
  expect(editView(source, { kind: 'highlight', id: 'missing' })).toBeNull();
});
