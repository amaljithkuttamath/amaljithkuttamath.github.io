// @vitest-environment jsdom
// The redesign's own flows, end to end through the real workspace: the
// ambiguity choice, editable tokens on a direct answer, type-ahead, the chart
// panel, and the model path's thinking block.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
vi.mock("./Chart", () => ({ default: ({ spec }: any) => <div role="img" aria-label={`chart ${spec.title}`}>Chart rendered</div> }));
vi.mock("../../lib/chitti/fastpath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chitti/fastpath")>()),
  runFastPath: vi.fn(),
}));
vi.mock("../../lib/chitti/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chitti/session")>()),
  createSession: vi.fn(),
}));
import Workspace from "./Workspace";
import { runFastPath, parseFastPath, type SeriesCandidate } from "../../lib/chitti/fastpath";
import { createSession, type ChittiSession } from "../../lib/chitti/session";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
const box = () => screen.getByRole("combobox", { name: "Ask a data question" }) as HTMLTextAreaElement;
const send = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};
const citation = (id: string) => ({
  id: `worldbank:${id}`, source: "worldbank" as const, sourceLabel: "World Bank Open Data", indicatorId: id, indicatorName: id,
  url: `https://data.worldbank.org/indicator/${id}`, countries: ["JPN", "ITA", "ESP"], yearRange: { start: 1960, end: 2023 },
  fetchedAt: "2026-11-11T00:00:00.000Z", rowCount: 6, cached: false,
});
const answer = (question: string, series: SeriesCandidate, countries: [string, string][], alternatives: SeriesCandidate[] = []) => {
  const plan = { ...parseFastPath(question)!, countries: countries.map(([c]) => c), countryNames: countries.map(([, n]) => n) };
  return {
    plan,
    hit: series,
    spec: { type: "line" as const, title: `${series.name}, 1960–2023`, x_axis: "Year", y_axis: series.name, series: countries.map(([, name], k) => ({ name, data: [[1960, 68 + k], [2023, 83 + k]] as [number, number][] })) },
    rows: countries.flatMap(([iso3, country], k) => [{ country, iso3, year: 1960, value: 68 + k, indicator: series.id }, { country, iso3, year: 2023, value: 83 + k, indicator: series.id }]),
    citations: [citation(series.id)],
    summary: `${series.name} fetched.`,
    trace: [{ tool: "find_series", argSummary: "q", status: "ok" as const, detail: series.name, ts: 1, durationMs: 3 }],
    alternatives,
  };
};
const total = { id: "SP.RUR.TOTL", name: "Rural population", source: "worldbank" };
const share = { id: "SP.RUR.TOTL.ZS", name: "Rural population (% of total population)", source: "worldbank" };
const life = { id: "SP.DYN.LE00.IN", name: "Life expectancy at birth, total (years)", source: "worldbank" };

it("turns an ambiguous lookup into a choice with no chart, then charts the pick and keeps the others as switches", async () => {
  vi.mocked(runFastPath)
    .mockResolvedValueOnce({ ok: false, reason: "ambiguous", phrase: "rural population", candidates: [total, share] })
    .mockImplementation(async (_plan, opts) => answer("rural population of India", opts!.chosen!, [["IND", "India"]], [total, share].filter((c) => c.id !== opts!.chosen!.id)));
  render(<Workspace />);
  send("rural population of India");
  const choice = await screen.findByRole("group", { name: "Choose a series" });
  expect(within(choice).getByRole("status").textContent).toBe("“rural population” fits more than one series. Pick one to look it up directly.");
  expect(screen.queryByText("Chart rendered")).toBeNull();
  expect(createSession).not.toHaveBeenCalled();
  fireEvent.click(within(choice).getByRole("button", { name: /Rural population \(% of total population\)/ }));
  await screen.findByText("Chart rendered");
  expect(vi.mocked(runFastPath).mock.calls[1][1]!.chosen).toEqual(share);
  expect(vi.mocked(runFastPath).mock.calls[1][0].indicatorQuery).toBe("rural population");
  // The unresolved request is not left behind as a chat of its own.
  expect(within(screen.getByRole("region", { name: "Recent chats" })).getAllByRole("button")).toHaveLength(1);
  const switches = screen.getByRole("group", { name: "Other series this phrase fits" });
  expect(switches.textContent).toContain("Showing Rural population (% of total population). Switch to:");
  fireEvent.click(within(switches).getByRole("button", { name: "Rural population" }));
  await waitFor(() => expect(runFastPath).toHaveBeenCalledTimes(3));
  expect(vi.mocked(runFastPath).mock.calls[2][1]!.chosen).toEqual(total);
  await screen.findByRole("heading", { name: "Switch to Rural population" });
  expect(createSession).not.toHaveBeenCalled();
});

