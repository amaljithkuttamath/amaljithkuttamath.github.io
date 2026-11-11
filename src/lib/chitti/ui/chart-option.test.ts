// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildOption, usesEndLabels, CHART_FALLBACK, END_LABEL_MAX } from "./chart-option";
import type { ChartSpec } from "../core";

const line = (n: number): ChartSpec => ({
  type: "line",
  title: "t",
  x_axis: "Year",
  y_axis: "years",
  series: Array.from({ length: n }, (_, i) => ({ name: `S${i}`, data: [[2000, i], [2001, i + 1.25]] as [number, number][] })),
});
afterEach(() => document.documentElement.removeAttribute("style"));

describe("line charts label their series at the right end instead of a legend", () => {
  it("uses end labels (name in the series colour + last value) and hides the legend up to the limit", () => {
    const option: any = buildOption(line(3));
    expect(usesEndLabels(line(3))).toBe(true);
    expect(option.legend.show).toBe(false);
    const s = option.series[1];
    expect(s.endLabel.show).toBe(true);
    expect(s.endLabel.formatter({ value: 2.25 })).toBe("{n|S1} {v|2.3}");
    expect(s.endLabel.rich.n.color).toBe(s.lineStyle.color);
  });
  it("falls back to a legend past the limit, and never end-labels bars", () => {
    const many: any = buildOption(line(END_LABEL_MAX + 1));
    expect(usesEndLabels(line(END_LABEL_MAX + 1))).toBe(false);
    expect(many.legend.show).not.toBe(false);
    expect(many.series[0].endLabel.show).toBe(false);
    expect(usesEndLabels({ ...line(2), type: "bar" })).toBe(false);
  });
});

describe("the chart palette comes from the page's --chart-N variables", () => {
  it("reads --chart-N from the document and falls back to the dark set", () => {
    expect(CHART_FALLBACK).toHaveLength(8);
    expect(new Set(CHART_FALLBACK).size).toBe(8);
    expect((buildOption(line(1)) as any).color[0]).toBe(CHART_FALLBACK[0]);
    document.documentElement.style.setProperty("--chart-1", "#123456");
    expect((buildOption(line(1)) as any).color[0]).toBe("#123456");
  });
});
