// evals-view.ts — the Evals sidebar: run the suite, watch the funnel fill in,
// and keep a history you can read a trend off.
//
// WHY A SIDEBAR AND NOT A TURN. An eval run is not an answer, and rendering it
// as one would put eleven fake questions in the thread and leave the user's
// actual conversation buried under them. It is a panel that opens beside the
// work, streams as it goes, and closes. The thread stays the record of what the
// user asked.
//
// THE FUNNEL IS THE HEADLINE. Six stage bars, in pipeline order, each showing
// how many cases reached it and how many were lost there. A pass count says the
// suite regressed; the funnel says which layer did — retrieval, the source API,
// the chart guard, or the expectation itself.
//
// TWO MODES, AND THE CHEAP ONE IS THE DEFAULT. "Fast path only" costs nothing —
// no key, no model, no tokens — and still grades the whole deterministic
// pipeline plus every refusal. "With the agent" spends the user's own key, one
// fresh session per case, and is never entered by accident: it needs a key
// present and an explicit pick.
import {
  EVAL_CASES,
  EVAL_STAGES,
  STAGE_LABELS,
  funnel,
  summarize,
  stoppedAt,
  loadRuns,
  saveRun,
  clearRuns,
  runToMarkdown,
  type EvalCase,
  type EvalCaseResult,
  type EvalRun,
} from '../evals';
import { runEvalSuite, makeDirectRunner, type EvalDeps, type RunnerAnswer } from '../evals-run';
import { createSession } from '../agent';
import type { ProviderConfig } from '../providers';
import { evalsPanel, evalsBody, evalsBackdrop, evalsNavBtn, keyIn, modelSel, dashStore } from './state';
import { selectedSources, currentProvider, rlmEnabled, openByok } from './config';
import { esc, escapeHtml, fmtDate } from './dom';
import { writeClipboard } from './actions';

// ── Panel state (module-private, like every other view here) ─────────────
let mode: 'direct' | 'agent' = 'direct';
let controller: AbortController | null = null;
let live: EvalCaseResult[] = [];
let history: EvalRun[] = [];
let statusMsg = '';
let statusKind: 'idle' | 'work' | 'ok' | 'error' = 'idle';
let returnFocus: HTMLElement | null = null;

const running = () => controller !== null;

function setStatus(msg: string, kind: typeof statusKind = 'work') {
  statusMsg = msg;
  statusKind = kind;
  const el = document.getElementById('ch-evals-status');
  if (el) {
    el.textContent = msg;
    el.className = 'ch-evals-status is-' + kind;
  }
}

// ── Open / close ─────────────────────────────────────────────────────────
export function openEvals() {
  if (!evalsPanel) return;
  returnFocus = document.activeElement as HTMLElement;
  history = loadRuns(dashStore);
  evalsPanel.hidden = false;
  if (evalsBackdrop) evalsBackdrop.hidden = false;
  evalsNavBtn?.setAttribute('aria-expanded', 'true');
  document.body.classList.add('ch-evals-open');
  render();
  requestAnimationFrame(() => document.getElementById('ch-evals-run')?.focus());
}

export function closeEvals() {
  if (!evalsPanel) return;
  // A run in flight is stopped rather than orphaned: it spends the user's key
  // and holds a network connection, and a closed panel has nowhere to report.
  controller?.abort();
  evalsPanel.hidden = true;
  if (evalsBackdrop) evalsBackdrop.hidden = true;
  evalsNavBtn?.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('ch-evals-open');
  if (returnFocus && document.body.contains(returnFocus)) returnFocus.focus();
  else evalsNavBtn?.focus();
}

// Set by the "/evals agent" form of the chat command. Ignored mid-run: a mode
// switch under a running suite would file results under a mode that did not
// produce them.
export function setEvalMode(m: 'direct' | 'agent') {
  if (running()) return;
  mode = m;
  if (evalsOpen()) render();
}

export function toggleEvals() {
  if (evalsPanel?.hidden) openEvals();
  else closeEvals();
}

export function evalsOpen(): boolean {
  return !!evalsPanel && !evalsPanel.hidden;
}

