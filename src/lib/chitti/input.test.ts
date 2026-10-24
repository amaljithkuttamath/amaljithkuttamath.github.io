import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers")>()),
  complete: vi.fn(),
}));
import { complete } from "./providers";
import { createSession } from "./session";
const mock = vi.mocked(complete);
const turn = (name: string, args: Record<string, unknown>) => ({
  text: "",
  toolCalls: [{ id: name, name, arguments: args }],
  usage: { input: 1, output: 1 },
});
const callbacks = {
  onTrace: vi.fn(),
  onFiles: vi.fn(),
  onChart: vi.fn(),
  onStatus: vi.fn(),
};
beforeEach(() => mock.mockReset());
describe("request_input tool", () => {
  it("feeds the chosen answer back into the real agent loop", async () => {
    mock.mockResolvedValueOnce(
      turn("request_input", {
        question: "Which units?",
        options: ["Total", "Per person"],
      }),
    );
    mock.mockResolvedValueOnce(
      turn("finish_explanation", { explanation: "Using per-person units." }),
    );
    const requestInput = vi.fn().mockResolvedValue("Per person");
    const session = createSession(
      { provider: "openrouter", model: "test", apiKey: "test" },
      { requestInput },
    );
    const result = await session.ask("Clarify the units", callbacks);
    expect(requestInput).toHaveBeenCalledWith(
      { question: "Which units?", options: ["Total", "Per person"] },
      undefined,
    );
    expect(mock.mock.calls[1][1]).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: JSON.stringify({ answer: "Per person" }),
      }),
    );
    expect(result.finding).toBe("Using per-person units.");
  });
  it("refuses malformed options without opening a control", async () => {
    mock.mockResolvedValueOnce(
      turn("request_input", { question: "Which?", options: ["Same", "Same"] }),
    );
    mock.mockResolvedValueOnce(
      turn("finish_explanation", { explanation: "Please specify units." }),
    );
    const requestInput = vi.fn();
    const session = createSession(
      { provider: "openrouter", model: "test", apiKey: "test" },
      { requestInput },
    );
    await session.ask("Clarify the units", callbacks);
    expect(requestInput).not.toHaveBeenCalled();
    expect(JSON.stringify(mock.mock.calls[1][1])).toContain(
      "2 to 5 short options",
    );
  });
});
