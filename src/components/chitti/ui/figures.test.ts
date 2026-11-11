import { describe, expect, it } from "vitest";
import { findingHtml, markFigures } from "./figures";

const S = [
  { name: "Japan", colorIndex: 0 },
  { name: "Italy", colorIndex: 1 },
  { name: "Spain", colorIndex: 2 },
];
const span = (n: number, inner: string) => `<span class="cx-fig" style="--c:var(--chart-${n})">${inner}</span>`;

describe("findingHtml — figures underlined in their series colour", () => {
  it("wraps each name with the figures that follow it", () => {
    const html = findingHtml(
      "Life expectancy rose in all three countries between 1960 and 2023: Japan from 67.86 to 83.68 (+23.3%), Italy from 69.24 to 85.04 (+22.8%) and Spain from 70.4 to 86.14 (+22.4%).",
      S,
    );
    expect(html).toContain(span(1, "Japan from 67.86 to 83.68 (+23.3%)"));
    expect(html).toContain(span(2, "Italy from 69.24 to 85.04 (+22.8%)"));
    expect(html).toContain(span(3, "Spain from 70.4 to 86.14 (+22.4%)"));
  });

  it("handles the per-country verb, years, points and a fall", () => {
    expect(findingHtml("X, 1960 to 2023: Japan rose from 68 to 84 (+23.5%); Italy fell from 70 to 66 (−5.7%).", S)).toContain(
      span(2, "Italy fell from 70 to 66 (−5.7%)"),
    );
    expect(findingHtml("Unemployment in Spain rose from 4 in 2000 to 5 in 2020 (+1 percentage point).", S)).toContain(
      span(3, "Spain rose from 4 in 2000 to 5 in 2020 (+1 percentage point)"),
    );
  });

  it("underlines just the name in free prose, on whole words only", () => {
    const html = findingHtml("Spain overtook Italy; Spainish and Japanese are not names.", S);
    expect(html).toContain(span(3, "Spain") + " overtook " + span(2, "Italy"));
    expect(html).toContain("Spainish and Japanese");
    expect(html.match(/cx-fig/g)).toHaveLength(2);
  });

  it("prefers the longest name and never nests", () => {
    const html = findingHtml("Papua New Guinea and Guinea differ.", [
      { name: "Guinea", colorIndex: 0 },
      { name: "Papua New Guinea", colorIndex: 1 },
    ]);
    expect(html).toBe("<p>" + span(2, "Papua New Guinea") + " and " + span(1, "Guinea") + " differ.</p>");
  });

  it("keeps markdown, links and escaping intact", () => {
    const html = findingHtml("**Japan** leads. See [Spain data](https://example.org/Spain?x=Italy). <b>Italy</b>", S);
    expect(html).toContain("<strong>" + span(1, "Japan") + "</strong>");
    expect(html).toContain('href="https://example.org/Spain?x=Italy"');
    expect(html).toContain("&lt;b&gt;" + span(2, "Italy") + "&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("cannot be steered by sentinels or markup in the text", () => {
    const html = findingHtml('\uE0009\uE001 Japan\uE002 <img src=x onerror=alert(1)> \uE000', S);
    expect(html).not.toMatch(/[\uE000-\uE002]/);
    expect(html).not.toContain("<img");
    expect(html).toContain(span(1, "Japan"));
    expect(html).not.toContain("chart-10");
  });

  it("does nothing without series, and wraps palette slots", () => {
    expect(findingHtml("Japan rose.", [])).toBe("<p>Japan rose.</p>");
    expect(markFigures("Japan", [{ name: "Japan", colorIndex: 9 }])).toBe("\uE0001\uE001Japan\uE002");
    expect(markFigures("A b", [{ name: "A" }])).toBe("A b");
  });
});