// ── The runners ──────────────────────────────────────────────────────────
// A FRESH SESSION PER CASE. Reusing one would make each case a follow-up to the
// last, and the suite would be grading conversation memory instead of the thing
// each case claims to measure.
function makeAgentRunner(): EvalDeps['agent'] | undefined {
  const apiKey = keyIn.value.trim();
  if (!apiKey) return undefined;
  const cfg: ProviderConfig = {
    provider: currentProvider(),
    model: modelSel.value,
    apiKey,
    requestReasoning: modelSel.selectedOptions[0]?.dataset.reasoning === '1',
  };
  const sources = selectedSources();
  return async (question, signal): Promise<RunnerAnswer> => {
    const session = createSession(cfg, { sources, rlm: rlmEnabled() });
    const out = await session.ask(
      question,
      { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} },
      signal
    );
    return {
      rows: out.rows,
      citations: out.citations,
      charted: !!out.chartSpec,
      cost: out.cost,
      aborted: out.aborted,
    };
  };
}

export async function runEvals() {
  if (running()) return;
  const sources = selectedSources();
  if (!sources.length) {
    setStatus('Pick at least one database first.', 'error');
    render();
    openByok(true);
    return;
  }
  const agent = mode === 'agent' ? makeAgentRunner() : undefined;
  if (mode === 'agent' && !agent) {
    setStatus('The agent mode needs a key — connect one, or run the fast path only.', 'error');
    render();
    openByok(true);
    return;
  }

  live = [];
  controller = new AbortController();
  const deps: EvalDeps = { direct: makeDirectRunner(sources), ...(agent ? { agent } : {}) };
  const startedAt = new Date().toISOString();
  setStatus(`Running 0/${EVAL_CASES.length}…`);
  render();

  try {
    const results = await runEvalSuite(EVAL_CASES, deps, {
      mode,
      signal: controller.signal,
      onProgress: (done, total, current: EvalCase) => {
        setStatus(`Running ${done + 1}/${total} — ${current.question}`);
      },
      onResult: (r) => {
        live = [...live, r];
        render();
      },
    });
    const stopped = controller.signal.aborted;
    const record: EvalRun = {
      at: startedAt,
      mode,
      sources,
      provider: currentProvider(),
      ...(mode === 'agent' ? { model: modelSel.value } : {}),
      results,
      summary: summarize(results),
    };
    // A stopped run is a partial one; it is shown but never filed, because a
    // history you cannot compare like for like is worse than a shorter one.
    if (stopped) {
      setStatus('Stopped — partial results shown, not saved to history.', 'error');
    } else {
      const saved = saveRun(dashStore, record);
      history = saved.ok ? saved.runs : history;
      const s = record.summary;
      setStatus(
        `${s.passed}/${s.ran} passed` +
          (s.refusalsChecked ? ` · ${s.refusalsHeld}/${s.refusalsChecked} refusals held` : '') +
          (s.cost > 0 ? ` · ~$${s.cost.toFixed(4)}` : ' · no key, no cost') +
          (saved.ok ? '' : ` · ${saved.error}`),
        s.failed ? 'error' : 'ok'
      );
    }
  } catch (err: any) {
    console.error('eval run failed', err);
    setStatus('The run failed: ' + (err?.message ?? String(err)), 'error');
  } finally {
    controller = null;
    render();
  }
}

export function stopEvals() {
  controller?.abort();
}

// ── Render ───────────────────────────────────────────────────────────────
const pctText = (n: number) => `${Math.round(n * 100)}%`;

function funnelHtml(results: EvalCaseResult[]): string {
  const rows = funnel(results);
  const ran = results.filter((r) => !r.skipped).length;
  if (!ran) {
    return `<p class="ch-evals-empty">No graded cases yet. The fast-path run costs nothing — start there.</p>`;
  }
  const bars = rows
    .map((f) => {
      const width = Math.max(f.pct * 100, f.reached ? 2 : 0);
      return `<div class="ch-evals-fstage">
        <div class="ch-evals-frow">
          <span class="ch-evals-fname">${esc(f.stage)}</span>
          <span class="ch-evals-fcount">${f.reached}/${ran}${f.lost ? ` <span class="ch-evals-flost">−${f.lost}</span>` : ''}</span>
        </div>
        <div class="ch-evals-fbar" role="img" aria-label="${escapeHtml(`${STAGE_LABELS[f.stage]}: ${f.reached} of ${ran} (${pctText(f.pct)})`)}">
          <span class="ch-evals-ffill" style="width:${width}%"></span>
        </div>
        <p class="ch-evals-fhint">${esc(STAGE_LABELS[f.stage].split('— ')[1] ?? '')}</p>
      </div>`;
    })
    .join('');
  return `<div class="ch-evals-funnel">${bars}</div>`;
}