it("re-runs the direct lookup when a country token is removed or added, with no model and no key", async () => {
  vi.mocked(runFastPath).mockImplementation(async (plan, opts) =>
    answer("life expectancy in Japan, Italy and Spain since 1960", opts?.chosen || life, plan.countries.map((c, i) => [c, plan.countryNames[i]] as [string, string])),
  );
  render(<Workspace />);
  send("Compare life expectancy in Japan, Italy and Spain since 1960");
  const tokens = await screen.findByRole("group", { name: "What is shown (editable)" });
  expect(within(tokens).getByText("SP.DYN.LE00.IN")).toBeTruthy();
  fireEvent.click(within(tokens).getByRole("button", { name: "Remove Italy and look it up again" }));
  await screen.findByRole("heading", { name: "Remove Italy" });
  const [plan, opts] = vi.mocked(runFastPath).mock.calls[1];
  expect(plan.countries).toEqual(["JPN", "ESP"]);
  expect(plan.countryNames).toEqual(["Japan", "Spain"]);
  expect(plan.yearStart).toBe(1960);
  expect(opts!.chosen!.id).toBe("SP.DYN.LE00.IN");
  // Add a country through the token row's own search.
  await waitFor(() => expect(screen.getAllByRole("group", { name: "What is shown (editable)" }).at(-1)!.textContent).not.toContain("Italy"));
  fireEvent.click(screen.getAllByRole("button", { name: "+ country" }).at(-1)!);
  fireEvent.change(screen.getByLabelText("Country"), { target: { value: "Germ" } });
  fireEvent.click(screen.getByRole("button", { name: /Germany/ }));
  await screen.findByRole("heading", { name: "Add Germany" });
  expect(vi.mocked(runFastPath).mock.calls[2][0].countries).toEqual(["JPN", "ESP", "DEU"]);
  expect(createSession).not.toHaveBeenCalled();
});

