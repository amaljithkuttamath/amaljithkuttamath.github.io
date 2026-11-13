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
import { providerMeta } from "../../lib/chitti/providers";
// Recorded examples open from their cards on the empty state (the one entry
// point); a native <select> in the sidebar used to duplicate it.
async function openExample(demo: (typeof DEMOS)[number]) {
  fireEvent.click(
    within(screen.getByRole("region", { name: "Recorded analyses" })).getByRole(
      "button",
      { name: demo.question },
    ),
  );
  await screen.findByRole("heading", { name: demo.question });
}
// Chart steering controls are native selects: choose the option by value.
async function chooseOption(label: string, option: string) {
  const select = (await screen.findByRole("combobox", { name: label })) as HTMLSelectElement;
  expect([...select.options].map((o) => o.textContent)).toContain(option);
  fireEvent.change(select, { target: { value: option } });
}
// The composer is the one text entry: a combobox (it offers type-ahead).
const composerCount = () => {
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  return screen.getAllByRole("combobox", { name: "Ask a data question" }).length;
};
const contextChip = () =>
  within(screen.getByRole("group", { name: "Follow-up context" }));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("locks a chat's model, switches only in a new chat, and restores its original model", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  sessionStorage.setItem("chitti:model", "original-model");
  const ask = vi.fn().mockResolvedValue({ finding: "An answer to keep.", chartSpec: null, rows: [], citations: [], verification: null, cost: 0 });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  fireEvent.change(screen.getByLabelText("Ask a data question"), { target: { value: "Explain the limits of these indicators" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("An answer to keep.");
  const modelMenu = (id: string) => screen.getByRole("button", { name: `Choose model: ${id}` });
  fireEvent.click(modelMenu("original-model"));
  const next = providerMeta("openrouter").models[0];
  fireEvent.click(screen.getByRole("button", { name: (name) => name.startsWith(next.label) }));
  // The chat keeps its model until the user confirms a new chat.
  expect(modelMenu("original-model")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
  expect(screen.queryByText("An answer to keep.")).toBeNull();
  expect(modelMenu(next.id)).toBeTruthy();
  fireEvent.click(within(screen.getByRole("region", { name: "Recent chats" })).getByRole("button", { name: "Explain the limits of these indicators" }));
  expect(modelMenu("original-model")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ask a data question"), { target: { value: "Expand on that answer" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createSession).mock.calls[1][0].model).toBe("original-model");
});
it("finds a live model before connection and carries it through setup and the next request", async () => {
  const id = "fixture/research-pro";
  const catalog = [{ id, name: "Research Professional", supported_parameters: ["tools", "reasoning"] }];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: catalog }) }));
  const ask = vi.fn().mockResolvedValue({ finding: "Selected model ran.", chartSpec: null, rows: [], citations: [], verification: null, cost: 0 });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model: Direct queries" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "professional" } });
  fireEvent.click(await screen.findByRole("button", { name: /Research Professional/ }));
  expect((screen.getByLabelText("Model", { exact: true }) as HTMLInputElement).value).toBe(id);
  const submit = screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement;
  expect(submit.getAttribute("aria-disabled")).toBe("true");
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "fixture-key" } });
  fireEvent.click(submit);
  fireEvent.change(screen.getByLabelText("Ask a data question"), { target: { value: "Explain the limits of these indicators" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Selected model ran.");
  expect(vi.mocked(createSession).mock.calls[0][0]).toMatchObject({ model: id, requestReasoning: true });
});

it("lists subscription models for the restored ChatGPT account", async () => {
  sessionStorage.setItem("chitti:provider", "chatgpt");
  sessionStorage.setItem("chitti:model", "original");
  sessionStorage.setItem("chitti:account", "account-a");
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ id: "another", label: "Another model" }] }) });
  vi.stubGlobal("fetch", fetch);
  render(<Workspace />);
  fireEvent.click(screen.getByRole("button", { name: "Choose model: original" }));
  fireEvent.click(await screen.findByRole("button", { name: /Another model/ }));
  expect(screen.getByRole("button", { name: "Choose model: another" })).toBeTruthy();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ account: "account-a" });
});
it("changes chart type in place and preserves the current draft and answer", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  await openExample(demo);
  const picker = await screen.findByRole("radiogroup", { name: "Chart type" });
  const question = screen.getByRole("heading", { name: demo.question });
  const finding = document.querySelector(".cx-finding")!.textContent;
  const composer = screen.getByLabelText("Ask a data question") as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "My next question" } });
  for (const name of ["Bars", "Grouped", "Line"]) {
    const radio = within(picker).getByRole("radio", { name });
    fireEvent.click(radio);
    await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
    expect(screen.getByRole("radiogroup", { name: "Chart type" })).toBe(picker);
    expect(screen.getByRole("heading", { name: demo.question })).toBe(question);
    expect(document.querySelector(".cx-finding")!.textContent).toBe(finding);
    expect(composer.value).toBe("My next question");
  }
  expect(createSession).not.toHaveBeenCalled();
  expect(runFastPath).not.toHaveBeenCalled();
});

