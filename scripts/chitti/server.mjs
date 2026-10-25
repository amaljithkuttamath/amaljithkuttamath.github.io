import { createServer } from "node:http";
import {
  authorization,
  callbackClient,
  tokenRecord,
  exchange,
  verifyIdentity,
  revoke,
} from "./oauth.mjs";
import {
  requestSchema,
  responsesRequest,
  modelOptions,
  readCompletion,
  subscriptionError,
} from "./protocol.mjs";

export const PORT = 4319;
const allowedOrigins = new Set([
  "https://amaljithkuttamath.github.io",
  "http://127.0.0.1:4322",
  "http://127.0.0.1:4323",
  "http://localhost:4322",
  "http://localhost:4323",
]);
export function allowedRequest(headers, port = PORT) {
  return (
    headers.host === `127.0.0.1:${port}` && allowedOrigins.has(headers.origin)
  );
}
async function jsonBody(req) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024)
      throw new Error("Request exceeds the 2 MB limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid request JSON.");
  }
}
export function createCompanion({
  store,
  persist,
  fetcher = fetch,
  verify = verifyIdentity,
  port = PORT,
  openBrowser = async () => false,
}) {
  let lastConnected,
    pending,
    authBusy = false,
    lastAuth = 0;
  const refreshing = new Map(),
    controllers = new Map(),
    signingOut = new Set();
  const accountFor = (id) => {
    const a = store.accounts.find((a) => a.client_id === id);
    if (!a || !a.access_token || signingOut.has(id))
      throw new Error("Connect your ChatGPT account in Settings.");
    return a;
  };
  async function access(id) {
    let a = accountFor(id);
    if (a.expires > Date.now() + 60_000) return a.access_token;
    if (!refreshing.has(id)) {
      const task = (async () => {
        const raw = await exchange(
          {
            grant_type: "refresh_token",
            client_id: id,
            refresh_token: a.refresh_token,
          },
          fetcher,
        );
        if (raw.id_token) await verify(raw.id_token, id, undefined, a.subject);
        const updated = tokenRecord(raw, a);
        if (signingOut.has(id)) return updated; // Sign-out revokes the latest rotating token.
        Object.assign(a, updated);
        await persist();
        return updated;
      })();
      refreshing.set(id, task);
      task.finally(() => refreshing.delete(id)).catch(() => {});
    }
    await refreshing.get(id);
    return accountFor(id).access_token;
  }
  async function api(path, id, options = {}) {
    const token = await access(id);
    const response = await fetcher(`https://api.openai.com/v1/${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: options.signal || AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401)
        throw new Error("ChatGPT access expired. Reconnect in Settings.");
      throw new Error(subscriptionError(body.error?.code));
    }
    return response;
  }
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.host !== `127.0.0.1:${port}`)
      return send(403, { error: "Invalid host." });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/auth/callback" && req.method === "GET") {
      if (authBusy)
        return send(409, { error: "Sign-in is already completing." });
      let success = false,
        message = "Sign-in failed. Return to Chitti and try again.";
      try {
        const attempt = pending;
        // Ignore unsolicited callbacks without consuming the legitimate attempt.
        const client = callbackClient(url.searchParams, attempt);
        pending = undefined;
        authBusy = true;
        const raw = await exchange(
          {
            grant_type: "authorization_code",
            client_id: client,
            code: url.searchParams.get("code"),
            code_verifier: attempt.verifier,
            redirect_uri: attempt.redirect,
          },
          fetcher,
        );
        const identity = await verify(
          raw.id_token,
          client,
          attempt.nonce,
          attempt.account?.subject,
        );
        const record = tokenRecord(raw, { ...identity, client_id: client });
        store.accounts = [
          ...store.accounts.filter((a) => a.client_id !== client),
          record,
        ];
        await persist();
        lastConnected = client;
        success = true;
        message = "Connected. Return to Chitti and choose a model.";
      } catch {
        if (pending?.state === url.searchParams.get("state"))
          pending = undefined;
      } finally {
        authBusy = false;
      }
      res.writeHead(success ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      return res.end(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Chitti · ChatGPT</title><style>body{font:16px system-ui;max-width:36em;margin:15vh auto;padding:24px}h1{font-size:22px}</style><h1>${message}</h1><p>You can close this tab.</p>`,
      );
    }
    if (!allowedRequest(req.headers, port))
      return send(403, { error: "This origin cannot use Chitti’s companion." });
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Chitti-Client",
        "Access-Control-Allow-Private-Network": "true",
        "Access-Control-Max-Age": "600",
      });
      return res.end();
    }
    if (
      req.method !== "POST" ||
      req.headers["x-chitti-client"] !== "1" ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return send(403, { error: "Use the Chitti client." });
    try {
      const body = await jsonBody(req);
      if (url.pathname === "/status")
        return send(200, {
          authorizing: authBusy || !!(pending && pending.expires > Date.now()),
          lastConnected,
          accounts: store.accounts.map((a) => ({
            id: a.client_id,
            label: `${a.email || "ChatGPT account"} · ${a.client_id.slice(-6)}`,
            connected: !!a.access_token && !signingOut.has(a.client_id),
          })),
        });
      if (url.pathname === "/auth/start") {
        if (authBusy || Date.now() - lastAuth < 2000)
          throw new Error("Sign-in is already starting. Wait a moment.");
        const account = body.account
          ? store.accounts.find((a) => a.client_id === body.account)
          : undefined;
        if (body.account && !account)
          throw new Error("Unknown ChatGPT account.");
        lastAuth = Date.now();
        const attempt = authorization(
          store.host,
          `http://127.0.0.1:${port}/auth/callback`,
          account,
        );
        pending = attempt.pending;
        lastConnected = undefined;
        const opened = await openBrowser(attempt.url).catch(() => false);
        return send(200, { url: attempt.url, opened });
      }
      if (url.pathname === "/disconnect") {
        const a = accountFor(body.account);
        signingOut.add(a.client_id);
        if (pending?.account?.client_id === a.client_id) pending = undefined;
        controllers.get(a.client_id)?.forEach((c) => c.abort());
        let latest = a;
        try {
          latest = (await refreshing.get(a.client_id)) || a;
        } catch {}
        const revoked = await revoke(latest, fetcher);
        const { client_id, subject, email } = a;
        Object.keys(a).forEach((k) => delete a[k]);
        Object.assign(a, { client_id, subject, email });
        await persist();
        signingOut.delete(client_id);
        return send(200, {
          message: revoked
            ? "Disconnected."
            : "Disconnected locally. Remote revocation was not confirmed; remove Chitti in ChatGPT Settings.",
        });
      }
      if (url.pathname === "/models")
        return send(200, {
          models: modelOptions(
            await (await api("models", body.account)).json(),
          ),
        });
      if (url.pathname === "/complete") {
        const request = requestSchema.parse(body);
        const active = controllers.get(request.account) || new Set();
        if (active.size >= 4)
          throw new Error(
            "Too many active ChatGPT requests. Wait for the current analysis.",
          );
        const controller = new AbortController();
        active.add(controller);
        controllers.set(request.account, active);
        const onClose = () => controller.abort();
        res.on("close", onClose);
        try {
          const models = modelOptions(
            await (await api("models", request.account)).json(),
          );
          if (!models.some((m) => m.id === request.model))
            throw new Error(
              "This model is unavailable to your ChatGPT account. Reload models in Settings.",
            );
          const upstream = await api("responses", request.account, {
            method: "POST",
            body: JSON.stringify(responsesRequest(request)),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(180_000),
            ]),
          });
          const result = await readCompletion(upstream.body);
          if (!res.destroyed) send(200, result);
        } finally {
          active.delete(controller);
          res.off("close", onClose);
        }
        return;
      }
      send(404, { error: "Unknown companion route." });
    } catch (e) {
      if (!res.destroyed && !res.headersSent)
        send(400, {
          error:
            e.name === "ZodError"
              ? "Invalid model request."
              : e instanceof Error
                ? e.message
                : "Companion request failed.",
        });
    }
  });
}
