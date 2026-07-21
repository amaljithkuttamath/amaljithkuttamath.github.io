// Dashboards view: the pin picker, the dashboards grid + detail view, tile
// cards, refresh log, share/export/import, and the read-only shared-dashboard
// render. Extracted verbatim from the UI monolith. Owns its own local state
// (pinContext, currentDashId, refreshController, ...) as module-level lets — no
// state crosses into other modules except the shared els/dashStore from state.ts.
import type { TurnBlock } from './state';
import {
  dashStore, liveDashCharts,
  dashNavBtn, dashNavCount, pinDialog, pinBackdrop, pinCloseBtn, pinListEl,
  pinNewForm, pinNameInput, pinStatusEl, dashView, dashViewBack, dashViewTitle,
  dashViewBody, dashViewStatus, dashImportFile,
} from './state';
import type { ChartSpec, DataRow, Citation } from '../tools';
import { refreshDashboard, type TileRefreshResult } from '../agent';
import {
  createDashboard, addTile, removeTile, renameTile, renameDashboard, moveTile,
  replaceTile, makeTile, listDashboards, loadDashboard, saveDashboard,
  deleteDashboard, findDashboardByTitle, serializeDashboard, DashboardCapError,
  type Dashboard, type Tile,
} from '../dashboard';
import {
  encodeDashShare, materializeSharedDashboard, parseImportedDashboard,
  prepareImportedDashboard, type DashShareV1, type DashShareTileV1,
} from '../dashboard-share';
import { chartAriaLabel, FOCUSABLE_SELECTOR, focusTrapTarget } from '../a11y';
import { titleSlug } from '../chart-format';
import { esc, fmtDate } from './dom';
import { buildOption } from './chart-option';
import { loadECharts } from './charts';
import { writeClipboard, clipboardFallback, announceShare } from './actions';

// ── Dashboards (pin picker + saved-dashboard view) ───────────────────────
// Client-side, localStorage-backed. Nothing here touches the network or the
// agent: pinning captures the turn's already-rendered chart + rows + citation
// ledger and writes a Dashboard document; the view re-renders each tile's
// chart through the SAME buildOption path the live answers use.


// Polite status line for the dashboards view (share/export/import). Mirrors the
// per-turn announceShare: auto-clears a success message, keeps errors up.
export function setDashStatus(msg: string, isError = false) {
  dashViewStatus.textContent = msg;
  dashViewStatus.classList.toggle('ch-dashview-status-error', isError);
  if (msg && !isError) {
    window.setTimeout(() => {
      if (dashViewStatus.textContent === msg) dashViewStatus.textContent = '';
    }, 2600);
  }
}

// Reflect the number of saved dashboards on the header chip.
export function updateDashNavCount() {
  const n = dashStore ? listDashboards(dashStore).length : 0;
  if (n > 0) {
    dashNavCount.textContent = String(n);
    dashNavCount.hidden = false;
  } else {
    dashNavCount.hidden = true;
  }
}


// ── Two-step confirm (reused for destructive tile removal, per b5cdcfd) ───
// First activation arms the button (relabelled, styled); a second within the
// window confirms; anything else disarms. Keeps destructive actions inline,
// no window.confirm.
const confirmTimers = new WeakMap<HTMLElement, number>();
export function armConfirm(btn: HTMLButtonElement, armedLabel: string, onConfirm: () => void) {
  if (btn.dataset.armed === '1') {
    const t = confirmTimers.get(btn);
    if (t) clearTimeout(t);
    confirmTimers.delete(btn);
    onConfirm();
    return;
  }
  const original = btn.textContent || '';
  btn.dataset.armed = '1';
  btn.dataset.original = original;
  btn.textContent = armedLabel;
  btn.classList.add('ch-confirm-armed');
  const disarm = () => {
    btn.dataset.armed = '';
    btn.textContent = btn.dataset.original || original;
    btn.classList.remove('ch-confirm-armed');
    confirmTimers.delete(btn);
  };
  confirmTimers.set(btn, window.setTimeout(disarm, 3500));
}

// ── Pin picker ────────────────────────────────────────────────────────────
let pinContext: { tb: TurnBlock; spec: ChartSpec; rows: DataRow[]; citations: Citation[] } | null = null;
let pinReturnFocus: HTMLElement | null = null;

export function setPinStatus(msg: string, isError = false) {
  pinStatusEl.textContent = msg;
  pinStatusEl.classList.toggle('ch-pin-status-error', isError);
}

