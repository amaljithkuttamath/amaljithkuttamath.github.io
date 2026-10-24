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
vi.mock("./Chart", async () => {
  const { highlightChanges, explainChange, deltaLabel } = await import(
    "../../lib/chitti/chart-insights"
  );
  const { ChangeExplanation } = await import("./ChangeExplanation");
  return {
    default: ({ spec, onAsk }: any) => (
      <div>
        <span>Chart rendered</span>
        {highlightChanges(spec).map((c) => (
          <button
            key={c.series}
            disabled={!onAsk}
            onClick={() => onAsk(explainChange(c), c)}
            aria-label={`Ask why: ${c.series}, ${deltaLabel(c, spec.y_axis)}, ${c.from[0]} to ${c.to[0]}`}
          >
            Why?
          </button>
        ))}
        <ChangeExplanation unit={spec.y_axis} />
      </div>
    ),
  };
});
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
import { highlightChanges, deltaLabel } from "../../lib/chitti/chart-insights";
import { within } from "@testing-library/react";
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

it("keeps explanation progress and the answer beside the selected change without replacing the source chart", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  const demo = DEMOS[2];
  const change = highlightChanges(demo.state.spec!)[0];
  let resolve!: (value: any) => void;
  const ask = vi.fn((_q, callbacks) => {
    callbacks.onPreview({
      chartSpec: { ...demo.state.spec, title: "Replacement must not appear" },
      rows: demo.state.rows,
      citations: demo.state.citations,
    });
    return new Promise((r) => {
      resolve = r;
    });
  });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Ask why: ${change.series}, ${deltaLabel(change, demo.state.spec!.y_axis)}, ${change.from[0]} to ${change.to[0]}`,
    }),
  );
  const panel = await screen.findByRole("region", {
    name: `Explanation: ${change.series}, ${change.from[0]} to ${change.to[0]}`,
  });
  expect(
    within(panel).getByText("Checking this change against the sources…"),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Current request" })).toBeNull();
  expect(screen.getByRole("heading", { name: demo.question })).toBeTruthy();
  expect(screen.queryByText("Replacement must not appear")).toBeNull();
  expect(vi.mocked(createSession).mock.calls[0][1]!.workspace).toEqual(
    demo.state,
  );
  expect(ask.mock.calls[0][0]).toContain("at most 80 words");
  await act(async () =>
    resolve({
      finding:
        "The observations show a decline; the source cannot establish its cause.",
      chartSpec: null,
      rows: demo.state.rows,
      citations: demo.state.citations,
      verification: null,
      cost: 0,
    }),
  );
  expect(
    await within(panel).findByText(
      "The observations show a decline; the source cannot establish its cause.",
    ),
  ).toBeTruthy();

  expect(screen.queryByText(/History/)).toBeNull();
  fireEvent.click(
    within(panel).getByRole("button", { name: "Close explanation" }),
  );
  expect(screen.queryByRole("region", { name: /Explanation:/ })).toBeNull();
  expect(screen.getByRole("heading", { name: demo.question })).toBeTruthy();
});
it("keeps missing-key and retry controls in the change, not a new conversation turn", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  const change = highlightChanges(demo.state.spec!)[0];
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Ask why: ${change.series}, ${deltaLabel(change, demo.state.spec!.y_axis)}, ${change.from[0]} to ${change.to[0]}`,
    }),
  );
  const panel = await screen.findByRole("region", { name: /Explanation:/ });
  await within(panel).findByRole("button", { name: "Connect model" });
  fireEvent.click(
    within(panel).getByRole("button", { name: "Retry explanation" }),
  );
  await within(panel).findByRole("button", { name: "Connect model" });
  expect(screen.queryByRole("region", { name: "Current request" })).toBeNull();
  expect(createSession).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: demo.question })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${DEMOS[0].id}` },
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: /Explanation:/ })).toBeNull(),
  );
});

it("stops an inline explanation and retries against the same evidence", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  const demo = DEMOS[2];
  const change = highlightChanges(demo.state.spec!)[0];
  const ask = vi.fn(
    (_q, _callbacks, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Stopped")), {
          once: true,
        }),
      ),
  );
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  fireEvent.change(screen.getByLabelText("Open result"), {
    target: { value: `example:${demo.id}` },
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Ask why: ${change.series}, ${deltaLabel(change, demo.state.spec!.y_axis)}, ${change.from[0]} to ${change.to[0]}`,
    }),
  );
  const panel = await screen.findByRole("region", { name: /Explanation:/ });
  await waitFor(() => expect(ask).toHaveBeenCalledOnce());
  fireEvent.click(
    within(panel).getByRole("button", { name: "Stop explanation" }),
  );
  await within(panel).findByText("Stopped");
  fireEvent.click(
    within(panel).getByRole("button", { name: "Retry explanation" }),
  );
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createSession).mock.calls[1][1]!.workspace).toEqual(
    demo.state,
  );
  fireEvent.click(
    within(panel).getByRole("button", { name: "Stop explanation" }),
  );
  await within(panel).findByText("Stopped");
});
