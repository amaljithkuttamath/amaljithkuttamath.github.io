// Trace rendering: the receipt log, plan card, verify stamp, nested llm()
// receipt cards, and inline write_file file rows. Extracted verbatim from the
// UI monolith. Reads only its TraceEvent args + the TurnBlock passed in; no
// agent calls, no shared mutable state beyond the turn it is handed.
import type { TurnBlock } from './state';
import type { TraceEvent, InsightBrief, PlanStep } from '../agent';
import { matchStepToEvent } from '../agent';
import { verificationStampLabel } from '../a11y';
import { fileExt, formatTokens, formatTs } from './dom';

export const PLAN_OFF_PLAN_TOOLS = new Set([
  'find_series', 'fetch_series', 'fetch_worldbank', 'fetch_worldbank_all',
  'fetch_owid', 'fetch_imf', 'execute_js', 'growth_stats', 'correlate', 'delegate_source',
]);
export function buildPlanCard(plan: InsightBrief, events: TraceEvent[], tokens?: number): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ch-plan';

  // Header: a small "plan" label + the plan's token cost, receipt-style.
  const header = document.createElement('div');
  header.className = 'ch-plan-header';
  const label = document.createElement('span');
  label.className = 'ch-plan-label';
  label.textContent = 'plan';
  header.appendChild(label);
  if (typeof tokens === 'number' && tokens > 0) {
    const tok = document.createElement('span');
    tok.className = 'ch-plan-tokens';
    tok.textContent = formatTokens(tokens);
    header.appendChild(tok);
  }
  card.appendChild(header);

  // The insight line — the story this turn set out to surface.
  const insight = document.createElement('p');
  insight.className = 'ch-plan-insight';
  insight.textContent = plan.insight;
  card.appendChild(insight);

  // Only tool events (not the plan itself, reasoning, verify, etc.) can match.
  const toolEvents = events.filter(
    (ev) => ev.tool && ev.tool !== 'plan' && ev.tool !== 'reasoning'
  );
  // The run has ended once a terminal step is present — after that, an
  // unmatched step reads as "not needed", not still-pending.
  const runEnded = toolEvents.some(
    (ev) => ev.tool === 'verify' || ev.tool === 'finish' || ev.tool === 'finish_explanation'
  );

  const list = document.createElement('ul');
  list.className = 'ch-plan-steps';
  const matchedEventIdx = new Set<number>();
  (plan.steps || []).forEach((step: PlanStep) => {
    let matched = false;
    toolEvents.forEach((ev, idx) => {
      if (matchStepToEvent(step, ev)) {
        matched = true;
        matchedEventIdx.add(idx);
      }
    });
    const li = document.createElement('li');
    const state = matched ? 'done' : runEnded ? 'skipped' : 'pending';
    li.className = 'ch-plan-step ch-plan-step-' + state;
    const box = document.createElement('span');
    box.className = 'ch-plan-box';
    // ✓ done · ○ pending · – not-needed. role/aria speaks the state in words.
    box.textContent = matched ? '✓' : runEnded ? '–' : '○';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', matched ? 'done' : runEnded ? 'not needed' : 'pending');
    li.appendChild(box);
    const what = document.createElement('span');
    what.className = 'ch-plan-what';
    what.textContent = step.what;
    li.appendChild(what);
    if (step.tool_hint) {
      const hint = document.createElement('span');
      hint.className = 'ch-plan-hint';
      hint.textContent = step.tool_hint;
      li.appendChild(hint);
    }
    list.appendChild(li);
  });
  card.appendChild(list);

  // Off-plan: a data tool ran that matched no step. Surface it ONCE, muted —
  // an honest "the model deviated" note, never a fake check on the checklist.
  const offPlan = toolEvents.some(
    (ev, idx) => !matchedEventIdx.has(idx) && ev.tool && PLAN_OFF_PLAN_TOOLS.has(ev.tool)
  );
  if (offPlan) {
    const off = document.createElement('div');
    off.className = 'ch-plan-off';
    off.textContent = 'off-plan: ran a step the plan did not call for';
    card.appendChild(off);
  }
  return card;
}