export function openPinPicker(tb: TurnBlock, trigger: HTMLElement) {
  if (!tb.lastSpec) return;
  pinContext = {
    tb,
    spec: tb.lastSpec,
    rows: tb.lastRows || [],
    citations: tb.lastCitations || [],
  };
  pinReturnFocus = trigger;
  setPinStatus('');
  pinNameInput.value = '';
  renderPinList();
  pinBackdrop.hidden = false;
  pinDialog.hidden = false;
  if (!dashStore) {
    setPinStatus('Browser storage is unavailable — dashboards cannot be saved here.', true);
  }
  // Move focus into the dialog and announce its label.
  requestAnimationFrame(() => {
    const first = pinDialog.querySelector<HTMLElement>('.ch-pin-existing') || pinNameInput;
    (first || pinDialog).focus();
  });
}

export function closePinPicker() {
  pinDialog.hidden = true;
  pinBackdrop.hidden = true;
  pinContext = null;
  if (pinReturnFocus && document.body.contains(pinReturnFocus)) pinReturnFocus.focus();
  pinReturnFocus = null;
}

// Build the "pin into an existing dashboard" list. Each existing dashboard
// offers "add as new tile" (the primary button); a dashboard that already has
// tiles ALSO offers "replace a tile…", which expands its tiles so the pin can
// take an existing tile's slot (increment 2 — reuses replaceTile, position is
// inherited).
export function renderPinList() {
  const boards = dashStore ? listDashboards(dashStore) : [];
  if (!boards.length) {
    pinListEl.innerHTML = '<p class="ch-pin-empty">No dashboards yet — name one below to start.</p>';
    return;
  }
  pinListEl.innerHTML = '';
  for (const d of boards) {
    const row = document.createElement('div');
    row.className = 'ch-pin-existing-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ch-pin-existing';
    btn.innerHTML =
      `<span class="ch-pin-existing-name"></span>` +
      `<span class="ch-pin-existing-meta">${d.tiles.length} tile${d.tiles.length === 1 ? '' : 's'} · add new</span>`;
    (btn.querySelector('.ch-pin-existing-name') as HTMLElement).textContent = d.title;
    btn.addEventListener('click', () => doPin(d));
    row.appendChild(btn);

    if (d.tiles.length) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ch-pin-replace-toggle';
      toggle.textContent = 'replace a tile…';
      toggle.setAttribute('aria-expanded', 'false');
      const sub = document.createElement('div');
      sub.className = 'ch-pin-replace-list';
      sub.hidden = true;
      sub.setAttribute('role', 'group');
      sub.setAttribute('aria-label', `Replace a tile in ${d.title}`);
      for (const t of d.tiles) {
        const tbtn = document.createElement('button');
        tbtn.type = 'button';
        tbtn.className = 'ch-pin-replace-tile';
        tbtn.textContent = t.title;
        tbtn.setAttribute('aria-label', `Replace tile "${t.title}"`);
        tbtn.addEventListener('click', () => doPinReplace(d, t.id));
        sub.appendChild(tbtn);
      }
      toggle.addEventListener('click', () => {
        const open = sub.hidden;
        sub.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      row.appendChild(toggle);
      row.appendChild(sub);
    }
    pinListEl.appendChild(row);
  }
}

// Pin the captured chart into a target dashboard (an existing Dashboard, or
// 'new' with a name). Reloads the target fresh from storage so concurrent
// edits are not clobbered, then addTile → saveDashboard, surfacing any cap or
// quota error inline without closing the dialog.
export function doPin(target: Dashboard | 'new', rawName?: string) {
  if (!pinContext) return;
  if (!dashStore) {
    setPinStatus('Browser storage is unavailable — cannot pin.', true);
    return;
  }
  let dash: Dashboard;
  if (target === 'new') {
    const name = (rawName || '').trim() || pinContext.spec.title || 'My dashboard';
    dash = findDashboardByTitle(dashStore, name) || createDashboard(name);
  } else {
    dash = loadDashboard(dashStore, target.id) || target;
  }
  const tile = makeTile({
    title: pinContext.spec.title || 'Chart',
    spec: pinContext.spec,
    rows: pinContext.rows,
    citations: pinContext.citations,
  });
  try {
    dash = addTile(dash, tile);
  } catch (e: any) {
    setPinStatus(e instanceof DashboardCapError ? e.message : 'Could not pin: ' + (e?.message ?? e), true);
    return;
  }
  const saved = saveDashboard(dashStore, dash);
  if (!saved.ok) {
    setPinStatus(saved.error, true);
    return;
  }
  updateDashNavCount();
  const tb = pinContext.tb;
  const title = dash.title;
  closePinPicker();
  // Confirm through the turn's existing aria-live region (reused from share).
  announceShare(tb, `pinned to "${title}"`);
}

// Replace an existing tile with the captured chart (increment 2). Reloads the
// target fresh from storage (so a concurrent edit is not clobbered), builds a
// tile from the pin context, and swaps it into the chosen slot via the pure
// replaceTile op — the new tile inherits the old one's position. Cap/quota
// errors surface inline without closing the dialog.
export function doPinReplace(target: Dashboard, tileId: string) {
  if (!pinContext) return;
  if (!dashStore) {
    setPinStatus('Browser storage is unavailable — cannot pin.', true);
    return;
  }
  const dash0 = loadDashboard(dashStore, target.id) || target;
  const tile = makeTile({
    title: pinContext.spec.title || 'Chart',
    spec: pinContext.spec,
    rows: pinContext.rows,
    citations: pinContext.citations,
  });
  let dash: Dashboard;
  try {
    dash = replaceTile(dash0, tileId, tile);
  } catch (e: any) {
    setPinStatus(e instanceof DashboardCapError ? e.message : 'Could not replace: ' + (e?.message ?? e), true);
    return;
  }
  if (dash === dash0) {
    // The tile vanished between opening the picker and clicking (concurrent
    // edit). Refresh the list rather than silently claiming a replacement.
    setPinStatus('That tile no longer exists — pick another.', true);
    renderPinList();
    return;
  }
  const saved = saveDashboard(dashStore, dash);
  if (!saved.ok) {
    setPinStatus(saved.error, true);
    return;
  }
  updateDashNavCount();
  const tb = pinContext.tb;
  const title = dash.title;
  closePinPicker();
  announceShare(tb, `replaced a tile in "${title}"`);
}

pinNewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  doPin('new', pinNameInput.value);
});
pinCloseBtn.addEventListener('click', () => closePinPicker());
pinBackdrop.addEventListener('click', () => closePinPicker());
pinDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePinPicker();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = Array.from(pinDialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 || el === document.activeElement
  );
  const idx = items.indexOf(document.activeElement as HTMLElement);
  const target = focusTrapTarget(idx, items.length, e.shiftKey);
  if (target !== null) {
    e.preventDefault();
    items[target]?.focus();
  }
});

