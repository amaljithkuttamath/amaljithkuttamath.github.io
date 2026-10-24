import { expect, it } from "vitest";
import {
  chartChanges,
  highlightChanges,
  lineDomain,
  deltaLabel,
  explainChange,
} from "./chart-insights";
import type { ChartSpec } from "./core";
const spec: ChartSpec = {
  type: "line",
  title: "Life expectancy",
  x_axis: "Year",
  y_axis: "years",
  series: [
    {
      name: "Japan",
      data: [
        [2019, 84.4],
        [2020, 84.6],
        [2021, 84.5],
      ],
    },
    {
      name: "Spain",
      data: [
        [2019, 83.8],
        [2020, 82.3],
        [2021, 83.1],
      ],
    },
  ],
};
it("fits a shared domain without clipping values or forcing zero", () => {
  const d = lineDomain(spec)!;
  expect(d.min).toBeGreaterThan(80);
  expect(d.min).toBeLessThan(82.3);
  expect(d.max).toBeGreaterThan(84.6);
  expect(lineDomain({ ...spec, type: "bar" })).toBeNull();
  const flat = lineDomain({
    ...spec,
    series: [
      {
        name: "Flat",
        data: [
          [2020, 0],
          [2021, 0],
        ],
      },
    ],
  })!;
  expect(flat.min).toBeLessThan(0);
  expect(flat.max).toBeGreaterThan(0);
  expect(lineDomain({ ...spec, series: [] })).toBeNull();
});
it("finds the largest observed step per series and supplies exact evidence to the question", () => {
  const changes = highlightChanges(spec);
  expect(changes[0]).toMatchObject({
    series: "Spain",
    from: [2019, 83.8],
    to: [2020, 82.3],
  });
  expect(deltaLabel(changes[0], spec.y_axis)).toBe("−1.5 years");
  expect(explainChange(changes[0])).toBe(
    "Why did Spain change from 83.8 to 82.3 between 2019 and 2020?",
  );
  expect(changes).toHaveLength(2);
});
it("keeps gaps explicit and refuses ambiguous, non-time or missing-value transitions", () => {
  expect(chartChanges({ ...spec, x_axis: "GDP" })).toEqual([]);
  expect(chartChanges({ ...spec, type: "scatter" })).toEqual([]);
  expect(
    chartChanges({
      ...spec,
      series: [
        {
          name: "gap",
          data: [
            [2018, 80],
            [2020, 82],
          ],
        },
      ],
    }).at(0),
  ).toMatchObject({ from: [2018, 80], to: [2020, 82], delta: 2 });
  expect(
    chartChanges({
      ...spec,
      series: [
        {
          name: "duplicate",
          data: [
            [2019, 80],
            [2019, 82],
          ],
        },
      ],
    }),
  ).toEqual([]);
  expect(
    chartChanges({
      ...spec,
      series: [
        {
          name: "missing",
          data: [
            [2018, 80],
            [2019, null as unknown as number],
            [2020, 82],
          ],
        },
      ],
    }),
  ).toEqual([]);
});
it("uses percentage points for percentage deltas and preserves small movements", () => {
  const c = {
    series: "A",
    from: [2019, 5] as [number, number],
    to: [2020, 7] as [number, number],
    delta: 2,
  };
  expect(deltaLabel(c, "% of GDP")).toBe("+2 pp");
  expect(deltaLabel({ ...c, delta: 0.0002 })).toBe("+0.0002");
});
