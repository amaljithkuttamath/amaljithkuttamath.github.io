  import { createSession, refreshDashboard, type ChittiSession, type TileRefreshResult } from '../agent';
  import {
    PROVIDERS,
    providerMeta,
    fetchModels,
    formatPricePerM,
    RECOMMENDED_OPENROUTER_MODELS,
    type ProviderId,
    type ProviderConfig,
    type ModelOption,
  } from '../providers';
  import type { TraceEvent, AgentOutput, InsightBrief, PlanStep } from '../agent';
  import { matchStepToEvent } from '../agent';
  import type { ChartSpec, DataRow, Citation } from '../tools';
  import { matchPointToRow, matchRowToPoint } from '../chart-link';
  import { rowsToCSV } from '../tools';
  import {
    encodeShareState,
    decodeShareState,
    type ShareStateV1,
  } from '../share';
  import { formatAxisValue, needsDataZoom, legendMode, titleSlug } from '../chart-format';
  import {
    createDashboard,
    addTile,
    removeTile,
    renameTile,
    renameDashboard,
    moveTile,
    replaceTile,
    makeTile,
    listDashboards,
    loadDashboard,
    saveDashboard,
    deleteDashboard,
    findDashboardByTitle,
    serializeDashboard,
    DashboardCapError,
    type Dashboard,
    type Tile,
    type StorageLike,
  } from '../dashboard';
  import {
    encodeDashShare,
    decodeDashShare,
    materializeSharedDashboard,
    parseImportedDashboard,
    prepareImportedDashboard,
    type DashShareV1,
    type DashShareTileV1,
  } from '../dashboard-share';
  import {
    chartAriaLabel,
    verificationCueText,
    verificationStampLabel,
    focusTrapTarget,
    FOCUSABLE_SELECTOR,
  } from '../a11y';
  import { $, q, formatTs, formatTokens, formatBytes, fileExt, cssVar, escapeHtml, prefersReducedMotion, esc, inlineMd, mdToHtml, fmtShareDate, fmtRange, fmtFetchedAt, fmtDate } from './dom';
  import { buildOption } from './chart-option';
  import { run, SESSION_KEY, SESSION_PROVIDER, providerSel, modelSel, modelPickList, modelPickSearch, modelPickCount, modelPickEmpty, keyIn, saveChk, keyLinks, providerNote, byokPanel, byokSum, byokState, byokCta, byokMore, byokSettings, consoleEl, askForm, qIn, chips, composerForm, composerQ, askBtn, newConvoBtn, threadEl, turnTemplate, sourcesBox, sourcesHint, sourcesCount, sourcesSearch, sourcesEmpty, sourceItems, rlmBox, rlmToggle, rlmHint, dashNavBtn, dashNavCount, pinDialog, pinBackdrop, pinCloseBtn, pinListEl, pinNewForm, pinNameInput, pinStatusEl, dashView, dashViewBack, dashViewTitle, dashViewBody, dashViewStatus, dashImportFile, INDICATOR_MAP, liveChartTurns, liveDashCharts, allTurns, dashStore } from './state';
  import type { TurnBlock } from './state';
  import { renderTrace, renderFiles } from './trace';
  import { createTurnBlock, setStatus, renderQuestion } from './turns';
  import { maybeRestoreFromFragment } from './restore';
  import { announceShare, buildShareUrl, shareTurn, writeClipboard, clipboardFallback } from './actions';
  import { renderChart, activateChartPoint, highlightPointForRow, downplayPointForRow } from './charts';
  import { renderTable, renderCitations, renderFinding, renderVerification, renderSharedVerification, renderRunningTotal } from './evidence';
  import {
    openPinPicker, updateDashNavCount, openDashboards, openDashboard, dashBack,
    renderDashList, renderDashDetail, renderSharedDashboard, importParsedDashboard,
    syncDashboardsAfterTurn, resetSharedDashState,
  } from './dashboards-view';
  import {
    setSettingsOpen, syncSheetToKeyboard, openByok, currentProvider, populateModels,
    onProviderChange, updateByokState, applyModelFilter, syncSession, selectedSources,
    setSource, updateSourcesCount, rlmEnabled, lockSources, unlockSources, sourcesLocked, vv,
  } from './config';
  import { resetNewQuestionChip, handleNewConvoClick, maybeDisarmOnClick } from './composer';
  import { installDebugSeam } from './debug-seam';


  byokMore.addEventListener('click', () => setSettingsOpen(byokSettings.hidden));

  if (vv) {
    vv.addEventListener('resize', syncSheetToKeyboard);
    vv.addEventListener('scroll', syncSheetToKeyboard);
  }

  byokSum.addEventListener('click', () => openByok(byokPanel.hidden));
  // Explicit close paths that work everywhere, including iOS where
  // document-level click delegation from page areas is unreliable.
  $('ch-byok-close').addEventListener('click', () => openByok(false));
  $('ch-byok-backdrop').addEventListener('click', () => openByok(false));
  // Close on outside click / Escape, like a popover.
  document.addEventListener('click', (e) => {
    if (byokPanel.hidden) return;
    const bar = $('ch-inputbar');
    if (bar && !bar.contains(e.target as Node)) openByok(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !byokPanel.hidden) openByok(false);
  });
  // Focus trap: while the sheet is open, Tab cycles within it. The pure
  // focusTrapTarget() decides when to wrap (at an edge) vs. let the browser
  // handle a natural in-bounds Tab; querying focusables at each keystroke keeps
  // the collapsed model/database disclosure (hidden ⇒ not focusable) correct.
  byokPanel.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || byokPanel.hidden) return;
    const items = Array.from(
      byokPanel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    const target = focusTrapTarget(idx, items.length, e.shiftKey);
    if (target !== null) {
      e.preventDefault();
      items[target]?.focus();
    }
  });



  // ── Turn blocks ──────────────────────────────────────────────────────
  // Every render function and its mutable state used to be a module-level
  // singleton (one trace, one chart, one table for the whole page). To
  // support a multi-turn thread, all of that becomes per-turn: each call to
  // createTurnBlock() clones the turn template, appends it to the thread,
  // and hands back a TurnBlock scoping every element and every piece of
  // mutable state (chart instance, last spec, rows, csv, trace, files,
  // start times) to that one turn.





  // ── Provider / model dropdown wiring ───────────────────────────────────


  // The visible model picker: a searchable, scrollable list mirroring the
  // database picker. Each row shows the model's human name, a free badge, its
  // context length, and prompt/completion pricing per 1M tokens — everything a
  // user needs to actually choose, instead of a truncated slug. Clicking a row
  // just sets the hidden <select> (so requestReasoning and every other reader
  // keep working) and refreshes the chip.

  modelPickSearch?.addEventListener('input', applyModelFilter);





  providerSel.addEventListener('change', onProviderChange);
  modelSel.addEventListener('change', updateByokState);
  keyIn.addEventListener('input', updateByokState);

  // When the user enters a key for OpenAI/Anthropic, refresh the model list.
  // Debounced so we don't hit the API on every keystroke.
  let keyDebounce: number | null = null;
  keyIn.addEventListener('input', () => {
    const pid = currentProvider();
    if (pid === 'openrouter') return; // OpenRouter is already loaded (public endpoint)
    if (keyDebounce) window.clearTimeout(keyDebounce);
    keyDebounce = window.setTimeout(() => {
      // Only refresh once the key looks plausibly complete.
      if (keyIn.value.trim().length >= 20) {
        void populateModels(pid, modelSel.value);
      }
    }, 800);
  });

  // Restore a session-saved key if the user opted in previously this session.
  (function restoreSession() {
    const savedKey = sessionStorage.getItem(SESSION_KEY);
    const savedProvider = sessionStorage.getItem(SESSION_PROVIDER) as ProviderId | null;
    if (savedProvider && PROVIDERS.some((p) => p.id === savedProvider)) {
      providerSel.value = savedProvider;
    }
    if (savedKey) {
      keyIn.value = savedKey;
      saveChk.checked = true;
    }
    // Fires the dynamic model fetch with the key already present, so the
    // dropdown lands with real slugs on first paint.
    onProviderChange();
    updateByokState();
  })();

  saveChk.addEventListener('change', syncSession);
  keyIn.addEventListener('input', () => { if (saveChk.checked) syncSession(); });

  // ── Preset chips ───────────────────────────────────────────────────────
  chips.querySelectorAll<HTMLButtonElement>('.ch-chip').forEach((b) => {
    b.addEventListener('click', () => {
      // A suggestion chip submits immediately (like a Codex/ChatGPT prompt
      // starter). Route through qIn (the submit handler's source of truth) and
      // fire the same ask form the composer delegates to.
      qIn.value = b.dataset.q || '';
      askForm.requestSubmit();
    });
  });

  // ── Database picker ─────────────────────────────────────────────────────


  sourceItems.forEach((b) => {
    b.addEventListener('click', () => {
      if (sourcesLocked) return;
      setSource(b, !b.classList.contains('is-on'));
      updateSourcesCount();
    });
  });
  $('ch-sources-all')?.addEventListener('click', () => {
    if (sourcesLocked) return;
    sourceItems.forEach((b) => setSource(b, true));
    updateSourcesCount();
  });
  $('ch-sources-none')?.addEventListener('click', () => {
    if (sourcesLocked) return;
    sourceItems.forEach((b) => setSource(b, false));
    updateSourcesCount();
  });
  // Live filter: hide non-matching rows and any category group left empty.
  sourcesSearch?.addEventListener('input', () => {
    const q = sourcesSearch.value.trim().toLowerCase();
    sourceItems.forEach((b) => { b.hidden = !!q && !(b.dataset.search || '').includes(q); });
    let anyVisible = false;
    document.querySelectorAll<HTMLElement>('.ch-source-group').forEach((g) => {
      const vis = Array.from(g.querySelectorAll<HTMLElement>('.ch-source-item')).some((it) => !it.hidden);
      g.hidden = !vis;
      if (vis) anyVisible = true;
    });
    if (sourcesEmpty) sourcesEmpty.hidden = anyVisible;
  });


  // ── Trace rendering: a live timeline of the agent's tool calls ────────
  // Receipt-style: a real per-line timestamp (captured once, at the moment
  // the event first arrived), a strike-through+fade once a step resolves
  // ('ch-trace-ok'), an amber glow on whichever single step is in flight
  // ('ch-trace-running'), and — only for the verify step, only on a pass —
  // an ink-stamped VERIFIED badge.
  //
  // startTimes and the latest trace/files snapshot used to be module-level
  // singletons; they now live on the TurnBlock passed in (tb.startTimes,
  // tb.trace, tb.files) so each turn keeps its own.




  // The plan card (backlog #10): the turn's committed insight brief, rendered
  // at the top of the trace. The insight sits in Newsreader italic; the steps
  // are a mono checklist checked off against the turn's later tool events via
  // the shared matchStepToEvent matcher. State is honest, never faked:
  //   • matched by ≥1 event         → checked (done).
  //   • unmatched, run still going   → pending (open box).
  //   • unmatched, run ended         → "not needed" (neutral strike, NOT a check).
  // If the model ran data tools that fit no step, a single muted "off-plan" line
  // appears once — deviation shown honestly, not hidden. Plan token cost shows
  // on the card like every other receipt.


  // Every turn block created so far, regardless of whether it has a chart.



  // ── Shared-answer banner + restore (backlog #15) ─────────────────────────
  void maybeRestoreFromFragment();



  dashNavBtn.addEventListener('click', () => openDashboards());
  dashViewBack.addEventListener('click', () => dashBack());
  dashView.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); dashBack(); return; }
    if (e.key !== 'Tab') return;
    // Trap focus within the overlay while it is open.
    const items = Array.from(dashView.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.getClientRects().length > 0 || el === document.activeElement
    );
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const target = focusTrapTarget(idx, items.length, e.shiftKey);
    if (target !== null) {
      e.preventDefault();
      items[target]?.focus();
    }
  });

  updateDashNavCount();


  // ── Run ────────────────────────────────────────────────────────────────

  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (run.running) return;
    const question = qIn.value.trim() || (qIn.placeholder || '').trim();
    if (!question) return;

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

    run.running = true;
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
        setStatus(tb, 'error', 'No result' + (out.retried ? ' (retried once, still nothing)' : ''));
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
      // A chart exists this turn ⇒ it can be pinned to a dashboard.
      if (tb.lastSpec) tb.pinBtn.style.display = '';

      const costTxt = out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : ' · free';
      setStatus(tb, 'ok', 'Done' + (out.retried ? ' (retried once)' : '') + costTxt);
      // No scroll here (or in the branches above): the submit-time scroll is
      // the only one. Auto-scrolling again when the answer lands was the
      // second half of the "chat keeps jumping" bug.
    } catch (err: any) {
      console.error(err);
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
    }
  });

  // The sticky composer delegates to the same submit handler above instead
  // of duplicating the question-reading logic: it copies its value into the
  // original top-console textarea (qIn), which stays the actual source of
  // truth the handler reads from, then re-submits the original form.
  composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    qIn.value = composerQ.value;
    composerQ.value = '';
    askForm.requestSubmit();
  });

  // Enter sends, Shift+Enter inserts a newline (chat convention).
  // isComposing guards IME input (e.g. Japanese) where Enter commits the
  // composition, not the message.
  composerQ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composerForm.requestSubmit();
    }
  });

  newConvoBtn.addEventListener('click', handleNewConvoClick);

  // A click anywhere other than the chip disarms the confirm, so the second
  // (destructive) click has to be a deliberate one on the chip itself.
  document.addEventListener('click', maybeDisarmOnClick);

  installDebugSeam();
