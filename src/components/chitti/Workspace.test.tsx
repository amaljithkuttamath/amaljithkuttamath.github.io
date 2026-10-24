// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
vi.mock("./Chart", () => ({ default: () => <div>Chart rendered</div> }));
vi.mock("../../lib/chitti/fastpath", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chitti/fastpath")>()),
  runFastPath: vi.fn(),
}));
vi.mock("../../lib/chitti/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/chitti/session")>()),
  createSession: vi.fn(),
}));
import { createSession, type ChittiSession } from "../../lib/chitti/session";
import Workspace from "./Workspace";
import { runFastPath, parseFastPath } from "../../lib/chitti/fastpath";
import { DEMOS } from "../../lib/chitti/demos";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
});
it("keeps the previous artifact visible while a new AG-UI run prepares its replacement", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof runFastPath>>) => void;
  vi.mocked(runFastPath).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<Workspace />);
  const previous = DEMOS[0];
  await screen.findByRole("heading", { name: previous.question });
  const question = "Chart life expectancy in Japan since 1960";
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  await screen.findByRole("button", { name: "Stop" });
  expect(screen.getByRole("heading", { name: previous.question })).toBeTruthy();
  await waitFor(() => expect(runFastPath).toHaveBeenCalled());
  await act(async () =>
    resolve({
      plan: parseFastPath(question)!,
      hit: {
        id: "SP.DYN.LE00.IN",
        name: "Life expectancy",
        source: "worldbank",
      },
      spec: previous.state.spec!,
      rows: previous.state.rows,
      citations: previous.state.citations,
      summary: "Result from the test source",
      trace: [],
    }),
  );
  await screen.findByRole("heading", { name: question });
  expect(screen.queryByRole("heading", { name: previous.question })).toBeNull();
  expect(screen.getByText("History (1)")).toBeTruthy();
  expect(screen.getByText("Result from the test source")).toBeTruthy();
});
it("lets the user steer a recorded result and return to the exact parent view without a key", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  const series = demo.state.spec!.series[0].name;
  const focus = await screen.findByLabelText("Focus chart");
  fireEvent.change(focus, { target: { value: series } });
  await screen.findByRole("heading", { name: `Focus on ${series}` });
  expect(
    screen.getAllByText(`Focused ${series}; 1 series hidden.`).length,
  ).toBeGreaterThan(0);
  expect(runFastPath).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByRole("heading", { name: demo.question });
  expect(screen.getByLabelText("Focus chart")).toBeTruthy();
});

it("keeps one composer, undoes and redoes a branch, and clears redo when the user steers again", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  fireEvent.change(await screen.findByLabelText("Focus chart"), {
    target: { value: demo.state.spec!.series[0].name },
  });
  await screen.findByRole("button", { name: "Undo" });
  expect(screen.getAllByRole("textbox")).toHaveLength(1);
  expect(screen.queryByLabelText("Ask about this view")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByRole("heading", { name: demo.question });
  expect(
    (screen.getByLabelText("Use current view") as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  await screen.findByRole("heading", {
    name: `Focus on ${demo.state.spec!.series[0].name}`,
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  fireEvent.change(await screen.findByLabelText("Focus chart"), {
    target: { value: demo.state.spec!.series[1].name },
  });
  await screen.findByRole("heading", {
    name: `Focus on ${demo.state.spec!.series[1].name}`,
  });
  expect(screen.queryByRole("button", { name: "Redo" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Steer" }));
  expect(document.activeElement).toBe(
    screen.getByLabelText("Ask a data question"),
  );
});

it("uses the restored evidence for the next model request after undo", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  const demo = DEMOS[2];
  const ask = vi.fn().mockResolvedValue({
    finding: "Test explanation",
    chartSpec: null,
    rows: demo.state.rows,
    citations: demo.state.citations,
    verification: null,
    cost: 0,
  });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  fireEvent.change(await screen.findByLabelText("Focus chart"), {
    target: { value: demo.state.spec!.series[0].name },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: "Explain the restored comparison" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(createSession).toHaveBeenCalled());
  expect(vi.mocked(createSession).mock.calls[0][1]!.workspace).toEqual(
    demo.state,
  );
  await screen.findByText("Test explanation");
});
it("keeps a model-key request beside the unchanged result", async () => {
  render(<Workspace />);
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: "Explain the causal mechanism" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
  await screen.findByRole("button", { name: "Connect model" });
  expect(screen.getByRole("heading", { name: DEMOS[0].question })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Current request" })).toBeTruthy();
});
