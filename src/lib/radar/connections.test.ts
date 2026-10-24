import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { CONNECTIONS, connectionsAt } from "./connections";
import { renderEvolution } from "./evolution";
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});
const setup = () => {
  dom = new JSDOM('<div id="host"></div>');
  vi.stubGlobal("document", dom.window.document);
  return dom.window.document.getElementById("host")!;
};
it("gates connections by both paper publication dates, never by traction", () => {
  expect(connectionsAt("2026-10-12")).toEqual([]);
  expect(connectionsAt("2026-10-13").map((c) => c.id)).toEqual([
    "flashvsr-hybrid",
  ]);
  expect(connectionsAt("2026-10-20")).toHaveLength(2);
  expect(connectionsAt("2026-10-21")).toHaveLength(3);
  for (const c of CONNECTIONS) {
    expect(new URL(c.evidence.url).hostname).toBe("arxiv.org");
    expect(c.evidence.section).toBeTruthy();
    expect(c.evidence.quote.split(" ").length).toBeLessThan(26);
    expect(c.earlier.date < c.later.date).toBe(true);
  }
});
it("shows reasons without hover and opens the supporting passage with the right caveat", () => {
  const host = setup();
  renderEvolution(host, ["2026-10-24"], "2026-10-24", new Map(), vi.fn());
  expect(host.querySelectorAll(".connection-reason")).toHaveLength(3);
  expect(host.textContent).toContain("independent and concurrent");
  const button = host.querySelector<HTMLButtonElement>(
    '[data-connection="agents-orchestration"]',
  )!;
  button.click();
  expect(host.querySelector(".connection-evidence")?.textContent).toContain(
    "built on Agents-A1",
  );
  expect(
    host.querySelector(".connection-evidence a")?.getAttribute("href"),
  ).toBe("https://arxiv.org/html/2610.28578v1");
  expect(
    dom.window.document.activeElement?.getAttribute("data-connection"),
  ).toBe("agents-orchestration");
});
it("retains dated activity as a separate view and returns to connections", () => {
  const host = setup();
  const onDate = vi.fn();
  const dates = ["2026-10-24", "2026-10-23"];
  renderEvolution(host, dates, dates[0], new Map(), onDate);
  host
    .querySelector<HTMLButtonElement>('[data-connection-date="2026-10-23"]')!
    .click();
  expect(onDate).toHaveBeenCalledWith("2026-10-23");
  host.querySelector<HTMLButtonElement>("[data-show-tracking]")!.click();
  expect(host.querySelector(".thread-map")).toBeTruthy();
  host.querySelector<HTMLButtonElement>(".connection-toolbar button")!.click();
  expect(host.querySelectorAll(".connection-row")).toHaveLength(3);
});
it("does not manufacture edges for dates without reviewed sources", () => {
  const host = setup();
  renderEvolution(host, ["2026-10-01"], "2026-10-01", new Map(), vi.fn());
  expect(host.querySelectorAll(".connection-row")).toHaveLength(0);
  expect(host.textContent).toContain("No source-checked connections");
});