// ── Dashboards view ─────────────────────────────────────────────────────
let currentDashId: string | null = null;
let dashReturnFocus: HTMLElement | null = null;
// When the view is showing a #dash= shared snapshot (read-only), this holds
// the decoded payload; null in normal (editable) mode. Increment 3. The shared
// view has NO edit/refresh/remove controls; its only mutation is "import",
// which materializes a fresh local dashboard and exits read-only mode.
let sharedDashState: DashShareV1 | null = null;
// The AbortController for an in-flight "refresh data" run (null when idle), so
// a refresh is stoppable and cannot start twice. Increment 2.
let refreshController: AbortController | null = null;
// The last refresh's receipt lines, kept so a re-render of the SAME dashboard
// (e.g. after the run applies fresh data) re-shows the log rather than losing
// it. Cleared when the dashboard changes.
let lastRefreshLog: { dashId: string; lines: { ok: boolean; text: string }[]; done: boolean; aborted: boolean } | null = null;

export function disposeDashCharts() {
  for (const t of liveDashCharts) t.inst?.dispose();
  liveDashCharts.length = 0;
}

export function openDashboards() {
  dashReturnFocus = document.activeElement as HTMLElement;
  sharedDashState = null;
  currentDashId = null;
  dashView.hidden = false;
  document.body.classList.add('ch-dashview-open');
  renderDashList();
  requestAnimationFrame(() => dashViewBack.focus());
}

export function closeDashboards() {
  disposeDashCharts();
  dashView.hidden = true;
  document.body.classList.remove('ch-dashview-open');
  currentDashId = null;
  sharedDashState = null;
  if (dashReturnFocus && document.body.contains(dashReturnFocus)) dashReturnFocus.focus();
  else dashNavBtn.focus();
}

// Back is contextual: from a dashboard's detail → back to the list; from the
// list → close the whole view. In shared read-only mode (a #dash= landing)
// there is no local list to return to, so back navigates to the clean live app
// (mirrors the answer-share banner's "ask your own live question").
export function dashBack() {
  if (sharedDashState) {
    location.href = location.pathname;
    return;
  }
  if (currentDashId) {
    disposeDashCharts();
    currentDashId = null;
    renderDashList();
    requestAnimationFrame(() => dashViewBack.focus());
  } else {
    closeDashboards();
  }
}

// The "Import dashboard" action for the list view — opens the hidden file
// input. Rendered on both the empty state and the populated list so a JSON
// export can always be brought in.
export function buildImportButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ch-dash-mini ch-dash-import';
  btn.setAttribute('data-testid', 'dash-import');
  btn.textContent = 'Import dashboard';
  btn.setAttribute('aria-label', 'Import a dashboard from a JSON file');
  btn.addEventListener('click', () => dashImportFile.click());
  return btn;
}