it("offers type-ahead by keyboard and says what sending will do, without blocking free text", async () => {
  render(<Workspace />);
  fireEvent.change(box(), { target: { value: "life expectancy in Jap" } });
  const list = await screen.findByRole("listbox", { name: "Suggestions" });
  expect(box().getAttribute("aria-expanded")).toBe("true");
  expect(box().getAttribute("aria-controls")).toBe(list.id);
  fireEvent.keyDown(box(), { key: "ArrowDown" });
  const active = box().getAttribute("aria-activedescendant")!;
  expect(document.getElementById(active)!.textContent).toContain("Japan");
  expect(document.getElementById(active)!.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(box(), { key: "Enter" });
  expect(box().value).toBe("life expectancy in Japan ");
  expect(screen.queryByRole("region", { name: "Current request" })).toBeNull();
  fireEvent.change(box(), { target: { value: "Compare life expectancy in Japan, Italy and Spain since 1960" } });
  expect(await screen.findByText("World Bank · answered directly, no key needed")).toBeTruthy();
  fireEvent.change(box(), { target: { value: "rural population of India" } });
  expect(await screen.findByText("pick a series")).toBeTruthy();
  fireEvent.change(box(), { target: { value: "Why did inflation spike in Argen" } });
  await screen.findByRole("listbox", { name: "Suggestions" });
  fireEvent.keyDown(box(), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.change(box(), { target: { value: "Why did inflation spike in Argentina?" } });
  expect(await screen.findByText("needs a model")).toBeTruthy();
  // Free text still sends.
  fireEvent.keyDown(box(), { key: "Enter" });
  await screen.findByRole("button", { name: "Connect model" });
});

it("opens a chart in the panel beside the thread, asks about it, and returns focus when Esc closes it", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  vi.mocked(runFastPath).mockResolvedValue(answer("life expectancy in Japan and Italy since 1960", life, [["JPN", "Japan"], ["ITA", "Italy"]]));
  const ask = vi.fn().mockResolvedValue({ finding: "About the open chart.", chartSpec: null, rows: [], citations: [], verification: null, cost: 0 });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  send("Compare life expectancy in Japan and Italy since 1960");
  const expand = await screen.findByRole("button", { name: "Expand chart" });
  expand.focus();
  fireEvent.click(expand);
  const panel = await screen.findByRole("complementary", { name: /Chart panel: Life expectancy/ });
  await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2 })));
  expect(within(panel).getByText("from your 1st question")).toBeTruthy();
  expect(within(panel).getByRole("tablist", { name: "Result views" })).toBeTruthy();
  expect(within(panel).getByRole("slider", { name: "First year shown" })).toBeTruthy();
  expect(within(panel).getByRole("list", { name: "Per-series summary" }).textContent).toContain("+15 since 1960");
  // The inline card collapses to a reference marked open; the composer is about the chart.
  expect(screen.getByRole("button", { name: /open in the chart panel/ })).toBeTruthy();
  expect(box().getAttribute("placeholder")).toBe("Reply, or ask about the open chart");
  // Tabs are a real tablist.
  const chartTab = within(panel).getByRole("tab", { name: "Chart" });
  fireEvent.keyDown(chartTab, { key: "ArrowRight" });
  expect(within(panel).getByRole("tab", { name: /Data/ }).getAttribute("aria-selected")).toBe("true");
  send("Why is Japan higher?");
  await waitFor(() => expect(createSession).toHaveBeenCalled());
  expect(vi.mocked(createSession).mock.calls[0][1]!.workspace!.spec!.title).toContain("Life expectancy");
  await screen.findByText("About the open chart.");
  fireEvent.keyDown(screen.getByRole("complementary", { name: /Chart panel/ }), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("complementary", { name: /Chart panel/ })).toBeNull());
  await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand chart"));
});

it("shows the model's thinking live, then the reasoning, steps and verdict it returned", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  let finish!: (value: unknown) => void;
  const ask = vi.fn((_q, cb) => {
    cb.onTrace([
      { tool: "reasoning", argSummary: "", status: "ok", detail: "Check the 2020 values first.", ts: 1 },
      { tool: "find_series", argSummary: "excess mortality", status: "running", ts: 2 },
    ]);
    return new Promise((r) => (finish = r));
  });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  send("Why did Italy dip in 2020?");
  const live = await screen.findByRole("button", { name: /Thinking/ });
  expect(live.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Check the 2020 values first.")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBeTruthy();
  await act(async () =>
    finish({
      finding: "Deaths rose in 2020.",
      chartSpec: null,
      rows: [],
      citations: [citation("SP.DYN.LE00.IN")],
      verification: { status: "verified", pass: true, confidence: "high", issues: [], report: "" },
      cost: 0.002,
    }),
  );
  await screen.findByText("Deaths rose in 2020.");
  expect(screen.getByText("Evidence check passed")).toBeTruthy();
  const head = screen.getAllByRole("button", { name: /Thought it through|Thought and checked sources/ }).at(-1)!;
  expect(head.textContent).toContain("your OpenRouter key");
  expect(head.textContent).not.toContain("test-key");
});
