import { expect, it } from "vitest";
import { describeChange } from "./changes";
import { editView } from "./steering";
import type { ShareStateV1 } from "../share";
const before: ShareStateV1 = {
  v: 1,
  q: "Compare",
  answer: "Original finding",
  spec: {
    type: "line",
    title: "Values",
    x_axis: "Year",
    series: [
      {
        name: "Japan",
        data: [
          [1960, 60],
          [2024, 84],
        ],
      },
      {
        name: "Italy",
        data: [
          [1960, 61],
          [2024, 83],
        ],
      },
    ],
  },
  rows: [
    { country: "Japan", iso3: "JPN", year: 1960, value: 60 },
    { country: "Italy", iso3: "ITA", year: 1960, value: 61 },
  ],
  citations: [],
  verification: null,
  ts: "2026-10-24",
};
it("describes focus and calendar changes from the actual chart, without claiming a fresh fetch", () => {
  expect(
    describeChange(
      before,
      editView(before, { kind: "series", name: "Japan" })!,
    ),
  ).toBe("Focused Japan; 1 series hidden.");
  expect(describeChange(before, editView(before, { kind: "recent" })!)).toBe(
    "Period 1960–2024 → 2024–2024.",
  );
});
it("distinguishes new evidence, changed values and narrative-only edits", () => {
  expect(describeChange(null, before)).toBe(
    "Loaded 2 source rows; charted 2 series.",
  );
  expect(describeChange(before, { ...before, answer: "New finding" })).toBe(
    "Updated answer; chart unchanged.",
  );
  expect(
    describeChange(before, {
      ...before,
      rows: before.rows.map((r) => ({ ...r, value: 62 })),
    }),
  ).toBe("Updated source values.");
  expect(
    describeChange(before, { ...before, rows: [...before.rows].reverse() }),
  ).toBe("No change to the result.");
});
it("does not interpret a numeric scatter axis as time", () => {
  const scatter = {
    ...before,
    spec: { ...before.spec!, type: "scatter" as const },
  };
  const next = {
    ...scatter,
    spec: {
      ...scatter.spec,
      series: [
        { name: "Japan", data: [[2000, 82]] as [number, number][] },
        { name: "Italy", data: [[2000, 80]] as [number, number][] },
      ],
    },
  };
  expect(describeChange(scatter, next)).toBe("Updated chart.");
});
it("names a replacement category without presenting it as a filtered subset", () => {
  const a = {
    ...before,
    spec: {
      type: "bar" as const,
      title: "Values",
      series: [{ name: "Value", data: [["Japan", 10]] as [string, number][] }],
    },
  };
  const b = {
    ...a,
    spec: {
      ...a.spec,
      series: [{ name: "Value", data: [["Italy", 20]] as [string, number][] }],
    },
  };
  expect(describeChange(a, b)).toBe("Categories now Italy.");
});
