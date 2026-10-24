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
