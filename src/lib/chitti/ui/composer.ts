// Composer flow: the "+ new question" two-step confirm (arm -> wipe) and the
// destructive thread reset. Extracted verbatim. Owns its private newQuestion*
// state; boot keeps the actual event-listener registrations (order unchanged)
// and points them at these handlers. unlockSources comes from config.ts.
import { run, allTurns, liveChartTurns, consoleEl, threadEl, newConvoBtn, composerQ,
         qIn, keyIn, byokSum, modelSel, askBtn, sourcesSearch, askForm } from './state';
import { unlockSources, openByok, selectedSources, updateSourcesCount, currentProvider,
         rlmEnabled, lockSources } from './config';
import { createSession } from '../agent';
import { parseFastPath, runFastPath, type FastPathResult } from '../fastpath';
import { rowsToCSV } from '../tools';
import { exportTurnTrace } from '../tracing';
import type { ProviderConfig } from '../providers';
import type { AgentOutput } from '../agent';
import { prefersReducedMotion } from './dom';
import { createTurnBlock, renderQuestion, setStatus } from './turns';
import { renderTrace, renderFiles } from './trace';
import { renderChart } from './charts';
import { renderTable, renderCitations, renderFinding, renderVerification, renderRunningTotal } from './evidence';
import { syncDashboardsAfterTurn } from './dashboards-view';
import { renderChartUnavailable } from './restore';

// ── "+ new question" (non-destructive two-step reset) ────────────────────
// The reset is genuinely destructive: it wipes the whole thread AND unlocks
// the source picker (the session's databases can only be changed by starting
// over). This thread model keeps every turn as full history — there is no
// collapsed-turn pattern to fold prior turns into — so rather than silently
// discarding history on one accidental tap, the chip ARMS a confirm: the
// first click turns it into "wipe N turns + start fresh?" for a few seconds;
// only a second click within that window actually resets. Any click
// elsewhere, or the timeout, disarms it. No window.confirm (kept inline).
let newQuestionArmed = false;
let newQuestionTimer: number | null = null;

export function resetNewQuestionChip() {
  newQuestionArmed = false;
  if (newQuestionTimer !== null) {
    clearTimeout(newQuestionTimer);
    newQuestionTimer = null;
  }
  newConvoBtn.textContent = '+ new question';
  newConvoBtn.classList.remove('ch-new-convo-armed');
}

export function performNewQuestion() {
  resetNewQuestionChip();
  run.session = null;
  // "Start fresh" means fresh: a pending escalation request from a wiped turn
  // must not silently skip the fast path when that question is asked again.
  escalateQuestion = null;
  unlockSources();
  // Dispose live charts before clearing the DOM so ECharts releases its
  // global registry entry and resize listener.
  for (const tb of liveChartTurns) {
    tb.chartInstance?.dispose();
    tb.chartInstance = null;
  }
  threadEl.innerHTML = '';
  allTurns.length = 0;
  liveChartTurns.length = 0;
  // Back to the empty state: the setup panel (chips + BYOK) returns; the
  // composer drops back to the first-question placeholder; the chip hides.
  consoleEl.style.display = '';
  newConvoBtn.style.display = 'none';
  composerQ.placeholder = 'Ask about the world…';
  composerQ.value = '';
  composerQ.focus();
}

export function handleNewConvoClick() {
  // Never-stuck: a mid-run click stops the current turn first, so the reset
  // proceeds against a settled session instead of racing an in-flight ask().
  if (run.running && run.runController) run.runController.abort();

  if (!newQuestionArmed) {
    const n = allTurns.length;
    newQuestionArmed = true;
    newConvoBtn.textContent = `wipe ${n} turn${n === 1 ? '' : 's'} + start fresh?`;
    newConvoBtn.classList.add('ch-new-convo-armed');
    // Auto-disarm so an armed chip never lingers into the next glance.
    newQuestionTimer = window.setTimeout(resetNewQuestionChip, 4000);
    return;
  }
  // Second, deliberate click within the window → actually reset.
  performNewQuestion();
}

export function maybeDisarmOnClick(e: MouseEvent) {
  if (
    newQuestionArmed &&
    e.target !== newConvoBtn &&
    !newConvoBtn.contains(e.target as Node)
  ) {
    resetNewQuestionChip();
  }
}