it("keeps the previous artifact visible while a new AG-UI run appends a new reply", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof runFastPath>>) => void;
  vi.mocked(runFastPath).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<Workspace />);
  const previous = DEMOS[0];
  await openExample(previous);
  await screen.findByRole("heading", { name: previous.question });
  // Detach the current view: the follow-up becomes a fresh question.
  fireEvent.click(contextChip().getByRole("button", { name: /^Remove / }));
  expect(contextChip().getByRole("button", { name: "Use current view" })).toBeTruthy();
  const question = "Chart life expectancy in Japan since 1960";
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: question },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
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
      alternatives: [],
    }),
  );
  await screen.findByRole("heading", { name: question });
  expect(screen.getByRole("heading", { name: previous.question })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Recent chats" })).toBeTruthy();
  expect(screen.getByText("Result from the test source")).toBeTruthy();
});
it("lets the user steer a recorded result and return to the exact parent view without a key", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  await openExample(demo);
  const series = demo.state.spec!.series[0].name;
  await chooseOption("Focus chart", series);
  await screen.findByRole("heading", { name: `Focus on ${series}` });
  expect(
    screen.getAllByText(`Focused ${series}; 1 series hidden.`).length,
  ).toBeGreaterThan(0);
  expect(runFastPath).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByRole("heading", { name: demo.question });
  expect(screen.getByRole("combobox", { name: "Focus chart" })).toBeTruthy();
});

it("keeps one composer, undoes and redoes a branch, and clears redo when the user steers again", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  await openExample(demo);
  await chooseOption("Focus chart", demo.state.spec!.series[0].name);
  await screen.findByRole("button", { name: "Undo" });
  expect(composerCount()).toBe(1);
  expect(screen.queryByLabelText("Ask about this view")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await screen.findByRole("heading", { name: demo.question });
  // The restored view is attached as the follow-up's context.
  expect(contextChip().getByRole("button", { name: /^Remove / })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  await screen.findByRole("heading", {
    name: `Focus on ${demo.state.spec!.series[0].name}`,
  });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await chooseOption("Focus chart", demo.state.spec!.series[1].name);
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
  await openExample(demo);
  await chooseOption("Focus chart", demo.state.spec!.series[0].name);
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: "Explain the restored comparison" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(createSession).toHaveBeenCalled());
  expect(vi.mocked(createSession).mock.calls[0][1]!.workspace).toEqual(
    demo.state,
  );
  await screen.findByText("Test explanation");
});
it("keeps a model-key request beside the unchanged result", async () => {
  render(<Workspace />);
  await openExample(DEMOS[0]);
  fireEvent.change(screen.getByLabelText("Ask a data question"), {
    target: { value: "Explain the causal mechanism" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
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
  await openExample(demo);
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
  await openExample(demo);
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
  // Switch to another recorded result: the explanation must not follow it.
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  await openExample(DEMOS[0]);
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
  await openExample(demo);
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

it("starts with the user's question and lets them deliberately open evidence", async () => {
  render(<Workspace />);
  expect(
    screen.getByRole("heading", { name: "What do you want to find out?" }),
  ).toBeTruthy();
  expect(screen.queryByText("Chart rendered")).toBeNull();
  expect(composerCount()).toBe(1);
  fireEvent.click(
    within(screen.getByRole("region", { name: "Recorded analyses" })).getByRole(
      "button",
      {
        name: new RegExp(
          DEMOS[0].question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ),
      },
    ),
  );
  await screen.findByRole("heading", { name: DEMOS[0].question });
  fireEvent.click(screen.getByRole("tab", { name: /Sources/ }));
  expect(screen.getAllByText(/World Bank/).length).toBeGreaterThan(0);
});


it("keeps prior answers in the selected branch's model context", async () => {
  sessionStorage.setItem("chitti:provider", "openrouter");
  sessionStorage.setItem("chitti:key", "test-key");
  const demo = DEMOS[0];
  const ask = vi.fn().mockResolvedValue({ finding: "First, rates fell. Second, causes need more evidence.", chartSpec: null, rows: demo.state.rows, citations: demo.state.citations, verification: null, cost: 0 });
  vi.mocked(createSession).mockReturnValue({ ask } as unknown as ChittiSession);
  render(<Workspace />);
  await openExample(demo);
  fireEvent.change(screen.getByLabelText("Ask a data question"), { target: { value: "Explain the finding" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("First, rates fell. Second, causes need more evidence.");
  fireEvent.change(screen.getByLabelText("Ask a data question"), { target: { value: "Explain your second point" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createSession).mock.calls[1][1]!.conversation).toContainEqual({ role: "assistant", content: "First, rates fell. Second, causes need more evidence." });
  expect(screen.getByRole("heading", { name: demo.question })).toBeTruthy();
});

it("opens a fresh chat without erasing earlier branches", async () => {
  render(<Workspace />);
  const demo = DEMOS[2];
  await openExample(demo);
  await chooseOption("Focus chart", demo.state.spec!.series[0].name);
  await screen.findByRole("button", { name: "Undo" });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await chooseOption("Focus chart", demo.state.spec!.series[1].name);
  await screen.findByRole("heading", { name: `Focus on ${demo.state.spec!.series[1].name}` });
  expect(within(screen.getByRole("region", { name: "Recent chats" })).getAllByRole("button")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  expect(screen.getByRole("heading", { name: "What do you want to find out?" })).toBeTruthy();
  expect(screen.queryByText("Chart rendered")).toBeNull();
  expect(within(screen.getByRole("region", { name: "Recent chats" })).getAllByRole("button")).toHaveLength(2);
});

it("sends on Enter, keeps Shift+Enter for a new line, and still sends on Ctrl/⌘+Enter", async () => {
  render(<Workspace />);
  const box = screen.getByLabelText("Ask a data question");
  fireEvent.change(box, { target: { value: "Explain the causal mechanism" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(screen.queryByRole("region", { name: "Current request" })).toBeNull();
  expect((box as HTMLTextAreaElement).value).toBe("Explain the causal mechanism");
  fireEvent.keyDown(box, { key: "Enter" });
  await screen.findByRole("button", { name: "Connect model" });
  expect(screen.getByRole("heading", { name: "Explain the causal mechanism" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
  fireEvent.change(box, { target: { value: "Explain the limits" } });
  fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
  await screen.findByRole("heading", { name: "Explain the limits" });
});
