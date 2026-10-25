import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const random = () => randomBytes(32).toString("base64url");
export function sameState(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function authorization(host, redirect, account) {
  const pending = {
    state: random(),
    nonce: random(),
    verifier: random(),
    redirect,
    account,
    expires: Date.now() + 5 * 60_000,
  };
  const url = new URL(`${issuer}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: account?.client_id || "dynamic_agent_client",
    ...(account ? {} : { agent_name_hint: "Chitti" }),
    ext_agent_host_id: host,
    response_type: "code",
    redirect_uri: redirect,
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(pending.verifier)
      .digest("base64url"),
  }).toString();
  // Deliberately omit token hints: no ID token passes through the website.
  return { pending, url: url.href };
}
export function callbackClient(query, pending) {
  if (
    !pending ||
    pending.expires < Date.now() ||
    !sameState(query.get("state"), pending.state)
  )
    throw new Error(
      "Sign-in expired or state did not match. Start again in Chitti.",
    );
  if (query.has("error"))
    throw new Error(
      "ChatGPT sign-in was not authorized. Start again when ready.",
    );
  const issued = query.get("client_id") || pending.account?.client_id;
  if (
    !issued ||
    issued === "dynamic_agent_client" ||
    issued.length > 256 ||
    (pending.account && issued !== pending.account.client_id) ||
    !query.get("code")
  )
    throw new Error("ChatGPT returned an invalid registration. Start again.");
  return issued;
}
export function tokenRecord(raw, previous = {}) {
  const scopes = typeof raw.scope === "string" ? raw.scope.split(" ") : [];
  if (
    typeof raw.access_token !== "string" ||
    !raw.access_token ||
    typeof raw.refresh_token !== "string" ||
    !raw.refresh_token ||
    raw.token_type?.toLowerCase() !== "bearer" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0 ||
    !scopes.includes("chatgpt.tokens.use.direct") ||
    !scopes.includes("resource.invoke")
  )
    throw new Error(
      "ChatGPT plan access was not granted. Reconnect and allow subscription access.",
    );
  return {
    ...previous,
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    id_token:
      typeof raw.id_token === "string" ? raw.id_token : previous.id_token,
    scopes,
    expires: Date.now() + raw.expires_in * 1000,
  };
}
export async function verifyIdentity(token, client, nonce, subject) {
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: client,
    requiredClaims: ["sub", "exp", "iat", ...(nonce ? ["nonce"] : [])],
  });
  if (
    typeof payload.sub !== "string" ||
    !payload.sub ||
    (nonce && payload.nonce !== nonce) ||
    (subject && payload.sub !== subject)
  )
    throw new Error("ChatGPT identity did not match this sign-in.");
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}
export async function loadStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const store = JSON.parse(
      await readFile(join(directory, "accounts.json"), "utf8"),
    );
    if (typeof store.host !== "string" || !Array.isArray(store.accounts))
      throw new Error("Invalid Chitti account store.");
    await chmod(join(directory, "accounts.json"), 0o600);
    return store;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return { host: `urn:uuid:${randomUUID()}`, accounts: [] };
  }
}
export async function saveStore(directory, store) {
  const temp = join(directory, `.accounts-${random()}.tmp`);
  await writeFile(temp, JSON.stringify(store), { mode: 0o600, flag: "wx" });
  await rename(temp, join(directory, "accounts.json"));
}
export async function exchange(fields, fetcher = fetch) {
  const res = await fetcher(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, resource }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!res.ok)
    throw new Error(
      `ChatGPT sign-in needs to be restarted (token endpoint ${res.status}).`,
    );
  return res.json();
}
export async function revoke(account, fetcher = fetch) {
  if (!account.refresh_token) return true;
  try {
    const discovery = await fetcher(
      `${issuer}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(10_000), redirect: "error" },
    );
    if (!discovery.ok) return false;
    const endpoint = new URL((await discovery.json()).revocation_endpoint);
    if (endpoint.origin !== issuer) return false;
    for (let n = 0; n < 2; n++) {
      try {
        const result = await fetcher(endpoint, {
          method: "POST",
          body: new URLSearchParams({
            token: account.refresh_token,
            token_type_hint: "refresh_token",
            client_id: account.client_id,
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        if (result.status === 200) return true;
        if (result.status < 500) return false;
      } catch {}
      if (n === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {}
  return false;
}