// ── The direct (no-model) answer ────────────────────────────────────────
// Set by the "run the full agent" escalation on a fast-path turn: the next
// submit of exactly this question skips the fast path and goes to the agent.
// Scoped to the question text so it can never silently disable the fast path
// for something else the user types afterwards.
let escalateQuestion: string | null = null;

// A hung source API must not leave the composer disabled with no way out, and
// the fast path's whole promise is that it is quick — so it gets a hard ceiling
// and falls through to the agent if it can't beat it.
const FAST_PATH_TIMEOUT_MS = 20_000;

// Render a completed fast-path answer as a turn. Deliberately reuses the same
// render functions a live agent turn uses, so the result is not a lesser view:
// same chart, same evidence table, same citation ledger, same CSV.
async function renderDirectAnswer(question: string, res: FastPathResult) {
  const tb = createTurnBlock();
  tb.question = question;
  renderQuestion(tb, question);
  allTurns.push(tb);
  liveChartTurns.push(tb);
  tb.panel.style.display = 'block';
  tb.railModelEl.textContent = 'no model · direct from source';
  renderFiles(tb, {});
  renderTrace(tb, res.trace);
  tb.canvasEl.classList.remove('ch-canvas-pending');
  // Same treatment as a restored answer: the chart is the one part of this view
  // that needs the network (ECharts is a CDN import), and losing it must not
  // leave a blank box or a stuck "rendering…" flag over an answer that is
  // otherwise complete.
  try {
    await renderChart(tb, res.spec);
  } catch (err) {
    console.error('chart render failed', err);
    renderChartUnavailable(tb, res.spec.title);
  }
  tb.renderFlag.style.display = 'none';
  tb.answerSection.style.display = 'block';
  tb.metaSection.style.display = 'block';
  // buildFastSummary returns '' when the rows describe no change (a single year
  // on a time series), rather than inventing a trend from one point. That is the
  // right call for the pure helper, but an empty answer line reads as a broken
  // render — so state plainly what was fetched instead.
  const countries = res.plan.countryNames.join(', ');
  renderFinding(
    tb,
    res.summary ||
      `${res.spec.y_axis || res.hit.name}: ${res.rows.length} value${res.rows.length === 1 ? '' : 's'} fetched for ${countries}.`
  );
  // Say plainly what this is. No verifier ran because no model ran — and that
  // is the selling point, not a caveat to bury: nothing in this path is capable
  // of inventing a number.
  tb.verifyEl.textContent = '';
  tb.verifyEl.className = 'ch-verify ch-verify-direct';
  tb.verifyEl.style.display = 'block';
  const tag = document.createElement('span');
  tag.className = 'ch-verify-tag';
  tag.textContent = 'answered directly from the source — no model ran, nothing generated';
  tb.verifyEl.appendChild(tag);
  renderTable(tb, res.rows, rowsToCSV(res.rows));
  renderCitations(tb, res.citations);
  tb.lastFinding = res.summary;
  tb.lastCitations = res.citations;
  tb.lastVerification = null;
  tb.shareBtn.style.display = '';
  tb.mdBtn.style.display = '';
  if (tb.lastSpec) tb.pinBtn.style.display = '';
  setStatus(tb, 'ok', 'Done · free · no key used');
  tb.panelDot.className = 'ch-panel-dot';
  tb.panelLabel.textContent = `${res.trace.length} steps · no model call`;

  // The escalation. A direct answer is literal — it reports the series and
  // stops — so anyone who wanted analysis needs one click to get the agent,
  // not a retyped question.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'ch-escalate';
  more.textContent = 'Want analysis? Run the full agent on this →';
  more.addEventListener('click', () => {
    escalateQuestion = question;
    qIn.value = question;
    // Resubmit in a FRESH task, not inline. Submitting inline runs
    // handleAskSubmit up to its first await; the microtask checkpoint after
    // this listener then resumes it, so `openByok(true)` from the key gate
    // lands BEFORE the click has finished bubbling — and the document-level
    // "close the sheet on an outside click" handler in boot.ts, which fires
    // last, immediately closed the sheet it had just opened. Escalating with
    // no key looked like a dead button. Deferring lets the click dispatch
    // finish (the sheet is still hidden, so that handler no-ops) before the
    // submit runs.
    setTimeout(() => askForm.requestSubmit(), 0);
  });
  tb.answerSection.appendChild(more);
  return tb;
}

