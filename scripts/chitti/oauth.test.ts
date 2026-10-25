import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorization,
  callbackClient,
  tokenRecord,
  loadStore,
  saveStore,
  exchange,
  revoke,
} from "./oauth.mjs";
import { allowedRequest } from "./server.mjs";
const redirect = "http://127.0.0.1:4319/auth/callback";
const tokens = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid resource.invoke chatgpt.tokens.use.direct",
};
describe("ChatGPT OAuth boundary", () => {
  it("binds initial registration to a persistent host and fresh PKCE/state/nonce", () => {
    const { pending, url } = authorization("host-1", redirect);
    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("dynamic_agent_client");
    expect(params.get("agent_name_hint")).toBe("Chitti");
    expect(params.get("ext_agent_host_id")).toBe("host-1");
    expect(params.get("redirect_uri")).toBe(redirect);
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(pending.verifier).digest("base64url"),
    );
    expect(authorization("host-1", redirect).pending.state).not.toBe(
      pending.state,
    );
  });
  it("reuses issued registration without exposing token hints", () => {
    const { pending, url } = authorization("host-1", redirect, {
      client_id: "issued",
      subject: "s",
      id_token: "secret",
    });
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("issued");
    expect(q.has("agent_name_hint")).toBe(false);
    expect(url).not.toContain("secret");
    expect(
      callbackClient(
        new URLSearchParams({ code: "c", state: pending.state }),
        pending,
      ),
    ).toBe("issued");
    expect(() =>
      callbackClient(
        new URLSearchParams({
          code: "c",
          state: pending.state,
          client_id: "other",
        }),
        pending,
      ),
    ).toThrow("invalid registration");
  });
  it("rejects wrong/expired state, denial and missing issued client", () => {
    const { pending } = authorization("host-1", redirect);
    expect(() =>
      callbackClient(new URLSearchParams({ state: "wrong" }), pending),
    ).toThrow("state");
    expect(() =>
      callbackClient(new URLSearchParams({ state: pending.state }), {
        ...pending,
        expires: 0,
      }),
    ).toThrow("expired");
    expect(() =>
      callbackClient(
        new URLSearchParams({ state: pending.state, error: "access_denied" }),
        pending,
      ),
    ).toThrow("not authorized");
    for (const client_id of ["", "dynamic_agent_client"])
      expect(() =>
        callbackClient(
          new URLSearchParams({ state: pending.state, code: "c", client_id }),
          pending,
        ),
      ).toThrow("invalid registration");
  });
  it("requires granted subscription permissions and replacement refresh token", () => {
    expect(tokenRecord(tokens).scopes).toContain("chatgpt.tokens.use.direct");
    for (const patch of [
      { scope: "openid" },
      { refresh_token: "" },
      { expires_in: -1 },
      { token_type: "other" },
    ])
      expect(() => tokenRecord({ ...tokens, ...patch })).toThrow("not granted");
  });
  it("allows only exact website/development origins and loopback host", () => {
    expect(
      allowedRequest({
        host: "127.0.0.1:4319",
        origin: "https://amaljithkuttamath.github.io",
      }),
    ).toBe(true);
    for (const origin of [
      "null",
      undefined,
      "https://evil.example",
      "https://amaljithkuttamath.github.io.evil.example",
    ])
      expect(allowedRequest({ host: "127.0.0.1:4319", origin })).toBe(false);
    expect(
      allowedRequest({
        host: "evil.example:4319",
        origin: "https://amaljithkuttamath.github.io",
      }),
    ).toBe(false);
  });
  it("persists a stable host and credentials atomically with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chitti-auth-test-"));
    try {
      const first = await loadStore(dir);
      first.accounts.push({ client_id: "test", ...tokens });
      await saveStore(dir, first);
      expect(await loadStore(dir)).toEqual(first);
      expect((await stat(join(dir, "accounts.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("exchanges at the fixed token endpoint with resource binding and no client secret", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(tokens)));
    await exchange(
      {
        grant_type: "refresh_token",
        client_id: "issued",
        refresh_token: "test-refresh",
      },
      f,
    );
    const [url, opts] = f.mock.calls[0] as any;
    expect(url).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(opts.body.get("resource")).toBe("https://api.openai.com/v1");
    expect(opts.body.has("client_secret")).toBe(false);
    expect(opts.body.has("scope")).toBe(false);
  });
  it("refuses off-origin revocation endpoints", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ revocation_endpoint: "https://evil.example" }),
        ),
    );
    expect(await revoke(tokens, f)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
