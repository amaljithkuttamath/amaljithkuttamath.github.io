import { z } from "zod";

const call = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()),
});
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }),
  z.object({ role: z.literal("user"), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    tool_calls: z.array(call).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);
export const requestSchema = z.object({
  account: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  messages: z.array(message).min(1).max(1000),
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        description: z.string(),
        parameters: z.object({
          type: z.literal("object"),
          properties: z.record(z.unknown()),
          required: z.array(z.string()).optional(),
        }),
      }),
    )
    .max(128),
});

export function responsesRequest(raw) {
  const { model, messages, tools } = requestSchema.parse(raw);
  const input = messages.flatMap((m) => {
    if (m.role === "system") return [{ role: "developer", content: m.content }];
    if (m.role === "tool")
      return [
        {
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: m.content,
        },
      ];
    if (m.role === "assistant")
      return [
        ...(m.content ? [{ role: "assistant", content: m.content }] : []),
        ...(m.tool_calls || []).map((t) => ({
          type: "function_call",
          namespace: "chitti",
          call_id: t.id,
          name: t.name,
          arguments: JSON.stringify(t.arguments),
        })),
      ];
    return [{ role: "user", content: m.content }];
  });
  return {
    model,
    input,
    store: false,
    stream: true,
    ...(tools.length
      ? {
          tools: [
            {
              type: "namespace",
              name: "chitti",
              description:
                "Find, analyze and present institutional data in the user’s workspace.",
              tools: tools.map((t) => ({
                type: "function",
                ...t,
                strict: false,
              })),
            },
          ],
        }
      : {}),
  };
}

export function modelOptions(raw) {
  if (!raw || !Array.isArray(raw.models))
    throw new Error("ChatGPT returned an invalid model catalog.");
  return raw.models
    .filter(
      (m) =>
        m?.visibility === "list" &&
        typeof m.slug === "string" &&
        typeof m.display_name === "string",
    )
    .map((m) => ({ id: m.slug, label: m.display_name }));
}

export function subscriptionError(code) {
  if (code === "subscription_sharing_usage_limit_exceeded")
    return "ChatGPT subscription limit reached. Review usage in ChatGPT Settings or retry later.";
  if (code === "subscription_sharing_usage_unavailable")
    return "ChatGPT subscription sharing is unavailable for this account. Check its app permissions in ChatGPT Settings.";
  return "ChatGPT could not complete this request. Retry, or reconnect in Settings.";
}

export function completion(response) {
  if (response?.status !== "completed" || !Array.isArray(response.output))
    throw new Error("ChatGPT returned an incomplete response.");
  let text = "";
  const toolCalls = [];
  for (const item of response.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content)
        if (part.type === "output_text" && typeof part.text === "string")
          text += part.text;
    } else if (item.type === "function_call") {
      if (
        typeof item.call_id !== "string" ||
        typeof item.name !== "string" ||
        (item.namespace && item.namespace !== "chitti")
      )
        throw new Error("ChatGPT returned an invalid tool call.");
      let args;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error("ChatGPT returned invalid tool arguments.");
      }
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("ChatGPT returned invalid tool arguments.");
      toolCalls.push({ id: item.call_id, name: item.name, arguments: args });
    }
  }
  if (!text && !toolCalls.length)
    throw new Error("ChatGPT returned no text or tool calls.");
  const count = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  return {
    text,
    toolCalls,
    usage: {
      input: count(response.usage?.input_tokens),
      output: count(response.usage?.output_tokens),
    },
    servedModel:
      typeof response.model === "string" ? response.model : undefined,
  };
}

// Incremental SSE framing: never accept partial deltas as a completed answer.
export async function readCompletion(body) {
  if (!body) throw new Error("ChatGPT returned no response stream.");
  const reader = body.getReader(),
    decoder = new TextDecoder();
  const finalized = new Map();
  let buffer = "",
    total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16 * 1024 * 1024)
        throw new Error("ChatGPT response exceeded the size limit.");
      buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error("ChatGPT returned a malformed stream event.");
        }
        if (event.type === "response.output_item.done") {
          if (
            !Number.isInteger(event.output_index) ||
            event.output_index < 0 ||
            event.output_index > 2048 ||
            !event.item ||
            typeof event.item !== "object" ||
            !["completed", undefined].includes(event.item.status)
          )
            throw new Error("ChatGPT returned an invalid output item.");
          finalized.set(event.output_index, event.item);
        }
        if (event.type === "response.completed") {
          // Subscription streams can put final content only in output_item.done.
          // Keep waiting for this terminal event before returning any result.
          const response = event.response;
          return completion({
            ...response,
            output:
              Array.isArray(response?.output) && response.output.length
                ? response.output
                : [...finalized.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, item]) => item),
          });
        }
        if (event.type === "response.failed" || event.type === "error")
          throw new Error(
            subscriptionError(event.response?.error?.code || event.code),
          );
        if (event.type === "response.incomplete")
          throw new Error(
            "ChatGPT stopped before completing the response. Retry with a shorter request.",
          );
      }
    }
    throw new Error(
      "ChatGPT stream ended before completion. Retry the request.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