// The could-not-verify receipt: a compact, honest verdict block for a verify
// step that ran but did NOT confirm the answer. Shows the verdict, the
// verifier's self-confidence, and the issue count, then the concrete doubts
// in an expandable <details> (the same receipt-detail motif used elsewhere in
// the trace). Muted throughout — never amber.
export function buildVerifyReceipt(e: TraceEvent): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ch-verify-receipt';
  const verdict = document.createElement('div');
  verdict.className = 'ch-verify-verdict';
  verdict.textContent = 'could not verify';
  wrap.appendChild(verdict);
  const meta = document.createElement('div');
  meta.className = 'ch-trace-detail';
  const conf = e.confidence && e.confidence !== 'none' ? 'confidence: ' + e.confidence : 'confidence: unknown';
  const n = (e.issues && e.issues.length) || 0;
  meta.textContent = conf + ' · ' + n + (n === 1 ? ' issue' : ' issues');
  wrap.appendChild(meta);
  if (e.issues && e.issues.length) {
    const det = document.createElement('details');
    det.className = 'ch-verify-issues';
    const sum = document.createElement('summary');
    sum.textContent = 'what was doubted';
    det.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'ch-verify-issue-list';
    for (const iss of e.issues) {
      const li = document.createElement('li');
      li.textContent = iss;
      ul.appendChild(li);
    }
    det.appendChild(ul);
    wrap.appendChild(det);
  }
  return wrap;
}

// The search-receipt card: find_series streams as a visible receipt of the
// scorer's work — how many databases were searched, how many candidates were
// weighed, the top match with its source, and which query terms/synonyms
// actually fired for it. Built as DOM (not template) so it lives in the
// JS-rendered trace; its styles are :global() for the same reason.
export function buildReceiptCard(r: NonNullable<TraceEvent['receipt']>): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ch-receipt';

  // Stat line: N databases → K candidates → top match.
  const stats = document.createElement('div');
  stats.className = 'ch-receipt-stats';
  const nDb = r.sourcesSearched.length;
  const addStat = (n: number, label: string) => {
    const wrap = document.createElement('span');
    wrap.className = 'ch-receipt-stat';
    const num = document.createElement('span');
    num.className = 'ch-receipt-num';
    num.textContent = String(n);
    wrap.appendChild(num);
    wrap.appendChild(document.createTextNode(' ' + label));
    stats.appendChild(wrap);
  };
  const arrow = () => {
    const a = document.createElement('span');
    a.className = 'ch-receipt-arrow';
    a.textContent = '→';
    stats.appendChild(a);
  };
  addStat(nDb, nDb === 1 ? 'database' : 'databases');
  arrow();
  addStat(r.candidateCount, r.candidateCount === 1 ? 'candidate' : 'candidates');
  if (r.topMatch) {
    arrow();
    const tm = document.createElement('span');
    tm.className = 'ch-receipt-toplabel';
    tm.textContent = 'top match';
    stats.appendChild(tm);
  }
  card.appendChild(stats);

  if (r.topMatch) {
    // The match itself: indicator name (Newsreader italic) + source tag.
    const match = document.createElement('div');
    match.className = 'ch-receipt-match';
    const name = document.createElement('span');
    name.className = 'ch-receipt-name';
    name.textContent = r.topMatch.name;
    match.appendChild(name);
    const src = document.createElement('span');
    src.className = 'ch-receipt-source';
    src.textContent = r.topMatch.sourceLabel;
    match.appendChild(src);
    card.appendChild(match);

    // Which terms/synonyms fired. Synonym expansions read "gdp → economy"
    // with the expansion in amber; plain base-term hits are chips.
    const base = r.topMatch.matchedBase;
    const syns = r.topMatch.matchedSynonyms;
    if (base.length || syns.length) {
      const terms = document.createElement('div');
      terms.className = 'ch-receipt-terms';
      const lead = document.createElement('span');
      lead.className = 'ch-receipt-lead';
      lead.textContent = 'matched';
      terms.appendChild(lead);
      for (const t of base) {
        const chip = document.createElement('code');
        chip.className = 'ch-receipt-term';
        chip.textContent = t;
        terms.appendChild(chip);
      }
      for (const s of syns) {
        const exp = document.createElement('span');
        exp.className = 'ch-receipt-syn';
        const from = document.createElement('code');
        from.className = 'ch-receipt-term';
        from.textContent = s.term;
        const via = document.createElement('code');
        via.className = 'ch-receipt-term ch-receipt-term-syn';
        via.textContent = s.synonym;
        exp.appendChild(from);
        exp.appendChild(document.createTextNode(' → '));
        exp.appendChild(via);
        terms.appendChild(exp);
      }
      card.appendChild(terms);
    }
  }
  return card;
}

