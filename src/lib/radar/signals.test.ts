import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { signalCells, mountSignals } from "./signals";
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
it("counts cumulative thresholds within each source without mutating observations", () => {
  const cells = signalCells(rows);
  expect(
    cells.filter((c) => c.group === "Code").map((c) => c.rows.length),
  ).toEqual([3, 3, 2]);
  expect(
    cells.filter((c) => c.group === "Models").map((c) => c.rows.length),
  ).toEqual([1, 0, 0]);
  expect(rows).toHaveLength(4);
});
it("inspects actual observations, bounds navigation, and passes the exact selected filters", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  const explore = vi.fn();
  mountSignals(rows, explore);
  const $ = (id: string) => dom.window.document.getElementById(id)!;
  expect($("signal-prev").hasAttribute("disabled")).toBe(true);
  expect($("signal-item").querySelector("img")).toBeNull();
  expect($("signal-item").textContent).toContain("<img");
  $("signal-next").click();
  expect($("signal-position").textContent).toBe("2 / 2");
  expect($("signal-next").hasAttribute("disabled")).toBe(true);
  $("signal-explore").click();
  expect(explore).toHaveBeenLastCalledWith("Code", 4);
  (
    dom.window.document.querySelector('[data-cell="3"]') as HTMLButtonElement
  ).click();
  expect($("signal-position").textContent).toBe("1 / 1");
  $("signal-explore").click();
  expect(explore).toHaveBeenLastCalledWith("Models", 0);
});
it("handles an empty feed without inventing a selection", () => {
  dom = new JSDOM(
    '<span id="signal-total"></span><div id="signal-workspace"></div>',
  );
  vi.stubGlobal("document", dom.window.document);
  mountSignals([], vi.fn());
  expect(dom.window.document.body.textContent).toContain("No observations yet");
  expect(dom.window.document.querySelector("button")).toBeNull();
});