// Try to answer without a model. Returns true when it did (the caller stops),
// false to fall through to the agent. Never throws: any failure is a fall-through.
async function tryDirectAnswer(question: string): Promise<boolean> {
  // The user asked for the agent on this exact question. NOT cleared here: if
  // the agent path then stops at the key gate, the flag must survive so that
  // pressing send again (now with a key) still reaches the agent instead of
  // silently serving the direct answer they just rejected. handleAskSubmit
  // clears it once the agent run actually commits.
  if (escalateQuestion === question) return false;

  // A conversation in progress belongs to the agent. The fast path never
  // creates or feeds a session, so answering mid-conversation would leave the
  // model blind to a turn the user can plainly see — and the next "add China to
  // that" would be answered from history that has a hole in it. Before any
  // session exists (the common case, including every key-less visit) this guard
  // is inert, because a direct answer never starts one.
  if (run.session) return false;

  // Honour the database hard filter. `resolveSources([])` treats an empty list
  // as "no filter" and searches everything, so an empty selection here would
  // silently query databases the user switched OFF. The agent path refuses to
  // run in that state; the fast path must refuse too, and fall through so the
  // user gets the same "pick a database" prompt.
  const sources = selectedSources();
  if (!sources.length) return false;

  const plan = parseFastPath(question);
  if (!plan) return false;
  run.running = true;
  askBtn.disabled = true;
  askBtn.classList.add('ch-send-working');
  try {
    // Belt and braces on the time ceiling: the signal covers the fetch, but the
    // catalog search can also reach the network (the live search APIs) and takes
    // no signal, so the whole attempt races a timer. Without this a hung search
    // would leave the composer disabled with no stop control and no way back.
    const res = await Promise.race([
      runFastPath(plan, {
        sources,
        signal: AbortSignal.timeout(FAST_PATH_TIMEOUT_MS),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fast path timed out')), FAST_PATH_TIMEOUT_MS)
      ),
    ]);
    // A miss is not a failure to report — it is exactly the case the agent is
    // better at, so say nothing and let it take over.
    if ('ok' in res) return false;
    qIn.value = '';
    consoleEl.style.display = 'none';
    resetNewQuestionChip();
    newConvoBtn.style.display = '';
    // "Another question", not "a follow-up": a direct answer starts no session,
    // so there is no conversation for the next question to build on. Promising
    // one would be a lie the very next turn.
    composerQ.placeholder = 'Ask another question — or + new question to start over…';
    const tb = await renderDirectAnswer(question, res);
    requestAnimationFrame(() =>
      tb.root.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
    );
    return true;
  } catch (err) {
    console.error('direct answer failed', err);
    return false;
  } finally {
    run.running = false;
    askBtn.disabled = false;
    askBtn.classList.remove('ch-send-working');
  }
}

// ── Run: the submit + stop flow (delegated to by the sticky composer) ──
export async function handleAskSubmit(e: SubmitEvent) {
  e.preventDefault();
  if (run.running) return;
  const question = qIn.value.trim() || (qIn.placeholder || '').trim();
  if (!question) return;

  // Before anything else — including the key gate. A question the deterministic
  // pipeline can answer costs no key, no model call and no money, so it must
  // never be held behind a credentials prompt.
  if (await tryDirectAnswer(question)) return;

  const apiKey = keyIn.value.trim();
  if (!apiKey) {
    openByok(true);
    byokSum.classList.remove('ch-byok-nudge');
    void byokSum.offsetWidth;
    byokSum.classList.add('ch-byok-nudge');
    keyIn.focus();
    return;
  }

  // Hard filter needs at least one database. Only enforced on the first ask,
  // when the session (and its source set) is created; later turns are locked.
  if (!run.session && selectedSources().length === 0) {
    openByok(true);
    updateSourcesCount();
    sourcesSearch?.focus();
    return;
  }

  const cfg: ProviderConfig = {
    provider: currentProvider(),
    model: modelSel.value,
    apiKey,
    requestReasoning: modelSel.selectedOptions[0]?.dataset.reasoning === '1',
  };

  // Past every gate — the agent run is committed, so an escalation request for
  // this question has been honoured and must not survive into a later turn.
  escalateQuestion = null;

  run.running = true;
  // Turn timing + terminal state for optional LangSmith tracing (fired in the
  // finally). Off unless PUBLIC_LANGSMITH_TRACING is set — see tracing.ts.
  const startedAt = Date.now();
  let turnOut: AgentOutput | undefined;
  let turnError: string | undefined;
  const controller = new AbortController();
  run.runController = controller;
  askBtn.disabled = true;
  askBtn.classList.add('ch-send-working');
  openByok(false);
  qIn.value = '';

  // Previous turns stay as full, readable history (chat style). Each turn
  // renders its own question line, chart, and answer, and its chart stays
  // live (re-themes/resizes via liveChartTurns). Nothing collapses.
  const tb = createTurnBlock();
  tb.question = question;
  renderQuestion(tb, question);
  allTurns.push(tb);
  liveChartTurns.push(tb);
  tb.canvasEl.classList.add('ch-canvas-pending');
  setStatus(tb, 'loading', 'Planning…');
  // Reveal + wire this turn's stop control. It aborts THIS run's controller;
  // ask() then resolves with an honest aborted output (handled below).
  tb.stopBtn.style.display = '';
  tb.stopBtn.disabled = false;
  tb.stopBtn.onclick = () => {
    controller.abort();
    tb.stopBtn.disabled = true;
    // Announce intent immediately through the polite status line; the final
    // "stopped by you — N receipts completed" lands when ask() resolves.
    setStatus(tb, 'stopped', 'Stopping…');
  };
  tb.panel.style.display = 'block';
  // The conversation has started: hide the setup panel (chips + BYOK) and
  // reveal the "+ new question" control. The bottom composer is always
  // present and is the sole input.
  consoleEl.style.display = 'none';
  resetNewQuestionChip();
  newConvoBtn.style.display = '';
  composerQ.placeholder = 'Ask a follow-up — or + new question for a fresh start…';
  // Bring the just-created turn up to the top of the scroll area so the
  // active exchange sits under the header and reads top-to-bottom down to
  // the pinned composer, instead of the answer landing far from the input.
  requestAnimationFrame(() =>
    tb.root.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  );
  renderFiles(tb, {});

  const modelLabel = modelSel.selectedOptions[0]?.textContent?.trim() || cfg.model;
  tb.railModelEl.textContent = `${modelLabel} / ${cfg.provider}`;

  try {
    // Bind the chosen databases to the session on first ask; the selection
    // is locked for the rest of the conversation. "+ new conversation" clears
    // `session` and unlocks the picker.
    if (!run.session) {
      run.session = createSession(cfg, { sources: selectedSources(), rlm: rlmEnabled() });
      lockSources();
    }
    const out = await run.session!.ask(question, {
      onTrace: (events) => renderTrace(tb, events),
      onFiles: (files) => renderFiles(tb, files),
      onChart: (spec) => { void renderChart(tb, spec); },
      onStatus: (msg, kind) => setStatus(tb, kind, msg),
      onModel: (served) => { tb.railModelEl.textContent = `${served} (fallback) / ${cfg.provider}`; },
    }, controller.signal);
    turnOut = out;

    // Honest stopped state (the user hit stop). NOT an error and NOT verified:
    // no VERIFIED stamp, neutral wording. Any rows/citations fetched before the
    // stop are real data with provenance — show them so the work isn't lost.
    // The session stays usable; the composer is re-enabled in `finally`.
    if (out.aborted) {
      if (out.chartSpec && !tb.chartInstance) await renderChart(tb, out.chartSpec);
      const completed = tb.trace.filter((ev) => ev.status === 'ok').length;
      if (out.rows.length) {
        tb.metaSection.style.display = 'block';
        renderTable(tb, out.rows, out.csv);
        renderCitations(tb, out.citations);
        tb.lastCitations = out.citations;
      }
      // A partial run that still rendered a chart can be pinned as-is.
      if (tb.lastSpec) tb.pinBtn.style.display = '';
      if (out.finding) {
        tb.answerSection.style.display = 'block';
        renderFinding(tb, out.finding);
      }
      renderRunningTotal(tb, tb.trace, out.cost);
      setStatus(
        tb,
        'stopped',
        `stopped by you — ${completed} receipt${completed === 1 ? '' : 's'} completed`
      );
      tb.panelDot.className = 'ch-panel-dot';
      tb.panelLabel.textContent = `stopped — ${completed} receipt${completed === 1 ? '' : 's'} completed`;
      return;
    }

    if (out.chartSpec && !tb.chartInstance) await renderChart(tb, out.chartSpec);

    tb.answerSection.style.display = 'block';
    tb.metaSection.style.display = 'block';

    if (out.kind === 'chart' && !out.chartSpec) {
      tb.findingEl.classList.add('ch-finding-empty');
      renderFinding(
        tb,
        out.finding || 'No chart could be built for this question — try rephrasing or narrowing it to a specific indicator.'
      );
      renderTable(tb, [], '');
      renderCitations(tb, []);
      renderRunningTotal(tb, tb.trace, out.cost);
      // Say what was tried before giving up (the executor's corrective nudge and
      // the free-model substitution both stream as receipts, so read them back).
      const nudged = tb.trace.some((ev) => ev.tool === 'nudge');
      const fellBack = tb.trace.some((ev) => ev.tool === 'fallback');
      const tried =
        nudged && fellBack
          ? ' (nudged the model, then tried a fallback model — still nothing)'
          : nudged
            ? ' (nudged the model — still nothing)'
            : out.retried
              ? ' (retried once, still nothing)'
              : '';
      setStatus(tb, 'error', 'No result' + tried);
      return;
    }

    if (out.kind === 'explanation') {
      // Open-ended answer: multi-paragraph prose, not a one-line headline.
      // pre-wrap (via the class) preserves the model's paragraph breaks,
      // and body sizing keeps a long answer readable.
      tb.findingEl.classList.add('ch-finding-prose');
      renderFinding(tb, out.finding || 'No explanation produced.');
      renderRunningTotal(tb, tb.trace, out.cost);
      setStatus(tb, 'ok', 'Done' + (out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : ' · free'));
      return;
    }

    renderFinding(tb, out.finding || 'No finding produced.');
    renderVerification(tb, out.verification);
    renderTable(tb, out.rows, out.csv);
    renderCitations(tb, out.citations);
    renderRunningTotal(tb, tb.trace, out.cost);

    // Snapshot the answer state for the share permalink, then reveal the
    // share action (it lives beside CSV in the raw-data disclosure).
    tb.lastFinding = out.finding || '';
    tb.lastCitations = out.citations;
    tb.lastVerification = out.verification;
    tb.shareBtn.style.display = '';
    tb.mdBtn.style.display = '';
    // A chart exists this turn ⇒ it can be pinned to a dashboard.
    if (tb.lastSpec) tb.pinBtn.style.display = '';

    const costTxt = out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : ' · free';
    setStatus(tb, 'ok', 'Done' + (out.retried ? ' (retried once)' : '') + costTxt);
    // No scroll here (or in the branches above): the submit-time scroll is
    // the only one. Auto-scrolling again when the answer lands was the
    // second half of the "chat keeps jumping" bug.
  } catch (err: any) {
    console.error(err);
    turnError = err?.message ?? String(err);
    setStatus(tb, 'error', 'Run failed: ' + (err?.message ?? String(err)));
    // The trace summary is only updated by trace events, so a failure
    // before/between events left it pulsing "Working…" forever.
    tb.panelDot.className = 'ch-panel-dot ch-panel-dot-error';
    tb.panelLabel.textContent = 'run failed — expand for details';
  } finally {
    // The single place the composer is re-enabled — EVERY terminal path
    // (success, error, aborted) lands here, so a run can never leave the app
    // stuck with a disabled input. The stop control is retired with the run.
    run.running = false;
    run.runController = null;
    tb.stopBtn.style.display = 'none';
    tb.stopBtn.onclick = null;
    askBtn.disabled = false;
    askBtn.classList.remove('ch-send-working');
    // Reflect any dashboard the turn touched (save_to_dashboard / edit_dashboard
    // both persist to the SAME localStorage the view reads). The nav count is
    // always cheap to recompute; if the dashboards view is open on a specific
    // dashboard, reload it fresh from storage and re-render so a conversational
    // edit (rename/remove/move/refresh) shows up immediately. This is the
    // cleanest hook: the view and the agent share storage, so a post-turn
    // reload is the single source-of-truth sync point — no event bus needed.
    syncDashboardsAfterTurn();

    // Optional LangSmith tracing — fire-and-forget, no-op unless enabled at
    // build time. Runs on EVERY terminal path (success, error, aborted) so a
    // failed turn is traced too. Never awaited: it must not delay re-enabling
    // the composer, and tracing.ts swallows its own errors.
    void exportTurnTrace({
      question: tb.question,
      trace: tb.trace,
      model: cfg.model,
      provider: cfg.provider,
      finding: turnOut?.finding,
      verification: turnOut?.verification ?? null,
      cost: turnOut?.cost,
      aborted: turnOut?.aborted,
      error: turnError,
      startedAt,
      endedAt: Date.now(),
    });
  }
}
