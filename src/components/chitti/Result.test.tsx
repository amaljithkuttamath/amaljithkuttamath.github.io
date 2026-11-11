// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const { init } = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock("./chart-runtime", () => ({
  init: (...args: unknown[]) => {
    init(...args);
    return { setOption: vi.fn(), on: vi.fn(), dispose: vi.fn(), resize: vi.fn() };
  },
}));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
import { Result } from "./Result";
import type { ShareStateV1 } from "../../lib/chitti/share";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const state = (n: number): ShareStateV1 => ({
  v: 1,
  q: "q",
  answer: "",
  spec: null,
  rows: Array.from({ length: n }, (_, i) => ({ country: "India", iso3: "IND", year: 1900 + i, value: i })),
  citations: [],
  verification: null,
  ts: "2026-01-01T00:00:00.000Z",
});

it("clamps the data page when a surface update leaves fewer rows than the open page", async () => {
  const { rerender } = render(<Result result={state(120)} />);
  fireEvent.click(screen.getByRole("tab", { name: /Data/ }));
  fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
  fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
  expect(screen.getByText(/Page 3 of 3/)).toBeTruthy();
  rerender(<Result result={state(10)} />);
  await waitFor(() => expect(screen.getByText(/Page 1 of 1/)).toBeTruthy());
  expect(screen.getAllByRole("row")).toHaveLength(11);
  expect(screen.queryByText("No matching rows.")).toBeNull();
});

it("keeps a snapshot citation labelled as a snapshot, distinct from a live fetch", () => {
  const citation = {
    id: "c1", source: "worldbank" as const, sourceLabel: "World Bank Open Data",
    indicatorId: "SP.DYN.LE00.IN", indicatorName: "Life expectancy", url: "https://data.worldbank.org/indicator/SP.DYN.LE00.IN",
    countries: ["JPN"], yearRange: { start: 1960, end: 2023 }, fetchedAt: "2026-11-01T00:00:00.000Z", rowCount: 64, live: false,
  };
  const { rerender } = render(<Result result={{ ...state(1), citations: [{ ...citation, mirroredAt: "2026-10-01T00:00:00.000Z" }] as never }} />);
  fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));
  expect(screen.getByText("Snapshot")).toBeTruthy();
  expect(screen.queryByText("Fetched")).toBeNull();
  rerender(<Result result={{ ...state(1), citations: [citation] as never }} />);
  expect(screen.getByText("Fetched")).toBeTruthy();
  expect(screen.queryByText("Snapshot")).toBeNull();
});
