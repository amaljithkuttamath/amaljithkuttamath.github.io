import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { bootRadar } from "./boot";
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});
function openArchive(receipt: unknown) {
  dom = new JSDOM(
    `<main>
    <span id="radar-status">Reading publication…</span><time id="radar-date"></time>
    <div id="radar-brief"></div><span id="evidence-count"></span>
    <div id="source-filters"></div><input id="evidence-search" />
    <select id="evidence-sort"><option>score</option></select><select id="minimum-score"><option value="0">All</option></select>
    <div id="evidence-result"></div><div id="evidence-list"></div><button id="evidence-more"></button>
    <input id="archive-search" /><div id="archive-result"></div><div id="archive-list"></div>
    <button id="radar-refresh"></button></main>`,
    { url: "https://example.org/radar#archive" },
  );
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("location", dom.window.location);
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        url.endsWith("publication.json")
          ? JSON.stringify(receipt)
          : url.endsWith("state.json")
            ? "{}"
            : "",
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  bootRadar();
  return fetcher;
}
it("shows receipt metadata when opening Archive without fetching the briefing", async () => {
  const fetcher = openArchive({
    report: "reports/2026-10-24-digest.md",
    published_at: "2026-10-24T05:23:15Z",
  });
  await vi.waitFor(() =>
    expect(dom.window.document.getElementById("radar-date")?.textContent).toBe(
      "October 24, 2026",
    ),
  );
  expect(
    dom.window.document.getElementById("radar-status")?.textContent,
  ).toMatch(/^Published/);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("latest.md"))).toBe(
    false,
  );
});
it("settles the metadata loading state when the receipt is malformed", async () => {
  openArchive({ report: "not-an-edition" });
  await vi.waitFor(() =>
    expect(
      dom.window.document.getElementById("radar-status")?.textContent,
    ).toBe("Publication time unavailable"),
  );
});