export function renderDashList() {
  disposeDashCharts();
  dashViewTitle.textContent = 'Dashboards';
  dashViewBack.setAttribute('aria-label', 'Close dashboards');
  const boards = dashStore ? listDashboards(dashStore) : [];
  dashViewBody.innerHTML = '';

  // A list-level action bar carrying the import control.
  const actions = document.createElement('div');
  actions.className = 'ch-dash-list-actions';
  actions.appendChild(buildImportButton());
  dashViewBody.appendChild(actions);

  if (!boards.length) {
    const empty = document.createElement('div');
    empty.className = 'ch-dash-empty';
    empty.innerHTML =
      '<p class="ch-dash-empty-title">No dashboards yet</p>' +
      '<p class="ch-dash-empty-sub">Pin a chart from any answer — use “Pin to dashboard” under an answer’s raw data — or import one below.</p>';
    dashViewBody.appendChild(empty);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'ch-dash-list';
  for (const d of boards) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ch-dash-card';
    card.innerHTML =
      '<span class="ch-dash-card-title"></span>' +
      `<span class="ch-dash-card-meta">${d.tiles.length} tile${d.tiles.length === 1 ? '' : 's'} · updated ${esc(fmtDate(d.updated))}</span>`;
    (card.querySelector('.ch-dash-card-title') as HTMLElement).textContent = d.title;
    card.addEventListener('click', () => openDashboard(d.id));
    grid.appendChild(card);
  }
  dashViewBody.appendChild(grid);
}

export function openDashboard(id: string) {
  if (!dashStore) return;
  sharedDashState = null;
  const dash = loadDashboard(dashStore, id);
  if (!dash) { renderDashList(); return; }
  // A refresh log belongs to the dashboard it ran on; drop it when opening a
  // different one so an old log never bleeds across dashboards.
  if (lastRefreshLog && lastRefreshLog.dashId !== id) lastRefreshLog = null;
  currentDashId = id;
  renderDashDetail(dash);
  requestAnimationFrame(() => dashViewBack.focus());
}

// Persist a mutated dashboard and re-render the detail from the saved copy so
// the view and storage never drift. Surfaces a save failure via the title bar.
export function saveAndRerender(dash: Dashboard) {
  if (!dashStore) return;
  const res = saveDashboard(dashStore, dash);
  updateDashNavCount();
  if (!res.ok) { dashViewTitle.textContent = dash.title + ' — ' + res.error; return; }
  renderDashDetail(dash);
}

// One receipt line in the refresh log (mono, receipt-style). ✓ reuses the
// success green already used for status dots; ✗ uses the sparing danger tint.
export function refreshLogLine(line: { ok: boolean; text: string }): HTMLElement {
  const li = document.createElement('li');
  li.className = 'ch-refresh-line ' + (line.ok ? 'ch-refresh-ok' : 'ch-refresh-fail');
  li.textContent = line.text;
  return li;
}

export function buildRefreshLog(log: { lines: { ok: boolean; text: string }[]; done: boolean; aborted: boolean }): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ch-refresh-log';
  box.setAttribute('data-testid', 'refresh-log');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Refresh log');
  const head = document.createElement('div');
  head.className = 'ch-refresh-log-head';
  head.textContent = log.done ? (log.aborted ? 'Refresh stopped' : 'Refresh complete') : 'Refreshing…';
  box.appendChild(head);
  const ul = document.createElement('ul');
  ul.className = 'ch-refresh-log-lines';
  for (const l of log.lines) ul.appendChild(refreshLogLine(l));
  box.appendChild(ul);
  return box;
}

// Run a whole-dashboard "refresh data" pass through the SHARED refreshDashboard
// orchestrator (the same code path the agent's refresh_dashboard action uses).
// Re-fetches each tile's series from source; success replaces the tile's rows/
// citations/vintage, failure marks it stale (data kept). Streams a receipt line
// per tile into a live log, then re-renders with the fresh data. Abortable via
// the Stop control (reuses the AbortController pattern the turn stop uses).
export async function runRefresh(dash: Dashboard) {
  if (!dashStore || refreshController) return;
  const controller = new AbortController();
  refreshController = controller;
  const log = { dashId: dash.id, lines: [] as { ok: boolean; text: string }[], done: false, aborted: false };
  lastRefreshLog = log;
  // Re-render so the button flips to "Stop refresh" and an empty log appears.
  renderDashDetail(dash);
  const ul = dashViewBody.querySelector('.ch-refresh-log-lines') as HTMLElement | null;
  try {
    await refreshDashboard(dashStore, dash.id, {
      signal: controller.signal,
      onTile: (r: TileRefreshResult) => {
        const line = { ok: r.ok, text: `${r.ok ? '✓' : '✗'} ${r.title} — ${r.detail}` };
        log.lines.push(line);
        ul?.appendChild(refreshLogLine(line));
      },
    });
    log.aborted = controller.signal.aborted;
  } catch (e: any) {
    // refreshDashboard resolves on abort; a genuine throw becomes a log line,
    // never a crash into the UI.
    log.lines.push({ ok: false, text: '✗ refresh error — ' + (e?.message ?? e) });
  } finally {
    log.done = true;
    refreshController = null;
    updateDashNavCount();
    const fresh = loadDashboard(dashStore, dash.id);
    // Re-render with fresh tiles (updated data + stale markers) and the
    // persisted log — but only if the view still shows this dashboard.
    if (fresh && currentDashId === dash.id && !dashView.hidden) renderDashDetail(fresh);
  }
}

