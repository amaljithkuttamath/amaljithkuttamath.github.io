import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExplanationContext } from "./ChangeExplanation";
import { chartChanges, changeKey, changeQuestion, type ChartChange } from "../../lib/chitti/chart-insights";
import { describeChange } from "../../lib/chitti/workspace/changes";
import type { ViewEdit } from "../../lib/chitti/workspace/steering";
import { ChittiAgent } from "../../lib/chitti/workspace/agent";
import { DEMOS } from "../../lib/chitti/demos";
import { fromShared, resultSurface, type Analysis, type Settings as Config, type WorkspaceState } from "../../lib/chitti/workspace/model";
import { decodeShareState, encodeShareState, type ShareStateV1 } from "../../lib/chitti/share";
import { PROVIDERS, providerMeta, type ProviderId } from "../../lib/chitti/providers";
import { SOURCES, rowsToCSV } from "../../lib/chitti/tools";
import { buildFindingOkf } from "../../lib/chitti/okf";
import type { FastPathPlan, SeriesCandidate } from "../../lib/chitti/fastpath";
import type { ActionPayload } from "@a2ui/web_core/v0_9";
import Settings from "./Settings";
import ModelPicker, { modelConnected } from "./ModelPicker";
import { Result, CollapseChart } from "./Result";
import { conversationPath, conversationHeads } from "../../lib/chitti/workspace/conversation";
import ExamplePlot from "./ExamplePlot";
import Surface from "./Surface";
import Dashboards, { download } from "./Dashboards";
import "./ui/chitti.css";
import { Button, Chip, Dialog, IconButton, Menu, Notice, Token, type MenuItem } from "./ui/controls";
import { CardContext, type CardContextValue } from "./ui/ChartCard";
import { ChartPanel } from "./ui/ChartPanel";
import { Composer } from "./ui/Composer";
import { CheckBadge, SourceLines } from "./ui/Evidence";
import { followUps } from "./ui/interpretation";
import { MessageTurn } from "./ui/MessageTurn";
import { RunStatus } from "./ui/RunStatus";
import { pinnedPlan, sourceLabel } from "./ui/suggest";
import { ThinkingBlock } from "./ui/ThinkingBlock";
import {
  ContextIcon,
  DashboardIcon,
  DownloadIcon,
  MenuIcon,
  PinIcon,
  PlusIcon,
  RedoIcon,
  SettingsIcon,
  ShareIcon,
  SparkIcon,
  SteerIcon,
  UndoIcon,
} from "./ui/icons";

function initialConfig(): Config {
  let provider: ProviderId = "openrouter",
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
    model: provider === "chatgpt" ? model : model || providerMeta(provider).models[0]?.id || "",
    chatgptAccount: provider === "chatgpt" ? chatgptAccount : undefined,
    apiKey: provider === "chatgpt" ? "" : apiKey,
    sources: SOURCES.map((s) => s.id),
    rlm: false,
  };
}

type Direct = { plan: FastPathPlan; series: SeriesCandidate };

