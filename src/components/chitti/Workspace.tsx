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
import {
  PROVIDERS,
  providerMeta,
  type ProviderId,
} from "../../lib/chitti/providers";
import { SOURCES, rowsToCSV } from "../../lib/chitti/tools";
import { buildFindingOkf } from "../../lib/chitti/okf";
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import Settings from "./Settings";
import ModelPicker from "./ModelPicker";
import { Result, CollapseChart } from "./Result";
import { conversationPath, conversationHeads } from "../../lib/chitti/workspace/conversation";
import ExamplePlot from "./ExamplePlot";
import Surface from "./Surface";
import Dashboards, { download } from "./Dashboards";
import "./workspace.css";
function initialConfig(): Config {
  let provider: ProviderId = "chatgpt",
    apiKey = "",
    model = "",
    chatgptAccount: string | undefined;
  try {
    const saved = sessionStorage.getItem("chitti:provider");
    if (PROVIDERS.some((p) => p.id === saved)) {
      provider = saved as ProviderId;
      apiKey = sessionStorage.getItem("chitti:key") || "";
      model = sessionStorage.getItem("chitti:model") || "";
      chatgptAccount = sessionStorage.getItem("chitti:account") || undefined;
    }
  } catch {}
  return {
    provider,
    model:
      provider === "chatgpt"
        ? model
        : model || providerMeta(provider).models[0]?.id || "",
    chatgptAccount: provider === "chatgpt" ? chatgptAccount : undefined,
    apiKey: provider === "chatgpt" ? "" : apiKey,
    sources: SOURCES.map((s) => s.id),
    rlm: false,
  };
}
export default function Workspace() {
  const [config, setConfig] = useState(initialConfig);
  const configRef = useRef(config);
  configRef.current = config;
  const chatConfigs = useRef<Record<string, Config>>({});
  const [settingsDraft, setSettingsDraft] = useState<Config | null>(null);
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
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const activeArticle = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && parents.current[selected])
      activeArticle.current?.scrollIntoView?.({ block: "start" });
  }, [selected]);
  useEffect(() => {
    const sub = agent.subscribe({
      onStateChanged: ({ state }) => {
        const snapshot = state as WorkspaceState;
        if (snapshot.analysis) {
          const next = snapshot.analysis;
          if (next.origin === "agent" && !explanationRuns.current[next.id]) {
            const root = conversationPath(next.id, parents.current)[0];
            chatConfigs.current[root] ||= { ...configRef.current, sources: [...configRef.current.sources] };
          }
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
  const resolveTurn = (id: string) => {
    const demo = DEMOS.find(d => id === `example:${d.id}`);
    return demo ? fromShared(demo.state, "example", id) : turns.find(t => t.id === id);
  };
  const previousTurns = conversationPath(selected, parents.current).slice(0, -1)
    .map(resolveTurn).filter((t): t is Analysis => !!t);
  const recentChats = conversationHeads(turns.map(t => t.id), parents.current).map(resolveTurn).filter((t): t is Analysis => !!t);
  const modelLocked = agent.sessionLocked || !!chatConfigs.current[conversationPath(selected, parents.current)[0]];
  const openChat = (id: string) => {
    if (busy.current) return;
    const savedConfig = chatConfigs.current[conversationPath(id, parents.current)[0]];
    agent.reset();
    if (savedConfig) { agent.configure(savedConfig); setConfig(savedConfig); }
    setSelected(id); setLatestRequest(""); setRedo([]); setReceipt(false);
    setUseCurrent(true); setNavigationNote(""); setDashboards(false);
  };
  const connect = (provider?: ProviderId) => {
    setSettingsDraft(provider && provider !== config.provider ? {
      ...config, provider, model: providerMeta(provider).models[0]?.id || "",
      apiKey: "", chatgptAccount: undefined, directOnly: false,
    } : { ...config, directOnly: false });
    setSettings(true);
  };
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
    agent.useConversation(context ? conversationPath(selected, parents.current).flatMap(id => {
      const turn = resolveTurn(id);
      return turn ? [{ role: "user" as const, content: turn.question }, ...(turn.result?.answer ? [{ role: "assistant" as const, content: turn.result.answer }] : [])] : [];
    }) : []);
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
    if (action.name === "years" && typeof value === "string") {
      try {
        const range = JSON.parse(value);
        if (range && Number.isInteger(range.start) && Number.isInteger(range.end))
          void submit(`Show ${range.start}–${range.end}`, false, active.result, { kind: "years", start: range.start, end: range.end });
      } catch {}
    }
    if (action.name === "chart-type" && typeof value === "string" && ["line", "bar", "grouped-bar"].includes(value))
      void submit(`Show a ${value.replace('-', ' ')} chart`, false, active.result, { kind: "type", type: value as "line" | "bar" | "grouped-bar" });
    if (action.name === "highlight" && typeof value === "string")
      void submit(value ? `Highlight ${active.result.spec?.series.find(s => (s.id || s.name) === value)?.name || value}` : "Clear highlighting", false, active.result, { kind: "highlight", id: value });
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
  const saveConfig = (value: Config, remember: boolean) => {
    try {
      agent.configure(value);
      setConfig(value);
      try {
        if (value.provider === "chatgpt") {
          sessionStorage.setItem("chitti:provider", value.provider);
          sessionStorage.setItem("chitti:account", value.chatgptAccount || "");
          sessionStorage.setItem("chitti:model", value.model);
          sessionStorage.removeItem("chitti:key");
        } else if (remember) {
          sessionStorage.setItem("chitti:key", value.apiKey);
          sessionStorage.setItem("chitti:provider", value.provider);
          sessionStorage.setItem("chitti:model", value.model);
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
      setSettingsDraft(null);
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
        onConnect: () => connect(),
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
            ? "Ask a follow-up"
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
              ? "Ask a follow-up or change the chart…"
              : "Compare life expectancy in Japan, Italy and Spain since 1960"
          }
        />
        <div>
          <ModelPicker value={config} locked={modelLocked} running={running}
            onChoose={value => { let remember = false; try { remember = !!sessionStorage.getItem("chitti:key"); } catch {} saveConfig(value, remember); }}
            onConnect={connect} onNewChat={newAnalysis} />
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
              Send{" "}
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
        <h1>Chitti</h1><span className="cw-subtitle">Data, in conversation</span>
      </header>
      <div className="cw-workspace">
        <aside className="cw-sidebar" aria-label="Chat navigation" data-history-open={historyOpen}>
          <button className="cw-new-chat" disabled={running} onClick={newAnalysis}>+ New chat</button>
          <button className="cw-mobile-history-toggle" aria-expanded={historyOpen} aria-controls="cw-recent-chats" onClick={() => setHistoryOpen(!historyOpen)}>Recent chats ({recentChats.length})</button>
          <section id="cw-recent-chats" aria-label="Recent chats">
            <h2>Recent chats</h2>
            {!recentChats.length && <p>Your chats appear here.</p>}
            {recentChats.map(t => <button key={t.id} disabled={running} aria-current={selected === t.id ? "page" : undefined} onClick={() => openChat(t.id)}>{resolveTurn(conversationPath(t.id, parents.current)[0])?.question || t.question}{parents.current[t.id] && <small>{t.question}</small>}</button>)}
          </section>
          <label className="cw-example-select">Recorded examples
            <select aria-label="Open result" value={example ? selected : ""} disabled={running} onChange={e => { if (e.target.value) openChat(e.target.value); }}>
              <option value="">Choose an example</option>
              {DEMOS.map(d => <option value={`example:${d.id}`} key={d.id}>{d.question}</option>)}
            </select>
          </label>
          <div className="cw-sidebar-bottom">
            <button onClick={() => { setDashboards(!dashboards); setPin(null); }} aria-pressed={dashboards}>Saved charts</button>
            <button aria-label="Model settings" onClick={() => connect()}>Settings</button>
            <small>Chats stay in this session. Save a chart or export a result to keep it.</small>
          </div>
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
              <div className="cw-transcript" aria-label="Conversation">
              {previousTurns.map((turn, index) => <article className="cw-analysis cw-previous-turn" key={turn.id}>
                <div className="cw-request"><span>You{turn.origin === "example" ? " · recorded example" : ""}</span><h2>{turn.question}</h2></div>
                <div className="cw-assistant-label">Chitti</div>
                {turn.result && <CollapseChart.Provider value={JSON.stringify(turn.result.spec) === JSON.stringify(previousTurns[index - 1]?.result?.spec)}><Result result={turn.result} /></CollapseChart.Provider>}
                {!turn.result && <p>{turn.status}</p>}
                <button className="cw-continue" disabled={running} onClick={() => openChat(turn.id)}>Continue from here</button>
              </article>)}
              {notice && (
                <p className="cw-notice" role="status">
                  {notice}
                </p>
              )}
              {active ? (
                <article className="cw-analysis" ref={activeArticle}>
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
                        collapseChart={!!contexts.current[active.id]?.spec && JSON.stringify(active.result?.spec) === JSON.stringify(contexts.current[active.id]?.spec)}
                      />
                    </ExplanationContext.Provider>
                  ) : active.phase === "running" ? (
                    <div className="cw-pending">
                      <span className="cw-pulse" />
                      Reading sources and preparing the result…
                    </div>
                  ) : null}
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
                            openChat(`example:${d.id}`);
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
                        <button onClick={() => connect()}>
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
              </div>
              <div className="cw-composer-dock">{composerView}<p className="cw-composer-help">Enter a question · Ctrl/⌘ + Enter to send · Answers keep their sources</p></div>
            </>
          )}
        </section>
      </div>
      {settings && (
        <Settings
          value={settingsDraft || config}
          locked={running || modelLocked}
          onSave={saveConfig}
          onClose={() => { setSettings(false); setSettingsDraft(null); }}
        />
      )}
    </div>
  );
}
