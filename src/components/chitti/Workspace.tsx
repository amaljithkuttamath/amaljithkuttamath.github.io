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
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./ui/chitti.css";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatComposer } from "@astryxdesign/core/Chat";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Code } from "@astryxdesign/core/Code";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Kbd } from "@astryxdesign/core/Kbd";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { ChittiTheme } from "./ui/ChittiTheme";
import { MessageTurn } from "./ui/MessageTurn";
import { MicroLabel, PanelHeader } from "./ui/primitives";
import { RunStatus, StepList } from "./ui/RunStatus";
import {
  ContextIcon,
  DashboardIcon,
  DownloadIcon,
  PinIcon,
  PlusIcon,
  RedoIcon,
  SendIcon,
  SettingsIcon,
  ShareIcon,
  SparkIcon,
  SteerIcon,
  StepsIcon,
  UndoIcon,
} from "./ui/icons";
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
function WorkspaceApp() {
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
  const [mobileNav, setMobileNav] = useState(false);
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
  // A request that is running, or ended without a result, stays visible beside the view.
  const inflight = !!currentRequest && (running ||
    (!currentRequest.result && ["needs-key", "error", "stopped"].includes(currentRequest.phase)));
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
  const attachable = !!active?.result;
  const attached = useCurrent && attachable;
  const composerView = (
    <ChatComposer
      className="cx-composer"
      density="compact"
      elevation="none"
      onSubmit={() => void submit()}
      value={question}
      onChange={setQuestion}
      isStopShown={running}
      onStop={() => agent.stop()}
      headerActions={
        attachable ? (
          <div className="cx-context" role="group" aria-label="Follow-up context">
            {attached ? (
              <>
                <MicroLabel>Follow-up uses</MicroLabel>
                <Token
                  size="sm"
                  color="cyan"
                  icon={<ContextIcon />}
                  label={active!.result!.spec?.title || active!.question}
                  isDisabled={running}
                  onRemove={() => setUseCurrent(false)}
                />
              </>
            ) : (
              <>
                <MicroLabel>New question, no context</MicroLabel>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ContextIcon />}
                  label="Use current view"
                  isDisabled={running}
                  onClick={() => setUseCurrent(true)}
                />
              </>
            )}
          </div>
        ) : undefined
      }
      input={
        <textarea
          id="cw-question"
          className="cx-composer-input"
          aria-label="Ask a data question"
          aria-describedby="cx-composer-help"
          ref={composer}
          value={question}
          rows={1}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
            e.preventDefault();
            void submit();
          }}
          placeholder={
            attached
              ? "Ask a follow-up or change the chart…"
              : "Compare life expectancy in Japan, Italy and Spain since 1960"
          }
        />
      }
      footerActions={
        <ModelPicker value={config} locked={modelLocked} running={running}
          onChoose={value => { let remember = false; try { remember = !!sessionStorage.getItem("chitti:key"); } catch {} saveConfig(value, remember); }}
          onConnect={connect} onNewChat={newAnalysis} />
      }
      sendActions={
        <span className="cx-composer-help" id="cx-composer-help">
          <Kbd keys="enter" /> to send · <Kbd keys="shift+enter" /> new line
        </span>
      }
      sendButton={
        running ? (
          <Button label="Stop" icon={<Icon icon="stop" />} onClick={() => agent.stop()} />
        ) : (
          <Button
            label="Send"
            variant="primary"
            icon={<SendIcon />}
            isDisabled={!question.trim()}
            onClick={() => void submit()}
          />
        )
      }
    />
  );
  const navigation = (
    <SideNav
      className="cx-sidenav"
      header={
        <SideNavHeading
          icon={<span className="cx-brand-mark" aria-hidden="true" />}
          heading="Chitti"
          subheading="Data, in conversation"
        />
      }
      topContent={
        <Button
          className="cx-new-chat"
          label="New chat"
          icon={<PlusIcon />}
          width="100%"
          isDisabled={running}
          onClick={() => { setMobileNav(false); newAnalysis(); }}
        />
      }
      footer={
        <div className="cx-nav-footer">
          <SideNavItem label="Dashboards" icon={<DashboardIcon />} isSelected={dashboards}
            aria-pressed={dashboards}
            onClick={() => { setMobileNav(false); setDashboards(!dashboards); setPin(null); }} />
          <SideNavItem label="Settings" icon={<SettingsIcon />} onClick={() => { setMobileNav(false); connect(); }} />
          <Text as="p" type="supporting" className="cx-nav-note">Chats stay in this tab. Pin a chart or export a result to keep it.</Text>
        </div>
      }
    >
      <section id="cw-recent-chats" aria-label="Recent chats" className="cx-recent">
        <SideNavSection title="Recent chats">
          {recentChats.map(t => {
            const root = resolveTurn(conversationPath(t.id, parents.current)[0]);
            const depth = conversationPath(t.id, parents.current).length - 1;
            return <SideNavItem key={t.id} label={root?.question || t.question} isSelected={selected === t.id}
              aria-current={selected === t.id ? "page" : undefined} isDisabled={running}
              endContent={depth > 0 ? <MicroLabel>+{depth}</MicroLabel> : undefined}
              onClick={() => { setMobileNav(false); openChat(t.id); }} />;
          })}
          {!recentChats.length && <Text as="p" type="supporting" className="cx-nav-empty">Your chats appear here.</Text>}
        </SideNavSection>
      </section>
    </SideNav>
  );
  const exportItems = (result: NonNullable<Analysis["result"]>, turn: Analysis): DropdownMenuOption[] => [
    { label: "Copy share link", icon: <ShareIcon />, onClick: () => void share() },
    { label: "Download CSV", icon: <DownloadIcon />, isDisabled: !result.rows.length,
      onClick: () => download("chitti-data.csv", rowsToCSV(result.rows), "text/csv") },
    { label: "Download Markdown", icon: <DownloadIcon />, onClick: () => download("chitti-analysis.md", buildFindingOkf({
        question: turn.question, finding: result.answer, spec: result.spec, citations: result.citations,
        verification: result.verification, createdAt: result.ts }), "text/markdown") },
    ...(result.spec ? [{ type: "divider" as const }, { label: "Pin to dashboard", icon: <PinIcon />,
      onClick: () => { setPin(result); setDashboards(true); } }] : []),
  ];
  return (
    <div className="cx-app">
      <div className="cx-mobilebar">
        <IconButton label="Open chats" tooltip="Chats, dashboards and settings" variant="ghost" icon={<Icon icon="menu" />}
          aria-expanded={mobileNav} onClick={() => setMobileNav(true)} />
        <span className="cx-brand"><span className="cx-brand-mark" aria-hidden="true" />Chitti</span>
        <MicroLabel>Data, in conversation</MicroLabel>
      </div>
      {mobileNav && (
        <MobileNav isOpen={mobileNav} onOpenChange={setMobileNav} side="start">
          <div className="cx-drawer-nav">{navigation}</div>
        </MobileNav>
      )}
      <div className="cx-workspace">
        <aside className="cx-rail" aria-label="Chat navigation">{!mobileNav && navigation}</aside>
        <section className="cx-main" aria-label="Analysis workspace">
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
              <div className="cx-transcript" aria-label="Conversation">
              {previousTurns.map((turn, index) => <MessageTurn key={turn.id}
                who={`You${turn.origin === "example" ? " · recorded example" : ""}`} question={turn.question}
                toolbar={<div className="cx-turn-meta"><Button size="sm" variant="ghost" label="Continue from here" isDisabled={running} onClick={() => openChat(turn.id)} /></div>}>
                {turn.result && <CollapseChart.Provider value={JSON.stringify(turn.result.spec) === JSON.stringify(previousTurns[index - 1]?.result?.spec)}><Result result={turn.result} /></CollapseChart.Provider>}
                {!turn.result && <Text as="p" type="supporting">{turn.status}</Text>}
              </MessageTurn>)}
              {notice && (
                <Banner
                  className="cx-notice"
                  status="info"
                  title={<span role="status">{notice}</span>}
                  isDismissable
                  dismissLabel="Dismiss notice"
                  onDismiss={() => setNotice("")}
                  collapsible={false}
                />
              )}
              {active ? (
                <MessageTurn
                  isCurrent
                  turnRef={activeArticle}
                  who={active.origin === "example" ? "Recorded example" : active.origin === "shared" ? "Shared result" : "You"}
                  question={active.question}
                  aside={
                    <div className="cx-change" aria-label="Workspace change">
                      <p role="status" className="cx-change-text">
                        {navigationNote && <span>{navigationNote} </span>}
                        {active.origin === "example" || active.origin === "shared"
                          ? "Opened recorded chart and sources."
                          : change}
                      </p>
                      {active.origin === "view" && <Badge variant="cyan" label="View only · source data unchanged" />}
                      {(active.phase === "running" || active.phase === "waiting") && (
                        <Badge variant="warning" label="Draft · not yet verified" />
                      )}
                    </div>
                  }
                  toolbar={
                    <Toolbar
                      label="Result actions"
                      size="sm"
                      className="cx-toolbar cx-turn-toolbar"
                      startContent={<>
                        {Object.hasOwn(parents.current, selected) && (
                          <IconButton variant="ghost" label="Undo" tooltip="Undo" icon={<UndoIcon />} isDisabled={running} onClick={undo} />
                        )}
                        {!!redo.length && (
                          <IconButton variant="ghost" label="Redo" tooltip="Redo" icon={<RedoIcon />} isDisabled={running} onClick={redoChange} />
                        )}
                        <Button variant="ghost" label="Steer" icon={<SteerIcon />} isDisabled={running}
                          onClick={() => { setUseCurrent(true); composer.current?.focus(); }} />
                        <Button variant="ghost" label={`Steps${active.trace.length ? ` ${active.trace.length}` : ""}`}
                          icon={<StepsIcon />} aria-expanded={receipt} onClick={() => setReceipt(!receipt)} />
                      </>}
                      endContent={<>
                        {active.origin === "direct" && active.phase === "done" && (
                          <Button label="Analyze with model" icon={<SparkIcon />} isDisabled={running}
                            onClick={() => void submit(active.question, true)} />
                        )}
                        {active.result && (
                          <DropdownMenu
                            alignment="end"
                            button={{ label: "Share & export", icon: <ShareIcon />, size: "sm" }}
                            items={exportItems(active.result, active)}
                          />
                        )}
                      </>}
                    />
                  }
                >
                  {receipt && (
                    <section className="cx-receipts" aria-label="Execution steps">
                      <PanelHeader level={3} eyebrow="Receipt" title="Execution steps"
                        description={active.cost !== undefined ? `Model cost: $${active.cost.toFixed(4)}` : undefined} />
                      {!active.trace.length && (
                        <Text as="p" type="supporting">
                          {active.origin === "example" || active.origin === "shared"
                            ? "This snapshot includes the result and sources, not the original execution log."
                            : "No completed steps yet."}
                        </Text>
                      )}
                      <StepList trace={active.trace} defaultIsExpanded />
                      {Object.entries(active.files).map(([name, body]) => (
                        <Collapsible key={name} className="cx-file" defaultIsOpen={false} trigger={<Code>{name}</Code>}>
                          <pre className="cx-pre">{body}</pre>
                          <Button size="sm" icon={<DownloadIcon />} label="Download file"
                            onClick={() => download(name.split("/").at(-1) || "file.txt", body)} />
                        </Collapsible>
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
                    <div className="cx-pending" aria-hidden="true">
                      <Skeleton height={14} width="72%" />
                      <Skeleton height={14} width="54%" index={1} />
                      <Skeleton height={220} index={2} />
                    </div>
                  ) : null}
                </MessageTurn>
              ) : inflight ? null : (
                <div className="cx-start">
                  <MicroLabel>Live public data · every number cited</MicroLabel>
                  <Heading level={2} className="cx-start-title">What do you want to find out?</Heading>
                  <Text as="p" type="large" color="secondary" className="cx-start-lede">
                    Compare countries, follow a trend, or check a claim against public data.
                  </Text>
                  {!!redo.length && (
                    <Button size="sm" variant="ghost" icon={<RedoIcon />} label="Redo" isDisabled={running} onClick={redoChange} />
                  )}
                  <section className="cx-examples" aria-label="Recorded analyses">
                    <MicroLabel as="p">Explore a recorded analysis</MicroLabel>
                    <div className="cx-example-grid">
                      {DEMOS.map((d) => (
                        <ClickableCard key={d.id} className="cx-example" label={d.question} padding={4}
                          onClick={() => openChat(`example:${d.id}`)}>
                          <ExamplePlot spec={d.state.spec} />
                          <span className="cx-example-question">{d.question}</span>
                          <span className="cx-example-sources">
                            {d.sources.map(source => <Badge key={source} variant="neutral" label={source} />)}
                          </span>
                        </ClickableCard>
                      ))}
                    </div>
                  </section>
                  <p className="cx-provenance">
                    World Bank, Our World in Data, IMF and WHO. Every result
                    keeps its sources.
                  </p>
                </div>
              )}
              {currentRequest && inflight && (
                  <section className="cx-inflight" aria-label="Current request">
                    {selected !== currentRequest.id && (
                      <div className="cx-turn-ask">
                        <MicroLabel>You</MicroLabel>
                        <Heading level={2} className="cx-turn-question">{currentRequest.question}</Heading>
                      </div>
                    )}
                    <RunStatus
                      phase={currentRequest.phase === "done" || currentRequest.phase === "idle" ? "running" : currentRequest.phase}
                      status={currentRequest.status}
                      trace={currentRequest.trace}
                      actions={<>
                        {running && (
                          <Button size="sm" label="Stop and steer" onClick={() => {
                            setUseCurrent(true);
                            agent.stop();
                            composer.current?.focus();
                          }} />
                        )}
                        {currentRequest.phase === "needs-key" && (
                          <Button size="sm" label="Connect model" onClick={() => connect()} />
                        )}
                        {["needs-key", "error"].includes(currentRequest.phase) && (
                          <Button size="sm" variant="ghost" label="Retry" onClick={() =>
                            void submit(currentRequest.question, false, contexts.current[currentRequest.id] || null)} />
                        )}
                      </>}
                    >
                      {clarification?.runId === currentRequest.id && (
                        <Surface operations={clarification.operations} onAction={respond} />
                      )}
                    </RunStatus>
                  </section>
                )}
              </div>
              <div className="cx-dock">{composerView}</div>
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

export default function Workspace() {
  return (
    <ChittiTheme>
      <WorkspaceApp />
    </ChittiTheme>
  );
}
