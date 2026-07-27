// dash-chat.ts — the conversational surface INSIDE a dashboard.
//
// Chitti's dashboard used to be the end of a funnel: ask in the thread, get an
// answer, then remember to pin it. The board was a filing cabinet you visited
// after the fact. This makes it the place you work: you stand in a dashboard,
// ask for a chart, and a tile appears. The conversation is how the board gets
// built, rather than something that happens elsewhere and is filed afterwards.
//
// Three decisions worth stating, because they are what make this "native"
// rather than a second ask box:
//
//  1. THE ANSWER IS THE TILE. There is no pin step and no intermediate turn to
//     approve — a successful chart is added to the dashboard you are standing
//     in. Pinning was the friction; removing it is the point.
//
//  2. THE FAST PATH RUNS FIRST, ALWAYS. `fastpath.ts` answers "indicator ×
//     countries × years" with no model and no key, so a board can be built by
//     someone who has never connected a provider. Unlike the thread, it runs
//     even when a session exists: a dashboard ask is its own thing, not a
//     follow-up to whatever the thread was discussing.
//
//  3. THE BOARD HAS ITS OWN CONVERSATION. When the agent is needed, this
//     surface uses a session scoped to the dashboard, not the thread's. So
//     "now add China" means the board's last chart, and a dashboard ask never
//     silently inherits — or pollutes — the thread's history.
import { dashStore, keyIn, modelSel } from './state';
import { currentProvider, selectedSources, rlmEnabled, openByok } from './config';
import { createSession, type ChittiSession } from '../agent';
import type { ProviderConfig } from '../providers';
import { parseFastPath, runFastPath } from '../fastpath';
import {
  addTile, makeTile, saveDashboard, loadDashboard, DashboardCapError,
  type Dashboard,
} from '../dashboard';
import type { ChartSpec, DataRow, Citation } from '../tools';

// The dashboard's own agent session, and the board it belongs to. Cleared when
// the user opens a different dashboard, so a board's conversation can never
// leak into another board's.
let dashSession: ChittiSession | null = null;
let dashSessionFor: string | null = null;
let asking = false;

// Adding a tile re-renders the whole board, which rebuilds this ask bar — so a
// confirmation written into the old bar's status line vanished the moment it
// mattered, taking the aria-live announcement with it. The message is parked
// here instead and the freshly-built bar picks it up.
let pendingStatus: { msg: string; kind: 'ok' | 'error' } | null = null;

export function resetDashChat(dashId: string | null) {
  if (dashSessionFor !== dashId) {
    dashSession = null;
    dashSessionFor = dashId;
  }
}

function status(el: HTMLElement, msg: string, kind: 'work' | 'ok' | 'error' = 'work') {
  el.textContent = msg;
  el.className = 'ch-dash-ask-status' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
}

// Add one chart to the dashboard as a tile. Reloads the board from storage
// first so a tile added here cannot clobber an edit made in another tab, and
// surfaces the cap/quota errors inline rather than throwing them away.
function addChartTile(
  dash: Dashboard,
  chart: { spec: ChartSpec; rows: DataRow[]; citations: Citation[] },
  el: HTMLElement
): Dashboard | null {
  if (!dashStore) {
    status(el, 'Browser storage is unavailable — cannot add a tile.', 'error');
    return null;
  }
  const fresh = loadDashboard(dashStore, dash.id) || dash;
  const tile = makeTile({
    title: chart.spec.title || 'Chart',
    spec: chart.spec,
    rows: chart.rows,
    citations: chart.citations,
  });
  let next: Dashboard;
  try {
    next = addTile(fresh, tile);
  } catch (e: any) {
    status(el, e instanceof DashboardCapError ? e.message : 'Could not add tile: ' + (e?.message ?? e), 'error');
    return null;
  }
  const saved = saveDashboard(dashStore, next);
  if (!saved.ok) {
    status(el, saved.error, 'error');
    return null;
  }
  return next;
}

