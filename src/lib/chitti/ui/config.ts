// Config sheet + provider/model/source/RLM logic. The function bodies extracted
// verbatim from the UI monolith; their event listeners and one-time init calls
// stay in boot.ts (the wiring layer) and call these exports, so listener
// registration order is byte-for-byte unchanged. Module-owned state:
// sourcesLocked (config writes it, boot reads it live), RLM_HINT_DEFAULT, vv.
import {
  run, SESSION_KEY, SESSION_PROVIDER,
  providerSel, modelSel, modelPickList, modelPickSearch, modelPickCount, modelPickEmpty,
  keyIn, saveChk, keyLinks, providerNote, byokPanel, byokSum, byokState, byokCta,
  byokMore, byokSettings, sourcesBox, sourcesHint, sourcesCount, sourcesSearch,
  sourcesEmpty, sourceItems, rlmBox, rlmToggle, rlmHint,
} from './state';
import {
  PROVIDERS, providerMeta, fetchModels, formatPricePerM, RECOMMENDED_OPENROUTER_MODELS,
  type ProviderId, type ModelOption,
} from '../providers';
import { $ } from './dom';

// Model + databases live behind a disclosure so the sheet is short on mobile
// (the keyboard-vs-key-field problem). Key-first: collapsed until there's a
// key, then auto-revealed; the toggle overrides either way.
// Full model list backing the searchable picker (config-owned state).
let modelPickAll: ModelOption[] = [];

export function setSettingsOpen(open: boolean) {
  byokSettings.hidden = !open;
  byokMore.setAttribute('aria-expanded', String(open));
}

// Keep the fixed bottom sheet above the on-screen keyboard: visualViewport
// shrinks when the keyboard opens, and `--kb` lifts the sheet by that much so
// the focused field (the key, at the top) is never covered. No-op on desktop.
export const vv = window.visualViewport;

export function syncSheetToKeyboard() {
  if (!vv || byokPanel.hidden) {
    byokPanel.style.removeProperty('--kb');
    return;
  }
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  byokPanel.style.setProperty('--kb', kb + 'px');
}

// The config panel is a plain div toggled open/closed (not <details>, so the
// trigger button can live inside the composer form). openByok(true/false)
// is the single entry point; the chip button and outside-click drive it.
// The sheet is a modal dialog: opening moves focus into it and closing
// returns focus to the chip that opened it, so a keyboard user never loses
// their place. Focus is only pulled back to the trigger when it was still
// inside the sheet at close time (an explicit close), never when a run has
// already moved focus elsewhere.
export function openByok(open: boolean) {
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

export function currentProvider(): ProviderId {
  return providerSel.value as ProviderId;
}

// Renders a list of {id,label,free} options into the model <select>.
// OpenRouter's catalog is large enough that a flat alphabetical list
// buries the models actually verified to work well on this app's own
// tool-calling pipeline — split into a "Recommended" optgroup (from
// RECOMMENDED_OPENROUTER_MODELS) plus everything else, rather than a
// single "· recommended" suffix a user could easily scroll past.
export function renderModelOptions(models: ModelOption[], selected?: string, defaultModel?: string, pid?: ProviderId) {
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

export function renderModelPicker(models: ModelOption[], pid?: ProviderId) {
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
export function applyModelFilter() {
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

// Populate the model dropdown — first from the hardcoded fallback (instant),
// then replace with the live /models fetch (right values).
export async function populateModels(pid: ProviderId, selected?: string) {
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

export function renderKeyLinks(pid: ProviderId) {
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
export function updateByokState() {
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

export function onProviderChange() {
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

// Persist / clear the session key when the checkbox toggles or key changes.
export function syncSession() {
  if (saveChk.checked && keyIn.value) {
    sessionStorage.setItem(SESSION_KEY, keyIn.value);
    sessionStorage.setItem(SESSION_PROVIDER, currentProvider());
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_PROVIDER);
  }
}

// Toggling chips is a hard filter on which databases the session may use.
// At least one must stay on; trying to turn the last one off is a no-op.
export let sourcesLocked = false;

export function selectedSources(): string[] {
  return sourceItems.filter((b) => b.classList.contains('is-on')).map((b) => b.dataset.source || '');
}

export function setSource(b: HTMLButtonElement, on: boolean) {
  b.classList.toggle('is-on', on);
  b.setAttribute('aria-pressed', String(on));
}

export function updateSourcesCount() {
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
export const RLM_HINT_DEFAULT = rlmHint?.textContent || '';

export function rlmEnabled(): boolean {
  return !!rlmToggle?.checked;
}

export function lockSources() {
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

export function unlockSources() {
  sourcesLocked = false;
  sourcesBox?.classList.remove('is-locked');
  sourceItems.forEach((b) => b.removeAttribute('aria-disabled'));
  if (sourcesSearch) sourcesSearch.disabled = false;
  updateSourcesCount();
  rlmBox?.classList.remove('is-locked');
  if (rlmToggle) rlmToggle.disabled = false;
  if (rlmHint) rlmHint.textContent = RLM_HINT_DEFAULT;
}
