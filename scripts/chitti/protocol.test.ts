import { describe, it, expect } from "vitest";
import {
  responsesRequest,
  modelOptions,
  readCompletion,
  completion,
} from "./protocol.mjs";
const request = {
  account: "client-a",
  model: "account-model",
  messages: [{ role: "user", content: "Compare data" }],
  tools: [],
};
const output = {
  status: "completed",
  model: "account-model",
  output: [
    { type: "message", content: [{ type: "output_text", text: "Result" }] },
  ],
  usage: { input_tokens: 2, output_tokens: 3 },
};
function stream(events: unknown[], fragment = 7) {
  const data = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < data.length; i += fragment)
        c.enqueue(new TextEncoder().encode(data.slice(i, i + fragment)));
      c.close();
    },
  });
}
describe("ChatGPT subscription Responses protocol", () => {
  it("uses stateless streaming, developer instructions and namespaced tools with full history", () => {
    const r = responsesRequest({
      ...request,
      temperature: 1,
      previous_response_id: "ignored",
      messages: [
        { role: "system", content: "Use evidence" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", name: "lookup", arguments: { q: "GDP" } },
          ],
        },
        {
          role: "tool",
          name: "lookup",
          tool_call_id: "call-1",
          content: "source data",
        },
        ...request.messages,
      ],
      tools: [
        {
          name: "lookup",
          description: "Search",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(r).toMatchObject({
      store: false,
      stream: true,
      tools: [
        {
          type: "namespace",
          name: "chitti",
          tools: [{ type: "function", name: "lookup", strict: false }],
        },
      ],
    });
    expect(r.input).toEqual([
      { role: "developer", content: "Use evidence" },
      {
        type: "function_call",
        namespace: "chitti",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"q":"GDP"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "source data",
      },
      ...request.messages,
    ]);
    expect(r).not.toHaveProperty("temperature");
    expect(r).not.toHaveProperty("previous_response_id");
    expect(r).not.toHaveProperty("account");
  });
  it("uses only visible account-specific models in server order", () => {
    expect(
      modelOptions({
        models: [
          { visibility: "list", slug: "z", display_name: "Z" },
          { visibility: "hidden", slug: "a", display_name: "A" },
          { visibility: "list", slug: "b", display_name: "B" },
          null,
        ],
      }),
    ).toEqual([
      { id: "z", label: "Z" },
      { id: "b", label: "B" },
    ]);
    expect(() => modelOptions({ data: [] })).toThrow("invalid model catalog");
  });
  it("handles chunked SSE only after completed", async () => {
    expect(
      await readCompletion(
        stream(
          [
            { type: "response.output_text.delta", delta: "ignored" },
            { type: "response.completed", response: output },
          ],
          1,
        ),
      ),
    ).toMatchObject({ text: "Result", usage: { input: 2, output: 3 } });
  });
  it.each(["response.failed", "error"])(
    "surfaces subscription limit from %s after deltas",
    async (type) => {
      await expect(
        readCompletion(
          stream([
            { type: "response.output_text.delta", delta: "partial" },
            {
              type,
              code: "subscription_sharing_usage_limit_exceeded",
              response: {
                error: { code: "subscription_sharing_usage_limit_exceeded" },
              },
            },
          ]),
        ),
      ).rejects.toThrow("subscription limit");
    },
  );
  it("rejects interrupted or incomplete streams", async () => {
    await expect(
      readCompletion(
        stream([{ type: "response.output_text.delta", delta: "partial" }]),
      ),
    ).rejects.toThrow("before completion");
    await expect(
      readCompletion(stream([{ type: "response.incomplete" }])),
    ).rejects.toThrow("before completing");
  });
  it("validates tool argument objects and namespace", () => {
    const tool = {
      type: "function_call",
      namespace: "chitti",
      call_id: "c",
      name: "lookup",
      arguments: '{"q":"GDP"}',
    };
    expect(completion({ ...output, output: [tool] }).toolCalls).toEqual([
      { id: "c", name: "lookup", arguments: { q: "GDP" } },
    ]);
    for (const arguments_ of ["[]", "null", "broken"])
      expect(() =>
        completion({ ...output, output: [{ ...tool, arguments: arguments_ }] }),
      ).toThrow("invalid tool arguments");
    expect(() =>
      completion({ ...output, output: [{ ...tool, namespace: "shell" }] }),
    ).toThrow("invalid tool call");
  });
});
