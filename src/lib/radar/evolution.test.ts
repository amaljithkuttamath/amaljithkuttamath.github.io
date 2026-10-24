import { afterEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { digestView } from "./digest";
import { editionEvolution, renderEvolution, sourceIdentity } from "./evolution";
let dom: JSDOM;
afterEach(() => {
  dom?.window.close();
  vi.unstubAllGlobals();
});
function read(body: string, date = "2026-10-23") {
  dom ||= new JSDOM('<div id="host"></div>');
  const digest = digestView(
    `# AI Radar — ${date}\n\nSummary.\n\n${body}`,
    dom.window.document,
  );
  return editionEvolution(digest.root, date);
}
const report = `## What changed

**New today**
- [WeVisOne-VL: Unified Perception](https://arxiv.org/abs/2610.31329) — unified VLM

**Climbing**
- [Jeva: System One Models](http://arxiv.org/abs/2610.18773v1) — traction +0.8%

**Cooled**
- [VX-One: Typed Decision Heads](https://arxiv.org/abs/2610.30090) — score −1, traction +0.3%

## Story arcs
- [Unrelated](https://example.org/unrelated) — traction +80% since first seen.
`;
it("extracts explicit reported moves and preserves score drops with positive traction", () => {
  dom = new JSDOM("");
  const data = read(report);
  expect(data.known).toEqual({ new: true, gaining: true, fading: true });
  expect(data.buckets.new).toHaveLength(1);
  expect(data.buckets.gaining[0].detail).toBe("traction +0.8%");
  expect(data.buckets.fading[0].detail).toBe("score −1, traction +0.3%");
  expect(JSON.stringify(data)).not.toContain("Unrelated");
});
it("distinguishes explicit zero moves from missing change data", () => {
  dom = new JSDOM("");
  expect(
    read(
      "## What changed\nNo new, climbing, or cooled items detected since the previous run.",
    ).known,
  ).toEqual({ new: true, gaining: true, fading: true });
  expect(read("## Story arcs\nNo changes here.").known).toEqual({
    new: false,
    gaining: false,
    fading: false,
  });
  expect(
    read(
      "## What changed\n### New today\nNone reported.\n## Main list\n### Cooled\n- [A](https://example.org/a)",
    ).known,
  ).toEqual({ new: true, gaining: false, fading: false });
});
it("deduplicates arXiv versions, preserves safe source identities, and rejects unsafe URLs", () => {
  dom = new JSDOM("");
  const data = read(
    "## What changed\n### New today\n- [A](http://arxiv.org/abs/1234.56789v1)\n- [A again](https://arxiv.org/abs/1234.56789)\n- [Unsafe](javascript:alert(1))",
  );
  expect(data.buckets.new).toHaveLength(1);
  expect(sourceIdentity("https://arxiv.org/pdf/1234.56789v2.pdf")).toBe(
    "arxiv:1234.56789",
  );
  expect(sourceIdentity("https://example.org/a")).not.toBe(
    sourceIdentity("https://example.org/ab"),
  );
});
it("traces a named item across dates without turning missing observations into declines", () => {
  dom = new JSDOM('<div id="host"></div>');
  vi.stubGlobal("document", dom.window.document);
  const current = read(report),
    earlier = read(
      "## What changed\n### Cooled\n- [Jeva](https://arxiv.org/abs/2610.18773) — traction −0.9%",
      "2026-10-22",
    );
  const host = dom.window.document.getElementById("host")!;
  const onDate = vi.fn();
  const editions = new Map([
    [current.date, current],
    [earlier.date, earlier],
    ["2026-10-21", null],
  ]);
  const dates = ["2026-10-23", "2026-10-22", "2026-10-21"];
  renderEvolution(host, dates, current.date, editions, onDate);
  expect(host.querySelectorAll(".evolution-summary")).toHaveLength(3);
  (
    host.querySelector('[data-trace="arxiv:2610.18773"]') as HTMLButtonElement
  ).click();
  expect(host.textContent).toContain("Gaining traction +0.8%");
  expect(host.textContent).toContain("Fading traction −0.9%");
  expect(host.textContent).toContain("No matching change recorded");
  expect(host.querySelector(".evolution-path")).toBeNull();
  expect(
    host.querySelector(".evolution-detail-head a")!.getAttribute("href"),
  ).toBe("http://arxiv.org/abs/2610.18773v1");
  const dateButton = host.querySelector(
    '[data-evolution-date="2026-10-23"]',
  ) as HTMLButtonElement;
  dateButton.focus();
  dateButton.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
    }),
  );
  expect(onDate).toHaveBeenCalledWith("2026-10-22");
  renderEvolution(host, dates, earlier.date, editions, onDate);
  expect(host.dataset.trace).toBe("arxiv:2610.18773");
  expect(
    dom.window.document.activeElement?.getAttribute("data-evolution-date"),
  ).toBe("2026-10-22");
  renderEvolution(
    host,
    ["2026-10-20"],
    "2026-10-20",
    new Map([["2026-10-20", null]]),
    onDate,
  );
  expect(host.querySelector(".evolution-details h3")!.textContent).toBe("Jeva");
  expect(host.querySelector(".evolution-path")).toBeNull();
  (host.querySelector("[data-reset]") as HTMLButtonElement).click();
  expect(host.querySelectorAll(".evolution-summary")).toHaveLength(3);
});
