import { afterEach, expect, it, vi } from "vitest";
import { complete, fetchModels } from "./providers";
afterEach(() => vi.unstubAllGlobals());
it("uses the local subscription transport without an API key or paid fallback", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: "ChatGPT subscription limit reached." }),
        { status: 400 },
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    complete(
      {
        provider: "chatgpt",
        model: "account-model",
        apiKey: "",
        chatgptAccount: "issued",
      },
      [{ role: "user", content: "hello" }],
    ),
  ).rejects.toThrow("subscription limit");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0] as any;
  expect(url).toBe("http://127.0.0.1:4319/complete");
  expect(JSON.parse(options.body)).toMatchObject({
    account: "issued",
    model: "account-model",
  });
  expect(options.headers.Authorization).toBeUndefined();
  expect(options.headers["X-Chitti-Client"]).toBe("1");
});
it("never supplies hardcoded subscription models on a disconnected catalog", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
  await expect(fetchModels("chatgpt", "", "issued")).rejects.toThrow(
    "Start the Chitti companion",
  );
});