// Ask the board a question. Returns the updated dashboard when a tile was
// added, or null when nothing changed (the caller re-renders on a change).
export async function askIntoDashboard(
  dash: Dashboard,
  question: string,
  el: HTMLElement
): Promise<Dashboard | null> {
  if (asking) return null;
  const q = question.trim();
  if (!q) return null;
  asking = true;
  try {
    // ── 1. The deterministic path: no model, no key, no cost ──────────────
    const sources = selectedSources();
    const plan = sources.length ? parseFastPath(q) : null;
    if (plan) {
      status(el, 'Fetching…');
      const res = await runFastPath(plan, {
        sources,
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (res && !('ok' in res)) {
        const next = addChartTile(dash, res, el);
        if (next) pendingStatus = { msg: 'Added — fetched directly, no model used.', kind: 'ok' };
        return next;
      }
      // A miss falls through to the agent, exactly as in the thread.
    }

    // ── 2. The agent path: needs a key ────────────────────────────────────
    const apiKey = keyIn.value.trim();
    if (!apiKey) {
      status(el, 'That one needs the full agent — connect a key to run it.', 'error');
      openByok(true);
      return null;
    }
    if (!sources.length) {
      status(el, 'Pick at least one database first.', 'error');
      openByok(true);
      return null;
    }

    if (!dashSession || dashSessionFor !== dash.id) {
      const cfg: ProviderConfig = {
        provider: currentProvider(),
        model: modelSel.value,
        apiKey,
        requestReasoning: modelSel.selectedOptions[0]?.dataset.reasoning === '1',
      };
      dashSession = createSession(cfg, { sources, rlm: rlmEnabled() });
      dashSessionFor = dash.id;
    }

    let spec: ChartSpec | null = null;
    const out = await dashSession.ask(q, {
      // The dashboard shows one live line, not the full receipt: the board is
      // the artifact here, and a streaming trace would bury it. The thread
      // remains the place to watch the agent work step by step.
      onTrace: () => {},
      onFiles: () => {},
      onChart: (s) => { spec = s; },
      onStatus: (msg) => status(el, msg),
    });

    const finalSpec = out.chartSpec ?? spec;
    if (out.aborted) {
      status(el, 'Stopped.', 'error');
      return null;
    }
    if (!finalSpec) {
      // An explanation with no chart has nothing to pin. Say what came back
      // rather than pretending the ask failed.
      status(
        el,
        out.finding
          ? 'No chart for that one — ' + out.finding.slice(0, 160)
          : 'That produced no chart, so there is nothing to add to the board.',
        'error'
      );
      return null;
    }
    const next = addChartTile(dash, { spec: finalSpec, rows: out.rows, citations: out.citations }, el);
    if (next) {
      const cost = out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : '';
      pendingStatus = { msg: 'Added.' + cost, kind: 'ok' };
    }
    return next;
  } catch (err: any) {
    console.error('dashboard ask failed', err);
    status(el, 'Failed: ' + (err?.message ?? String(err)), 'error');
    return null;
  } finally {
    asking = false;
  }
}

// Build the ask bar for a dashboard. `onAdded` hands the updated board back to
// the view so it can re-render with the new tile.
export function renderDashAsk(
  dash: Dashboard,
  onAdded: (next: Dashboard) => void
): HTMLElement {
  const wrap = document.createElement('form');
  wrap.className = 'ch-dash-ask';

  const input = document.createElement('textarea');
  input.className = 'ch-dash-ask-input';
  input.rows = 1;
  input.spellcheck = false;
  input.placeholder = dash.tiles.length
    ? 'Ask for another chart — it lands on this board…'
    : 'Ask for a chart and it lands here — e.g. "life expectancy in Japan and Italy since 1960"';
  input.setAttribute('aria-label', `Ask for a chart to add to ${dash.title}`);

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.className = 'ch-dash-ask-btn';
  btn.textContent = 'Add chart';

  const stat = document.createElement('div');
  stat.className = 'ch-dash-ask-status';
  stat.setAttribute('role', 'status');
  stat.setAttribute('aria-live', 'polite');
  // Carry over the outcome of the ask that caused this re-render.
  if (pendingStatus) {
    status(stat, pendingStatus.msg, pendingStatus.kind);
    pendingStatus = null;
  }

  const submit = async () => {
    const q = input.value.trim();
    if (!q || asking) return;
    btn.disabled = true;
    input.disabled = true;
    const next = await askIntoDashboard(dash, q, stat);
    btn.disabled = false;
    input.disabled = false;
    if (next) {
      input.value = '';
      onAdded(next);
    } else {
      input.focus();
    }
  };

  wrap.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
  // Enter sends, Shift+Enter newlines — the same convention as the main
  // composer, guarded against IME composition.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });

  const row = document.createElement('div');
  row.className = 'ch-dash-ask-row';
  row.appendChild(input);
  row.appendChild(btn);
  wrap.appendChild(row);
  wrap.appendChild(stat);
  return wrap;
}
