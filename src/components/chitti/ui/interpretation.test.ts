import { describe, expect, it } from "vitest";
import { followUps, interpret, provenance, seriesStats } from "./interpretation";
import type { ShareStateV1 } from "../../../lib/chitti/share";

const citation = {
  id: "c1", source: "worldbank" as const, sourceLabel: "World Bank Open Data", indicatorId: "SP.DYN.LE00.IN",
  indicatorName: "Life expectancy at birth, total (years)", url: "https://data.worldbank.org/indicator/SP.DYN.LE00.IN",
  countries: ["JPN", "ITA"], yearRange: { start: 1960, end: 2023 }, fetchedAt: "2026-11-11T10:00:00.000Z", rowCount: 4, cached: false,
};
const result: ShareStateV1 = {
  v: 1, q: "q", answer: "", verification: null, ts: "2026-11-11T10:00:00.000Z",
  spec: { type: "line", title: "Life expectancy", x_axis: "Year", y_axis: "years", series: [
    { name: "Japan", data: [[1960, 67.7], [2023, 84.1]] },
    { name: "Italy", data: [[1960, 69.1], [2023, 83.5]] },
  ] },
  rows: [
    { country: "Japan", iso3: "JPN", year: 1960, value: 67.7, indicator: "SP.DYN.LE00.IN" },
    { country: "Japan", iso3: "JPN", year: 2023, value: 84.1, indicator: "SP.DYN.LE00.IN" },
    { country: "Italy", iso3: "ITA", year: 2022, value: 83.5, indicator: "SP.DYN.LE00.IN" },
  ],
  citations: [citation],
};
const direct = {
  plan: { indicatorQuery: "life expectancy", countries: ["JPN", "ITA"], countryNames: ["Japan", "Italy"], yearStart: 1960, chartType: "line" as const },
  series: { id: "SP.DYN.LE00.IN", name: "Life expectancy at birth, total (years)", source: "worldbank" },
  alternatives: [],
};

describe("the token row", () => {
  it("is live on a direct answer, with one country token per series and the years plotted", () => {
    const view = interpret(result, direct);
    expect(view.live).toBe(true);
    expect(view.indicator).toEqual({ name: direct.series.name, id: "SP.DYN.LE00.IN" });
    expect(view.series.map((s) => [s.name, s.iso3])).toEqual([["Japan", "JPN"], ["Italy", "ITA"]]);
    expect(view.series[0].color).toMatch(/^var\(--chart-[1-8]\)$/);
    expect(view.years).toEqual({ start: 1960, end: 2023 });
  });
  it("is read-only on a model answer, derived from its single cited indicator", () => {
    const view = interpret(result);
    expect(view.live).toBe(false);
    expect(view.indicator?.id).toBe("SP.DYN.LE00.IN");
    expect(interpret({ ...result, citations: [citation, { ...citation, id: "c2", indicatorId: "X" }] }).indicator).toBeUndefined();
  });
});

describe("the provenance line", () => {
  it("prints source, series, unit, coverage, latest data year and the retrieval date", () => {
    expect(provenance(result)).toMatchObject({
      source: "World Bank Open Data", id: "SP.DYN.LE00.IN", unit: "years", coverage: "1960–2023", latest: 2023,
      when: "retrieved 11 Nov 2026", url: "https://data.worldbank.org/indicator/SP.DYN.LE00.IN", more: 0,
    });
  });
  it("keeps a snapshot a snapshot", () => {
    const snap = provenance({ ...result, citations: [{ ...citation, mirroredAt: "2026-10-01T00:00:00.000Z" }] });
    expect(snap!.when).toBe("snapshot 1 Oct 2026");
  });
  it("drops an unsafe link and says nothing without a citation", () => {
    expect(provenance({ ...result, citations: [{ ...citation, url: "javascript:alert(1)" }] })!.url).toBeUndefined();
    expect(provenance({ ...result, citations: [] })).toBeNull();
  });
});

describe("panel stats and follow-ups", () => {
  it("reports each series' last value and its change since the first plotted year", () => {
    expect(seriesStats(result.spec).map((s) => [s.name, s.last.value, s.last.year, +s.change.toFixed(1), s.first.year])).toEqual([
      ["Japan", 84.1, 2023, 16.4, 1960],
      ["Italy", 83.5, 2023, 14.4, 1960],
    ]);
  });
  it("offers deterministic view chips with no model, and marks the model ones", () => {
    const chips = followUps(result);
    expect(chips.filter((c) => !c.needsModel).map((c) => c.label)).toEqual(["Last 10 years", "Show as bars"]);
    expect(chips.filter((c) => c.needsModel).length).toBeGreaterThan(0);
    expect(followUps({ ...result, spec: null })).toEqual([]);
  });
});
