import { useEffect, useRef, useState } from "react";
import {
  companion,
  chatGPTModels,
  type ChatGPTAccount,
} from "../../lib/chitti/chatgpt";
import type { ModelOption } from "../../lib/chitti/providers";

export default function ChatGPTConnection({
  account,
  locked = false,
  onAccount,
  onModels,
}: {
  account?: string;
  locked?: boolean;
  onAccount: (id: string) => void;
  onModels: (models: ModelOption[]) => void;
}) {
  const mounted = useRef(true);
  const [accounts, setAccounts] = useState<ChatGPTAccount[]>([]);
  const [status, setStatus] = useState("Checking local companion…");
  const [online, setOnline] = useState(false);
  const [authURL, setAuthURL] = useState("");
  const [busy, setBusy] = useState(false);
  async function check() {
    setBusy(true);
    let reached = false;
    try {
      const result = await companion<{ accounts: ChatGPTAccount[] }>("status");
      if (!mounted.current) return;
      reached = true;
      if (!Array.isArray(result.accounts))
        throw new Error("Invalid companion status.");
      setOnline(true);
      setAccounts(result.accounts);
      const selected =
        result.accounts.find((a) => a.id === account) ||
        (!locked ? result.accounts.find((a) => a.connected) : undefined);
      if (selected?.connected) {
        const models = await chatGPTModels(selected.id);
        if (!mounted.current) return;
        onAccount(selected.id);
        onModels(models);
        setAuthURL("");
        setStatus(`${selected.label} · ${models.length} models`);
      } else {
        onAccount("");
        onModels([]);
        setStatus("Ready to sign in.");
      }
    } catch (e) {
      if (!mounted.current) return;
      setOnline(reached);
      setStatus(e instanceof Error ? e.message : "Companion unavailable.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
    };
  }, []);
  async function signIn(newAccount = false) {
    setBusy(true);
    try {
      const result = await companion<{ url: string }>("auth/start", {
        account: newAccount ? undefined : account || undefined,
      });
      if (!mounted.current) return;
      const url = new URL(result.url);
      if (
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize"
      )
        throw new Error("Invalid sign-in URL.");
      setAuthURL(url.href);
      setStatus("Open ChatGPT to authorize access, then check the connection.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  async function select(id: string) {
    onAccount(id);
    onModels([]);
    setBusy(true);
    try {
      if (accounts.find((a) => a.id === id)?.connected) {
        const models = await chatGPTModels(id);
        if (!mounted.current) return;
        onModels(models);
        setStatus("Account selected.");
      } else setStatus("Reconnect this saved account.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not load models.");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      const result = await companion<{ message: string }>("disconnect", {
        account,
      });
      if (!mounted.current) return;
      setAccounts(
        accounts.map((a) =>
          a.id === account ? { ...a, connected: false } : a,
        ),
      );
      onModels([]);
      setAuthURL("");
      setStatus(result.message);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cw-chatgpt">
      <p>Use your ChatGPT plan. Credentials stay in the local companion.</p>
      {!online && (
        <details open>
          <summary>Start the companion once per session</summary>
          <p>In a local checkout of this site, with Node 22 or newer:</p>
          <pre>
            <code>
              npm install
              <br />
              npm run chitti:connect
            </code>
          </pre>
          <p>
            If this browser blocks the connection, run the local interface in a
            second terminal:
          </p>
          <pre>
            <code>npm run dev -- --host 127.0.0.1 --port 4322</code>
          </pre>
          <p>
            <a
              href="http://127.0.0.1:4322/apps/chitti/"
              target="_blank"
              rel="noreferrer"
            >
              Open local Chitti ↗
            </a>
          </p>
          <a
            href="https://github.com/amaljithkuttamath/amaljithkuttamath.github.io/blob/main/docs/chitti-chatgpt.md"
            target="_blank"
            rel="noreferrer"
          >
            Setup instructions ↗
          </a>
        </details>
      )}
      {accounts.length > 0 && (
        <label>
          ChatGPT account
          <select
            value={account || ""}
            onChange={(e) => void select(e.target.value)}
            disabled={busy || locked}
          >
            <option value="" disabled>
              Choose an account
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
                {a.connected ? "" : " · signed out"}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="cw-chatgpt-actions">
        {online && !authURL && (
          <button type="button" disabled={busy} onClick={() => void signIn()}>
            Continue with ChatGPT
          </button>
        )}
        {authURL && (
          <a
            className="cw-primary"
            href={authURL}
            target="_blank"
            rel="noreferrer"
          >
            Continue with ChatGPT ↗
          </a>
        )}
        {authURL && (
          <button type="button" disabled={busy} onClick={() => void signIn()}>
            Restart sign-in
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void check()}>
          Check connection
        </button>
        {online && !locked && accounts.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void signIn(true)}
          >
            Add account
          </button>
        )}
        {accounts.find((a) => a.id === account)?.connected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Disconnect
          </button>
        )}
      </div>
      <p role="status">{status}</p>
      <p>
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noreferrer"
        >
          Plan usage & app limits ↗
        </a>{" "}
        · No automatic switch to API billing.
      </p>
    </div>
  );
}
