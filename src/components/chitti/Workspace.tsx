import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ViewEdit } from "../../lib/chitti/workspace/steering";
import { ChittiAgent } from "../../lib/chitti/workspace/agent";
import { DEMOS } from "../../lib/chitti/demos";
import {
  fromShared,
  resultSurface,
  type Analysis,
  type Settings as Config,
  type WorkspaceState,
} from "../../lib/chitti/workspace/model";
import {
  decodeShareState,
  encodeShareState,
  type ShareStateV1,
} from "../../lib/chitti/share";
import {
  PROVIDERS,
  providerMeta,
  type ProviderId,
} from "../../lib/chitti/providers";
import { SOURCES, rowsToCSV } from "../../lib/chitti/tools";
import { buildFindingOkf } from "../../lib/chitti/okf";
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import Settings from "./Settings";
import Surface from "./Surface";
import Dashboards, { download } from "./Dashboards";
import "./workspace.css";
function initialConfig(): Config {
  let provider: ProviderId = "openrouter",
    apiKey = "";
  try {
    const saved = sessionStorage.getItem("chitti:provider");
    if (PROVIDERS.some((p) => p.id === saved)) {
      provider = saved as ProviderId;
      apiKey = sessionStorage.getItem("chitti:key") || "";
    }
  } catch {}
  return {
    provider,
    model: providerMeta(provider).models[0]?.id || "",
    apiKey,
    sources: SOURCES.map((s) => s.id),
    rlm: false,
  };
}
export default function Workspace() {
  const [config, setConfig] = useState(initialConfig);
  const [agent] = useState(() => new ChittiAgent(config));
  const [turns, setTurns] = useState<Analysis[]>([]);
  const [selected, setSelected] = useState(
    DEMOS[0] ? `example:${DEMOS[0].id}` : "",
  );
  const [question, setQuestion] = useState("");
  const [useCurrent, setUseCurrent] = useState(true);
  const parents = useRef<Record<string, string>>({});
  const contexts = useRef<Record<string, ShareStateV1 | null>>({});
  const [running, setRunning] = useState(false),
    [settings, setSettings] = useState(false),
    [dashboards, setDashboards] = useState(false);
  const [pin, setPin] = useState<ShareStateV1 | null>(null),
    [notice, setNotice] = useState(""),
    [receipt, setReceipt] = useState(false);
  const [surfaces, setSurfaces] = useState<Record<string, unknown[]>>({});
  const [clarification, setClarification] = useState<{
    runId: string;
    operations: unknown[];
  } | null>(null);
  const activeRun = useRef(""),
    busy = useRef(false),
    composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const sub = agent.subscribe({
      onStateChanged: ({ state }) => {
        const snapshot = state as WorkspaceState;
        if (snapshot.analysis) {
          const next = snapshot.analysis;
          setTurns((previous) => {
            const found = previous.some((t) => t.id === next.id);
            return found
              ? previous.map((t) => (t.id === next.id ? next : t))
              : [...previous, next];
          });
        }
        if (!snapshot.question) setClarification(null);
      },
      onCustomEvent: ({ event, input }) => {
        if (event.name !== "a2ui" || !Array.isArray(event.value?.operations))
          return;
        const operations = event.value.operations;
        if (operations[0]?.createSurface?.surfaceId === "question")
          setClarification({ runId: input.runId, operations });
        else {
          setSurfaces((previous) => ({
            ...previous,
            [input.runId]: operations,
          }));
          setSelected(input.runId);
        }
      },
    });
    return () => {
      sub.unsubscribe();
      agent.stop();
    };
  }, [agent]);
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      if (location.hash.startsWith("#dash=")) {
        setDashboards(true);
        return;
      }
      if (!location.hash.startsWith("#share=")) return;
      const state = await decodeShareState(location.hash.slice(7));
      if (cancelled) return;
      if (!state) {
        setNotice("This shared answer could not be decoded.");
        return;
      }
      const analysis = fromShared(state, "shared", crypto.randomUUID());
      setTurns((t) => [...t, analysis]);
      setSelected(analysis.id);
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);
  const example = DEMOS.find((d) => selected === `example:${d.id}`);
  const active = useMemo(
    () =>
      example
        ? fromShared(example.state, "example", selected)
        : turns.find((t) => t.id === selected),
    [example, selected, turns],
  );
  const operations = useMemo(
    () =>
      surfaces[selected] ||
      (active?.result ? resultSurface(active.result) : null),
    [surfaces, selected, active?.result],
  );
  const respond = useCallback(
    (action: ActionPayload) => {
      if (
        action.name === "answer" &&
        typeof action.context.requestId === "string" &&
        typeof action.context.value === "string"
      )
        agent.respond(action.context.requestId, action.context.value);
    },
    [agent],
  );
  const submit = async (
    text = question,
    force = false,
    context: ShareStateV1 | null = useCurrent && active?.origin !== "example"
      ? active?.result || null
      : null,
    edit?: ViewEdit,
  ) => {
    if (busy.current || !text.trim()) return;
    busy.current = true;
    setRunning(true);
    setDashboards(false);
    setNotice("");
    setReceipt(false);
    const id = crypto.randomUUID();
    activeRun.current = id;
    parents.current[id] = selected;
    contexts.current[id] = context;
    setQuestion("");
    setUseCurrent(true);
    agent.useWorkspace(context, edit);
    if (force) agent.escalate();
    agent.addMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: text.trim(),
    });
    try {
      await agent.runAgent({ runId: id });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Analysis failed.");
    } finally {
      busy.current = false;
      setRunning(false);
      activeRun.current = "";
    }
  };
  const steerResult = (action: ActionPayload) => {
    if (busy.current || !active?.result) return;
    const value = action.context.value;
    if (action.name === "focus" && typeof value === "string")
      void submit(`Focus on ${value}`, false, active.result, {
        kind: "series",
        name: value,
      });
    if (action.name === "recent")
      void submit("Show the last 10 years", false, active.result, {
        kind: "recent",
      });
    if (action.name === "ask-view" && typeof value === "string" && value.trim())
      void submit(value.slice(0, 2000), true, active.result);
  };
  const newAnalysis = () => {
    if (busy.current) return;
    agent.reset();
    setSelected("");
    setQuestion("");
    setNotice("");
    setDashboards(false);
    setClarification(null);
    history.replaceState(null, "", location.pathname);
    composer.current?.focus();
  };
  const saveConfig = (value: Config, remember: boolean) => {
    try {
      agent.configure(value);
      setConfig(value);
      try {
        if (remember) {
          sessionStorage.setItem("chitti:key", value.apiKey);
          sessionStorage.setItem("chitti:provider", value.provider);
        } else {
          sessionStorage.removeItem("chitti:key");
          sessionStorage.removeItem("chitti:provider");
        }
      } catch {
        setNotice(
          "Settings applied. Browser storage is unavailable, so the key is kept only in memory.",
        );
      }
      setSettings(false);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const share = async () => {
    if (!active?.result) return;
    try {
      const r = await encodeShareState({
        question: active.question,
        answer: active.result.answer,
        spec: active.result.spec,
        rows: active.result.rows,
        citations: active.result.citations,
        verification: active.result.verification,
        ts: active.result.ts,
      });
      if (!r.ok) {
        setNotice("Too large for a link. Download the data instead.");
        return;
      }
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}#share=${r.payload}`,
      );
      setNotice(
        r.lossy
          ? "Link copied. Full evidence rows are omitted from this link."
          : "Result link copied.",
      );
    } catch {
      setNotice("Clipboard unavailable. Use the CSV or Markdown download.");
    }
  };
  return (
    <div className="cw">
      <header className="cw-header">
        <div>
          <h1>
            Chitti<span>Work with the data</span>
          </h1>
        </div>
        <div className="cw-actions">
          <button
            onClick={() => {
              setDashboards(!dashboards);
              setPin(null);
            }}
            aria-pressed={dashboards}
          >
            Dashboards
          </button>
          <button onClick={() => setSettings(true)}>
            Settings{" "}
            <span className="cw-connection" data-connected={!!config.apiKey} />
          </button>
        </div>
      </header>
      <div className="cw-workspace">
        <aside className="cw-conversation" aria-label="Conversation">
          <div className="cw-conversation-head">
            <h2>Conversation</h2>
            <button disabled={running} onClick={newAnalysis}>
              New
            </button>
          </div>
          <div className="cw-messages" aria-live="polite">
            {turns.filter((t) => t.origin !== "shared").length === 0 && (
              <div className="cw-welcome">
                <p>Ask for data, or start with the open example.</p>
                <p>
                  Focus a series or change the period in the workspace. Ask
                  about the view to continue with your model.
                </p>
              </div>
            )}
            {turns
              .filter((t) => t.origin !== "shared")
              .map((t) => (
                <section className="cw-message" key={t.id}>
                  <p className="cw-user-message">{t.question}</p>
                  <p className="cw-status" data-phase={t.phase}>
                    {t.status}
                  </p>
                  {t.result && (
                    <button
                      className="cw-open-result"
                      aria-pressed={selected === t.id}
                      onClick={() => {
                        setSelected(t.id);
                        setDashboards(false);
                        setReceipt(false);
                      }}
                    >
                      View result <span aria-hidden="true">↗</span>
                    </button>
                  )}
                  {t.phase === "needs-key" && (
                    <div className="cw-actions">
                      <button onClick={() => setSettings(true)}>
                        Connect model
                      </button>
                      <button
                        disabled={running}
                        onClick={() =>
                          void submit(
                            t.question,
                            false,
                            contexts.current[t.id] || null,
                          )
                        }
                      >
                        Retry
                      </button>
                    </div>
                  )}
                  {t.phase === "error" && (
                    <button
                      disabled={running}
                      onClick={() =>
                        void submit(
                          t.question,
                          false,
                          contexts.current[t.id] || null,
                        )
                      }
                    >
                      Retry
                    </button>
                  )}
                  {clarification?.runId === t.id && (
                    <Surface
                      operations={clarification.operations}
                      onAction={respond}
                    />
                  )}
                </section>
              ))}
          </div>
          <form
            className="cw-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor="cw-question">
              {agent.sessionLocked
                ? "Continue this analysis"
                : "Ask a data question"}
            </label>
            {active?.result && active.origin !== "example" && (
              <label className="cw-context-toggle">
                <input
                  type="checkbox"
                  checked={useCurrent}
                  disabled={running}
                  onChange={(e) => setUseCurrent(e.target.checked)}
                />
                Use current view
              </label>
            )}
            <textarea
              id="cw-question"
              ref={composer}
              value={question}
              rows={2}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                useCurrent && active?.result && active.origin !== "example"
                  ? "Ask about the current view…"
                  : "Compare life expectancy in Japan, Italy and Spain since 1960"
              }
            />
            <div>
              <span>
                {config.apiKey
                  ? `${config.model} · ${config.sources.length} sources`
                  : "Direct lookups need no API key"}
              </span>
              {running ? (
                <button type="button" onClick={() => agent.stop()}>
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="cw-primary"
                  disabled={!question.trim()}
                >
                  Analyze <span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
          </form>
          <p className="cw-privacy">
            Your key stays in this browser. Requests go to your selected
            provider.
          </p>
        </aside>
        <section className="cw-main" aria-label="Analysis workspace">
          {dashboards ? (
            <Dashboards
              pin={pin}
              onPinned={() => setPin(null)}
              onClose={() => {
                setDashboards(false);
                setPin(null);
              }}
            />
          ) : (
            <>
              <div className="cw-workspace-bar">
                <span>Workspace</span>
                <label>
                  Open result
                  <select
                    aria-label="Open result"
                    value={selected}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setReceipt(false);
                    }}
                  >
                    <option value="">Choose a result</option>
                    <optgroup label="Recorded examples">
                      {DEMOS.map((d) => (
                        <option key={d.id} value={`example:${d.id}`}>
                          {d.question}
                        </option>
                      ))}
                    </optgroup>
                    {turns.some((t) => t.result) && (
                      <optgroup label="This session">
                        {turns
                          .filter((t) => t.result)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.question}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>
                </label>
              </div>
              {running && (
                <p className="cw-live-status" role="status">
                  <span className="cw-pulse" />
                  {turns.find((t) => t.id === activeRun.current)?.status ||
                    "Starting analysis"}
                  <span>
                    {selected === activeRun.current
                      ? "Draft · Stop to steer"
                      : "Preparing next revision"}
                  </span>
                </p>
              )}
              {notice && (
                <p className="cw-notice" role="status">
                  {notice}
                </p>
              )}
              {active ? (
                <article className="cw-analysis">
                  <header className="cw-analysis-head">
                    <div>
                      <span className="cw-origin">
                        {active.origin === "example"
                          ? "Recorded example"
                          : active.origin === "shared"
                            ? "Shared snapshot"
                            : active.origin === "view"
                              ? "Adjusted view"
                              : active.origin === "direct"
                                ? "Direct lookup"
                                : "Agent analysis"}
                      </span>
                      <h2>{active.question}</h2>
                      <p
                        role="status"
                        className="cw-status"
                        data-phase={active.phase}
                      >
                        {active.status}
                        {active.cost !== undefined
                          ? ` · $${active.cost.toFixed(4)}`
                          : ""}
                      </p>
                    </div>
                    {active.origin === "view" && (
                      <button
                        disabled={running}
                        onClick={() => {
                          setSelected(parents.current[selected] || "");
                        }}
                      >
                        Previous view
                      </button>
                    )}
                    <button
                      onClick={() => setReceipt(!receipt)}
                      aria-expanded={receipt}
                    >
                      Steps
                      {active.trace.length ? ` ${active.trace.length}` : ""}
                    </button>
                  </header>
                  {active.phase === "needs-key" && (
                    <div className="cw-actions">
                      <button onClick={() => setSettings(true)}>
                        Connect model
                      </button>
                      <button
                        disabled={running}
                        onClick={() => void submit(active.question)}
                      >
                        Retry question
                      </button>
                    </div>
                  )}
                  {active.phase === "error" && (
                    <button
                      disabled={running}
                      onClick={() => void submit(active.question)}
                    >
                      Retry
                    </button>
                  )}
                  {receipt && (
                    <section
                      className="cw-receipts"
                      aria-label="Execution steps"
                    >
                      {!active.trace.length && (
                        <p>
                          {active.origin === "example" ||
                          active.origin === "shared"
                            ? "This snapshot includes the result and sources, not the original execution log."
                            : "No completed steps yet."}
                        </p>
                      )}
                      {active.trace.map((step, i) => (
                        <details
                          key={`${step.ts}-${i}`}
                          open={step.status === "running"}
                        >
                          <summary>
                            <span data-state={step.status}>
                              {step.status === "ok"
                                ? "✓"
                                : step.status === "error"
                                  ? "!"
                                  : "·"}
                            </span>
                            <strong>{step.tool.replaceAll("_", " ")}</strong>
                            <span>{step.argSummary}</span>
                          </summary>
                          {step.detail && <pre>{step.detail}</pre>}
                        </details>
                      ))}
                      {Object.entries(active.files).map(([name, body]) => (
                        <details key={name}>
                          <summary>{name}</summary>
                          <pre>{body}</pre>
                          <button
                            onClick={() =>
                              download(
                                name.split("/").at(-1) || "file.txt",
                                body,
                              )
                            }
                          >
                            Download file
                          </button>
                        </details>
                      ))}
                    </section>
                  )}
                  {operations ? (
                    <Surface
                      key={selected}
                      operations={operations}
                      onAction={steerResult}
                      disabled={running}
                    />
                  ) : active.phase === "running" ? (
                    <div className="cw-pending">
                      <span className="cw-pulse" />
                      Reading sources and preparing the result…
                    </div>
                  ) : null}
                  {active.result && (
                    <footer className="cw-actions cw-result-actions">
                      <button onClick={() => void share()}>Share result</button>
                      <button
                        disabled={!active.result.rows.length}
                        onClick={() =>
                          download(
                            "chitti-data.csv",
                            rowsToCSV(active.result!.rows),
                            "text/csv",
                          )
                        }
                      >
                        Download CSV
                      </button>
                      <button
                        onClick={() =>
                          download(
                            "chitti-analysis.md",
                            buildFindingOkf({
                              question: active.question,
                              finding: active.result!.answer,
                              spec: active.result!.spec,
                              citations: active.result!.citations,
                              verification: active.result!.verification,
                              createdAt: active.result!.ts,
                            }),
                            "text/markdown",
                          )
                        }
                      >
                        Markdown
                      </button>
                      {active.result.spec && (
                        <button
                          onClick={() => {
                            setPin(active.result);
                            setDashboards(true);
                          }}
                        >
                          Pin chart
                        </button>
                      )}
                      {active.origin === "direct" &&
                        active.phase === "done" && (
                          <button
                            disabled={running}
                            onClick={() => void submit(active.question, true)}
                          >
                            Analyze with model
                          </button>
                        )}
                    </footer>
                  )}
                </article>
              ) : (
                <div className="cw-start">
                  <h2>Chart, data and sources stay together.</h2>
                  <p>
                    Choose a recorded example to inspect its chart, values and
                    sources, or ask your own question in the conversation.
                  </p>
                  <button
                    onClick={() => {
                      setQuestion(
                        "Chart life expectancy in Japan, Italy and Spain since 1960",
                      );
                      composer.current?.focus();
                    }}
                  >
                    Try a live data lookup
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {settings && (
        <Settings
          value={config}
          locked={running || agent.sessionLocked}
          onSave={saveConfig}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