export default function Workspace() {
  const [config, setConfig] = useState(initialConfig);
  const configRef = useRef(config);
  configRef.current = config;
  const chatConfigs = useRef<Record<string, Config>>({});
  const [settingsDraft, setSettingsDraft] = useState<Config | null>(null);
  const [agent] = useState(() => new ChittiAgent(config));
  const explanationRuns = useRef<Record<string, { view: string; change: ChartChange }>>({});
  const [explanations, setExplanations] = useState<Record<string, { change: ChartChange; analysis: Analysis }>>({});
  const [turns, setTurns] = useState<Analysis[]>([]);
  const [selected, setSelected] = useState("");
  const [question, setQuestion] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [useCurrent, setUseCurrent] = useState(false);
  const [redo, setRedo] = useState<string[]>([]);
  const [latestRequest, setLatestRequest] = useState("");
  const [navigationNote, setNavigationNote] = useState("");
  const [panelFor, setPanelFor] = useState("");
  const panelOpener = useRef<HTMLElement | null>(null);
  const panelOpenerTurn = useRef("");
  const parents = useRef<Record<string, string>>({});
  const contexts = useRef<Record<string, ShareStateV1 | null>>({});
  const directs = useRef<Record<string, Direct>>({});
  const [running, setRunning] = useState(false),
    [settings, setSettings] = useState(false),
    [dashboards, setDashboards] = useState(false);
  const [pin, setPin] = useState<ShareStateV1 | null>(null),
    [notice, setNotice] = useState("");
  const [surfaces, setSurfaces] = useState<Record<string, unknown[]>>({});
  const [clarification, setClarification] = useState<{ runId: string; operations: unknown[] } | null>(null);
  const busy = useRef(false),
    composer = useRef<HTMLTextAreaElement>(null);
  const activeArticle = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && parents.current[selected]) activeArticle.current?.scrollIntoView?.({ block: "start" });
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
            setExplanations((previous) => ({ ...previous, [target.view]: { change: target.change, analysis: next } }));
            if (!snapshot.question) setClarification(null);
            return;
          }
          setTurns((previous) =>
            previous.some((t) => t.id === next.id) ? previous.map((t) => (t.id === next.id ? next : t)) : [...previous, next],
          );
        }
        if (!snapshot.question) setClarification(null);
      },
      onCustomEvent: ({ event, input }) => {
        if (event.name !== "a2ui" || !Array.isArray(event.value?.operations)) return;
        const operations = event.value.operations;
        if (operations[0]?.createSurface?.surfaceId === "question") setClarification({ runId: input.runId, operations });
        else if (!explanationRuns.current[input.runId]) {
          setSurfaces((previous) => ({ ...previous, [input.runId]: operations }));
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
    () => (example ? fromShared(example.state, "example", selected) : turns.find((t) => t.id === selected)),
    [example, selected, turns],
  );
  const resolveTurn = (id: string) => {
    const demo = DEMOS.find((d) => id === `example:${d.id}`);
    return demo ? fromShared(demo.state, "example", id) : turns.find((t) => t.id === id);
  };
  const path = conversationPath(selected, parents.current);
  const previousTurns = path.slice(0, -1).map(resolveTurn).filter((t): t is Analysis => !!t);
  // An ambiguous lookup the user has not resolved yet is not a chat of its own.
  const recentChats = conversationHeads(turns.filter((t) => !(t.choice && !t.result) || t.id === latestRequest).map((t) => t.id), parents.current)
    .map(resolveTurn)
    .filter((t): t is Analysis => !!t);
  const modelLocked = agent.sessionLocked || !!chatConfigs.current[conversationPath(selected, parents.current)[0]];
  const connectedModel = modelConnected(config);
  const panelTurn = panelFor && path.includes(panelFor) ? resolveTurn(panelFor) : undefined;
  const panelOpen = !!panelTurn?.result?.spec && !dashboards;
  // The panel follows a view edit made from it, and closes when its turn
  // leaves the conversation on screen (new chat, another chat).
  useEffect(() => {
    if (!panelFor) return;
    if (parents.current[selected] === panelFor && active?.result?.spec && active.id !== panelFor) setPanelFor(selected);
    else if (!conversationPath(selected, parents.current).includes(panelFor)) setPanelFor("");
  }, [selected, active?.result?.spec]);
  const closePanel = useCallback(() => {
    setPanelFor("");
    const opener = panelOpener.current;
    const id = panelOpenerTurn.current;
    panelOpener.current = null;
    // Focus returns to the control that opened the panel; when that control
    // was replaced while the panel was open (the card became a reference),
    // to the same turn's expand control.
    requestAnimationFrame(() => {
      const target = opener?.isConnected
        ? opener
        : document.querySelector<HTMLElement>(`[data-expand-turn="${id.replace(/["\\]/g, "\\$&")}"]`);
      (target || composer.current)?.focus();
    });
  }, []);
  const openPanel = (id: string, opener: HTMLElement) => {
    panelOpener.current = opener;
    panelOpenerTurn.current = id;
    setPanelFor(id);
  };
  const openChat = (id: string) => {
    if (busy.current) return;
    const savedConfig = chatConfigs.current[conversationPath(id, parents.current)[0]];
    agent.reset();
    if (savedConfig) {
      agent.configure(savedConfig);
      setConfig(savedConfig);
    }
    setSelected(id);
    setLatestRequest("");
    setRedo([]);
    setUseCurrent(true);
    setNavigationNote("");
    setDashboards(false);
  };
  const connect = (provider?: ProviderId) => {
    setSettingsDraft(
      provider && provider !== config.provider
        ? { ...config, provider, model: providerMeta(provider).models[0]?.id || "", apiKey: "", chatgptAccount: undefined, directOnly: false }
        : { ...config, directOnly: false },
    );
    setSettings(true);
  };
  const operations = useMemo(
    () =>
      active?.origin === "view" && active.result
        ? resultSurface({ ...active.result, answer: "" })
        : surfaces[selected] || (active?.result ? resultSurface(active.result) : null),
    [surfaces, selected, active?.result, active?.origin],
  );
  const respond = useCallback(
    (action: ActionPayload) => {
      if (action.name === "answer" && typeof action.context.requestId === "string" && typeof action.context.value === "string")
        agent.respond(action.context.requestId, action.context.value);
    },
    [agent],
  );
  const followUpContext = () => (panelOpen ? panelTurn!.result : useCurrent ? active?.result || null : null);
  const submit = async (
    text = question,
    force = false,
    context: ShareStateV1 | null = followUpContext(),
    edit?: ViewEdit,
    detail?: ChartChange,
    direct?: Direct,
  ) => {
    if (busy.current || !text.trim()) return;
    busy.current = true;
    setRunning(true);
    setDashboards(false);
    setNotice("");
    const id = crypto.randomUUID();
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
    contexts.current[id] = direct ? null : context;
    if (direct) directs.current[id] = direct;
    agent.useWorkspace(direct ? null : context, edit);
    if (direct) agent.useDirect(direct.plan, direct.series);
    agent.useConversation(
      context && !direct
        ? conversationPath(selected, parents.current).flatMap((id) => {
            const turn = resolveTurn(id);
            return turn
              ? [{ role: "user" as const, content: turn.question }, ...(turn.result?.answer ? [{ role: "assistant" as const, content: turn.result.answer }] : [])]
              : [];
          })
        : [],
    );
    if (force) agent.escalate();
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text.trim() });
    try {
      await agent.runAgent({ runId: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed.";
      if (detail)
        setExplanations((previous) => {
          const current = previous[selected];
          return current ? { ...previous, [selected]: { ...current, analysis: { ...current.analysis, phase: "error", status: message } } } : previous;
        });
      else if (!direct) setNotice(message);
    } finally {
      busy.current = false;
      setRunning(false);
    }
  };
  const steer = (name: string, value: string) => {
    if (busy.current || !active?.result) return;
    if (name === "years") {
      try {
        const range = JSON.parse(value);
        if (range && Number.isInteger(range.start) && Number.isInteger(range.end))
          void submit(`Show ${range.start}–${range.end}`, false, active.result, { kind: "years", start: range.start, end: range.end });
      } catch {}
    }
    if (name === "chart-type" && ["line", "bar", "grouped-bar"].includes(value))
      void submit(`Show a ${value.replace("-", " ")} chart`, false, active.result, { kind: "type", type: value as "line" | "bar" | "grouped-bar" });
    if (name === "highlight")
      void submit(
        value ? `Highlight ${active.result.spec?.series.find((s) => (s.id || s.name) === value)?.name || value}` : "Clear highlighting",
        false,
        active.result,
        { kind: "highlight", id: value },
      );
    if (name === "explain-change" && active.result.spec) {
      const detail = chartChanges(active.result.spec).find((c) => changeKey(c) === value);
      if (detail && explanations[selected] && changeKey(explanations[selected].change) === value) {
        setExplanations((previous) => {
          const next = { ...previous };
          delete next[selected];
          return next;
        });
        return;
      }
      if (detail) void submit(changeQuestion(detail), true, active.result, undefined, detail);
      return;
    }
    if (name === "focus") void submit(`Focus on ${value}`, false, active.result, { kind: "series", name: value });
    if (name === "recent") void submit("Show the last 10 years", false, active.result, { kind: "recent" });
    if (name === "ask-view" && value.trim()) void submit(value.slice(0, 2000), true, active.result);
  };
  const steerResult = (action: ActionPayload) => {
    const value = action.context.value;
    steer(action.name, typeof value === "string" ? value : "");
  };
  const runDirect = (plan: FastPathPlan, series: SeriesCandidate, text: string) =>
    void submit(text, false, null, undefined, undefined, { plan, series });
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
    setPanelFor("");
    history.replaceState(null, "", location.pathname);
    composer.current?.focus();
  };
  const currentRequest = turns.find((t) => t.id === latestRequest);
  // A request that is running, ended without a result, or is waiting for the
  // user to pick a series, stays visible after the conversation.
  const inflight =
    !!currentRequest &&
    (running || (!currentRequest.result && (["needs-key", "error", "stopped"].includes(currentRequest.phase) || !!currentRequest.choice)));
  const change = useMemo(
    () => (active?.result ? describeChange(contexts.current[active.id] || null, active.result) : active?.status || ""),
    [active],
  );
  const undo = () => {
    if (busy.current || !Object.hasOwn(parents.current, selected)) return;
    setNavigationNote(`Undid: ${active?.question || "change"}.`);
    setRedo((stack) => [...stack, selected]);
    setSelected(parents.current[selected]);
    setLatestRequest("");
    setUseCurrent(true);
  };
  const redoChange = () => {
    if (busy.current || !redo.length) return;
    setNavigationNote("Change restored.");
    setSelected(redo[redo.length - 1]);
    setRedo((stack) => stack.slice(0, -1));
    setLatestRequest("");
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
        setNotice("Settings applied. Browser storage is unavailable, so the key is kept only in memory.");
      }
      setSettings(false);
      setSettingsDraft(null);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const share = async (turn: Analysis) => {
    if (!turn.result) return;
    try {
      const r = await encodeShareState({
        question: turn.question,
        answer: turn.result.answer,
        spec: turn.result.spec,
        rows: turn.result.rows,
        citations: turn.result.citations,
        verification: turn.result.verification,
        ts: turn.result.ts,
      });
      if (!r.ok) {
        setNotice("Too large for a link. Download the data instead.");
        return;
      }
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#share=${r.payload}`);
      setNotice(r.lossy ? "Link copied. Full evidence rows are omitted from this link." : "Result link copied.");
    } catch {
      setNotice("Clipboard unavailable. Use the CSV or Markdown download.");
    }
  };
  const pinResult = (result: ShareStateV1) => {
    setPin(result);
    setDashboards(true);
  };
  const exportItems = (result: NonNullable<Analysis["result"]>, turn: Analysis, withPin = true): MenuItem[] => [
    { label: "Copy share link", icon: <ShareIcon />, onSelect: () => void share(turn) },
    { label: "Download CSV", icon: <DownloadIcon />, disabled: !result.rows.length, onSelect: () => download("chitti-data.csv", rowsToCSV(result.rows), "text/csv") },
    {
      label: "Download Markdown",
      icon: <DownloadIcon />,
      onSelect: () =>
        download(
          "chitti-analysis.md",
          buildFindingOkf({ question: turn.question, finding: result.answer, spec: result.spec, citations: result.citations, verification: result.verification, createdAt: result.ts }),
          "text/markdown",
        ),
    },
    ...(withPin && result.spec ? [{ type: "divider" as const }, { label: "Pin to dashboard", icon: <PinIcon />, onSelect: () => pinResult(result) }] : []),
  ];
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
        onRetry: () => void submit(changeQuestion(explanation.change), true, active?.result || null, undefined, explanation.change),
        onConnect: () => connect(),
        onStop: () => agent.stop(),
        clarification: clarification?.runId === explanation.analysis.id ? <Surface operations={clarification.operations} onAction={respond} /> : null,
      }
    : null;
  const attachable = !!active?.result;
  const attached = useCurrent && attachable;
  const cardFor = (turn: Analysis, live: boolean): CardContextValue => ({
    turnId: turn.id,
    direct: turn.direct,
    onDirect: live && turn.direct ? runDirect : undefined,
    onExpand: turn.result?.spec ? (opener) => openPanel(turn.id, opener) : undefined,
    openInPanel: panelOpen && panelFor === turn.id,
  });
  const turnNumber = (id: string) => Math.max(1, path.indexOf(id) + 1);

  const contextRow = panelOpen ? (
    <div className="cx-context" role="group" aria-label="Follow-up context">
      <span className="cx-micro">About the open chart</span>
      <Token removeLabel="Close the chart panel" onRemove={closePanel} disabled={running}>
        {panelTurn!.result!.spec!.title}
      </Token>
    </div>
  ) : attachable ? (
    <div className="cx-context" role="group" aria-label="Follow-up context">
      {attached ? (
        <>
          <span className="cx-micro">Follow-up uses</span>
          <Token removeLabel={`Remove ${active!.result!.spec?.title || active!.question}`} onRemove={() => setUseCurrent(false)} disabled={running}>
            {active!.result!.spec?.title || active!.question}
          </Token>
        </>
      ) : (
        <>
          <span className="cx-micro">New question, no context</span>
          <Button size="sm" variant="ghost" icon={<ContextIcon />} label="Use current view" disabled={running} onClick={() => setUseCurrent(true)} />
        </>
      )}
    </div>
  ) : undefined;

  const navigation = (
    <nav className="cx-side" aria-label="Chat navigation">
      <div className="cx-brand">
        <span className="cx-glyph" aria-hidden="true" />
        <span className="cx-brand-text">Chitti</span>
      </div>
      <Button
        className="cx-new"
        label="New chat"
        aria-label="New chat"
        icon={<PlusIcon />}
        disabled={running}
        onClick={() => {
          setMobileNav(false);
          newAnalysis();
        }}
      />
      <section aria-label="Recent chats">
        <h2 className="cx-micro">Recent chats</h2>
        <ul className="cx-side-list">
          {recentChats.map((t) => {
            const chain = conversationPath(t.id, parents.current);
            const root = resolveTurn(chain[0]);
            const depth = chain.length - 1;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="cx-side-item"
                  aria-current={selected === t.id ? "page" : undefined}
                  aria-disabled={running || undefined}
                  title={root?.question || t.question}
                  onClick={() => {
                    if (running) return;
                    setMobileNav(false);
                    openChat(t.id);
                  }}
                >
                  <span>{root?.question || t.question}</span>
                  {depth > 0 && <span className="cx-side-depth" aria-label={`${depth} more turns`}>+{depth}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {!recentChats.length && <p className="cx-side-empty">Your chats appear here.</p>}
      </section>
      <span className="cx-side-spacer" />
      <button
        type="button"
        className="cx-side-item"
        aria-pressed={dashboards}
        aria-label="Dashboards"
        title="Dashboards"
        onClick={() => {
          setMobileNav(false);
          setDashboards(!dashboards);
          setPin(null);
        }}
      >
        <span className="cx-btn-icon" aria-hidden="true">
          <DashboardIcon />
        </span>
        <span>Dashboards</span>
      </button>
      <button
        type="button"
        className="cx-side-item"
        aria-label="Settings"
        title="Settings"
        onClick={() => {
          setMobileNav(false);
          connect();
        }}
      >
        <span className="cx-btn-icon" aria-hidden="true">
          <SettingsIcon />
        </span>
        <span>Settings</span>
      </button>
      <p className="cx-side-note">Chats stay in this tab. Pin a chart or export a result to keep it.</p>
    </nav>
  );

  const chips = (turn: Analysis) =>
    turn.phase === "done" && turn.result ? (
      <div className="cx-next" role="group" aria-label="Follow-ups">
        {followUps(turn.result).map((f) => (
          <Chip
            key={f.label}
            label={f.label}
            note={f.needsModel && !connectedModel ? "needs a model" : undefined}
            disabled={running}
            onClick={() => steer(f.action.name, f.action.value)}
          />
        ))}
      </div>
    ) : null;

  const choiceBlock = (request: Analysis) =>
    request.choice ? (
      <div className="cx-choice" role="group" aria-label="Choose a series">
        <p className="cx-choice-q" role="status">
          {request.status}
        </p>
        <div className="cx-choice-list">
          {request.choice.candidates.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              note={`${c.id} · ${sourceLabel(c.source)}`}
              disabled={running}
              onClick={() => runDirect(request.choice!.plan, c, request.question)}
            />
          ))}
        </div>
        {connectedModel ? (
          <div>
            <Button size="sm" variant="ghost" icon={<SparkIcon />} label="Let the model decide" disabled={running} onClick={() => void submit(request.question, true, null)} />
          </div>
        ) : (
          <p className="cx-choice-note">Or connect a model to let it choose and explain.</p>
        )}
      </div>
    ) : null;

  const activeTools = active && (
    <div className="cx-tools" role="toolbar" aria-label="Result actions">
      {Object.hasOwn(parents.current, selected) && (
        <IconButton variant="ghost" size="sm" label="Undo" icon={<UndoIcon />} disabled={running} onClick={undo} />
      )}
      {!!redo.length && <IconButton variant="ghost" size="sm" label="Redo" icon={<RedoIcon />} disabled={running} onClick={redoChange} />}
      <Button
        variant="ghost"
        size="sm"
        label="Steer"
        title="Steer"
        icon={<SteerIcon />}
        disabled={running}
        onClick={() => {
          setUseCurrent(true);
          composer.current?.focus();
        }}
      />
      <span className="cx-tools-end">
        {active.origin === "direct" && active.phase === "done" && (
          <Button size="sm" variant="ghost" label="Analyze with model" title="Analyze with model" icon={<SparkIcon />} disabled={running} onClick={() => void submit(active.question, true)} />
        )}
        {active.result && <Menu label="Share & export" icon={<ShareIcon />} items={exportItems(active.result, active)} align="end" placement="above" variant="ghost" />}
      </span>
    </div>
  );

  const thread = (
    <div className="cx-thread" aria-label="Conversation">
      {previousTurns.map((turn, index) => (
        <MessageTurn key={turn.id} who={turn.origin === "example" ? "Recorded example" : undefined} question={turn.question}>
          <ThinkingBlock analysis={turn} />
          {turn.result && (
            <CardContext.Provider value={cardFor(turn, false)}>
              <CollapseChart.Provider value={JSON.stringify(turn.result.spec) === JSON.stringify(previousTurns[index - 1]?.result?.spec)}>
                <Result result={turn.result} />
              </CollapseChart.Provider>
            </CardContext.Provider>
          )}
          {turn.result && <CheckBadge verification={turn.result.verification} origin={turn.origin} />}
          {!turn.result && <p className="cx-change">{turn.status}</p>}
          <div>
            <Button size="sm" variant="ghost" label="Continue from here" disabled={running} onClick={() => openChat(turn.id)} />
          </div>
        </MessageTurn>
      ))}
      {notice && <Notice title={notice} onDismiss={() => setNotice("")} />}
      {active ? (
        <MessageTurn
          isCurrent
          turnRef={activeArticle}
          who={active.origin === "example" ? "Recorded example" : active.origin === "shared" ? "Shared result" : undefined}
          question={active.question}
          meta={
            <>
              {active.origin === "view" && <span className="cx-badge">View only · source data unchanged</span>}
              {(active.phase === "running" || active.phase === "waiting") && (
                <span className="cx-badge" data-tone="warn">
                  Draft · not yet verified
                </span>
              )}
            </>
          }
        >
          <ThinkingBlock analysis={active} onDownload={(name, body) => download(name, body)} />
          {(navigationNote || contexts.current[active.id]) && (
            <p role="status" className="cx-change" aria-label="Workspace change">
              {navigationNote && <span>{navigationNote} </span>}
              {contexts.current[active.id] ? change : ""}
            </p>
          )}
          {operations ? (
            <CardContext.Provider value={cardFor(active, true)}>
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
            </CardContext.Provider>
          ) : active.phase === "running" ? (
            <div className="cx-pending" aria-hidden="true">
              <span className="cx-skel" style={{ width: "72%" }} />
              <span className="cx-skel" style={{ width: "54%" }} />
            </div>
          ) : null}
          {active.result && active.phase !== "running" && active.phase !== "waiting" && (
            <CheckBadge verification={active.result.verification} origin={active.origin} />
          )}
          {currentRequest && currentRequest.id === selected && inflight && (
            <RunStatus
              phase={currentRequest.phase === "done" || currentRequest.phase === "idle" ? "running" : currentRequest.phase}
              status={currentRequest.status}
              actions={
                running ? (
                  <Button
                    size="sm"
                    label="Stop and steer"
                    onClick={() => {
                      setUseCurrent(true);
                      agent.stop();
                      composer.current?.focus();
                    }}
                  />
                ) : undefined
              }
            >
              {clarification?.runId === currentRequest.id && <Surface operations={clarification.operations} onAction={respond} />}
            </RunStatus>
          )}
          {!running && chips(active)}
          {activeTools}
        </MessageTurn>
      ) : inflight ? null : (
        <div className="cx-start">
          <span className="cx-micro">Live public data · every number cited</span>
          <h2 className="cx-start-title">What do you want to find out?</h2>
          <p className="cx-start-lede">Compare countries, follow a trend, or check a claim against public data.</p>
          {!!redo.length && (
            <div>
              <Button size="sm" variant="ghost" icon={<RedoIcon />} label="Redo" disabled={running} onClick={redoChange} />
            </div>
          )}
          <section className="cx-examples" aria-label="Recorded analyses">
            <p className="cx-micro">Explore a recorded analysis · no key needed</p>
            <div className="cx-example-grid">
              {DEMOS.map((d) => (
                <button type="button" key={d.id} className="cx-example" aria-label={d.question} onClick={() => openChat(`example:${d.id}`)}>
                  <ExamplePlot spec={d.state.spec} />
                  <span className="cx-example-question">{d.question}</span>
                  <span className="cx-example-sources">
                    {d.sources.map((source) => (
                      <span key={source} className="cx-badge">
                        {source}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <p className="cx-provenance">World Bank, Our World in Data, IMF and WHO. Every result keeps its sources.</p>
        </div>
      )}
      {currentRequest && inflight && currentRequest.id !== selected && (
        <section className="cx-inflight" aria-label="Current request">
          <MessageTurn question={currentRequest.question}>
            <ThinkingBlock analysis={currentRequest} />
            {choiceBlock(currentRequest)}
            <RunStatus
              phase={currentRequest.choice ? "done" : currentRequest.phase === "done" || currentRequest.phase === "idle" ? "running" : currentRequest.phase}
              status={currentRequest.status}
              actions={
                <>
                  {running && (
                    <Button
                      size="sm"
                      label="Stop and steer"
                      onClick={() => {
                        setUseCurrent(true);
                        agent.stop();
                        composer.current?.focus();
                      }}
                    />
                  )}
                  {currentRequest.phase === "needs-key" && <Button size="sm" variant="primary" label="Connect model" onClick={() => connect()} />}
                  {["needs-key", "error"].includes(currentRequest.phase) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      label="Retry"
                      onClick={() =>
                        void submit(currentRequest.question, false, contexts.current[currentRequest.id] || null, undefined, undefined, directs.current[currentRequest.id])
                      }
                    />
                  )}
                </>
              }
            >
              {clarification?.runId === currentRequest.id && <Surface operations={clarification.operations} onAction={respond} />}
            </RunStatus>
          </MessageTurn>
        </section>
      )}
    </div>
  );

  return (
    <div className="cx-app" data-panel={panelOpen || undefined}>
      {!mobileNav && navigation}
      {mobileNav && (
        <Dialog title="Chats and settings" onClose={() => setMobileNav(false)} className="cx-drawer">
          {navigation}
        </Dialog>
      )}
      <section className="cx-main" aria-label="Analysis workspace">
        <div className="cx-mobilebar">
          <IconButton label="Open chats" variant="ghost" size="sm" icon={<MenuIcon />} aria-expanded={mobileNav} onClick={() => setMobileNav(true)} />
          <span className="cx-brand">
            <span className="cx-glyph" aria-hidden="true" />
            Chitti
          </span>
        </div>
        {dashboards ? (
          <div className="cx-scroll">
            <Dashboards
              pin={pin}
              onPinned={() => setPin(null)}
              onClose={() => {
                setDashboards(false);
                setPin(null);
              }}
            />
          </div>
        ) : (
          <>
            <div className="cx-scroll">{thread}</div>
            <div className="cx-dock">
              <Composer
                inputRef={composer}
                value={question}
                onChange={setQuestion}
                running={running}
                onStop={() => agent.stop()}
                sources={config.sources}
                modelConnected={connectedModel}
                placeholder={
                  panelOpen
                    ? "Reply, or ask about the open chart"
                    : attached
                      ? "Ask a follow-up or change the chart…"
                      : "Compare life expectancy in Japan, Italy and Spain since 1960"
                }
                context={contextRow}
                onSend={(pinned) => {
                  const plan = pinned ? pinnedPlan(question, pinned) : null;
                  if (plan && pinned) runDirect(plan, { id: pinned.id, name: pinned.name, source: pinned.source }, question);
                  else void submit();
                }}
                footer={
                  <ModelPicker
                    value={config}
                    locked={modelLocked}
                    running={running}
                    onChoose={(value) => {
                      let remember = false;
                      try {
                        remember = !!sessionStorage.getItem("chitti:key");
                      } catch {}
                      saveConfig(value, remember);
                    }}
                    onConnect={connect}
                    onNewChat={newAnalysis}
                  />
                }
              />
            </div>
          </>
        )}
      </section>
      {panelOpen && !dashboards && (
        <CardContext.Provider value={{ ...cardFor(panelTurn!, panelTurn!.id === selected), openInPanel: false }}>
          <ExplanationContext.Provider value={panelTurn!.id === selected ? inlineExplanation : null}>
            <ChartPanel
              turn={panelTurn!}
              turnNumber={turnNumber(panelTurn!.id)}
              onClose={closePanel}
              onSteer={panelTurn!.id === selected ? steer : undefined}
              shareItems={exportItems(panelTurn!.result!, panelTurn!, false)}
              onPin={() => pinResult(panelTurn!.result!)}
            />
          </ExplanationContext.Provider>
        </CardContext.Provider>
      )}
      {settings && (
        <Settings
          value={settingsDraft || config}
          locked={running || modelLocked}
          onSave={saveConfig}
          onClose={() => {
            setSettings(false);
            setSettingsDraft(null);
          }}
        />
      )}
    </div>
  );
}
