import { useEffect, useRef, useState } from "react";
import {
  companion,
  chatGPTModels,
  type ChatGPTAccount,
} from "../../lib/chitti/chatgpt";
import type { ModelOption } from "../../lib/chitti/providers";
import { Button, Select } from "./ui/controls";
import { MicroLabel } from "./ui/primitives";
type Status = {
  accounts: ChatGPTAccount[];
  authorizing?: boolean;
  lastConnected?: string;
};
export default function ChatGPTConnection(props: {
  account?: string;
  locked?: boolean;
  onAccount: (id: string) => void;
  onModels: (models: ModelOption[]) => void;
}) {
  const { account, locked = false } = props;
  const current = useRef(props);
  current.current = props;
  const mounted = useRef(true);
  const [accounts, setAccounts] = useState<ChatGPTAccount[]>([]);
  const [status, setStatus] = useState("Checking connection…");
  const [online, setOnline] = useState(false);
  const [authURL, setAuthURL] = useState("");
  const [busy, setBusy] = useState(false);
  const connected = accounts.find((a) => a.id === account)?.connected;
  async function accept(result: Status, preferred?: string) {
    if (!mounted.current) return;
    if (!Array.isArray(result.accounts))
      throw new Error("Invalid companion status.");
    setOnline(true);
    setAccounts(result.accounts);
    const p = current.current;
    const selected =
      result.accounts.find((a) => a.id === (preferred || p.account)) ||
      (!p.locked ? result.accounts.find((a) => a.connected) : undefined);
    if (selected?.connected) {
      const models = await chatGPTModels(selected.id);
      if (!mounted.current) return;
      p.onAccount(selected.id);
      p.onModels(models);
      setAuthURL("");
      setStatus("Connected. Uses your ChatGPT plan.");
    } else {
      p.onAccount(selected?.id || "");
      p.onModels([]);
      setStatus("Sign in to use your ChatGPT plan.");
    }
  }
  async function check() {
    setBusy(true);
    try {
      const result = await companion<Status>("status");
      if (!mounted.current) return;
      setOnline(true);
      await accept(result);
    } catch (e) {
      if (mounted.current)
        setStatus(e instanceof Error ? e.message : "Connection unavailable.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void check();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!authURL) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 5 * 60_000;
    async function poll() {
      try {
        const result = await companion<Status>("status");
        if (cancelled) return;
        if (!result.authorizing && result.lastConnected) {
          await accept(result, result.lastConnected);
          return;
        }
      } catch {
        /* Keep the sign-in link available while the companion recovers. */
      }
      if (!cancelled && Date.now() < deadline) timer = setTimeout(poll, 2000);
      else if (!cancelled) setStatus("Sign-in expired. Start again below.");
    }
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authURL]);
  async function signIn(newAccount = false) {
    setBusy(true);
    try {
      const result = await companion<{ url: string; opened?: boolean }>(
        "auth/start",
        { account: newAccount ? undefined : account || undefined },
      );
      if (!mounted.current) return;
      const url = new URL(result.url);
      if (
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize"
      )
        throw new Error("Invalid sign-in URL.");
      setAuthURL(url.href);
      setStatus(
        result.opened
          ? "Finish sign-in in your browser. This connection updates automatically."
          : "Open ChatGPT to finish sign-in. This connection updates automatically.",
      );
    } catch (e) {
      if (mounted.current)
        setStatus(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function select(id: string) {
    current.current.onAccount(id);
    current.current.onModels([]);
    setBusy(true);
    try {
      await accept({ accounts }, id);
    } catch (e) {
      if (mounted.current)
        setStatus(e instanceof Error ? e.message : "Could not load models.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      const result = await companion<{ message: string }>("disconnect", {
        account,
      });
      if (!mounted.current) return;
      setAccounts((a) =>
        a.map((v) => (v.id === account ? { ...v, connected: false } : v)),
      );
      current.current.onModels([]);
      setAuthURL("");
      setStatus(result.message);
    } catch (e) {
      if (mounted.current)
        setStatus(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const accountLabel = accounts.find((a) => a.id === account)?.label.split(" · ")[0];
  return (
    <div className="cx-chatgpt" data-connected={connected || undefined}>
      {connected && (
        <div className="cx-account">
          <span className="cx-model-dot" data-on="" role="img" aria-label="Connected" />
          <span className="cx-account-name">{accountLabel}</span>
          <MicroLabel>Connected</MicroLabel>
        </div>
      )}
      {(!connected || status !== "Connected. Uses your ChatGPT plan.") && (
        <p className="cx-status-text" role="status">
          {status}
        </p>
      )}
      {(!connected || authURL) && (
        <div className="cx-row">
          {online && !authURL && (
            <Button
              label="Continue with ChatGPT"
              disabled={busy}
              onClick={() => void signIn()}
            />
          )}
          {authURL && (
            <>
              <Button
                label="Open ChatGPT sign-in"
                href={authURL}
                target="_blank"
                rel="noreferrer"
              />
              <Button
                label="Restart sign-in"
                variant="ghost"
                disabled={busy}
                onClick={() => void signIn()}
              />
            </>
          )}
          {!online && (
            <Button
              label="Check connection"
              disabled={busy}
              onClick={() => void check()}
            />
          )}
        </div>
      )}
      {!online && !busy && (
        <details className="cx-disclosure" open>
          <summary>Connect this computer</summary>
          <div className="cx-disclosure-body">
            <p className="cx-status-text">In your local site checkout, run:</p>
            <pre className="cx-pre">
              <code>{"npm install\nnpm run chitti:connect"}</code>
            </pre>
            <p className="cx-status-text">
              If this browser blocks the connection, run the local interface:
            </p>
            <pre className="cx-pre">
              <code>
                npm run build &amp;&amp; npm run preview -- --host 127.0.0.1 --port 4323
              </code>
            </pre>
            <p className="cx-row">
              <a
                href="http://127.0.0.1:4323/apps/chitti/"
                target="_blank"
                rel="noreferrer"
              >
                Open local Chitti
              </a>
              <a
                href="https://github.com/amaljithkuttamath/amaljithkuttamath.github.io/blob/main/docs/chitti-chatgpt.md"
                target="_blank"
                rel="noreferrer"
              >
                Setup guide
              </a>
            </p>
          </div>
        </details>
      )}
      {online && (
        <details className="cx-disclosure">
          <summary>{connected ? "Account and usage" : "Connection options"}</summary>
          <div className="cx-disclosure-body">
            {accounts.length > 0 && (
              <Select
                label="ChatGPT account"
                placeholder="Choose an account"
                disabled={busy || locked}
                value={account || ""}
                onChange={(id) => void select(id)}
                options={accounts.map((a) => ({
                  value: a.id,
                  label: `${a.label}${a.connected ? "" : " · signed out"}`,
                }))}
              />
            )}
            <div className="cx-row">
              <Button
                size="sm"
                label="Check connection"
                disabled={busy}
                onClick={() => void check()}
              />
              {connected && (
                <>
                  <Button
                    size="sm"
                    label="Reconnect"
                    disabled={busy}
                    onClick={() => void signIn()}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    label="Disconnect"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  />
                </>
              )}
              {!locked && accounts.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  label="Add account"
                  disabled={busy}
                  onClick={() => void signIn(true)}
                />
              )}
            </div>
            <p className="cx-status-text">
              <a
                href="https://chatgpt.com/settings/usage"
                target="_blank"
                rel="noreferrer"
              >
                ChatGPT plan usage
              </a>
              . Credentials stay on this computer. No automatic API billing.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