function pipsHtml(r: EvalCaseResult): string {
  return EVAL_STAGES.map((stage) => {
    const s = r.stages.find((x) => x.stage === stage);
    const cls = s?.status === 'pass' ? 'is-pass' : s?.status === 'fail' ? 'is-fail' : 'is-skip';
    return `<span class="ch-evals-pip ${cls}" title="${escapeHtml(stage)}"></span>`;
  }).join('');
}

function caseHtml(c: EvalCase, r: EvalCaseResult | undefined): string {
  const state = !r ? 'pending' : r.skipped ? 'skip' : r.passed ? 'pass' : 'fail';
  const stop = r ? stoppedAt(r.stages) : null;
  const verdict =
    state === 'pending' ? '·' : state === 'pass' ? 'pass' : state === 'skip' ? 'not run' : 'fail';
  // The failure line is the case's own reason for existing plus what actually
  // happened — a failing eval is a question ("did we mean to change this?"),
  // never a verdict on its own.
  const detail = r?.skipped
    ? `<p class="ch-evals-case-note">${esc(r.skipped)}</p>`
    : stop
      ? `<p class="ch-evals-case-note is-fail">${esc(stop.stage)}${stop.detail ? ' — ' + esc(stop.detail) : ''}</p>
         <p class="ch-evals-case-why">${esc(c.why)}</p>`
      : '';
  return `<li class="ch-evals-case is-${state}">
    <div class="ch-evals-case-head">
      <span class="ch-evals-case-route">${esc(c.route)}</span>
      <span class="ch-evals-case-q">${esc(c.question)}</span>
      <span class="ch-evals-case-verdict">${esc(verdict)}</span>
    </div>
    <div class="ch-evals-pips" aria-hidden="true">${r ? pipsHtml(r) : ''}</div>
    ${detail}
  </li>`;
}

function historyHtml(): string {
  if (!history.length) {
    return `<p class="ch-evals-empty">No runs saved yet. Every completed run is filed here — up to twenty, newest first.</p>`;
  }
  const rows = history
    .map((h) => {
      const s = h.summary;
      const rate = s.ran ? Math.round((s.passed / s.ran) * 100) : 0;
      return `<li class="ch-evals-hrun">
        <span class="ch-evals-hdate">${esc(fmtDate(h.at))}</span>
        <span class="ch-evals-hbar"><span class="ch-evals-hfill" style="width:${rate}%"></span></span>
        <span class="ch-evals-hnum">${s.passed}/${s.ran}</span>
        <span class="ch-evals-hmode">${esc(h.mode === 'agent' ? h.model || 'agent' : 'fast path')}</span>
        <span class="ch-evals-hcost">${s.cost > 0 ? '~$' + s.cost.toFixed(4) : '—'}</span>
      </li>`;
    })
    .join('');
  return `<ol class="ch-evals-hlist">${rows}</ol>`;
}

