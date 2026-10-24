import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  ageLabel,
  parseState,
  parseArchive,
  filterRows,
  safeURL,
  validDate,
} from "./data";
import { digestView } from "./digest";
const date = "2026-10-24";
describe("Radar publication data", () => {
  it("does not invent a publication time from a date or show negative ages", () => {
    expect(
      ageLabel("2026-10-24T13:00:00Z", Date.parse("2026-10-24T05:00:00Z")),
    ).toBe("Time unavailable");
    expect(ageLabel(undefined)).toBe("Time unavailable");
    expect(
      ageLabel("2026-10-24T04:30:00Z", Date.parse("2026-10-24T05:00:00Z")),
    ).toBe("Less than an hour ago");
  });
  it("rejects malformed dates and unsafe URLs", () => {
    expect(validDate("2026-02-30")).toBe(false);
    expect(safeURL("javascript:alert(1)")).toBe(null);
    expect(safeURL("https://example.org")).toBe("https://example.org/");
  });
  it("normalizes real observations and ignores hostile or malformed entries", () => {
    const rows = parseState({
      "arxiv:1": {
        title: "Paper",
        url: "https://arxiv.org/abs/1",
        score: 4,
        first_seen: date,
        last_seen: date,
        mag_history: [2, 4, "bad"],
      },
      "ghrepo:2": { title: "Tool", url: "https://github.com/x/y", score: 2 },
      evil: { title: "Evil", url: "javascript:bad" },
      empty: null,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].history).toEqual([2, 4]);
    expect(filterRows(rows, "", "Papers")).toHaveLength(1);
    expect(filterRows(rows, "tool")).toHaveLength(1);
    expect(filterRows(rows, "", "All", "score", true)).toHaveLength(1);
  });
  it("parses archived editions without trusting their destinations", () => {
    expect(
      parseArchive(
        "| [2026-10-24](javascript:bad) | A **real** brief |\n| [2026-02-30](x) | invalid |",
      ),
    ).toEqual([{ date, teaser: "A real brief" }]);
  });
  it("summarizes current Markdown formats and keeps the full edition", () => {
    const dom = new JSDOM();
    const d = digestView(
      "# AI Radar — 2026-10-24\n\nA current lead.\n\n## Main list\n\n**[A source](https://example.org)** — Description.\n\n## Action items\n\n1. Read the source.",
      dom.window.document,
    );
    expect(d.lead).toBe("A current lead.");
    expect(d.stories[0].body).toBe("Description.");
    expect(d.actions).toContain("Read the source");
    expect(d.root.textContent).toContain("Main list");
    dom.window.close();
  });
  it("sanitizes scripts, remote pixels, handlers, and unsafe links", () => {
    const dom = new JSDOM();
    const d = digestView(
      '# AI Radar — 2026-10-24\n\n<img src="https://tracker.example" onerror="bad()"><script>bad()</script>\n\n[Bad](javascript:alert(1)) [Good](https://example.org)',
      dom.window.document,
    );
    expect(
      d.root.querySelector('img,script,[onerror],a[href^="javascript:"]'),
    ).toBeNull();
    expect(
      d.root.querySelector('a[href="https://example.org/"]'),
    ).not.toBeNull();
    dom.window.close();
  });
  it("preserves fallback notices and handles older bold sections", () => {
    const dom = new JSDOM();
    const d = digestView(
      "# AI Radar — 2026-10-24\n\n> Degraded run: no model synthesis\n\nA fallback.\n\n**Action items**\n\n- Read.",
      dom.window.document,
    );
    expect(d.degraded).toBe(true);
    expect(d.actions).toContain("Read");
    expect(d.root.querySelector("blockquote")).not.toBeNull();
    dom.window.close();
  });
});
