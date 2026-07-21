// Turn blocks: createTurnBlock (clones the turn template, wires its CSV/share/
// pin buttons) plus the per-turn status line and question header. Extracted
// verbatim. Share + pin actions come from actions.ts / dashboards-view.ts.
import type { TurnBlock } from './state';
import { threadEl, turnTemplate } from './state';
import { q } from './dom';
import { shareTurn } from './actions';
import { openPinPicker } from './dashboards-view';

export function createTurnBlock(): TurnBlock {
  const fragment = turnTemplate.content.cloneNode(true) as DocumentFragment;
  const root = fragment.querySelector('.ch-turn') as HTMLElement;
  threadEl.appendChild(fragment);

  const tb: TurnBlock = {
    root,
    questionEl: q(root, '.ch-turn-q'),
    statusRow: q(root, '.ch-status'),
    statusDot: q(root, '.ch-status-dot'),
    statusMsg: q(root, '.ch-status-msg'),
    stopBtn: q<HTMLButtonElement>(root, '.ch-stop'),
    panel: q<HTMLDetailsElement>(root, '.ch-panel'),
    panelDot: q(root, '.ch-panel-dot'),
    panelLabel: q(root, '.ch-panel-label'),
    railModelEl: q(root, '.ch-rail-model'),
    traceEl: q(root, '.ch-trace'),
    renderFlag: q(root, '.ch-render-flag'),
    railTotal: q(root, '.ch-rail-total'),
    canvasEl: q(root, '.ch-canvas'),
    chartEl: q(root, '.ch-chart'),
    chartTitle: q(root, '.ch-chart-title'),
    chartUnit: q(root, '.ch-chart-unit'),
    metaSection: q(root, '.ch-meta'),
    answerSection: q(root, '.ch-answer'),
    findingEl: q(root, '.ch-finding'),
    verifyEl: q(root, '.ch-verify'),
    dataDetails: q<HTMLDetailsElement>(root, '.ch-data'),
    dataCount: q(root, '.ch-data-count'),
    csvBtn: q<HTMLButtonElement>(root, '.ch-csv'),
    shareBtn: q<HTMLButtonElement>(root, '.ch-share'),
    pinBtn: q<HTMLButtonElement>(root, '.ch-pin'),
    shareStatus: q(root, '.ch-share-status'),
    shareBanner: q(root, '.ch-share-banner'),
    tableEl: q<HTMLTableElement>(root, '.ch-table'),
    citeEl: q(root, '.ch-cite'),
    chartInstance: null,
    lastSpec: null,
    lastRows: [],
    lastCSV: '',
    lastFinding: '',
    lastCitations: [],
    lastVerification: null,
    isShared: false,
    activeRowIndex: -1,
    trace: [],
    files: {},
    startTimes: [],
    question: '',
  };

  tb.csvBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const blob = new Blob([tb.lastCSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chitti-data.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  tb.shareBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void shareTurn(tb);
  });

  tb.pinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPinPicker(tb, tb.pinBtn);
  });

  return tb;
}

// ── Status helpers ─────────────────────────────────────────────────────
// A successful run reads from the answer itself; the status line only
// carries in-flight and error states, so it hides on 'ok' instead of
// leaving a redundant "Done" chip above the finding.
export function setStatus(tb: TurnBlock, kind: 'loading' | 'ok' | 'error' | 'stopped', msg: string) {
  // 'ok' hides the line (success reads from the answer); every other kind —
  // including the neutral 'stopped' — keeps it visible. 'stopped' is styled
  // muted (not the red error dot): a user-cancel is not a failure.
  tb.statusRow.style.display = kind === 'ok' ? 'none' : 'flex';
  tb.statusDot.className = 'ch-status-dot ch-status-' + kind;
  tb.statusMsg.textContent = msg;
}

// The user's question, shown chat-style at the top of its turn.
export function renderQuestion(tb: TurnBlock, question: string) {
  tb.questionEl.textContent = question;
  tb.questionEl.style.display = 'block';
}
