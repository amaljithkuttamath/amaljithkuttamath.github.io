import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExplanationContext } from "./ChangeExplanation";
import {
  chartChanges,
  changeKey,
  changeQuestion,
  type ChartChange,
} from "../../lib/chitti/chart-insights";
import { describeChange } from "../../lib/chitti/workspace/changes";
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
import { providerMeta } from "../../lib/chitti/providers";
import { SOURCES, rowsToCSV } from "../../lib/chitti/tools";
import { buildFindingOkf } from "../../lib/chitti/okf";
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import Settings from "./Settings";
import ExamplePlot from "./ExamplePlot";
import {
  readPreferences,
  writePreferences,
  selectProvider,
  type ProviderProfiles,
} from "../../lib/chitti/workspace/preferences";
import Surface from "./Surface";
import Dashboards, { download } from "./Dashboards";
import "./workspace.css";
function initialPreferences() {
  try {
    return readPreferences(sessionStorage);
  } catch {
    return { active: "chatgpt" as const, profiles: {} };
  }
}
export default function Workspace() {
  const [preferences] = useState(initialPreferences);
  const [profiles, setProfiles] = useState<ProviderProfiles>(
    preferences.profiles,
  );
  const [config, setConfig] = useState<Config>(() =>
    selectProvider(
      {
        provider: preferences.active,
        apiKey: "",
        model: "",
        sources: SOURCES.map((s) => s.id),
        rlm: false,
      },
      preferences.active,
      preferences.profiles,
    ),
  );
  const [agent] = useState(() => new ChittiAgent(config));
  const explanationRuns = useRef<
    Record<string, { view: string; change: ChartChange }>
  >({});
  const [explanations, setExplanations] = useState<
    Record<string, { change: ChartChange; analysis: Analysis }>
  >({});
  const [turns, setTurns] = useState<Analysis[]>([]);
  const [selected, setSelected] = useState("");
  const [question, setQuestion] = useState("");
  const [useCurrent, setUseCurrent] = useState(false);
  const [redo, setRedo] = useState<string[]>([]);
  const [latestRequest, setLatestRequest] = useState("");
  const [navigationNote, setNavigationNote] = useState("");
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
          const target = explanationRuns.current[next.id];
          if (target) {
            setExplanations((previous) => ({
              ...previous,
              [target.view]: { change: target.change, analysis: next },
            }));
            if (!snapshot.question) setClarification(null);
            return;
          }
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
        else if (!explanationRuns.current[input.runId]) {
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
      active?.origin === "view" && active.result
        ? resultSurface({ ...active.result, answer: "" })
        : surfaces[selected] ||
          (active?.result ? resultSurface(active.result) : null),
    [surfaces, selected, active?.result, active?.origin],
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
    context: ShareStateV1 | null = useCurrent ? active?.result || null : null,
    edit?: ViewEdit,
    detail?: ChartChange,
  ) => {
    if (busy.current || !text.trim()) return;
    busy.current = true;
    setRunning(true);
    setDashboards(false);
    setNotice("");
    setReceipt(false);
    const id = crypto.randomUUID();
    activeRun.current = id;
    if (detail) {
      explanationRuns.current[id] = { view: selected, change: detail };
      setLatestRequest("");
    } else {
      setLatestRequest(id);
      setNavigationNote("");
      setRedo([]);
      parents.current[id] = selected;
      setQuestion("");
      setUseCurrent(true);
    }
    contexts.current[id] = context;
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
      const message =
        error instanceof Error ? error.message : "Analysis failed.";
      if (detail)
        setExplanations((previous) => {
          const current = previous[selected];
          return current
            ? {
                ...previous,
                [selected]: {
                  ...current,
                  analysis: {
                    ...current.analysis,
                    phase: "error",
                    status: message,
                  },
                },
              }
            : previous;
        });
      else setNotice(message);
    } finally {
      busy.current = false;
      setRunning(false);
      activeRun.current = "";
    }
  };
  const steerResult = (action: ActionPayload) => {
    if (busy.current || !active?.result) return;
    const value = action.context.value;
    if (
      action.name === "explain-change" &&
      typeof value === "string" &&
      active.result.spec
    ) {
      const detail = chartChanges(active.result.spec).find(
        (c) => changeKey(c) === value,
      );
      if (
        detail &&
        explanations[selected] &&
        changeKey(explanations[selected].change) === value
      ) {
        setExplanations((previous) => {
          const next = { ...previous };
          delete next[selected];
          return next;
        });
        return;
      }
      if (detail)
        void submit(
          changeQuestion(detail),
          true,
          active.result,
          undefined,
          detail,
        );
      return;
    }
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
    setNavigationNote("");
    setSelected("");
    setLatestRequest("");
    setRedo([]);
    setUseCurrent(false);
    setQuestion("");
    setNotice("");
    setDashboards(false);
    setClarification(null);
    history.replaceState(null, "", location.pathname);
    composer.current?.focus();
  };
  const currentRequest = turns.find((t) => t.id === latestRequest);
  const change = useMemo(
    () =>
      active?.result
        ? describeChange(contexts.current[active.id] || null, active.result)
        : active?.status || "",
    [active],
  );
  const undo = () => {
    if (busy.current || !Object.hasOwn(parents.current, selected)) return;
    setNavigationNote(`Undid: ${active?.question || "change"}.`);
    setRedo((stack) => [...stack, selected]);
    setSelected(parents.current[selected]);
    setLatestRequest("");
    setReceipt(false);
    setUseCurrent(true);
  };
  const redoChange = () => {
    if (busy.current || !redo.length) return;
    setNavigationNote("Change restored.");
    setSelected(redo[redo.length - 1]);
    setRedo((stack) => stack.slice(0, -1));
    setLatestRequest("");
    setReceipt(false);
    setUseCurrent(true);
  };
  const saveConfig = (value: Config, nextProfiles: ProviderProfiles) => {
    try {
      agent.configure(value);
      setConfig(value);
      setProfiles(nextProfiles);
      try {
        writePreferences(sessionStorage, value.provider, nextProfiles);
      } catch {
        setNotice(
          "Settings applied in memory. Browser storage could not be updated; saved-key changes may not survive a reload.",
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
  const explanation = explanations[selected];
  const inlineExplanation = explanation
    ? {
        ...explanation,
        onClose: () =>
          setExplanations((previous) => {
            const next = { ...previous };
            delete next[selected];
            return next;
          }),
        onRetry: () =>
          void submit(
            changeQuestion(explanation.change),
            true,
            active?.result || null,
            undefined,
            explanation.change,
          ),
        onConnect: () => setSettings(true),
        onStop: () => agent.stop(),
        clarification:
          clarification?.runId === explanation.analysis.id ? (
            <Surface operations={clarification.operations} onAction={respond} />
          ) : null,
      }
    : null;
  const composerView = (
    <>
      <form
        className="cw-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="cw-question">
          {useCurrent && active?.result
            ? "Ask or change this view"
            : "Ask a data question"}
        </label>
        {active?.result && (
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
          aria-label="Ask a data question"
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
            useCurrent && active?.result
              ? "Ask about the current view…"
              : "Compare life expectancy in Japan, Italy and Spain since 1960"
          }
        />
        <div>
          <span>
            {config.provider === "chatgpt" && config.chatgptAccount
              ? `ChatGPT plan · ${config.model}`
              : config.apiKey
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
              {useCurrent && active?.result ? "Update" : "Analyze"}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </form>
    </>
  );
  return (
    <div className="cw">
      <header className="cw-header">
        <div>
          <h1>Chitti</h1>
        </div>
        <div className="cw-actions">
          <button
            onClick={() => {
              setDashboards(!dashboards);
              setPin(null);
            }}
            aria-pressed={dashboards}
          >
            Saved
          </button>
          <button
            className="cw-model-control"
            aria-label="Model settings"
            onClick={() => setSettings(true)}
          >
            {config.provider === "chatgpt" && config.chatgptAccount
              ? "ChatGPT"
              : config.apiKey
                ? providerMeta(config.provider).label
                : "Connect model"}{" "}
            <span
              className="cw-connection"
              data-connected={
                config.provider === "chatgpt"
                  ? !!config.chatgptAccount
                  : !!config.apiKey
              }
            />
          </button>
        </div>
      </header>
      <div className="cw-workspace">
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
              <div
                className="cw-thread-tools"
                data-empty={!active || undefined}
              >
                <button disabled={running} onClick={newAnalysis}>
                  New analysis
                </button>
                <label>
                  Examples
                  <select
                    aria-label="Open result"
                    value={example ? selected : ""}
                    disabled={running}
                    onChange={(e) => {
                      setNavigationNote("");
                      setSelected(e.target.value);
                      setLatestRequest("");
                      setRedo([]);
                      setReceipt(false);
                      setUseCurrent(true);
                    }}
                  >
                    <option value="">Choose an example</option>
                    {DEMOS.map((d) => (
                      <option key={d.id} value={`example:${d.id}`}>
                        {d.question}
                      </option>
                    ))}
                  </select>
                </label>
                {turns.length > 0 && (
                  <details className="cw-history">
                    <summary>History ({turns.length})</summary>
                    <ol>
                      {turns.map((t) => (
                        <li
                          key={t.id}
                          aria-current={selected === t.id ? "step" : undefined}
                        >
                          <div>
                            <strong>{t.question}</strong>
                            <p>
                              {t.result
                                ? describeChange(
                                    contexts.current[t.id] || null,
                                    t.result,
                                  )
                                : t.status}
                            </p>
                          </div>
                          {t.result && (
                            <button
                              disabled={running || selected === t.id}
                              onClick={() => {
                                setNavigationNote("");
                                setSelected(t.id);
                                setLatestRequest("");
                                setRedo([]);
                                setReceipt(false);
                                setUseCurrent(true);
                              }}
                            >
                              Restore
                            </button>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </div>
              {currentRequest &&
                (running ||
                  (!currentRequest.result &&
                    ["needs-key", "error", "stopped"].includes(
                      currentRequest.phase,
                    ))) && (
                  <section className="cw-inflight" aria-label="Current request">
                    {selected !== currentRequest.id && (
                      <p className="cw-request-text">
                        {currentRequest.question}
                      </p>
                    )}
                    <p role="status">{currentRequest.status}</p>
                    <div className="cw-actions">
                      {running && (
                        <button
                          onClick={() => {
                            setUseCurrent(true);
                            agent.stop();
                            composer.current?.focus();
                          }}
                        >
                          Stop and steer
                        </button>
                      )}
                      {currentRequest.phase === "needs-key" && (
                        <button onClick={() => setSettings(true)}>
                          Connect model
                        </button>
                      )}
                      {["needs-key", "error"].includes(
                        currentRequest.phase,
                      ) && (
                        <button
                          onClick={() =>
                            void submit(
                              currentRequest.question,
                              false,
                              contexts.current[currentRequest.id] || null,
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                    </div>
                    {clarification?.runId === currentRequest.id && (
                      <Surface
                        operations={clarification.operations}
                        onAction={respond}
                      />
                    )}
                  </section>
                )}
              {notice && (
                <p className="cw-notice" role="status">
                  {notice}
                </p>
              )}
              {active ? (
                <article className="cw-analysis">
                  <header className="cw-turn-head">
                    <div className="cw-request">
                      <span>
                        {active.origin === "example"
                          ? "Example"
                          : active.origin === "shared"
                            ? "Shared"
                            : "You"}
                      </span>
                      <h2>{active.question}</h2>
                    </div>
                    <div className="cw-change" aria-label="Workspace change">
                      <span className="cw-change-author">Chitti</span>
                      <div>
                        <p role="status">
                          {navigationNote && <span>{navigationNote} </span>}
                          {active.origin === "example" ||
                          active.origin === "shared"
                            ? "Opened recorded chart and sources."
                            : change}
                        </p>
                        {active.origin === "view" && (
                          <small>View only. Source data unchanged.</small>
                        )}
                        {(active.phase === "running" ||
                          active.phase === "waiting") && (
                          <small>Draft; not yet verified.</small>
                        )}
                      </div>
                      <div className="cw-change-actions">
                        {Object.hasOwn(parents.current, selected) && (
                          <button disabled={running} onClick={undo}>
                            Undo
                          </button>
                        )}
                        {!!redo.length && (
                          <button disabled={running} onClick={redoChange}>
                            Redo
                          </button>
                        )}
                        <button
                          disabled={running}
                          onClick={() => {
                            setUseCurrent(true);
                            composer.current?.focus();
                          }}
                        >
                          Steer
                        </button>
                        <button
                          onClick={() => setReceipt(!receipt)}
                          aria-expanded={receipt}
                        >
                          Steps
                          {active.trace.length ? ` ${active.trace.length}` : ""}
                        </button>
                      </div>
                    </div>
                  </header>
                  {receipt && (
                    <section
                      className="cw-receipts"
                      aria-label="Execution steps"
                    >
                      {active.cost !== undefined && (
                        <p>Model cost: ${active.cost.toFixed(4)}</p>
                      )}
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
                    <ExplanationContext.Provider value={inlineExplanation}>
                      <Surface
                        key={selected}
                        operations={operations}
                        onAction={steerResult}
                        disabled={running}
                        inlineComposer
                      />
                    </ExplanationContext.Provider>
                  ) : active.phase === "running" ? (
                    <div className="cw-pending">
                      <span className="cw-pulse" />
                      Reading sources and preparing the result…
                    </div>
                  ) : null}
                  {composerView}
                  {active.result && (
                    <details className="cw-export">
                      <summary>Save or export</summary>
                      <footer className="cw-actions cw-result-actions">
                        <button onClick={() => void share()}>
                          Share result
                        </button>
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
                    </details>
                  )}
                </article>
              ) : (
                <div className="cw-start">
                  <h2>What do you want to find out?</h2>
                  <p>
                    Compare countries, follow a trend, or check a claim against
                    public data.
                  </p>
                  {!!redo.length && (
                    <button disabled={running} onClick={redoChange}>
                      Redo
                    </button>
                  )}
                  {composerView}
                  <section
                    className="cw-examples"
                    aria-label="Recorded analyses"
                  >
                    <h3>Explore a recorded analysis</h3>
                    <div>
                      {DEMOS.map((d) => (
                        <button
                          key={d.id}
                          onClick={() => {
                            setSelected(`example:${d.id}`);
                            setUseCurrent(true);
                          }}
                        >
                          <ExamplePlot spec={d.state.spec} />
                          <strong>{d.question}</strong>
                          <span>{d.sources.join(" / ")}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                  <p className="cw-source-line">
                    World Bank, Our World in Data, IMF and WHO. Every result
                    keeps its sources.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {settings && (
        <Settings
          value={config}
          profiles={profiles}
          locked={running || agent.sessionLocked}
          onSave={saveConfig}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
}
