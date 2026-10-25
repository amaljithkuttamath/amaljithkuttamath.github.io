import type { CompletionResult, ModelOption } from "./providers";

const base = "http://127.0.0.1:4319";
export interface ChatGPTAccount {
  id: string;
  label: string;
  connected: boolean;
}
export async function companion<T>(
  path: string,
  data: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Chitti-Client": "1" },
      body: JSON.stringify(data),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(185_000)])
        : AbortSignal.timeout(15_000),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(
      "Start the Chitti companion, then reconnect. Allow local network access if your browser asks.",
    );
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "ChatGPT companion request failed.",
    );
  return result as T;
}
export async function chatGPTModels(account?: string): Promise<ModelOption[]> {
  if (!account) throw new Error("Connect a ChatGPT account first.");
  const result = await companion<{ models: ModelOption[] }>("models", {
    account,
  });
  if (
    !Array.isArray(result.models) ||
    result.models.some(
      (m) => typeof m?.id !== "string" || typeof m.label !== "string",
    )
  )
    throw new Error("Invalid ChatGPT model catalog.");
  return result.models;
}
export async function chatGPTCompletion(
  data: unknown,
  signal?: AbortSignal,
): Promise<CompletionResult> {
  const r = await companion<CompletionResult>("complete", data, signal);
  if (
    typeof r?.text !== "string" ||
    !Array.isArray(r.toolCalls) ||
    !r.usage ||
    typeof r.usage.input !== "number" ||
    typeof r.usage.output !== "number" ||
    r.toolCalls.some(
      (t) =>
        typeof t?.id !== "string" ||
        typeof t.name !== "string" ||
        !t.arguments ||
        typeof t.arguments !== "object" ||
        Array.isArray(t.arguments),
    )
  )
    throw new Error("Invalid ChatGPT completion.");
  return r;
}
