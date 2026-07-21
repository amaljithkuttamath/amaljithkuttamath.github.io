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
  import { announceShare, buildShareUrl, shareTurn, writeClipboard, clipboardFallback } from './actions';
  import { renderChart, activateChartPoint, highlightPointForRow, downplayPointForRow } from './charts';
  import { renderTable, renderCitations, renderFinding, renderVerification, renderSharedVerification, renderRunningTotal } from './evidence';
  import {
    openPinPicker, updateDashNavCount, openDashboards, openDashboard, dashBack,
    renderDashList, renderDashDetail, renderSharedDashboard, importParsedDashboard,
    syncDashboardsAfterTurn, resetSharedDashState,
  } from './dashboards-view';


  // Model + databases live behind a disclosure so the sheet is short on mobile
  // (the keyboard-vs-key-field problem). Key-first: collapsed until there's a
  // key, then auto-revealed; the toggle overrides either way.
  function setSettingsOpen(open: boolean) {
    byokSettings.hidden = !open;
    byokMore.setAttribute('aria-expanded', String(open));
  }
  byokMore.addEventListener('click', () => setSettingsOpen(byokSettings.hidden));

  // Keep the fixed bottom sheet above the on-screen keyboard: visualViewport
  // shrinks when the keyboard opens, and `--kb` lifts the sheet by that much so
  // the focused field (the key, at the top) is never covered. No-op on desktop.
  const vv = window.visualViewport;
  function syncSheetToKeyboard() {
    if (!vv || byokPanel.hidden) {
      byokPanel.style.removeProperty('--kb');
      return;
    }
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    byokPanel.style.setProperty('--kb', kb + 'px');
  }
  if (vv) {
    vv.addEventListener('resize', syncSheetToKeyboard);
    vv.addEventListener('scroll', syncSheetToKeyboard);
  }

  // The config panel is a plain div toggled open/closed (not <details>, so the
  // trigger button can live inside the composer form). openByok(true/false)
  // is the single entry point; the chip button and outside-click drive it.
  // The sheet is a modal dialog: opening moves focus into it and closing
  // returns focus to the chip that opened it, so a keyboard user never loses
  // their place. Focus is only pulled back to the trigger when it was still
  // inside the sheet at close time (an explicit close), never when a run has
  // already moved focus elsewhere.
  function openByok(open: boolean) {
    const wasOpen = !byokPanel.hidden;
    byokPanel.hidden = !open;
    $('ch-byok-backdrop').hidden = !open;
    byokSum.setAttribute('aria-expanded', String(open));
    if (open) {
      setSettingsOpen(!!keyIn.value.trim()); // key-first: reveal only once connected
      // Move focus into the dialog so its label is announced and Tab is
      // trapped. The container is focusable (tabindex=-1) but not a tab stop.
      if (!wasOpen) requestAnimationFrame(() => byokPanel.focus());
    } else if (wasOpen && byokPanel.contains(document.activeElement)) {
      byokSum.focus();
    }
    syncSheetToKeyboard();
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


  function createTurnBlock(): TurnBlock {
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



  // ── Provider / model dropdown wiring ───────────────────────────────────
  function currentProvider(): ProviderId {
    return providerSel.value as ProviderId;
  }

  // Renders a list of {id,label,free} options into the model <select>.
  // OpenRouter's catalog is large enough that a flat alphabetical list
  // buries the models actually verified to work well on this app's own
  // tool-calling pipeline — split into a "Recommended" optgroup (from
  // RECOMMENDED_OPENROUTER_MODELS) plus everything else, rather than a
  // single "· recommended" suffix a user could easily scroll past.
  function renderModelOptions(models: ModelOption[], selected?: string, defaultModel?: string, pid?: ProviderId) {
    modelSel.innerHTML = '';
    const buildOpt = (m: ModelOption) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.free) opt.classList.add('ch-free-opt');
      if (m.reasoning) opt.dataset.reasoning = '1';
      return opt;
    };
    if (pid === 'openrouter') {
      const recommended = models.filter((m) => RECOMMENDED_OPENROUTER_MODELS.has(m.id));
      const rest = models.filter((m) => !RECOMMENDED_OPENROUTER_MODELS.has(m.id));
      if (recommended.length) {
        const group = document.createElement('optgroup');
        group.label = 'Recommended — reliable on this app\'s tool-calling pipeline';
        for (const m of recommended) group.appendChild(buildOpt(m));
        modelSel.appendChild(group);
      }
      if (rest.length) {
        const group = document.createElement('optgroup');
        group.label = recommended.length ? 'All models' : 'Models';
        for (const m of rest) group.appendChild(buildOpt(m));
        modelSel.appendChild(group);
      }
    } else {
      for (const m of models) modelSel.appendChild(buildOpt(m));
    }
    if (selected && models.some((m) => m.id === selected)) {
      modelSel.value = selected;
    } else if (defaultModel && models.some((m) => m.id === defaultModel)) {
      modelSel.value = defaultModel;
    } else if (models.length) {
      modelSel.value = models[0].id;
    }
    // The hidden <select> above stays the state source of truth; the visible
    // searchable picker is rendered from the same list and drives it.
    renderModelPicker(models, pid);
    updateByokState();
  }

  // The visible model picker: a searchable, scrollable list mirroring the
  // database picker. Each row shows the model's human name, a free badge, its
  // context length, and prompt/completion pricing per 1M tokens — everything a
  // user needs to actually choose, instead of a truncated slug. Clicking a row
  // just sets the hidden <select> (so requestReasoning and every other reader
  // keep working) and refreshes the chip.
  let modelPickAll: ModelOption[] = [];
  function renderModelPicker(models: ModelOption[], pid?: ProviderId) {
    modelPickAll = models;
    if (!modelPickList) return;
    modelPickList.innerHTML = '';

    const buildRow = (m: ModelOption): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ch-model-item';
      btn.dataset.id = m.id;
      const on = m.id === modelSel.value;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));

      // Top line: human name (fallback to id) + optional free/reasoning badges.
      const nameRow = document.createElement('span');
      nameRow.className = 'ch-model-namerow';
      const name = document.createElement('span');
      name.className = 'ch-model-name';
      name.textContent = m.name || m.id;
      nameRow.appendChild(name);
      if (m.free) {
        const badge = document.createElement('span');
        badge.className = 'ch-model-badge ch-model-badge-free';
        badge.textContent = 'free';
        nameRow.appendChild(badge);
      }
      if (m.reasoning) {
        const badge = document.createElement('span');
        badge.className = 'ch-model-badge';
        badge.textContent = 'reasoning';
        nameRow.appendChild(badge);
      }

      // Sub line: the id (so the exact slug is always visible), then any
      // context/pricing facts the catalog actually provided — omitted, never
      // guessed, when absent.
      const meta = document.createElement('span');
      meta.className = 'ch-model-meta';
      // The id sub-line is only worth showing when the top line is a distinct
      // human name; otherwise it just repeats the id already shown above.
      if (m.name && m.name !== m.id) {
        const idEl = document.createElement('code');
        idEl.className = 'ch-model-id';
        idEl.textContent = m.id;
        meta.appendChild(idEl);
      }
      const facts: string[] = [];
      if (typeof m.ctx === 'number' && m.ctx > 0) {
        facts.push((m.ctx >= 1000 ? Math.round(m.ctx / 1000) + 'K' : String(m.ctx)) + ' ctx');
      }
      const inP = formatPricePerM(m.promptPricePerM);
      const outP = formatPricePerM(m.completionPricePerM);
      if (inP && outP) facts.push(inP + ' / ' + outP + ' per 1M');
      else if (inP) facts.push(inP + ' in per 1M');
      for (const f of facts) {
        const fact = document.createElement('span');
        fact.className = 'ch-model-fact';
        fact.textContent = f;
        meta.appendChild(fact);
      }

      const text = document.createElement('span');
      text.className = 'ch-model-text';
      text.appendChild(nameRow);
      text.appendChild(meta);
      const check = document.createElement('span');
      check.className = 'ch-model-check';
      check.setAttribute('aria-hidden', 'true');
      btn.appendChild(check);
      btn.appendChild(text);

      btn.addEventListener('click', () => {
        if (!models.some((x) => x.id === m.id)) return;
        modelSel.value = m.id;
        modelPickList.querySelectorAll('.ch-model-item').forEach((el) => {
          const isSel = (el as HTMLElement).dataset.id === m.id;
          el.classList.toggle('is-on', isSel);
          el.setAttribute('aria-pressed', String(isSel));
        });
        updateByokState();
      });
      // data-search powers the live filter (name + id + badges).
      btn.dataset.search = `${m.name || ''} ${m.id} ${m.free ? 'free' : ''} ${m.reasoning ? 'reasoning' : ''}`.toLowerCase();
      return btn;
    };

    const addGroup = (label: string, list: ModelOption[]) => {
      if (!list.length) return;
      const group = document.createElement('div');
      group.className = 'ch-model-group';
      const cat = document.createElement('div');
      cat.className = 'ch-model-cat';
      cat.textContent = label;
      group.appendChild(cat);
      for (const m of list) group.appendChild(buildRow(m));
      modelPickList.appendChild(group);
    };

    if (pid === 'openrouter') {
      const recommended = models.filter((m) => RECOMMENDED_OPENROUTER_MODELS.has(m.id));
      const rest = models.filter((m) => !RECOMMENDED_OPENROUTER_MODELS.has(m.id));
      if (recommended.length) addGroup('Recommended for this pipeline', recommended);
      addGroup(recommended.length ? 'All models' : 'Models', rest);
    } else {
      for (const m of models) modelPickList.appendChild(buildRow(m));
    }

    if (modelPickCount) modelPickCount.textContent = models.length ? `${models.length} available` : '';
    applyModelFilter();
  }

  // Live filter: hide non-matching rows and any group left empty.
  function applyModelFilter() {
    if (!modelPickList) return;
    const q = (modelPickSearch?.value || '').trim().toLowerCase();
    const rows = Array.from(modelPickList.querySelectorAll<HTMLElement>('.ch-model-item'));
    let anyVisible = false;
    rows.forEach((r) => {
      const hit = !q || (r.dataset.search || '').includes(q);
      r.hidden = !hit;
      if (hit) anyVisible = true;
    });
    modelPickList.querySelectorAll<HTMLElement>('.ch-model-group').forEach((g) => {
      const vis = Array.from(g.querySelectorAll<HTMLElement>('.ch-model-item')).some((it) => !it.hidden);
      g.hidden = !vis;
    });
    if (modelPickEmpty) modelPickEmpty.hidden = anyVisible;
  }
  modelPickSearch?.addEventListener('input', applyModelFilter);

  // Populate the model dropdown — first from the hardcoded fallback (instant),
  // then replace with the live /models fetch (right values).
  async function populateModels(pid: ProviderId, selected?: string) {
    const meta = providerMeta(pid);
    // 1. Instant paint using the fallback list so the UI is never empty.
    renderModelOptions(meta.models, selected, meta.defaultModel, pid);

    // 2. Dynamic refresh from the provider's /models endpoint.
    const key = keyIn.value.trim();
    const needsKey = pid !== 'openrouter';
    if (needsKey && !key) {
      // Direct-provider dropdowns need a key. Signal to the user.
      const hint = document.createElement('option');
      hint.value = '__hint__';
      hint.textContent = '─ enter a key to load available models ─';
      hint.disabled = true;
      modelSel.prepend(hint);
      return;
    }

    const loadingOpt = document.createElement('option');
    loadingOpt.value = '__loading__';
    loadingOpt.textContent = 'loading models…';
    loadingOpt.disabled = true;
    modelSel.prepend(loadingOpt);

    try {
      const live = await fetchModels(pid, key || undefined);
      // Guard: user may have switched providers while we were fetching.
      if (currentProvider() !== pid) return;
      if (live.length) {
        renderModelOptions(live, modelSel.value, meta.defaultModel, pid);
      } else {
        // Fall back cleanly.
        renderModelOptions(meta.models, modelSel.value, meta.defaultModel, pid);
      }
    } catch (err) {
      console.warn('populateModels dynamic fetch failed', err);
      renderModelOptions(meta.models, modelSel.value, meta.defaultModel, pid);
    }
  }

  function renderKeyLinks(pid: ProviderId) {
    keyLinks.innerHTML = '';
    for (const p of PROVIDERS) {
      const a = document.createElement('a');
      a.href = p.keyUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = p.keyLabel;
      a.className = 'ch-keylink' + (p.freeNote ? ' ch-keylink-free' : '');
      keyLinks.appendChild(a);
    }
    const meta = providerMeta(pid);
    if (meta.note) {
      providerNote.textContent = meta.note;
      providerNote.style.display = 'block';
    } else {
      providerNote.style.display = 'none';
    }
  }

  // One-line summary of the connection, shown even when the panel is closed.
  // The model name is the whole point of the chip, so it's shown in full (the
  // CSS wraps it rather than truncating). Prefer the catalog's human name, then
  // the exact slug — never a lossy label.
  function updateByokState() {
    const pid = currentProvider();
    const meta = providerMeta(pid);
    const live = modelPickAll.find((m) => m.id === modelSel.value);
    const curated = meta.models.find((m) => m.id === modelSel.value);
    const modelName = live?.name || live?.id || curated?.label || modelSel.value || meta.defaultModel;
    const hasKey = keyIn.value.trim().length > 0;
    byokState.textContent = pid + ' · ' + modelName + (hasKey ? ' · key ✓' : '');
    byokState.title = pid + ' · ' + modelName + (hasKey ? ' · key set' : ' · no key');
    byokState.classList.toggle('ch-byok-ready', hasKey);
    byokCta.style.display = hasKey ? 'none' : 'inline';
    byokSum.classList.toggle('ch-byok-missing', !hasKey);
  }

  function onProviderChange() {
    const pid = currentProvider();
    void populateModels(pid);
    renderKeyLinks(pid);
    keyIn.placeholder =
      pid === 'anthropic' ? 'sk-ant-… (never leaves your browser)'
      : pid === 'openrouter' ? 'sk-or-… (never leaves your browser)'
      : 'sk-… (never leaves your browser)';
    if (saveChk.checked) sessionStorage.setItem(SESSION_PROVIDER, pid);
    updateByokState();
  }

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

  // Persist / clear the session key when the checkbox toggles or key changes.
  function syncSession() {
    if (saveChk.checked && keyIn.value) {
      sessionStorage.setItem(SESSION_KEY, keyIn.value);
      sessionStorage.setItem(SESSION_PROVIDER, currentProvider());
    } else {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_PROVIDER);
    }
  }
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
  // Toggling chips is a hard filter on which databases the session may use.
  // At least one must stay on; trying to turn the last one off is a no-op.
  let sourcesLocked = false;

  function selectedSources(): string[] {
    return sourceItems.filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.source || '');
  }
  function setSource(b: HTMLButtonElement, on: boolean) {
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  function updateSourcesCount() {
    const n = selectedSources().length;
    if (sourcesCount) sourcesCount.textContent = `${n} of ${sourceItems.length}`;
    if (!sourcesLocked && sourcesHint) {
      sourcesHint.textContent = n === 0
        ? 'Pick at least one database to ask.'
        : 'Chitti answers only from the selected databases.';
      sourcesHint.classList.toggle('is-warn', n === 0);
    }
  }
  // The hard filter binds when the session is created (first ask), so the
  // picker locks for the rest of the conversation. "+ new conversation" clears
  // the session and calls unlockSources().
  //
  // The judgment-call toggle binds at the same moment and for the same
  // reason: it is read once, when createSession() is called, so letting it
  // change mid-conversation would show a control that no longer decides
  // anything. It rides the same lock rather than growing a second mechanism.
  const RLM_HINT_DEFAULT = rlmHint?.textContent || '';

  function rlmEnabled(): boolean {
    return !!rlmToggle?.checked;
  }
  function lockSources() {
    sourcesLocked = true;
    sourcesBox?.classList.add('is-locked');
    sourceItems.forEach((b) => b.setAttribute('aria-disabled', 'true'));
    if (sourcesSearch) sourcesSearch.disabled = true;
    if (sourcesHint) {
      sourcesHint.textContent = 'Locked for this conversation — start a new one to change.';
      sourcesHint.classList.remove('is-warn');
    }
    rlmBox?.classList.add('is-locked');
    if (rlmToggle) rlmToggle.disabled = true;
    if (rlmHint) {
      rlmHint.textContent = rlmEnabled()
        ? 'On for this conversation. Start a new one to turn it off.'
        : 'Off for this conversation. Start a new one to turn it on.';
    }
  }
  function unlockSources() {
    sourcesLocked = false;
    sourcesBox?.classList.remove('is-locked');
    sourceItems.forEach((b) => b.removeAttribute('aria-disabled'));
    if (sourcesSearch) sourcesSearch.disabled = false;
    updateSourcesCount();
    rlmBox?.classList.remove('is-locked');
    if (rlmToggle) rlmToggle.disabled = false;
    if (rlmHint) rlmHint.textContent = RLM_HINT_DEFAULT;
  }
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

  // ── Status helpers ─────────────────────────────────────────────────────
  // A successful run reads from the answer itself; the status line only
  // carries in-flight and error states, so it hides on 'ok' instead of
  // leaving a redundant "Done" chip above the finding.
  function setStatus(tb: TurnBlock, kind: 'loading' | 'ok' | 'error' | 'stopped', msg: string) {
    // 'ok' hides the line (success reads from the answer); every other kind —
    // including the neutral 'stopped' — keeps it visible. 'stopped' is styled
    // muted (not the red error dot): a user-cancel is not a failure.
    tb.statusRow.style.display = kind === 'ok' ? 'none' : 'flex';
    tb.statusDot.className = 'ch-status-dot ch-status-' + kind;
    tb.statusMsg.textContent = msg;
  }

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

  // The user's question, shown chat-style at the top of its turn.
  function renderQuestion(tb: TurnBlock, question: string) {
    tb.questionEl.textContent = question;
    tb.questionEl.style.display = 'block';
  }


  // ── Shared-answer banner + restore (backlog #15) ─────────────────────────

  function renderShareBanner(tb: TurnBlock, state: ShareStateV1) {
    const el = tb.shareBanner;
    el.textContent = '';
    el.style.display = 'block';
    const lead = document.createElement('span');
    lead.className = 'ch-share-banner-lead';
    lead.textContent =
      `Shared answer — generated ${fmtShareDate(state.ts)} · data as fetched then` +
      (state.lossy ? ' · showing charted data only' : '');
    const link = document.createElement('a');
    link.className = 'ch-share-banner-link';
    // Clears the fragment and returns to the live app (a full reload to a clean
    // URL — no share state, fresh session).
    link.href = location.pathname;
    link.textContent = 'ask your own live question →';
    el.appendChild(lead);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(link);
  }

  // Restore a full answer view from a decoded permalink — no agent run, no key.
  // Reuses the live render paths (renderChart / renderTable / renderCitations),
  // all of which write text via textContent or escape through esc() before any
  // innerHTML, so nothing from the payload is ever injected as markup.
  async function restoreSharedAnswer(state: ShareStateV1) {
    const tb = createTurnBlock();
    tb.isShared = true;
    tb.question = state.q;
    allTurns.push(tb);
    renderShareBanner(tb, state);
    renderQuestion(tb, state.q);
    // No trace panel on a shared view (there is no run to show).
    if (state.spec) {
      liveChartTurns.push(tb); // keep it re-theming/resizing like a live chart
      tb.canvasEl.classList.remove('ch-canvas-pending');
      await renderChart(tb, state.spec);
      tb.renderFlag.style.display = 'none';
    }
    tb.answerSection.style.display = 'block';
    tb.metaSection.style.display = 'block';
    renderFinding(tb, state.answer);
    renderSharedVerification(tb, state.verification);
    renderTable(tb, state.rows, rowsToCSV(state.rows));
    renderCitations(tb, state.citations);
    // Hide the setup console and switch the composer to "new conversation".
    consoleEl.style.display = 'none';
    newConvoBtn.style.display = '';
    composerQ.placeholder = 'Ask your own live question…';
  }

  function renderShareError() {
    consoleEl.style.display = 'none';
    const tb = createTurnBlock();
    allTurns.push(tb);
    const el = tb.shareBanner;
    el.style.display = 'block';
    el.classList.add('ch-share-banner-error');
    el.textContent = '';
    const lead = document.createElement('span');
    lead.className = 'ch-share-banner-lead';
    lead.textContent = 'This share link is invalid — it may be corrupted, truncated, or from a newer version.';
    const link = document.createElement('a');
    link.className = 'ch-share-banner-link';
    link.href = location.pathname;
    link.textContent = 'ask your own live question →';
    el.appendChild(lead);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(link);
  }

  // Invalid #dash= link: open the dashboards overlay showing a clear error and a
  // way back to the live app. No tiles, no controls — never a half-rendered view.
  function renderDashShareError() {
    resetSharedDashState();
    consoleEl.style.display = 'none';
    dashView.hidden = false;
    document.body.classList.add('ch-dashview-open');
    dashViewTitle.textContent = 'Shared dashboard';
    dashViewBack.setAttribute('aria-label', 'Leave shared dashboard');
    dashViewBody.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'ch-share-banner ch-share-banner-error ch-dash-shared-banner';
    banner.setAttribute('role', 'note');
    banner.setAttribute('data-testid', 'dash-share-error');
    const lead = document.createElement('span');
    lead.className = 'ch-share-banner-lead';
    lead.textContent = 'This shared dashboard link is invalid — it may be corrupted, truncated, or from a newer version.';
    const link = document.createElement('a');
    link.className = 'ch-share-banner-link';
    link.href = location.pathname;
    link.textContent = 'open the live app →';
    banner.appendChild(lead);
    banner.appendChild(document.createTextNode(' '));
    banner.appendChild(link);
    dashViewBody.appendChild(banner);
    requestAnimationFrame(() => dashViewBack.focus());
  }

  // On load, if the URL carries a #share= fragment, restore that answer view
  // instead of the empty app. Defensive: any decode failure shows a clear
  // invalid-link state and never crashes the page or executes payload content.
  async function maybeRestoreFromFragment() {
    const hash = location.hash || '';
    // A URL carries only ONE of these fragments. #share= restores an answer view;
    // #dash= restores a read-only shared dashboard. Distinct prefixes, checked in
    // order; neither ever reaches a server (both are fragments).
    const share = hash.match(/^#share=(.+)$/);
    if (share) {
      let state: ShareStateV1 | null = null;
      try {
        state = await decodeShareState(decodeURIComponent(share[1]));
      } catch {
        state = null;
      }
      if (!state) { renderShareError(); return; }
      try {
        await restoreSharedAnswer(state);
      } catch (err) {
        console.error('share restore failed', err);
        renderShareError();
      }
      return;
    }
    const dash = hash.match(/^#dash=(.+)$/);
    if (dash) {
      let state: DashShareV1 | null = null;
      try {
        state = await decodeDashShare(decodeURIComponent(dash[1]));
      } catch {
        state = null;
      }
      if (!state) { renderDashShareError(); return; }
      try {
        consoleEl.style.display = 'none';
        renderSharedDashboard(state);
        requestAnimationFrame(() => dashViewBack.focus());
      } catch (err) {
        console.error('dashboard share restore failed', err);
        renderDashShareError();
      }
    }
  }
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

  function resetNewQuestionChip() {
    newQuestionArmed = false;
    if (newQuestionTimer !== null) {
      clearTimeout(newQuestionTimer);
      newQuestionTimer = null;
    }
    newConvoBtn.textContent = '+ new question';
    newConvoBtn.classList.remove('ch-new-convo-armed');
  }

  function performNewQuestion() {
    resetNewQuestionChip();
    run.session = null;
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

  newConvoBtn.addEventListener('click', () => {
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
  });

  // A click anywhere other than the chip disarms the confirm, so the second
  // (destructive) click has to be a deliberate one on the chip itself.
  document.addEventListener('click', (e) => {
    if (
      newQuestionArmed &&
      e.target !== newConvoBtn &&
      !newConvoBtn.contains(e.target as Node)
    ) {
      resetNewQuestionChip();
    }
  });

  // Test-only seam. When the page is opened with ?chittidebug in the URL, the
  // real render path (createTurnBlock → renderQuestion/renderChart/renderTable)
  // is exposed so an offline harness can stage a turn through the ACTUAL
  // functions — same DOM, same chart↔table linking — without an LLM call. The
  // guard is false in normal use, so nothing is exposed in production; it hands
  // out render helpers only, never agent/provider/session internals.
  if (new URLSearchParams(location.search).has('chittidebug')) {
    const dbg: any = {
      async stage(
        question: string,
        spec: ChartSpec,
        rows: DataRow[],
        opts?: { finding?: string; citations?: Citation[]; verification?: AgentOutput['verification'] }
      ) {
        const tb = createTurnBlock();
        allTurns.push(tb);
        liveChartTurns.push(tb);
        consoleEl.style.display = 'none';
        tb.panel.style.display = 'block';
        tb.question = question;
        renderQuestion(tb, question);
        await renderChart(tb, spec);
        tb.metaSection.style.display = 'block';
        tb.answerSection.style.display = 'block';
        const finding = opts?.finding ?? 'Staged turn (offline harness).';
        renderFinding(tb, finding);
        if (opts?.verification !== undefined) renderVerification(tb, opts.verification);
        renderTable(tb, rows, rowsToCSV(rows));
        if (opts?.citations && opts.citations.length) renderCitations(tb, opts.citations);
        tb.dataDetails.open = true;
        // Capture the answer state and reveal the share action, exactly as the
        // live completion path does, so the harness can exercise real sharing.
        tb.lastFinding = finding;
        tb.lastCitations = opts?.citations ?? [];
        tb.lastVerification = opts?.verification ?? null;
        tb.shareBtn.style.display = '';
        tb.pinBtn.style.display = '';
        dbg.chart = tb.chartInstance;
        dbg.tb = tb;
        return tb.root;
      },
      // Dashboard test hooks: open the view, and clear all saved dashboards so a
      // headless harness starts from a known-empty state. Render helpers only —
      // still no agent/provider/session internals exposed.
      openDashboards() {
        openDashboards();
      },
      clearDashboards() {
        if (!dashStore) return;
        for (const d of listDashboards(dashStore)) deleteDashboard(dashStore, d.id);
        updateDashNavCount();
      },
      // Seed a two-tile dashboard (built through the REAL makeTile/addTile ops,
      // with genuine World Bank citations) so the offline harness can exercise
      // the refresh flow: overriding window.fetch to succeed for one indicator
      // and fail for the other yields a live one-✓-one-✗ refresh log with a
      // stale-marked tile — no LLM, no live egress. Returns the dashboard id.
      seedRefreshFixture(): string | null {
        if (!dashStore) return null;
        const mk = (title: string, indicatorId: string) =>
          makeTile({
            title,
            spec: {
              type: 'line', title, y_axis: 'per 1,000',
              series: [{ name: 'India', data: [[2000, 66.6], [2010, 41.9], [2020, 27.3]] }],
            },
            rows: [
              { country: 'India', iso3: 'IND', year: 2000, value: 66.6, indicator: indicatorId },
              { country: 'India', iso3: 'IND', year: 2010, value: 41.9, indicator: indicatorId },
              { country: 'India', iso3: 'IND', year: 2020, value: 27.3, indicator: indicatorId },
            ],
            citations: [{
              id: `wb:${indicatorId}|IND|2000:2020`, source: 'worldbank', sourceLabel: 'World Bank Open Data',
              indicatorId, indicatorName: title, url: `https://data.worldbank.org/indicator/${indicatorId}`,
              countries: ['IND'], yearRange: { start: 2000, end: 2020 },
              fetchedAt: '2026-07-01T00:00:00.000Z', sourceUpdated: '2024-06-01', rowCount: 3, cached: false,
            }],
          });
        let d = createDashboard('Health board');
        d = addTile(d, mk('GDP per capita', 'SP.DYN.IMRT.IN'));
        d = addTile(d, mk('life expectancy', 'SP.DYN.LE00.IN'));
        saveDashboard(dashStore, d);
        updateDashNavCount();
        return d.id;
      },
      openDashboardById(id: string) {
        if (dashView.hidden) openDashboards();
        openDashboard(id);
      },
      // Build the #dash= permalink for a saved dashboard without touching the
      // clipboard, so a headless harness can capture it and open it in a fresh
      // page to screenshot the read-only shared view. Returns null when the
      // dashboard is missing or too large to fit a link.
      async dashShareUrl(id: string): Promise<string | null> {
        if (!dashStore) return null;
        const dash = loadDashboard(dashStore, id);
        if (!dash) return null;
        const enc = await encodeDashShare(dash);
        return enc.ok ? location.origin + location.pathname + '#dash=' + enc.payload : null;
      },
      // Export a saved dashboard's JSON (the exact bytes the .json download
      // carries), so the harness can exercise export→import without file IO.
      exportDashboardJson(id: string): string | null {
        if (!dashStore) return null;
        const dash = loadDashboard(dashStore, id);
        return dash ? serializeDashboard(dash) : null;
      },
      // Run the REAL import pipeline (parse → prepare fresh id + dedup title →
      // save) over a JSON string and return the new dashboard id, or null on a
      // malformed/oversized file. Never overwrites an existing dashboard.
      importDashboardJson(raw: string): string | null {
        const parsed = parseImportedDashboard(raw);
        if (!parsed) return null;
        return importParsedDashboard(parsed);
      },
      // Build the share URL for the staged turn without touching the clipboard,
      // so a headless harness can capture it deterministically.
      async shareUrl() {
        if (!dbg.tb) return null;
        const built = await buildShareUrl(dbg.tb);
        return built ? built.url : null;
      },
      // Stage a trace through the REAL renderTrace path — same DOM, same
      // receipt/nesting/provenance rendering — from a supplied TraceEvent[]
      // (and optional VFS snapshot for inline-expandable write_file rows). No
      // LLM call: the harness hands over a realistic event sequence (e.g. an
      // execute_js step with nested llm() child receipts) and this drives the
      // app's own renderer over it.
      stageTrace(
        question: string,
        events: any[],
        files?: Record<string, string>,
        citations?: Citation[],
        answer?: { finding?: string; verification?: AgentOutput['verification'] }
      ) {
        const tb = createTurnBlock();
        allTurns.push(tb);
        consoleEl.style.display = 'none';
        tb.panel.style.display = 'block';
        (tb.panel as HTMLDetailsElement).open = true;
        renderQuestion(tb, question);
        if (files) renderFiles(tb, files);
        renderTrace(tb, events as TraceEvent[]);
        // Citations render OUTSIDE the trace, in the evidence section — drive
        // them through the SAME renderCitations path the live run uses (real
        // .ch-meta / .ch-cite containers, no floating DOM), so an offline
        // screenshot exercises the actual references renderer.
        if (citations && citations.length) {
          tb.metaSection.style.display = 'block';
          renderCitations(tb, citations);
        }
        // The answer-level verification cue lives in the answer section, not the
        // trace — drive it through the REAL renderFinding + renderVerification so
        // an offline screenshot exercises the actual honest-state treatment.
        if (answer) {
          tb.answerSection.style.display = 'block';
          renderFinding(tb, answer.finding ?? 'Staged finding.');
          renderVerification(tb, answer.verification ?? null);
        }
        dbg.tb = tb;
        return tb.root;
      },
      // Run the REAL chart-click activation path (matchPointToRow → highlight)
      // for a given point. Used by the offline harness because headless
      // Chromium's synthetic canvas events don't resolve a zrender series-click
      // target, even though hover does — so the ECharts event is stubbed but
      // every line of the app's own linking code still runs.
      activatePoint(seriesIndex: number, dataIndex: number) {
        if (dbg.tb) activateChartPoint(dbg.tb, seriesIndex, dataIndex);
      },
      // Pixel position of a data point, so the harness can issue a real mouse
      // click on the canvas that flows through the actual ECharts listeners.
      pointPixel(seriesIndex: number, dataIndex: number, value: number) {
        const p = dbg.chart?.convertToPixel({ seriesIndex }, [dataIndex, value]);
        const rect = dbg.chart?.getDom()?.getBoundingClientRect();
        return p && rect ? { x: rect.left + p[0], y: rect.top + p[1] } : null;
      },
      // Stop-control harness: drive the REAL submit handler with a stubbed
      // session so the actual running/stopped DOM is exercised with no network.
      // The injected session's ask() streams a couple of receipts, then waits;
      // when the user clicks the (real) stop button, the (real) AbortSignal
      // fires and ask() resolves with an honest aborted output — the same path
      // a live stop takes. Egress stays untouched; this is stubbing, not a run.
      setKey(k: string) {
        keyIn.value = k;
      },
      injectStopSession(over?: { rows?: DataRow[]; citations?: Citation[]; finding?: string }) {
        const rows = over?.rows ?? [];
        const citations = over?.citations ?? [];
        const fake = {
          ask(_q: string, cb: any, sig?: AbortSignal) {
            // Stream a realistic, resolved trace so "N receipts completed" is
            // non-zero and the collapsed panel reads like a real partial run.
            const now = Date.now();
            cb.onTrace([
              { tool: 'find_series', argSummary: 'child mortality', status: 'ok', ts: now, detail: '3 hits' },
              { tool: 'fetch_series', argSummary: 'SP.DYN.IMRT.IN', status: 'ok', ts: now + 1, detail: `${rows.length} rows` },
              { tool: 'execute_js', argSummary: 'rank countries', status: 'running', ts: now + 2 },
            ]);
            cb.onStatus('Working…', 'loading');
            return new Promise((resolve) => {
              const finish = () =>
                resolve({
                  finding: over?.finding ?? '',
                  chartSpec: null,
                  rows,
                  csv: rowsToCSV(rows),
                  indicators: [],
                  citations,
                  confidence: 'low',
                  verifierReport: '',
                  verification: null,
                  cost: 0,
                  retried: false,
                  kind: 'chart',
                  aborted: true,
                });
              if (sig?.aborted) finish();
              else sig?.addEventListener('abort', finish, { once: true });
            });
          },
        };
        // Same closure as `session` — inject directly and lock the picker, as a
        // real first ask() would, so the "+ new question" unlock is exercised.
        run.session = fake as unknown as ChittiSession;
        lockSources();
      },
    };
    (window as any).__chittiDebug = dbg;
    document.documentElement.setAttribute('data-chitti-debug-ready', '1');
  }