// ── Share / export / import (increment 3) ─────────────────────────────────
// Copy `text` to the clipboard against the dashboards-view status line, with
// the same selectable-input fallback the answer share uses.
export async function copyDashLink(text: string, okMsg: string) {
  if (await writeClipboard(text)) {
    setDashStatus(okMsg);
    return;
  }
  clipboardFallback(dashViewStatus, text, okMsg, (m) => setDashStatus(m));
}

// Build a #dash= permalink for a dashboard and copy it. Refuses (honest error)
// when the dashboard is too large to fit a link even after dropping rows.
export async function shareDashboard(dash: Dashboard) {
  const enc = await encodeDashShare(dash);
  if (!enc.ok) {
    setDashStatus('dashboard too large to share as a link — use export', true);
    return;
  }
  const url = location.origin + location.pathname + '#dash=' + enc.payload;
  const note = enc.lossy ? ' (charts only; some rows omitted for size)' : '';
  await copyDashLink(url, 'Link copied' + note);
}

// Download the dashboard as a .json file (Blob), filename from the title slug.
// The exact document JSON that parseImportedDashboard reads back on import.
export function exportDashboard(dash: Dashboard) {
  try {
    const json = serializeDashboard(dash);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chitti-dashboard-${titleSlug(dash.title)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setDashStatus('Exported ' + a.download);
  } catch (e: any) {
    setDashStatus('Could not export: ' + (e?.message ?? e), true);
  }
}

// Materialize an imported document as a NEW local dashboard: fresh id + a
// de-duplicated title, so an import never overwrites an existing dashboard.
// Returns the new id on success, or null (with a status message) on failure.
export function importParsedDashboard(parsed: Dashboard): string | null {
  if (!dashStore) {
    setDashStatus('Browser storage is unavailable — cannot import.', true);
    return null;
  }
  const existing = listDashboards(dashStore).map((d) => d.title);
  const prepared = prepareImportedDashboard(parsed, existing);
  const saved = saveDashboard(dashStore, prepared);
  if (!saved.ok) {
    setDashStatus(saved.error, true);
    return null;
  }
  updateDashNavCount();
  return prepared.id;
}

// Read a picked .json file, parse it through the versioned whitelist, and land
// it as a new dashboard. Malformed/oversized input surfaces a clear error and
// never crashes the view.
export function handleImportFile(file: File) {
  const reader = new FileReader();
  reader.onerror = () => setDashStatus('Could not read that file.', true);
  reader.onload = () => {
    const raw = typeof reader.result === 'string' ? reader.result : '';
    const parsed = parseImportedDashboard(raw);
    if (!parsed) {
      setDashStatus('That file is not a valid Chitti dashboard export.', true);
      return;
    }
    const id = importParsedDashboard(parsed);
    if (!id) return;
    // Land on the freshly imported dashboard so the result is unmistakable.
    openDashboard(id);
    setDashStatus('Imported as a new dashboard.');
  };
  reader.readAsText(file);
}

dashImportFile.addEventListener('change', () => {
  const file = dashImportFile.files && dashImportFile.files[0];
  // Reset the input value so re-picking the SAME file fires change again.
  dashImportFile.value = '';
  if (file) handleImportFile(file);
});

export function renderDashDetail(dash: Dashboard) {
  disposeDashCharts();
  currentDashId = dash.id;
  dashViewTitle.textContent = dash.title;
  dashViewBack.setAttribute('aria-label', 'Back to dashboards');
  dashViewBody.innerHTML = '';

  // Detail header: dashboard title + rename control + tile count.
  const head = document.createElement('div');
  head.className = 'ch-dash-detail-head';
  const count = document.createElement('span');
  count.className = 'ch-dash-detail-count';
  count.textContent = `${dash.tiles.length} tile${dash.tiles.length === 1 ? '' : 's'}`;
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'ch-dash-mini';
  renameBtn.textContent = 'Rename dashboard';
  renameBtn.addEventListener('click', () =>
    inlineRename(dash.title, 'Dashboard name', (name) => saveAndRerender(renameDashboard(dash, name)))
  );
  head.appendChild(count);
  head.appendChild(renameBtn);

  // Share + export actions (increment 3). Available whenever the dashboard has
  // tiles to carry; both keyboard-accessible and announced via the view's
  // polite status line.
  if (dash.tiles.length) {
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'ch-dash-mini';
    shareBtn.setAttribute('data-testid', 'dash-share-link');
    shareBtn.textContent = 'Share link';
    shareBtn.setAttribute('aria-label', 'Copy a read-only shareable link to this dashboard');
    shareBtn.addEventListener('click', () => void shareDashboard(dash));
    head.appendChild(shareBtn);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'ch-dash-mini';
    exportBtn.setAttribute('data-testid', 'dash-export');
    exportBtn.textContent = 'Export';
    exportBtn.setAttribute('aria-label', 'Download this dashboard as a JSON file');
    exportBtn.addEventListener('click', () => exportDashboard(dash));
    head.appendChild(exportBtn);
  }

  // Refresh-data control (increment 2). Only when there are tiles to refresh.
  // Two-step confirm — the data APIs are free, so the confirm copy is honest
  // that it costs nothing but source calls (no LLM, no key spend). While a
  // refresh is running the button becomes a Stop control.
  if (dash.tiles.length) {
    const seriesCount = dash.tiles.reduce((n, t) => n + t.citations.length, 0);
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'ch-dash-mini ch-dash-refresh';
    refreshBtn.setAttribute('data-testid', 'dash-refresh');
    if (refreshController) {
      refreshBtn.textContent = 'Stop refresh';
      refreshBtn.classList.add('ch-confirm-armed');
      refreshBtn.addEventListener('click', () => refreshController?.abort());
    } else {
      refreshBtn.textContent = 'Refresh data';
      refreshBtn.setAttribute(
        'aria-label',
        `Refresh data — re-fetch ${seriesCount} series from source APIs (free, no key cost)`
      );
      refreshBtn.addEventListener('click', function (this: HTMLButtonElement) {
        armConfirm(
          this,
          `Re-fetch ${seriesCount} series? (free)`,
          () => void runRefresh(dash)
        );
      });
    }
    head.appendChild(refreshBtn);
  }
  dashViewBody.appendChild(head);

  // Re-show the last refresh log for THIS dashboard, if any (survives the
  // post-run re-render so the receipts stay visible next to the fresh tiles).
  if (lastRefreshLog && lastRefreshLog.dashId === dash.id && lastRefreshLog.lines.length) {
    dashViewBody.appendChild(buildRefreshLog(lastRefreshLog));
  }

  if (!dash.tiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ch-dash-empty-sub';
    empty.textContent = 'This dashboard is empty. Pin a chart from an answer to add a tile.';
    dashViewBody.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'ch-dash-grid';
  dash.tiles.forEach((tile, i) => grid.appendChild(buildTileCard(dash, tile, i)));
  dashViewBody.appendChild(grid);

  // Lazily init each tile's chart as it scrolls into view; initially-visible
  // tiles fire immediately on observe. Charts are disposed on view exit.
  initTileChartsLazily();
}

export function buildTileCard(dash: Dashboard, tile: Tile, index: number): HTMLElement {
  const card = document.createElement('figure');
  card.className = 'ch-dash-tile';

  const head = document.createElement('figcaption');
  head.className = 'ch-dash-tile-head';
  const title = document.createElement('span');
  title.className = 'ch-dash-tile-title';
  title.textContent = tile.title;
  head.appendChild(title);

  const controls = document.createElement('div');
  controls.className = 'ch-dash-tile-controls';

  const upBtn = miniBtn('↑', 'Move tile up', () => saveAndRerender(moveTile(dash, tile.id, 'up')));
  upBtn.disabled = index === 0;
  const downBtn = miniBtn('↓', 'Move tile down', () => saveAndRerender(moveTile(dash, tile.id, 'down')));
  downBtn.disabled = index === dash.tiles.length - 1;
  const renameBtn = miniBtn('Rename', 'Rename tile', () =>
    inlineRename(tile.title, 'Tile title', (name) => saveAndRerender(renameTile(dash, tile.id, name)))
  );
  const removeBtn = miniBtn('Remove', 'Remove tile', function (this: HTMLButtonElement) {
    armConfirm(this, 'Remove?', () => saveAndRerender(removeTile(dash, tile.id)));
  });
  removeBtn.classList.add('ch-dash-tile-remove');

  controls.appendChild(upBtn);
  controls.appendChild(downBtn);
  controls.appendChild(renameBtn);
  controls.appendChild(removeBtn);
  head.appendChild(controls);
  card.appendChild(head);

  const chartWrap = document.createElement('div');
  chartWrap.className = 'ch-dash-tile-chart';
  chartWrap.setAttribute('role', 'img');
  chartWrap.setAttribute('aria-label', chartAriaLabel(tile.spec));
  // Stash the spec on the element so the lazy initializer can read it.
  (chartWrap as any).__spec = tile.spec;
  card.appendChild(chartWrap);

  // Provenance line: unit (if any) + the tile's source/vintage note.
  const source = document.createElement('div');
  source.className = 'ch-dash-tile-source';
  const bits: string[] = [];
  if (tile.spec.y_axis) bits.push(tile.spec.y_axis);
  if (tile.sourceNote) bits.push(tile.sourceNote);
  source.textContent = bits.join(' · ') || 'pinned chart';
  card.appendChild(source);

  // Refresh state (increment 2). A FAILED refresh marks the tile stale: it
  // keeps its last-good data (never blank, never fabricated) and says so
  // honestly, muted — "showing data from <the date of the data on screen>".
  // A SUCCESSFUL refresh shows a quiet "refreshed <date>" line instead.
  if (tile.stale) {
    const stale = document.createElement('div');
    stale.className = 'ch-dash-tile-stale';
    const shownFrom = fmtDate(tile.refreshedAt || tile.pinnedAt);
    stale.textContent =
      `refresh failed ${fmtDate(tile.stale.failedAt)}` +
      (tile.stale.reason ? ` (${tile.stale.reason})` : '') +
      (shownFrom ? ` — showing data from ${shownFrom}` : '');
    card.appendChild(stale);
  } else if (tile.refreshedAt) {
    const r = document.createElement('div');
    r.className = 'ch-dash-tile-refreshed';
    r.textContent = `refreshed ${fmtDate(tile.refreshedAt)}`;
    card.appendChild(r);
  }

  return card;
}

// ── Shared read-only dashboard view (#dash=, increment 3) ─────────────────
// Render a decoded shared snapshot: a banner disclosing the data is "as fetched
// then", read-only tile cards (NO move/rename/remove/refresh), per-tile
// vintages with as-of framing, preserved stale markers, and a lossy note when
// a tile's rows were dropped for size. The only action is "import to edit or
// refresh", which materializes a fresh local dashboard. Nothing here is ever
// framed as freshly verified.
export function renderSharedDashboard(state: DashShareV1) {
  disposeDashCharts();
  sharedDashState = state;
  currentDashId = null;
  dashView.hidden = false;
  document.body.classList.add('ch-dashview-open');
  dashViewTitle.textContent = state.title || 'Shared dashboard';
  dashViewBack.setAttribute('aria-label', 'Leave shared dashboard');
  dashViewBody.innerHTML = '';

  // Banner: honest "as fetched then" framing + import action.
  const banner = document.createElement('div');
  banner.className = 'ch-share-banner ch-dash-shared-banner';
  banner.setAttribute('role', 'note');
  const lead = document.createElement('span');
  lead.className = 'ch-share-banner-lead';
  lead.textContent = 'Shared dashboard — data as fetched then, not refreshed. ';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'ch-share-banner-link ch-dash-shared-import';
  importBtn.setAttribute('data-testid', 'shared-import');
  importBtn.textContent = 'import to edit or refresh →';
  importBtn.addEventListener('click', () => {
    const local = materializeSharedDashboard(state);
    if (!dashStore) {
      setDashStatus('Browser storage is unavailable — cannot import.', true);
      return;
    }
    // Re-title on collision, save under a fresh id (never overwrites), then
    // switch out of read-only mode onto the new editable dashboard.
    const id = importParsedDashboard(local);
    if (!id) return;
    sharedDashState = null;
    openDashboard(id);
    setDashStatus('Imported — now editable and refreshable.');
  });
  banner.appendChild(lead);
  banner.appendChild(importBtn);
  dashViewBody.appendChild(banner);

  if (!state.tiles.length) {
    const empty = document.createElement('p');
    empty.className = 'ch-dash-empty-sub';
    empty.textContent = 'This shared dashboard has no tiles.';
    dashViewBody.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'ch-dash-grid';
  for (const tile of state.tiles) grid.appendChild(buildSharedTileCard(tile));
  dashViewBody.appendChild(grid);
  initTileChartsLazily();
}

// A read-only tile card for the shared view: chart + provenance, no controls.
export function buildSharedTileCard(tile: DashShareTileV1): HTMLElement {
  const card = document.createElement('figure');
  card.className = 'ch-dash-tile ch-dash-tile-shared';

  const head = document.createElement('figcaption');
  head.className = 'ch-dash-tile-head';
  const title = document.createElement('span');
  title.className = 'ch-dash-tile-title';
  title.textContent = tile.title;
  head.appendChild(title);
  card.appendChild(head);

  const chartWrap = document.createElement('div');
  chartWrap.className = 'ch-dash-tile-chart';
  chartWrap.setAttribute('role', 'img');
  chartWrap.setAttribute('aria-label', chartAriaLabel(tile.spec));
  (chartWrap as any).__spec = tile.spec;
  card.appendChild(chartWrap);

  // Provenance: unit + source note.
  const source = document.createElement('div');
  source.className = 'ch-dash-tile-source';
  const bits: string[] = [];
  if (tile.spec.y_axis) bits.push(tile.spec.y_axis);
  if (tile.sourceNote) bits.push(tile.sourceNote);
  source.textContent = bits.join(' · ') || 'shared chart';
  card.appendChild(source);

  // As-of framing: the vintage the data was fetched/refreshed at — never a
  // fresh-verified claim. Prefer refreshedAt, else pinnedAt.
  const asOf = fmtDate(tile.refreshedAt || tile.pinnedAt || '');
  if (asOf) {
    const v = document.createElement('div');
    v.className = 'ch-dash-tile-refreshed';
    v.textContent = `as of ${asOf}`;
    card.appendChild(v);
  }

  // Preserved stale marker.
  if (tile.stale) {
    const stale = document.createElement('div');
    stale.className = 'ch-dash-tile-stale';
    const shownFrom = fmtDate(tile.refreshedAt || tile.pinnedAt || '');
    stale.textContent =
      `refresh failed ${fmtDate(tile.stale.failedAt)}` +
      (tile.stale.reason ? ` (${tile.stale.reason})` : '') +
      (shownFrom ? ` — showing data from ${shownFrom}` : '');
    card.appendChild(stale);
  }

  // Lossy disclosure: rows were dropped for size; the chart is intact.
  if (tile.lossy) {
    const lossy = document.createElement('div');
    lossy.className = 'ch-dash-tile-lossy';
    lossy.textContent = 'showing charted data only (rows omitted for link size)';
    card.appendChild(lossy);
  }

  return card;
}

export function miniBtn(label: string, aria: string, onClick: (this: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ch-dash-mini';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.addEventListener('click', onClick);
  return b;
}

// Swap a title element region for an inline text input with save/cancel,
// keyboard-operable (Enter saves, Escape cancels). Used for both dashboard
// and tile renames. A simple prompt-free inline editor.
export function inlineRename(current: string, label: string, onSave: (name: string) => void) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ch-input ch-dash-rename-input';
  input.value = current;
  input.setAttribute('aria-label', label);
  input.maxLength = 80;

  const bar = document.createElement('div');
  bar.className = 'ch-dash-rename';
  const save = () => {
    const v = input.value.trim();
    if (v) onSave(v);
    else cleanup();
  };
  const cleanup = () => bar.remove();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
  });
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'ch-dash-mini';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', save);
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ch-dash-mini';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', cleanup);
  bar.appendChild(input);
  bar.appendChild(saveBtn);
  bar.appendChild(cancelBtn);
  // Insert the editor at the top of the detail body so it is unmistakable.
  dashViewBody.insertBefore(bar, dashViewBody.firstChild);
  input.focus();
  input.select();
}

