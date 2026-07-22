// Shared UI state for the chitti client: the single module that owns every
// piece of cross-module mutable/shared state. DOM element handles, the
// per-turn TurnBlock shape, the live-chart registries, the run-lifecycle
// scalars (session/running/controller) and the localStorage handle all live
// here so the ui/ modules share one source of truth — no window globals, no
// duplicated singletons. Everything is moved verbatim from the monolith.
import type { ChittiSession, TraceEvent, AgentOutput } from '../agent';
import type { ChartSpec, DataRow, Citation } from '../tools';
import type { StorageLike } from '../dashboard';
import { $ } from './dom';

// ── Run lifecycle ─────────────────────────────────────────────────────
// The multi-turn agent session (created on the first ask(), reused after,
// cleared by "new conversation"), the in-flight flag, and the AbortController
// for the turn currently running (null when idle). Owned here; mutated by the
// ask handler, the composer's new-question reset, and the debug seam.
export const run = {
  session: null as ChittiSession | null,
  running: false,
  runController: null as AbortController | null,
};

export const SESSION_KEY = 'chitti:key';
export const SESSION_PROVIDER = 'chitti:provider';

// ── Config-sheet elements ─────────────────────────────────────────────
export const providerSel = $('ch-provider') as HTMLSelectElement;
export const modelSel = $('ch-model') as HTMLSelectElement;
export const modelPickList = $('ch-modelpick-list');
export const modelPickSearch = $('ch-model-search') as HTMLInputElement;
export const modelPickCount = $('ch-modelpick-count');
export const modelPickEmpty = $('ch-modelpick-empty');
export const keyIn = $('ch-key') as HTMLInputElement;
export const saveChk = $('ch-save') as HTMLInputElement;
export const keyLinks = $('ch-keylinks');
export const providerNote = $('ch-provider-note');

export const byokPanel = $('ch-byok') as HTMLDivElement;
export const byokSum = $('ch-byok-sum') as HTMLButtonElement;
export const byokState = $('ch-byok-state');
export const byokCta = $('ch-byok-cta');
export const byokMore = $('ch-byok-more') as HTMLButtonElement;
export const byokSettings = $('ch-byok-settings') as HTMLDivElement;

// ── Console / composer / thread elements ──────────────────────────────
export const consoleEl = $('ch-console');
export const askForm = $('ch-ask') as HTMLFormElement;
export const qIn = $('ch-q') as HTMLTextAreaElement;
export const chips = $('ch-chips');

export const composerForm = $('ch-composer') as HTMLFormElement;
export const composerQ = $('ch-composer-q') as HTMLTextAreaElement;
// The composer's Ask button IS the primary (and only) submit button now, so
// the run-state "Working…" toggle drives it directly.
export const askBtn = $('ch-composer-btn') as HTMLButtonElement;
export const newConvoBtn = $('ch-new-convo') as HTMLButtonElement;

export const threadEl = $('ch-thread');
export const turnTemplate = $('ch-turn-template') as HTMLTemplateElement;

// ── Source picker + RLM elements ──────────────────────────────────────
export const sourcesBox = $('ch-sources');
export const sourcesHint = $('ch-sources-hint');
export const sourcesCount = $('ch-sources-count');
export const sourcesSearch = $('ch-sources-search') as HTMLInputElement;
export const sourcesEmpty = $('ch-sources-empty');
export const sourceItems = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.ch-source-item')
);
export const rlmBox = $('ch-rlm');
export const rlmToggle = $('ch-rlm-toggle') as HTMLInputElement | null;
export const rlmHint = $('ch-rlm-hint');

// ── Dashboards view elements ──────────────────────────────────────────
export const dashNavBtn = $('ch-dash-nav') as HTMLButtonElement;
export const dashNavCount = $('ch-dash-nav-count');
export const pinDialog = $('ch-pin-dialog');
export const pinBackdrop = $('ch-pin-backdrop');
export const pinCloseBtn = $('ch-pin-close') as HTMLButtonElement;
export const pinListEl = $('ch-pin-list');
export const pinNewForm = $('ch-pin-new') as HTMLFormElement;
export const pinNameInput = $('ch-pin-name') as HTMLInputElement;
export const pinStatusEl = $('ch-pin-status');
export const dashView = $('ch-dashview');
export const dashViewBack = $('ch-dashview-back') as HTMLButtonElement;
export const dashViewTitle = $('ch-dashview-title');
export const dashViewBody = $('ch-dashview-body');
export const dashViewStatus = $('ch-dashview-status');
export const dashImportFile = $('ch-dash-import-file') as HTMLInputElement;

// Curated indicator id → friendly name, for citations.
export const INDICATOR_MAP: Record<string, string> = JSON.parse(
  ($('ch-indicator-map') as HTMLScriptElement).textContent || '{}'
);

export interface TurnBlock {
  root: HTMLElement;
  questionEl: HTMLElement;
  statusRow: HTMLElement;
  statusDot: HTMLElement;
  statusMsg: HTMLElement;
  stopBtn: HTMLButtonElement;
  panel: HTMLDetailsElement;
  panelDot: HTMLElement;
  panelLabel: HTMLElement;
  railModelEl: HTMLElement;
  traceEl: HTMLElement;
  renderFlag: HTMLElement;
  railTotal: HTMLElement;
  canvasEl: HTMLElement;
  chartEl: HTMLElement;
  chartTitle: HTMLElement;
  chartUnit: HTMLElement;
  metaSection: HTMLElement;
  answerSection: HTMLElement;
  findingEl: HTMLElement;
  verifyEl: HTMLElement;
  dataDetails: HTMLDetailsElement;
  dataCount: HTMLElement;
  csvBtn: HTMLButtonElement;
  shareBtn: HTMLButtonElement;
  mdBtn: HTMLButtonElement;
  pinBtn: HTMLButtonElement;
  shareStatus: HTMLElement;
  shareBanner: HTMLElement;
  tableEl: HTMLTableElement;
  citeEl: HTMLElement;
  chartInstance: any | null;
  lastSpec: ChartSpec | null;
  lastRows: DataRow[];
  lastCSV: string;
  // Answer-level state captured for the share permalink (backlog #15): the
  // finding text, citations, and verdict this turn ended with. Snapshotted on
  // completion so the share button encodes exactly what is on screen.
  lastFinding: string;
  lastCitations: Citation[];
  lastVerification: AgentOutput['verification'];
  // True when this turn was restored from a #share= link (no agent ran).
  isShared: boolean;
  // Index (into lastRows) of the evidence row currently highlighted by a
  // chart click, or -1 when nothing is highlighted. Chart↔table linking.
  activeRowIndex: number;
  trace: TraceEvent[];
  files: Record<string, string>;
  startTimes: number[];
  question: string;
}

// not yet superseded by a later turn. Task 5 removes an entry from this
// array when that turn's chart is frozen.
export const liveChartTurns: TurnBlock[] = [];
// Live dashboard-view tile charts (one per rendered tile in the open
// dashboard). Wired into the same theme/resize handlers as turn charts;
// disposed and cleared when the dashboard view is exited.
export const liveDashCharts: { el: HTMLElement; spec: ChartSpec; inst: any }[] = [];
// Separate from liveChartTurns (which only tracks turns with a live
// chart) so the new-conversation reset can dispose every chart at once.
export const allTurns: TurnBlock[] = [];

// localStorage handle for saved dashboards (null in privacy modes that throw).
export const dashStore: StorageLike | null = (() => {
  try {
    const s = window.localStorage;
    s.getItem('__chitti_probe'); // throws in some privacy modes
    return s as unknown as StorageLike;
  } catch {
    return null;
  }
})();
