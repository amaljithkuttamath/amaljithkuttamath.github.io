import { describe, expect, it } from "vitest";
import { applySuggestion, fragmentOf, pinnedPlan, preview, suggest, type IndicatorSuggestion } from "./suggest";

describe("type-ahead suggestions (offline)", () => {
  it("finds the phrase being typed after the last boundary word", () => {
    expect(fragmentOf("life expectancy in Jap")).toEqual({ fragment: "Jap", start: 19 });
    expect(fragmentOf("child mort")).toEqual({ fragment: "child mort", start: 0 });
    expect(fragmentOf("since 1990 ").fragment).toBe("");
  });
  it("offers countries for a country prefix, never one already named", () => {
    const names = suggest("Compare life expectancy in Japan, Italy and Spa").map((s) => s.name);
    expect(names).toContain("Spain");
    expect(suggest("life expectancy in Japan and Jap").map((s) => s.name)).not.toContain("Japan");
  });
  it("offers indicators and explains a match made through an alias or group word", () => {
    const list = suggest("child mort");
    const under5 = list.find((s) => s.kind === "indicator" && s.id === "SH.DYN.MORT") as IndicatorSuggestion;
    expect(under5).toBeTruthy();
    expect(under5.alsoCalled).toBe("child mortality");
    const gdp = suggest("gdp per").find((s) => s.id === "NY.GDP.PCAP.CD") as IndicatorSuggestion;
    expect(gdp.alsoCalled).toBeUndefined();
    expect(gdp.insert).toBe("GDP per capita");
  });
  it("replaces only the fragment when a suggestion is chosen", () => {
    const [spain] = suggest("life expectancy in Spa");
    expect(applySuggestion("life expectancy in Spa", spain)).toBe("life expectancy in Spain ");
  });
  it("returns nothing for one character or a trailing space", () => {
    expect(suggest("J")).toEqual([]);
    expect(suggest("life expectancy in ")).toEqual([]);
  });
});

describe("what sending will do", () => {
  it("says a direct question is answered with no key, naming the source", () => {
    expect(preview("Compare life expectancy in Japan, Italy and Spain since 1960", undefined, false)).toEqual({ kind: "direct", source: "World Bank" });
  });
  it("says an ambiguous phrase needs a choice", () => {
    expect(preview("rural population of India", undefined, false)).toEqual({ kind: "choose" });
  });
  it("says 'needs a model' only when no model is connected", () => {
    expect(preview("Why did inflation spike in Argentina?", undefined, false)).toEqual({ kind: "model" });
    expect(preview("Why did inflation spike in Argentina?", undefined, true)).toBeNull();
  });
  it("treats a picked series as the user's choice while its phrase is still in the message", () => {
    const pick = suggest("gdp per").find((s) => s.id === "NY.GDP.PCAP.CN") as IndicatorSuggestion;
    expect(pick.insert).toBe("GDP per capita");
    expect(pinnedPlan("GDP per capita of India since 2000", pick)).toMatchObject({ countries: ["IND"], yearStart: 2000 });
    expect(pinnedPlan("inflation of India", pick)).toBeNull();
    expect(preview("GDP per capita of India", undefined, false, pick)).toEqual({ kind: "direct", source: "World Bank" });
  });
});
