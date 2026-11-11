// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThinkingBlock, thinkingSummary } from "./ThinkingBlock";
import { CheckBadge } from "./Evidence";
import type { Analysis } from "../../../lib/chitti/workspace/model";

afterEach(cleanup);
const base: Analysis = {
  id: "a",
  question: "q",
  phase: "done",
  status: "Done",
  origin: "agent",
  result: null,
  files: {},
  trace: [
    { tool: "reasoning", argSummary: "", status: "ok", detail: "I should check <img src=x onerror=alert(1)> the 2020 values.", ts: 1 },
    { tool: "find_series", argSummary: "excess mortality", status: "ok", detail: "Excess mortality (owid)", ts: 2, durationMs: 400 },
    { tool: "verify", argSummary: "", status: "error", verifyStatus: "unverified", confidence: "medium", issues: ["The cause is not in the data."], ts: 3 },
  ],
  startedAt: 1000,
  endedAt: 9200,
  model: "some/model",
  provider: "openrouter",
  cost: 0.0031,
};

describe("the thinking block", () => {
  it("is a collapsed disclosure by default with label, step count, duration, key and cost", () => {
    render(<ThinkingBlock analysis={base} />);
    const head = screen.getByRole("button", { name: /Thought and checked sources/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.textContent).toContain("2 steps");
    expect(head.textContent).toContain("8.2s");
    expect(head.textContent).toContain("your OpenRouter key");
    expect(head.textContent).toContain("$0.0031");
    // The timeline is in the DOM but hidden until the reader opens it.
    expect(document.querySelector(".cx-think-body")!.hasAttribute("hidden")).toBe(true);
  });
  it("expands into the turn's own timeline, reasoning as plain text, ending with the evidence check", () => {
    const { container } = render(<ThinkingBlock analysis={base} />);
    fireEvent.click(screen.getByRole("button", { name: /Thought and checked sources/ }));
    expect(screen.getByRole("button", { name: /Thought/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("find series")).toBeTruthy();
    expect(screen.getByText("0.4s")).toBeTruthy();
    // Model-authored reasoning is text, never markup.
    expect(screen.getByText(/I should check <img src=x onerror=alert\(1\)> the 2020 values\./)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    const steps = [...container.querySelectorAll(".cx-th")];
    expect(steps.at(-1)!.textContent).toContain("evidence check");
    expect(steps.at(-1)!.textContent).toContain("Evidence not verified");
    expect(steps.at(-1)!.textContent).toContain("The cause is not in the data.");
    fireEvent.click(screen.getByRole("button", { name: /Thought/ }));
    expect(screen.getByRole("button", { name: /Thought/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("is open and live while the turn runs, then collapses when it finishes", () => {
    const running: Analysis = { ...base, phase: "running", endedAt: undefined, trace: base.trace.slice(0, 2) };
    const { rerender } = render(<ThinkingBlock analysis={running} />);
    const head = screen.getByRole("button", { name: /Thinking/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".cx-think-body")!.getAttribute("aria-live")).toBe("polite");
    // No end time yet: no duration is shown rather than a made-up one.
    expect(head.textContent).not.toMatch(/\d+\.\ds/);
    rerender(<ThinkingBlock analysis={base} />);
    expect(screen.getByRole("button", { name: /Thought and checked sources/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("says the direct path used no model, and never shows a cost for the ChatGPT plan", () => {
    expect(thinkingSummary({ ...base, origin: "direct", provider: undefined, cost: undefined, trace: base.trace.slice(1, 2) })).toMatchObject({
      label: "Looked it up directly",
      steps: 1,
      meta: ["8.2s", "no model"],
    });
    const plan = thinkingSummary({ ...base, provider: "chatgpt", cost: undefined });
    expect(plan.meta).toEqual(["8.2s", "some/model", "your ChatGPT plan"]);
    expect(plan.meta.join(" ")).not.toContain("$");
  });
  it("never renders a credential: only the provider's name reaches the summary", () => {
    const { container } = render(<ThinkingBlock analysis={{ ...base }} />);
    expect(container.textContent).not.toMatch(/sk-|key-sentinel/);
  });
});

describe("the check badge", () => {
  it("shows exactly the verifier's verdict, with confidence and issues on expand", () => {
    render(<CheckBadge origin="agent" verification={{ status: "unverified", confidence: "medium", issues: ["One claim is not in the data."] } as never} />);
    expect(screen.getByText("Evidence not verified")).toBeTruthy();
    expect(screen.getByText(/Verifier confidence: medium/)).toBeTruthy();
    expect(screen.getByText("One claim is not in the data.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\d+ of \d+/);
  });
  it("says how an unchecked direct answer was produced instead of looking checked", () => {
    render(<CheckBadge origin="direct" verification={null} />);
    expect(screen.getByText("Matched to a known series · no language model involved")).toBeTruthy();
    expect(screen.queryByText(/Evidence check passed/)).toBeNull();
  });
});
