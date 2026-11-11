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
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
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
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText(/Page 3 of 3/)).toBeTruthy();
  rerender(<Result result={state(10)} />);
  await waitFor(() => expect(screen.getByText(/Page 1 of 1/)).toBeTruthy());
  expect(screen.getAllByRole("row")).toHaveLength(11);
  expect(screen.queryByText("No matching rows.")).toBeNull();
});