// Init any not-yet-initialized tile charts as they enter the viewport.
export function initTileChartsLazily() {
  const wraps = Array.from(dashViewBody.querySelectorAll<HTMLElement>('.ch-dash-tile-chart'));
  const init = async (el: HTMLElement) => {
    if ((el as any).__inited) return;
    (el as any).__inited = true;
    const spec = (el as any).__spec as ChartSpec;
    const echarts = await loadECharts();
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    inst.setOption(buildOption(spec));
    liveDashCharts.push({ el, spec, inst });
  };
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver((entries, obs) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          void init(en.target as HTMLElement);
          obs.unobserve(en.target);
        }
      }
    }, { root: null, rootMargin: '200px' });
    for (const w of wraps) io.observe(w);
  } else {
    for (const w of wraps) void init(w);
  }
}

// ── Cross-module accessors ────────────────────────────────────────────────
// Two seams so the run lifecycle (boot) never touches this module's private
// state (currentDashId / sharedDashState) directly. Bodies are the exact
// statements that used to live inline in the ask() finally block and in the
// invalid-#dash= handler — moved here verbatim so the state stays encapsulated.
export function syncDashboardsAfterTurn() {
  updateDashNavCount();
  if (!dashView.hidden && currentDashId && dashStore) {
    const fresh = loadDashboard(dashStore, currentDashId);
    if (fresh) renderDashDetail(fresh);
    else { currentDashId = null; renderDashList(); }
  }
}

export function resetSharedDashState() {
  disposeDashCharts();
  sharedDashState = null;
}
