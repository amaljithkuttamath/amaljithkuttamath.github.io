import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createCompanion } from "./server.mjs";
const origin = "https://amaljithkuttamath.github.io";
const grant = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  id_token: "test-id",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "resource.invoke chatgpt.tokens.use.direct",
};
const record = {
  client_id: "issued",
  subject: "subject",
  email: "test@example.com",
  ...grant,
  expires: Date.now() + 3600000,
};
// Exercise the actual HTTP handler without opening a port in unit-test sandboxes.
function request(server: any, path: string, body: any = {}, options: any = {}) {
  return new Promise<{ status: number; body: any; headers: any }>((resolve) => {
    const req = Readable.from(
      options.method === "GET" ? [] : [Buffer.from(JSON.stringify(body))],
    ) as any;
    req.url = path;
    req.method = options.method || "POST";
    req.headers = {
      host: "127.0.0.1:4319",
      origin,
      "content-type": "application/json",
      "x-chitti-client": "1",
      ...options.headers,
    };
    const res = new EventEmitter() as any;
    const headers: any = {};
    res.setHeader = (k: string, v: any) => {
      headers[k] = v;
    };
    res.writeHead = (status: number, h: any) => {
      res.status = status;
      res.headersSent = true;
      Object.assign(headers, h);
    };
    res.end = (text: string) => {
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      resolve({ status: res.status, body, headers });
    };
    server.emit("request", req, res);
  });
}
describe("ChatGPT companion integration", () => {
  it("blocks cross-origin and simple form requests before touching credentials", async () => {
    const fetcher = vi.fn();
    const server = createCompanion({
      store: { accounts: [record] },
      persist: vi.fn(),
      fetcher,
    });
    expect(
      (
        await request(
          server,
          "/status",
          {},
          { headers: { origin: "https://evil.example" } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          server,
          "/status",
          {},
          { headers: { "x-chitti-client": undefined } },
        )
      ).status,
    ).toBe(403);
    const status = await request(server, "/status");
    expect(status.body.accounts[0]).toEqual({
      id: "issued",
      label: "test@example.com · issued",
      connected: true,
    });
    expect(JSON.stringify(status)).not.toContain("test-access");
    expect(JSON.stringify(status)).not.toContain("test-refresh");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("validates identity before activating a registration and consumes callbacks once", async () => {
    const store = { host: "host-1", accounts: [] as any[] };
    const persist = vi.fn();
    const verify = vi.fn(async () => ({
      subject: "verified-subject",
      email: "verified@example.com",
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify(grant)));
    const openBrowser = vi.fn(async () => true);
    const server = createCompanion({
      store,
      persist,
      fetcher,
      verify,
      openBrowser,
    });
    const auth = await request(server, "/auth/start");
    expect(openBrowser).toHaveBeenCalledWith(auth.body.url);
    expect(auth.body.opened).toBe(true);
    expect((await request(server, "/status")).body).toMatchObject({
      authorizing: true,
    });
    const q = new URL(auth.body.url).searchParams;
    const callback = `/auth/callback?${new URLSearchParams({ code: "test-code", state: q.get("state")!, client_id: "issued" })}`;
    expect(
      (await request(server, callback, {}, { method: "GET" })).status,
    ).toBe(200);
    expect(verify).toHaveBeenCalledWith(
      "test-id",
      "issued",
      q.get("nonce"),
      undefined,
    );
    expect(store.accounts[0]).toMatchObject({
      subject: "verified-subject",
      client_id: "issued",
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect((await request(server, "/status")).body).toMatchObject({
      authorizing: false,
      lastConnected: "issued",
    });
    expect(
      (await request(server, callback, {}, { method: "GET" })).status,
    ).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not activate credentials when identity validation fails", async () => {
    const store = { host: "host-1", accounts: [] as any[] };
    const server = createCompanion({
      store,
      persist: vi.fn(),
      fetcher: async () => new Response(JSON.stringify(grant)),
      verify: async () => {
        throw new Error("nonce mismatch");
      },
    });
    const auth = await request(server, "/auth/start");
    const state = new URL(auth.body.url).searchParams.get("state")!;
    expect(
      (
        await request(
          server,
          `/auth/callback?${new URLSearchParams({ code: "c", state, client_id: "issued" })}`,
          {},
          { method: "GET" },
        )
      ).status,
    ).toBe(400);
    expect(store.accounts).toEqual([]);
  });
  it("serializes rotating refreshes and isolates the selected account", async () => {
    const store = {
      accounts: [
        { ...record, expires: 0 },
        { ...record, client_id: "other", access_token: "other-access" },
      ],
    };
    const fetcher = vi.fn(async (url: any) =>
      String(url).endsWith("/oauth/token")
        ? new Response(
            JSON.stringify({
              ...grant,
              refresh_token: "replacement",
              access_token: "renewed",
            }),
          )
        : new Response(
            JSON.stringify({
              models: [
                { visibility: "list", slug: "m", display_name: "Model" },
              ],
            }),
          ),
    );
    const server = createCompanion({
      store,
      persist: vi.fn(),
      fetcher,
      verify: async () => ({ subject: "subject", email: undefined }),
    });
    const results = await Promise.all([
      request(server, "/models", { account: "issued" }),
      request(server, "/models", { account: "issued" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      fetcher.mock.calls.filter(([u]) => u.endsWith("/oauth/token")),
    ).toHaveLength(1);
    expect(store.accounts[0].refresh_token).toBe("replacement");
    expect(store.accounts[1].access_token).toBe("other-access");
  });
  it("maps Responses tool output and never falls back on a subscription limit", async () => {
    let fail = false;
    const fetcher = vi.fn(async (url: any, options?: any) => {
      expect(options.headers.Authorization).toBe("Bearer test-access");
      if (url.endsWith("/models"))
        return new Response(
          JSON.stringify({
            models: [{ visibility: "list", slug: "m", display_name: "Model" }],
          }),
        );
      expect(JSON.parse(options.body)).toMatchObject({
        model: "m",
        store: false,
        stream: true,
      });
      const event = fail
        ? {
            type: "response.failed",
            response: {
              error: { code: "subscription_sharing_usage_limit_exceeded" },
            },
          }
        : {
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "function_call",
                  namespace: "chitti",
                  call_id: "c",
                  name: "lookup",
                  arguments: "{}",
                },
              ],
            },
          };
      return new Response(`data: ${JSON.stringify(event)}\n\n`);
    });
    const server = createCompanion({
      store: { accounts: [{ ...record }] },
      persist: vi.fn(),
      fetcher,
    });
    const body = {
      account: "issued",
      model: "m",
      messages: [{ role: "user", content: "Lookup GDP" }],
      tools: [],
    };
    expect((await request(server, "/complete", body)).body.toolCalls).toEqual([
      { id: "c", name: "lookup", arguments: {} },
    ]);
    fail = true;
    expect((await request(server, "/complete", body)).body.error).toContain(
      "subscription limit",
    );
    expect(
      fetcher.mock.calls.filter(([u]) => u.endsWith("/responses")),
    ).toHaveLength(2);
    expect(
      (await request(server, "/complete", { ...body, model: "not-in-catalog" }))
        .body.error,
    ).toContain("unavailable");
  });
  it("revokes sign-out, clears tokens and retains the account registration", async () => {
    const store = { accounts: [{ ...record }] };
    const fetcher = vi.fn(async (url: any) =>
      String(url).includes("openid-configuration")
        ? new Response(
            JSON.stringify({
              revocation_endpoint: "https://auth.openai.com/revoke",
            }),
          )
        : new Response(null, { status: 200 }),
    );
    const server = createCompanion({ store, persist: vi.fn(), fetcher });
    expect(
      (await request(server, "/disconnect", { account: "issued" })).body
        .message,
    ).toBe("Disconnected.");
    expect(store.accounts[0]).toEqual({
      client_id: "issued",
      subject: "subject",
      email: "test@example.com",
    });
    expect(
      (await request(server, "/models", { account: "issued" })).body.error,
    ).toContain("Connect");
  });
});
