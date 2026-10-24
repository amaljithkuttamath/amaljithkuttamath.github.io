import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { bootRadar } from "./boot";
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});
function openArchive(
  receipt: unknown,
  archive = "",
  state = "{}",
  failNotes = false,
  reportBodies: Record<string, string> = {},
) {
  dom = new JSDOM(
    `<main>
    <span id="radar-status">Reading publication…</span><time id="radar-date"></time>
    <h2 id="signal-title"></h2><div id="evolution-workspace"></div><button data-signal-view="evolution"></button><button data-signal-view="observations"></button><span id="signal-total"></span><div id="signal-workspace"></div><div id="radar-brief"></div><span id="evidence-count"></span>
    <div id="source-filters"></div><input id="evidence-search" />
    <select id="evidence-sort"><option>score</option></select><select id="minimum-score"><option value="0">All</option></select>
    <div id="evidence-result"></div><div id="evidence-list"></div><button id="evidence-more"></button>
    <input id="archive-search" /><div id="archive-result"></div><div id="archive-list"></div>
    <nav id="radar-timeline"></nav><button id="radar-refresh"></button></main>`,
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
            ? state
            : url.endsWith("README.md")
              ? archive
              : /^.*reports\/\d{4}-\d{2}-\d{2}-digest.md$/.test(url)
                ? `# AI Radar — ${url.match(/(\d{4}-\d{2}-\d{2})-digest/)![1]}\n\nPublished summary.\n\n${reportBodies[url.match(/(\d{4}-\d{2}-\d{2})-digest/)![1]] || ""}`
                : "",
        { status: failNotes && url.endsWith("latest.md") ? 503 : 200 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  bootRadar();
  return fetcher;
}
it("shows receipt metadata while separately loading latest notes for the current feed", async () => {
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
    true,
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

it("exposes real edition dates and navigates the timeline across missing days", async () => {
  const fetcher = openArchive(
    { report: "reports/2026-10-24-digest.md" },
    "| [2026-10-24](2026-10-24-digest.md) | Latest |\n| [2026-10-22](2026-10-22-digest.md) | Earlier |\n| [2026-10-21](2026-10-21-digest.md) | First |",
  );
  const doc = dom.window.document;
  await vi.waitFor(() =>
    expect(doc.querySelectorAll("#radar-timeline a")).toHaveLength(3),
  );
  expect(doc.querySelector("#radar-timeline [aria-current]")!.textContent).toBe(
    "10/24",
  );
  expect(
    (doc.querySelector('[aria-label="Next edition"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  (
    doc.querySelector('[aria-label="Previous edition"]') as HTMLButtonElement
  ).click();
  await vi.waitFor(() =>
    expect(dom.window.location.hash).toBe("#briefing/2026-10-22"),
  );
  await vi.waitFor(() =>
    expect(doc.getElementById("radar-date")!.textContent).toBe(
      "October 22, 2026",
    ),
  );
  expect(
    fetcher.mock.calls.some(([url]) => url.endsWith("2026-10-22-digest.md")),
  ).toBe(true);
  expect(doc.querySelector("#radar-timeline [aria-current]")!.textContent).toBe(
    "10/22",
  );
  expect(doc.querySelector('[href="#briefing/2026-10-23"]')).toBeNull();
});

it("keeps observations usable when published context cannot be fetched", async () => {
  openArchive(
    {},
    "",
    JSON.stringify({
      "ghrepo:a": { title: "A", url: "https://github.com/a", score: 4 },
    }),
    true,
  );
  const doc = dom.window.document;
  await vi.waitFor(() =>
    expect(doc.getElementById("evidence-result")!.textContent).toBe(
      "1 matching items / 1 observed",
    ),
  );
  expect(doc.getElementById("signal-highlights")!.textContent).toContain(
    "No change or use-case note in the latest briefing.",
  );
  expect(doc.querySelector("#evidence-list a")!.getAttribute("href")).toBe(
    "https://github.com/a",
  );
});

it("updates movement summaries and preserves the observation view while stepping through editions", async () => {
  openArchive(
    {},
    "| [2026-10-24](2026-10-24-digest.md) | Latest |\n| [2026-10-23](2026-10-23-digest.md) | Earlier |",
    "{}",
    false,
    {
      "2026-10-24":
        "## What changed\nNo new, climbing, or cooled items detected since the previous run.",
      "2026-10-23":
        "## What changed\n### New today\n- [New work](https://example.com/new) — benchmark\n### Climbing\n- [Rising work](https://example.com/rising) — traction +2.9%\n### Cooled\n- [Cooling work](https://example.com/cooling) — score −1, traction +0.3%",
    },
  );
  const doc = dom.window.document;
  await vi.waitFor(() =>
    expect(doc.querySelectorAll(".thread-name")).toHaveLength(3),
  );
  (
    doc.querySelector('[data-evolution-date="2026-10-23"]') as HTMLButtonElement
  ).click();
  await vi.waitFor(() =>
    expect(doc.querySelector(".thread-name")!.textContent).toContain(
      "Cooling work",
    ),
  );
  (
    doc.querySelector(
      '[data-trace="https://example.com/cooling"]',
    ) as HTMLButtonElement
  ).click();
  expect(doc.querySelector(".evolution-details")!.textContent).toContain(
    "score −1, traction +0.3%",
  );
  await vi.waitFor(() =>
    expect(
      doc
        .querySelector("[data-evolution-date][aria-current]")!
        .getAttribute("data-evolution-date"),
    ).toBe("2026-10-23"),
  );
  (
    doc.querySelector('[data-signal-view="observations"]') as HTMLButtonElement
  ).click();
  expect(doc.getElementById("evolution-workspace")!.hidden).toBe(true);
  expect(doc.getElementById("signal-workspace")!.hidden).toBe(false);
  expect(doc.getElementById("radar-timeline")!.hidden).toBe(false);
  (
    doc.querySelector('[data-signal-view="evolution"]') as HTMLButtonElement
  ).click();
  expect(doc.getElementById("evolution-workspace")!.hidden).toBe(false);
  expect(doc.getElementById("radar-timeline")!.hidden).toBe(true);
});