export function render() {
  if (!evalsBody) return;
  const results = new Map(live.map((r) => [r.id, r]));
  const summary = summarize(live);
  const keyed = !!keyIn.value.trim();

  evalsBody.innerHTML = `
    <div class="ch-evals-controls">
      <div class="ch-evals-modes" role="group" aria-label="Eval mode">
        <button type="button" class="ch-evals-mode${mode === 'direct' ? ' is-on' : ''}" data-mode="direct">
          Fast path only <span class="ch-evals-mode-sub">no key · no cost</span>
        </button>
        <button type="button" class="ch-evals-mode${mode === 'agent' ? ' is-on' : ''}" data-mode="agent"${keyed ? '' : ' disabled'}>
          With the agent <span class="ch-evals-mode-sub">${keyed ? 'spends your key' : 'needs a key'}</span>
        </button>
      </div>
      <div class="ch-evals-actions">
        <button type="button" class="ch-evals-run" id="ch-evals-run">${running() ? 'Stop' : 'Run evals'}</button>
        <span class="ch-evals-status is-${statusKind}" id="ch-evals-status" role="status" aria-live="polite">${esc(statusMsg)}</span>
      </div>
    </div>

    <section class="ch-evals-sec" aria-labelledby="ch-evals-funnel-h">
      <h3 class="ch-evals-h" id="ch-evals-funnel-h">Funnel</h3>
      <p class="ch-evals-lead">Every answer walks these six stages in order. Where the bar drops is the layer that broke.</p>
      ${funnelHtml(live)}
      ${
        summary.refusalsChecked
          ? `<p class="ch-evals-refusals">Refusals held: <strong>${summary.refusalsHeld}/${summary.refusalsChecked}</strong> — questions the fast path must escalate rather than answer.</p>`
          : ''
      }
    </section>

    <section class="ch-evals-sec" aria-labelledby="ch-evals-cases-h">
      <h3 class="ch-evals-h" id="ch-evals-cases-h">Cases <span class="ch-evals-count">${live.length}/${EVAL_CASES.length}</span></h3>
      <ul class="ch-evals-cases">
        ${EVAL_CASES.map((c) => caseHtml(c, results.get(c.id))).join('')}
      </ul>
    </section>

    <section class="ch-evals-sec" aria-labelledby="ch-evals-hist-h">
      <h3 class="ch-evals-h" id="ch-evals-hist-h">History</h3>
      <p class="ch-evals-lead">Tracked in this browser only. Copy a run out to keep it — a Markdown table drops straight into a PR.</p>
      ${historyHtml()}
      <div class="ch-evals-exports">
        <button type="button" class="ch-evals-x" id="ch-evals-copy"${live.length || history.length ? '' : ' disabled'}>Copy Markdown</button>
        <button type="button" class="ch-evals-x" id="ch-evals-json"${live.length || history.length ? '' : ' disabled'}>Export JSON</button>
        <button type="button" class="ch-evals-x is-danger" id="ch-evals-clear"${history.length ? '' : ' disabled'}>Clear history</button>
      </div>
    </section>

    <p class="ch-evals-foot">
      Cases assert which series and which countries answer a question — never a value.
      Numbers belong to the source, and change when it updates.
    </p>`;
}

// The most recent complete run: the live one if there is one, else the newest
// filed. What "export" means has to be unambiguous, and "what you are looking
// at" is the only answer that never surprises.
function exportable(): EvalRun | null {
  if (live.length) {
    return {
      at: new Date().toISOString(),
      mode,
      sources: selectedSources(),
      provider: currentProvider(),
      ...(mode === 'agent' ? { model: modelSel.value } : {}),
      results: live,
      summary: summarize(live),
    };
  }
  return history[0] ?? null;
}

// ── Events (delegated, so a re-render never drops a listener) ────────────
export function handleEvalsClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const modeBtn = t.closest<HTMLButtonElement>('.ch-evals-mode');
  if (modeBtn && !modeBtn.disabled) {
    if (running()) return;
    mode = modeBtn.dataset.mode === 'agent' ? 'agent' : 'direct';
    render();
    return;
  }
  if (t.closest('#ch-evals-run')) {
    if (running()) stopEvals();
    else void runEvals();
    return;
  }
  if (t.closest('#ch-evals-copy')) {
    const r = exportable();
    if (!r) return;
    void writeClipboard(runToMarkdown(r)).then((ok) =>
      setStatus(ok ? 'Markdown copied.' : 'Could not reach the clipboard.', ok ? 'ok' : 'error')
    );
    return;
  }
  if (t.closest('#ch-evals-json')) {
    const r = exportable();
    if (!r) return;
    downloadJson(r);
    return;
  }
  if (t.closest('#ch-evals-clear')) {
    clearRuns(dashStore);
    history = [];
    setStatus('History cleared.', 'ok');
    render();
    return;
  }
  if (t.closest('#ch-evals-close')) closeEvals();
}

function downloadJson(r: EvalRun) {
  try {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chitti-evals-${r.at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Run exported.', 'ok');
  } catch {
    setStatus('Could not export this run.', 'error');
  }
}

export function handleEvalsKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeEvals();
  }
}
