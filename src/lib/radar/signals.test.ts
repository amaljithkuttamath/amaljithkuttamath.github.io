import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { mountSignals } from "./signals";
import {
  researchField,
  nearestPoint,
  directionalPoint,
  FIELD_WIDTH,
  FIELD_HEIGHT,
} from "./field";
import { parseState } from "./data";
const rows = parseState({
  "ghrepo:a": {
    title: "A — <img src=x onerror=alert(1)>",
    url: "https://github.com/a",
    score: 4,
    first_seen: "2026-10-24",
  },
  "ghrepo:b": { title: "B", url: "https://github.com/b", score: 4 },
  "ghrepo:c": { title: "C", url: "https://github.com/c", score: 3 },
  "hfmodel:d": { title: "D", url: "https://huggingface.co/d", score: 2 },
});
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});
it("represents every observation once and preserves identity when regrouping", () => {
  for (const mode of ["source", "score"] as const) {
    const field = researchField(rows, mode);
    expect(field.points.map((p) => p.row.id).sort()).toEqual(
      rows.map((r) => r.id).sort(),
    );
    expect(field.groups.reduce((sum, g) => sum + g.count, 0)).toBe(rows.length);
    expect(
      field.points.every(
        (p) => p.x > 0 && p.x < FIELD_WIDTH && p.y > 0 && p.y < FIELD_HEIGHT,
      ),
    ).toBe(true);
    expect(researchField(rows, mode)).toEqual(field);
  }
});
it("keeps a dense feed inside non-overlapping category boundaries", () => {
  const dense = Array.from({ length: 600 }, (_, i) => ({
    ...rows[i % rows.length],
    id: String(i),
    group: ["Papers", "Code", "Models", "Datasets", "Lab posts", "Other"][
      i % 6
    ],
    score: i % 6,
  }));
  for (const mode of ["source", "score"] as const) {
    const mobile = researchField(dense, mode, 310, 190);
    expect(mobile.points).toHaveLength(600);
    expect(
      mobile.points.every((p) => p.x > 0 && p.x < 310 && p.y > 0 && p.y < 190),
    ).toBe(true);
    const field = researchField(dense, mode);
    expect(field.points).toHaveLength(600);
    field.groups.forEach((g, i) => {
      expect(g.x - g.radius).toBeGreaterThanOrEqual(0);
      expect(g.y + g.radius).toBeLessThanOrEqual(FIELD_HEIGHT);
      field.groups
        .slice(i + 1)
        .forEach((h) =>
          expect(Math.hypot(g.x - h.x, g.y - h.y)).toBeGreaterThan(
            g.radius + h.radius,
          ),
        );
    });
  }
});
it("finds the closest observation and moves spatially with the keyboard", () => {
  const field = researchField(rows, "source"),
    p = field.points[0];
  expect(nearestPoint(field.points, p.x, p.y)?.row.id).toBe(p.row.id);
  expect(
    directionalPoint(field.points, p, "ArrowRight").x,
  ).toBeGreaterThanOrEqual(p.x);
  expect(nearestPoint([], 0, 0)).toBeUndefined();
});
it("retains selection across layouts, escapes titles, and supports keyboard/list access", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  const explore = vi.fn();
  mountSignals(rows, explore);
  const $ = (id: string) => dom.window.document.getElementById(id)!;
  const svg = dom.window.document.querySelector("svg")!;
  expect(svg.querySelectorAll('[role="option"]')).toHaveLength(4);
  expect($("signal-item").querySelector("img")).toBeNull();
  expect($("signal-item").textContent).toContain("<img");
  const before = svg.getAttribute("aria-activedescendant");
  (
    dom.window.document.querySelector(
      '[data-arrangement="score"]',
    ) as HTMLButtonElement
  ).click();
  expect(svg.getAttribute("aria-activedescendant")).toBe(before);
  svg.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
  );
  expect(svg.getAttribute("aria-activedescendant")).not.toBe(before);
  expect(svg.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  const model = dom.window.document.querySelector(
    '[data-observation="hfmodel:d"]',
  )!;
  model.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  $("signal-explore").click();
  expect(explore).toHaveBeenCalledWith("Models", 0);
});
it("handles an empty feed without inventing observations", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  mountSignals([], vi.fn());
  expect(dom.window.document.body.textContent).toContain("No observations yet");
  expect(dom.window.document.querySelector("svg")).toBeNull();
});

it("shows ranked titles without hovering, opens details, and restores the shortlist", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  const explore = vi.fn();
  mountSignals([...rows].reverse(), explore);
  const doc = dom.window.document;
  const highlights = doc.getElementById("signal-highlights")!;
  const detail = doc.getElementById("signal-detail")!;
  const buttons = [
    ...doc.querySelectorAll<HTMLButtonElement>("[data-highlight]"),
  ];
  expect(highlights.hidden).toBe(false);
  expect(detail.hidden).toBe(true);
  expect(buttons.map((b) => b.dataset.highlight)).toEqual([
    "ghrepo:a",
    "ghrepo:b",
    "ghrepo:c",
  ]);
  expect(highlights.textContent).toContain("4/5");
  expect(highlights.querySelector("img")).toBeNull();
  expect(highlights.textContent).toContain("No change or use-case note");
  buttons[1].click();
  expect(highlights.hidden).toBe(true);
  expect(detail.hidden).toBe(false);
  expect(doc.getElementById("signal-source")!.getAttribute("href")).toBe(
    "https://github.com/b",
  );
  (
    doc.querySelector('[data-arrangement="score"]') as HTMLButtonElement
  ).click();
  expect(detail.hidden).toBe(false);
  expect(doc.getElementById("signal-source")!.getAttribute("href")).toBe(
    "https://github.com/b",
  );
  doc.getElementById("signal-back")!.click();
  expect(highlights.hidden).toBe(false);
  expect(detail.hidden).toBe(true);
  expect(doc.activeElement).toBe(buttons[1]);
  doc.getElementById("signal-all-highlights")!.click();
  expect(explore).toHaveBeenCalledWith("All", 3);
});
it("includes tied scores in the evidence handoff and handles a single observation", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  const explore = vi.fn();
  const tied = rows.map((row) => ({ ...row, score: 4 }));
  mountSignals(tied, explore);
  const all = dom.window.document.getElementById("signal-all-highlights")!;
  expect(all.textContent).toBe("See all 4");
  all.click();
  expect(explore).toHaveBeenCalledWith("All", 4);
  mountSignals([rows[0]], explore);
  expect(dom.window.document.querySelectorAll("[data-highlight]")).toHaveLength(
    1,
  );
  expect(
    dom.window.document.getElementById("signal-all-highlights")!.textContent,
  ).toBe("See all 1");
});

it("shows published context instead of repo slogans, escaping external notes", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  mountSignals(
    rows,
    vi.fn(),
    new Map([
      [rows[0].url, "Tests structured choices. <img src=x onerror=alert(1)>"],
    ]),
  );
  const highlights = dom.window.document.getElementById("signal-highlights")!;
  expect(highlights.textContent).toContain("Tests structured choices.");
  expect(highlights.querySelector("img")).toBeNull();
  expect(highlights.querySelectorAll(".highlight-description")).toHaveLength(3);
});
