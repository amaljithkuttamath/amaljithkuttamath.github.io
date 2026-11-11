import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  complete: vi.fn(),
}));
import { complete } from "./providers";
import { createSession } from "./session";
import { VFS } from "./vfs";
const mock = vi.mocked(complete);
const turn = (name: string, args: Record<string, unknown>, id = name) => ({
  text: "",
  toolCalls: [{ id, name, arguments: args }],
  usage: { input: 1, output: 1 },
});
const say = (text: string) => ({ text, toolCalls: [], usage: { input: 1, output: 1 } });
const callbacks = () => ({ onTrace: vi.fn(), onFiles: vi.fn(), onChart: vi.fn(), onStatus: vi.fn() });
const cfg = { provider: "openrouter" as const, model: "test", apiKey: "test" };
const toolResult = (call: number, id: string) =>
  (mock.mock.calls[call][1] as any[]).find((m) => m.role === "tool" && m.tool_call_id === id)?.content;

beforeEach(() => mock.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("files written in one turn are readable in the next", () => {
  it("keeps the model's filesystem in step with the file list the UI shows", async () => {
    const session = createSession(cfg);
    const cb = callbacks();
    mock.mockResolvedValueOnce(turn("write_file", { path: "note.md", content: "keep me" }));
    mock.mockResolvedValueOnce(turn("finish_explanation", { explanation: "Saved." }));
    await session.ask("Write a note", cb);

    mock.mockResolvedValueOnce(turn("read_file", { path: "note.md" }));
    mock.mockResolvedValueOnce(turn("finish_explanation", { explanation: "Read." }));
    await session.ask("Read it back", cb);

    // Turn 2's second model call carries the read_file result.
    expect(toolResult(3, "read_file")).toBe("keep me");
    expect(cb.onFiles.mock.calls.at(-1)![0]).toHaveProperty("note.md", "keep me");
  });
});

describe("VFS.read", () => {
  it("returns only what was written, never an inherited property", () => {
    const vfs = new VFS();
    vfs.write("a.md", "x");
    expect(vfs.read("a.md")).toBe("x");
    for (const path of ["constructor", "__proto__", "toString", "missing.md"]) expect(vfs.read(path)).toBe("");
  });
});

describe("a chart turn that runs out of budget", () => {
  it("is summarised before it is verified, instead of verifying an empty finding", async () => {
    const points = [2000, 2001, 2002].map((year, i) => ({
      indicator: { id: "SP.POP.TOTL", value: "Population, total" },
      country: { id: "IN", value: "India" },
      countryiso3code: "IND",
      date: String(year),
      value: 1000 + i,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [{ page: 1, pages: 1, per_page: 2000, total: points.length, lastupdated: "2026-01-01" }, points],
        text: async () => "",
      })),
    );
    mock.mockResolvedValueOnce(turn("fetch_series", { indicator: "SP.POP.TOTL", countries: ["IND"] }));
    mock.mockResolvedValueOnce(
      turn("render_chart", {
        type: "line",
        title: "Population",
        series: [{ name: "India", data: [[2000, 1000], [2001, 1001], [2002, 1002]] }],
      }),
    );
    for (let i = 0; i < 4; i++) mock.mockResolvedValueOnce(turn("growth_stats", {}, "g" + i));
    mock.mockResolvedValueOnce(say("India's population rose from 1,000 to 1,002."));
    mock.mockResolvedValue(say("PASS: matches the rows."));

    const out = await createSession(cfg, { sources: ["worldbank"] }).ask("Population of India", callbacks());
    expect(out.chartSpec).not.toBeNull();
    expect(out.rows.length).toBe(3);
    expect(out.finding).toBe("India's population rose from 1,000 to 1,002.");
    // The summariser was asked exactly once, with no tools.
    const summaries = mock.mock.calls.filter((c) => String((c[1] as any[])[0]?.content).startsWith("Summarize the analysis"));
    expect(summaries).toHaveLength(1);
  });
});
