import { describe, expect, it, vi } from "vitest";
import { ChittiAgent, needsModelStatus } from "./agent";
import { DEMOS } from "../demos";
import type { SessionOptions } from "../session";
import type { Settings } from "./model";
const config: Settings = {
  provider: "openrouter",
  model: "test",
  apiKey: "private-key-sentinel",
  sources: ["worldbank"],
  rlm: false,
};
const output = {
  finding: "A tested finding.",
  rows: [],
  citations: [],
  chartSpec: null,
  verification: null,
  cost: 0,
};
function question(agent: ChittiAgent, text = "Explain this measure") {
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });
}
describe("AG-UI browser adapter", () => {
  it("runs a key-free lookup, respects the source selection and keeps credentials out of events", async () => {
    const demo = DEMOS[0].state;
    const runFastPath = vi.fn().mockResolvedValue({
      spec: demo.spec,
      rows: demo.rows,
      citations: demo.citations,
      summary: demo.answer,
      trace: [],
    });
    const createSession = vi.fn();
    const agent = new ChittiAgent(config, { runFastPath, createSession });
    const events: unknown[] = [];
    agent.subscribe({
      onEvent: ({ event }) => {
        events.push(event);
      },
    });
    question(agent, "Chart life expectancy in Japan since 1960");
    await agent.runAgent({ runId: "direct" });
    expect(createSession).not.toHaveBeenCalled();
    expect(runFastPath.mock.calls[0][1].sources).toEqual(["worldbank"]);
    expect(agent.state.analysis.phase).toBe("done");
    expect(agent.state.analysis.result.citations).toEqual(demo.citations);
    expect(JSON.stringify(events)).not.toContain(config.apiKey);
    expect(events.some((e: any) => e.name === "a2ui")).toBe(true);
  });
  it("routes clarification actions to each current run, including follow-ups", async () => {
    let opts: SessionOptions | undefined;
    const answers: string[] = [];
    const ask = vi.fn(async (_q, _cb, signal) => {
      answers.push(
        await opts!.requestInput!(
          { question: "Which measure?", options: ["Total", "Per person"] },
          signal,
        ),
      );
      return output;
    });
    const createSession = vi.fn((_cfg, o) => {
      opts = o;
      return { ask } as any;
    });
    const agent = new ChittiAgent(config, {
      createSession,
      runFastPath: vi.fn(),
    });
    const seen: string[] = [];
    agent.subscribe({
      onCustomEvent: ({ event, input }) => {
        if (
          event.name === "a2ui" &&
          event.value.operations[0].createSurface.surfaceId === "question"
        ) {
          seen.push(input.runId);
          const id =
            event.value.operations[1].updateComponents.components[0].requestId;
          queueMicrotask(() => {
            expect(agent.respond("stale-id", "wrong")).toBe(false);
            expect(agent.respond(id, "Per person")).toBe(true);
          });
        }
      },
    });
    question(agent);
    await agent.runAgent({ runId: "first" });
    question(agent, "Explain a different measure");
    await agent.runAgent({ runId: "second" });
    expect(seen).toEqual(["first", "second"]);
    expect(answers).toEqual(["Per person", "Per person"]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(agent.state.question).toBeNull();
    expect(agent.state.analysis.phase).toBe("done");
  });
  it("stops a pending direct request even when the transport never settles", async () => {
    const agent = new ChittiAgent(config, {
      createSession: vi.fn(),
      runFastPath: vi.fn(() => new Promise<never>(() => {})),
    });
    question(agent, "Chart life expectancy in Japan since 1960");
    const run = agent.runAgent({ runId: "stop" });
    await vi.waitFor(() => expect(agent.isRunning).toBe(true));
    agent.stop();
    await run;
    expect(agent.state.analysis.phase).toBe("stopped");
    expect(agent.isRunning).toBe(false);
  });
  it("unblocks and clears a pending clarification on stop", async () => {
    let opts: SessionOptions | undefined;
    const agent = new ChittiAgent(config, {
      runFastPath: vi.fn(),
      createSession: vi.fn((_cfg, o) => {
        opts = o;
        return {
          ask: async (_q: string, _cb: unknown, signal?: AbortSignal) => {
            await opts!.requestInput!(
              { question: "Which measure?", options: ["A", "B"] },
              signal,
            );
            return output;
          },
        } as any;
      }),
    });
    question(agent);
    const run = agent.runAgent({ runId: "stop-question" });
    await vi.waitFor(() => expect(agent.state.analysis.phase).toBe("waiting"));
    const id = agent.state.question.id;
    agent.stop();
    await run;
    expect(agent.state.analysis.phase).toBe("stopped");
    expect(agent.state.question).toBeNull();
    expect(agent.respond(id, "A")).toBe(false);
  });
  it("says the source failed, not that a model is needed, when a direct lookup cannot finish", async () => {
    const run = async (runFastPath: any) => {
      const createSession = vi.fn();
      const agent = new ChittiAgent(
        { ...config, apiKey: "" },
        { createSession, runFastPath },
      );
      question(agent, "Chart life expectancy in Japan since 1960");
      await agent.runAgent();
      expect(createSession).not.toHaveBeenCalled();
      expect(agent.state.analysis.phase).toBe("needs-key");
      return agent.state.analysis.status as string;
    };
    expect(await run(vi.fn().mockRejectedValue(new Error("network")))).toBe(
      needsModelStatus("unreachable", false),
    );
    expect(
      await run(
        vi.fn().mockResolvedValue({
          ok: false,
          reason: "no-data",
          hit: { id: "SP.DYN.LE00.IN", name: "Life expectancy", source: "worldbank" },
        }),
      ),
    ).toBe(needsModelStatus({ noData: "Life expectancy" }, false));
    expect(
      await run(vi.fn().mockResolvedValue({ ok: false, reason: "no-match" })),
    ).toBe(needsModelStatus(null, false));
    expect(needsModelStatus("unreachable", false)).toMatch(/did not respond/);
    expect(needsModelStatus("unreachable", false)).not.toMatch(/needs a model/);
    expect(needsModelStatus({ noData: "X" }, true)).toMatch(/beside the message box/);
  });
  it("gates model questions without a key and rejects changes during a session", async () => {
    const createSession = vi.fn(() => ({ ask: async () => output }) as any);
    const agent = new ChittiAgent(
      { ...config, apiKey: "" },
      { createSession, runFastPath: vi.fn() },
    );
    question(agent);
    await agent.runAgent();
    expect(agent.state.analysis.phase).toBe("needs-key");
    expect(createSession).not.toHaveBeenCalled();
    agent.configure(config);
    question(agent);
    await agent.runAgent();
    expect(() => agent.configure(config)).toThrow("new analysis");
    agent.reset();
    expect(() => agent.configure(config)).not.toThrow();
  });
});
it("publishes a draft before completion and sends the chosen workspace to the engine", async () => {
  const demo = DEMOS[0].state;
  let finish!: (value: any) => void;
  const createSession = vi.fn(
    (_cfg: import("../providers").ProviderConfig, _opts?: SessionOptions) =>
      ({
        ask: vi.fn(
          async (_q: string, cb: import("../session").AgentCallbacks) => {
            cb.onPreview!({
              chartSpec: demo.spec,
              rows: demo.rows,
              citations: demo.citations,
            });
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        ),
      }) as any,
  );
  const agent = new ChittiAgent(config, {
    createSession,
    runFastPath: vi.fn(),
  });
  const surfaces: unknown[] = [];
  agent.subscribe({
    onCustomEvent: ({ event }) => {
      if (event.name === "a2ui") surfaces.push(event.value);
    },
  });
  agent.useWorkspace(demo);
  question(agent, "Explain this view");
  const pending = agent.runAgent({ runId: "draft" });
  await vi.waitFor(() => expect(surfaces).toHaveLength(1));
  expect(agent.state.analysis.phase).toBe("running");
  expect(agent.state.analysis.result.spec).toEqual(demo.spec);
  expect(agent.state.analysis.result.verification).toBeNull();
  expect(createSession.mock.calls[0][1]!.workspace).toEqual(demo);
  finish({
    ...output,
    chartSpec: demo.spec,
    rows: demo.rows,
    citations: demo.citations,
  });
  await pending;
  expect(agent.state.analysis.phase).toBe("done");
  expect(surfaces).toHaveLength(2);
});
it("routes view edits through the agent without spending a key or fetching data", async () => {
  const createSession = vi.fn(),
    runFastPath = vi.fn();
  const agent = new ChittiAgent(
    { ...config, apiKey: "" },
    { createSession, runFastPath },
  );
  const demo = DEMOS[0].state;
  const name = demo.spec!.series[0].name;
  agent.useWorkspace(demo, { kind: "series", name });
  question(agent, `Focus on ${name}`);
  await agent.runAgent();
  expect(agent.state.analysis.origin).toBe("view");
  expect(agent.state.analysis.result.spec.series).toHaveLength(1);
  expect(createSession).not.toHaveBeenCalled();
  expect(runFastPath).not.toHaveBeenCalled();
});

describe("direct choices", () => {
  const plan = {
    indicatorQuery: "rural population",
    countries: ["IND"],
    countryNames: ["India"],
    chartType: "line" as const,
  };
  const candidates = [
    { id: "SP.RUR.TOTL", name: "Rural population", source: "worldbank" },
    { id: "SP.RUR.TOTL.ZS", name: "Rural population (% of total population)", source: "worldbank" },
  ];
  it("turns an ambiguous lookup into a choice, with no chart and no model, even with a key", async () => {
    const runFastPath = vi.fn().mockResolvedValue({ ok: false, reason: "ambiguous", phrase: "rural population", candidates });
    const createSession = vi.fn();
    const agent = new ChittiAgent(config, { runFastPath, createSession });
    const surfaces: unknown[] = [];
    agent.subscribe({ onCustomEvent: ({ event }) => { surfaces.push(event); } });
    question(agent, "rural population of India");
    await agent.runAgent({ runId: "amb" });
    expect(createSession).not.toHaveBeenCalled();
    expect(surfaces).toHaveLength(0);
    expect(agent.state.analysis.result).toBeNull();
    expect(agent.state.analysis.phase).toBe("done");
    expect(agent.state.analysis.choice).toEqual({ phrase: "rural population", plan: expect.objectContaining({ indicatorQuery: "rural population" }), candidates });
    expect(agent.state.analysis.status).toContain("fits more than one series");
  });
  it("runs the series the user picked, records it with the other choices, and stamps the run's bounds", async () => {
    const demo = DEMOS[0].state;
    const runFastPath = vi.fn().mockResolvedValue({
      plan, hit: { id: candidates[1].id, name: candidates[1].name, source: "worldbank" },
      spec: demo.spec, rows: demo.rows, citations: demo.citations, summary: "s", trace: [], alternatives: [candidates[0]],
    });
    const agent = new ChittiAgent({ ...config, apiKey: "" }, { runFastPath, createSession: vi.fn() });
    agent.useDirect(plan, candidates[1]);
    question(agent, "Rural population (% of total population)");
    await agent.runAgent({ runId: "pick" });
    expect(runFastPath.mock.calls[0][0]).toBe(plan);
    expect(runFastPath.mock.calls[0][1].chosen).toEqual(candidates[1]);
    const a = agent.state.analysis;
    expect(a.direct).toEqual({ plan, series: candidates[1], alternatives: [candidates[0]] });
    expect(a.startedAt).toBeTypeOf("number");
    expect(a.endedAt).toBeGreaterThanOrEqual(a.startedAt);
    expect(a.provider).toBeUndefined();
  });
  it("never escalates a chosen-series lookup to the model when it fails", async () => {
    const runFastPath = vi.fn().mockResolvedValue({ ok: false, reason: "no-data", hit: { id: "X", name: "Rural population", source: "worldbank" } });
    const createSession = vi.fn();
    const agent = new ChittiAgent(config, { runFastPath, createSession });
    agent.useDirect(plan, candidates[0]);
    question(agent, "Remove India");
    await agent.runAgent({ runId: "edit" }).catch(() => {});
    expect(createSession).not.toHaveBeenCalled();
    expect(agent.state.analysis.phase).toBe("error");
    expect(agent.state.analysis.status).toBe("Rural population has no values for those countries and years.");
  });
});