// Keep the collapsed <details> summary honest: while a step is in flight it
// names that step; once the run settles it becomes a terse step count. The
// token/cost totals land separately via renderRunningTotal().
export function updatePanelSummary(tb: TurnBlock, events: TraceEvent[]) {
  const steps = events.filter((e) => e.tool !== 'reasoning');
  const runningEv = steps.find((e) => e.status === 'running');
  const hasError = steps.some((e) => e.status === 'error');
  if (!steps.length) {
    // Run just started, nothing traced yet.
    tb.panelLabel.textContent = 'Working…';
    tb.panelDot.className = 'ch-panel-dot ch-panel-dot-running';
  } else if (runningEv) {
    tb.panelLabel.textContent = runningEv.tool + '…';
    tb.panelDot.className = 'ch-panel-dot ch-panel-dot-running';
  } else {
    tb.panelLabel.textContent =
      'How it got this · ' + steps.length + (steps.length === 1 ? ' step' : ' steps');
    tb.panelDot.className = 'ch-panel-dot' + (hasError ? ' ch-panel-dot-error' : ' ch-panel-dot-ok');
  }
}

export function renderTrace(tb: TurnBlock, events: TraceEvent[]) {
  tb.panel.style.display = 'block';
  updatePanelSummary(tb, events);
  tb.trace = events;
  const stick =
    tb.traceEl.scrollHeight - tb.traceEl.scrollTop - tb.traceEl.clientHeight < 40;
  // Preserve open/closed state of any inline-expanded file across re-renders
  // (renderTrace re-runs on every trace AND every file event).
  const openPaths = new Set(
    Array.from(tb.traceEl.querySelectorAll<HTMLDetailsElement>('details[open]')).map(
      (d) => d.dataset.path || ''
    )
  );
  tb.traceEl.innerHTML = '';
  // Index of the LAST verify event: a failing verify that is followed by
  // another verify is a pre-retry attempt ("not verified — retrying"); only
  // the final verify event renders the full could-not-verify / unavailable
  // treatment, so the receipt reflects the turn's actual outcome.
  let lastVerifyIdx = -1;
  events.forEach((e, idx) => { if (e.tool === 'verify') lastVerifyIdx = idx; });
  events.forEach((e, i) => {
    if (tb.startTimes[i] === undefined) tb.startTimes[i] = performance.now();

    // Reasoning is a synthetic, already-settled event (see agent.ts) — not
    // a tool call, so no dot/glow/duration/token treatment implying one,
    // and no label or toggle calling it out as a distinct internal
    // artifact. It just reads as the agent's own words, in place, like the
    // rest of the terse narration — a clamped line count keeps a long
    // thinking block from dominating the trace.
    if (e.tool === 'reasoning') {
      const rrow = document.createElement('p');
      rrow.className = 'ch-trace-thinking';
      rrow.textContent = e.detail || '';
      tb.traceEl.appendChild(rrow);
      return;
    }

    // The insight brief (backlog #10) renders as a plan card at the TOP of the
    // trace — the insight line in Newsreader italic, the steps as a mono
    // checklist that checks off against later tool events. Not a tool row: no
    // dot/glow/duration column implying one.
    if (e.tool === 'plan' && e.plan) {
      tb.traceEl.appendChild(buildPlanCard(e.plan, events, e.tokens));
      return;
    }
    // A gated plan whose brief was unusable (parse failed or the planning call
    // errored) renders a muted one-line receipt in place of the card — so the
    // missing plan is explained, never silent. Not a tool row: no dot/glow.
    if (e.tool === 'plan' && !e.plan) {
      const skip = document.createElement('p');
      skip.className = 'ch-plan-skipped';
      skip.textContent = e.detail || 'plan skipped';
      tb.traceEl.appendChild(skip);
      return;
    }

    const row = document.createElement('div');
    // A recursive llm() step renders as an indented child line-item under the
    // execute_js step that spawned it, so the RLM recursion is visible.
    row.className =
      'ch-trace-row ch-trace-' + e.status + (e.nested ? ' ch-trace-nested' : '');
    const dot = document.createElement('span');
    dot.className = 'ch-trace-dot';
    const body = document.createElement('div');
    body.className = 'ch-trace-body';
    // Head: timestamp, then tool_name · arg_summary on one line.
    const head = document.createElement('div');
    head.className = 'ch-trace-head';
    const stamp = document.createElement('span');
    stamp.className = 'ch-trace-ts';
    stamp.textContent = formatTs(e.ts);
    head.appendChild(stamp);
    const name = document.createElement('span');
    name.className = 'ch-trace-name';
    name.textContent = e.tool;
    head.appendChild(name);
    // A write_file/read_file row whose path matches a real VFS entry
    // becomes expandable in place — no separate "workspace" list
    // duplicating the same content elsewhere on the page.
    const filePath = (e.tool === 'write_file' || e.tool === 'read_file') ? e.argSummary : '';
    const fileContent = filePath ? tb.files[filePath] : undefined;
    if (e.argSummary && fileContent === undefined) {
      const sep = document.createElement('span');
      sep.className = 'ch-trace-sep';
      sep.textContent = '·';
      head.appendChild(sep);
      const arg = document.createElement('span');
      arg.className = 'ch-trace-arg';
      arg.textContent = e.argSummary;
      head.appendChild(arg);
      body.appendChild(head);
    } else if (fileContent !== undefined) {
      const det = document.createElement('details');
      det.className = 'ch-trace-file';
      det.dataset.path = filePath;
      if (openPaths.has(filePath)) det.open = true;
      const sum = document.createElement('summary');
      sum.appendChild(head);
      const sep = document.createElement('span');
      sep.className = 'ch-trace-sep';
      sep.textContent = '·';
      head.appendChild(sep);
      const arg = document.createElement('span');
      arg.className = 'ch-trace-arg';
      arg.textContent = filePath;
      head.appendChild(arg);
      const ext = document.createElement('span');
      ext.className = 'ch-file-ext ch-file-ext-' + fileExt(filePath);
      ext.textContent = fileExt(filePath);
      sum.appendChild(ext);
      const pre = document.createElement('pre');
      pre.className = 'ch-file-body';
      pre.textContent = fileContent;
      det.appendChild(sum);
      det.appendChild(pre);
      body.appendChild(det);
    } else {
      body.appendChild(head);
    }
    // find_series carries a structured receipt — render the dedicated
    // search-receipt card instead of the plain "N hits" detail line.
    if (e.tool === 'find_series' && e.receipt) {
      body.appendChild(buildReceiptCard(e.receipt));
    } else if (e.detail && e.tool !== 'verify') {
      const d = document.createElement('div');
      d.className = 'ch-trace-detail';
      d.textContent = e.detail;
      body.appendChild(d);
    }
    // Provenance: a write_file whose content came from llm() is model-derived,
    // never fetched data — labelled here so it can never be read as measured.
    if (e.derived) {
      const prov = document.createElement('span');
      prov.className = 'ch-trace-derived';
      prov.textContent = 'model-derived';
      body.appendChild(prov);
    }
    // The verify receipt renders one of the three honest outcomes. The
    // ink-stamped amber VERIFIED badge appears ONLY on a genuine pass; the
    // other states are muted and never borrow amber.
    if (e.tool === 'verify') {
      const isLast = i === lastVerifyIdx;
      if (e.pass === true) {
        const stampEl = document.createElement('span');
        stampEl.className = 'ch-stamp';
        stampEl.textContent = 'verified';
        // The rubber-stamp styling carries the "passed a check" meaning
        // visually; role="img" + aria-label speak it in plain words.
        stampEl.setAttribute('role', 'img');
        stampEl.setAttribute('aria-label', verificationStampLabel());
        body.appendChild(stampEl);
        if (e.confidence && e.confidence !== 'none') {
          const c = document.createElement('div');
          c.className = 'ch-trace-detail';
          c.textContent = 'confidence: ' + e.confidence;
          body.appendChild(c);
        }
      } else if (!isLast) {
        // A failing verify with another verify still to come = a retry follows.
        const note = document.createElement('div');
        note.className = 'ch-trace-detail';
        note.textContent = 'not verified — retrying';
        body.appendChild(note);
      } else if (e.verifyStatus === 'unavailable') {
        const note = document.createElement('div');
        note.className = 'ch-trace-detail ch-trace-unavailable';
        note.textContent = 'verification unavailable — provider error';
        body.appendChild(note);
      } else {
        // Final could-not-verify: verdict + confidence + issue count, with the
        // concrete doubts in an expandable detail (reusing the trace's
        // details/summary receipt pattern).
        body.appendChild(buildVerifyReceipt(e));
      }
    }
    const metaCol = document.createElement('div');
    metaCol.className = 'ch-trace-meta-col';
    const meta = document.createElement('span');
    meta.className = 'ch-trace-meta';
    if (e.status === 'ok') {
      // Prefer a measured duration when the event carries one (llm() steps do,
      // so a staged/offline render still shows a real time); otherwise fall
      // back to this render's own timer.
      const ms =
        typeof e.durationMs === 'number'
          ? e.durationMs
          : Math.round(performance.now() - tb.startTimes[i]);
      meta.textContent = ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
    } else if (e.status === 'error') {
      meta.textContent = 'error';
    } else {
      meta.textContent = '…';
    }
    metaCol.appendChild(meta);
    // Per-step token count, right-aligned, receipt-style. Omitted entirely
    // (not shown as 0) when this step has no attributable LLM usage.
    if (typeof e.tokens === 'number' && e.tokens > 0) {
      const tok = document.createElement('span');
      tok.className = 'ch-trace-tokens';
      tok.textContent = formatTokens(e.tokens);
      metaCol.appendChild(tok);
    }
    row.appendChild(dot);
    row.appendChild(body);
    row.appendChild(metaCol);
    tb.traceEl.appendChild(row);
  });
  if (stick) tb.traceEl.scrollTop = tb.traceEl.scrollHeight;
}

// ── Virtual-FS rendering ───────────────────────────────────────────────

// No separate "workspace" list — a write_file trace row inline-expands its
// own content (see renderTrace) instead of duplicating the same file in a
// second section below the trace. This just keeps the latest VFS snapshot
// around for renderTrace to read from, and re-renders the trace so a file
// written moments after its trace row appeared becomes expandable.
export function renderFiles(tb: TurnBlock, files: Record<string, string>) {
  tb.panel.style.display = 'block';
  tb.files = files;
  renderTrace(tb, tb.trace);
}
