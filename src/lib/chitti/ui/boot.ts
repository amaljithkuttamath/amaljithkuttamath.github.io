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
  import { resetNewQuestionChip, handleNewConvoClick, maybeDisarmOnClick, handleAskSubmit } from './composer';
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

  askForm.addEventListener('submit', handleAskSubmit);

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
